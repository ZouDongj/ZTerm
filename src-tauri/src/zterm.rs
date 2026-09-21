// ZTerm PoC 7a: 本地终端 + SSH 连接 + 窗口控制 + 配置 IO + 登录脚本
// SessionMap 统一管理 Local PTY 和 SSH 会话

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use parking_lot::Mutex;
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::{mpsc, oneshot};

#[path = "native_trace.rs"]
mod native_trace;

// 用于 emit config-corrupted 等需要 AppHandle 的事件（setup 时注册一次）
static APP_HANDLE: std::sync::OnceLock<AppHandle> = std::sync::OnceLock::new();
// 损坏配置只备份/通知一次，避免每次 load_config 重复处理
static CONFIG_CORRUPT_HANDLED: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);
// 配置/known_hosts 串行写锁（A6）：多个 save_* 命令的 load-modify-save
// 必须互斥，否则并发保存时后完成的旧快照覆盖先完成的修改
static CONFIG_WRITE_LOCK: parking_lot::Mutex<()> = parking_lot::Mutex::new(());
static KNOWN_HOSTS_WRITE_LOCK: parking_lot::Mutex<()> = parking_lot::Mutex::new(());

pub fn init_app_handle(app: &AppHandle) {
    let _ = APP_HANDLE.set(app.clone());
}

// ── Login script types ──

#[derive(Debug, Clone)]
pub struct LoginScript {
    pub expect: String,
    pub send: String,
    pub is_regex: bool,
    pub optional: bool,
}

fn parse_login_scripts(scripts_val: &Value) -> Vec<LoginScript> {
    let arr = match scripts_val.as_array() {
        Some(a) => a,
        None => return vec![],
    };
    arr.iter()
        .filter_map(|s| {
            let expect = s
                .get("expect")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let send = s
                .get("send")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            if expect.is_empty() && send.is_empty() {
                return None;
            }
            Some(LoginScript {
                expect: unescape(&expect),
                send: unescape(&send),
                is_regex: s.get("isRegex").and_then(|v| v.as_bool()).unwrap_or(false),
                optional: s.get("optional").and_then(|v| v.as_bool()).unwrap_or(false),
            })
        })
        .collect()
}

fn ensure_newline(s: &str) -> String {
    if s.ends_with('\n') || s.ends_with('\r') {
        s.to_string()
    } else {
        format!("{}\n", s)
    }
}

fn unescape(s: &str) -> String {
    let mut result = String::with_capacity(s.len());
    let mut chars = s.chars();
    while let Some(c) = chars.next() {
        if c == '\\' {
            match chars.next() {
                Some('n') => result.push('\n'),
                Some('r') => result.push('\r'),
                Some('t') => result.push('\t'),
                Some('\\') => result.push('\\'),
                Some(other) => {
                    result.push('\\');
                    result.push(other);
                }
                None => result.push('\\'),
            }
        } else {
            result.push(c);
        }
    }
    result
}

/// Process terminal output against login scripts. Returns Some(send_text) on match.
fn feed_login_scripts(data: &str, scripts: &mut Vec<LoginScript>) -> Option<String> {
    let mut result = None;
    let mut i = 0;
    while i < scripts.len() {
        let script = &scripts[i];
        if script.expect.is_empty() {
            i += 1;
            continue;
        }
        let matched = if script.is_regex {
            regex::Regex::new(&script.expect)
                .map(|re| re.is_match(data))
                .unwrap_or(false)
        } else {
            data.contains(&script.expect)
        };
        if matched {
            let send = ensure_newline(&script.send);
            scripts.remove(i);
            result = Some(send);
            break;
        } else if script.optional {
            scripts.remove(i);
        } else {
            break;
        }
    }
    result
}

/// Execute all unconditional scripts (empty expect field) and return their send texts.
fn execute_unconditional(scripts: &mut Vec<LoginScript>) -> Vec<String> {
    let mut result = Vec::new();
    while !scripts.is_empty() {
        if scripts[0].expect.is_empty() {
            result.push(ensure_newline(&scripts[0].send));
            scripts.remove(0);
        } else {
            break;
        }
    }
    result
}

// ── Session types ──

pub struct PtySession {
    pub writer_tx: mpsc::Sender<LocalInput>,
    pub flush_ms: u64,
    pub pair: portable_pty::PtyPair,
    pub child: Box<dyn portable_pty::Child + Send + Sync>,
}

pub struct LocalInput {
    data: Vec<u8>,
    trace: Option<native_trace::Ticket>,
}

pub struct SshSession {
    pub writer_tx: mpsc::Sender<Vec<u8>>,
    pub resize_tx: mpsc::Sender<(u16, u16)>,
    pub handle: Arc<russh::client::Handle<SshHandler>>,
    pub sftp: Option<Arc<russh_sftp::client::SftpSession>>,
    pub sftp_transfer: Option<Arc<russh_sftp::client::SftpSession>>,
    pub transfer_cancels: Arc<Mutex<HashMap<String, Arc<std::sync::atomic::AtomicBool>>>>,
    pub cwd: Arc<Mutex<Option<String>>>,
    /// Shared with the SshHandler and the reader task: first writer wins for
    /// user-initiated closes (ssh_disconnect / tab close pre-fill it), the
    /// handler's disconnected() callback fills it for everything else.
    pub disconnect_reason: Arc<Mutex<Option<String>>>,
}

pub enum SessionType {
    Local(PtySession),
    Ssh(SshSession),
}

pub type SessionMap = Arc<Mutex<HashMap<String, SessionType>>>;

// ── SSH Handler ──

/// 用户对 host key 变更的决定 (对齐 Electron pendingHostKeyDecisions)
pub struct HostKeyDecision {
    pub accept: bool,
    pub trust: bool,
}

/// tabId -> 等待用户决策的通道 (check_server_key 挂起时注册)
pub type KeyDecisionMap = Arc<Mutex<HashMap<String, oneshot::Sender<HostKeyDecision>>>>;

/// in-flight SSH 连接登记：rendererId -> 取消标志。
/// 连接完成登记进 SessionMap 前，关闭 tab / 重连都通过它取消连接任务，
/// 避免"连接中关闭"产生孤儿会话（H3）和"连接中重连"产生双连接（H4）。
pub struct PendingConnection {
    pub cancel: Arc<std::sync::atomic::AtomicBool>,
}
pub type PendingMap = Arc<Mutex<HashMap<String, PendingConnection>>>;

pub struct SshHandler {
    pub host: String,
    pub port: u16,
    pub tab_id: String,
    pub app: AppHandle,
    pub decisions: Arc<Mutex<HashMap<String, oneshot::Sender<HostKeyDecision>>>>,
    pub disconnect_reason: Arc<Mutex<Option<String>>>,
}

/// Classify a session-level disconnect into a UI kind + human-readable text.
/// Pure function so the mapping is unit-testable without a live session.
/// Kinds: "server" (protocol DISCONNECT message), "keepalive" (silent death
/// detected by unanswered keepalives), "closed" (user-initiated or otherwise
/// expected end), "error" (anything else, e.g. TCP reset).
pub fn classify_disconnect(
    reason: &russh::client::DisconnectReason<russh::Error>,
) -> (&'static str, String) {
    use russh::client::DisconnectReason as R;
    match reason {
        R::ReceivedDisconnect(info) => (
            "server",
            format!("server sent disconnect: {} ({:?})", info.message, info.reason_code),
        ),
        R::Error(russh::Error::KeepaliveTimeout) => (
            "keepalive",
            "server stopped replying (keepalive timeout)".to_string(),
        ),
        R::Error(russh::Error::Disconnect) => ("closed", "session closed".to_string()),
        R::Error(e) => ("error", format!("session error: {e}")),
    }
}

/// Emit the reader-side ssh-disconnected event, attaching the session-level
/// disconnect reason when the handler callback already recorded one (the
/// reader usually wins the race on channel EOF, so a late reason arrives via
/// the separate ssh-disconnect-reason event instead).
fn emit_ssh_disconnected(
    app: &AppHandle,
    tab_id: &str,
    renderer_id: &str,
    path: &str,
    reason: &Arc<Mutex<Option<String>>>,
) {
    let mut payload = json!({ "tabId": tab_id, "rendererId": renderer_id, "path": path });
    if let Some(r) = reason.lock().clone() {
        payload["reason"] = json!(r);
    }
    let _ = app.emit("ssh-disconnected", payload);
}

/// SSH client config. SSH-level keepalive every 30s: keeps middlebox (NAT /
/// firewall) state alive on idle connections and detects a silently dead
/// peer within keepalive_max × interval (~120s) instead of hours later.
/// inactivity_timeout stays None on purpose — an idle-but-alive session is
/// exactly what a terminal must preserve.
pub fn ssh_client_config() -> russh::client::Config {
    russh::client::Config {
        keepalive_interval: Some(std::time::Duration::from_secs(30)),
        ..Default::default()
    }
}

impl russh::client::Handler for SshHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &russh::keys::PublicKey,
    ) -> Result<bool, Self::Error> {
        // TOFU (对齐 Electron known-hosts.js): 首次连接记录指纹, 已知且匹配放行, 不匹配需用户确认
        use russh::keys::HashAlg;
        let fingerprint = server_public_key.fingerprint(HashAlg::Sha256).to_string();
        let algorithm = server_public_key.algorithm().to_string();
        match known_hosts_check(&self.host, self.port, &fingerprint) {
            HostKeyStatus::Known => Ok(true),
            HostKeyStatus::Unknown => {
                known_hosts_trust(&self.host, self.port, &algorithm, &fingerprint);
                Ok(true)
            }
            HostKeyStatus::Mismatch {
                old_algorithm,
                old_fingerprint,
            } => {
                // 指纹变更, 可能 MITM: 挂起连接等待用户决定 (对齐 Electron onHostKey)
                let (tx, rx) = oneshot::channel::<HostKeyDecision>();
                self.decisions.lock().insert(self.tab_id.clone(), tx);
                let _ = self.app.emit(
                    "ssh-hostkey-mismatch",
                    json!({
                        "tabId": self.tab_id,
                        "host": self.host,
                        "port": self.port,
                        "oldAlgorithm": old_algorithm,
                        "oldFingerprint": old_fingerprint,
                        "newAlgorithm": algorithm,
                        "newFingerprint": fingerprint,
                    }),
                );
                match rx.await {
                    Ok(decision) => {
                        if decision.accept && decision.trust {
                            known_hosts_trust(&self.host, self.port, &algorithm, &fingerprint);
                        }
                        Ok(decision.accept)
                    }
                    // 无响应 (tab 关闭/窗口退出被兜底拒绝) → 拒绝连接
                    Err(_) => Ok(false),
                }
            }
        }
    }

    async fn disconnected(
        &mut self,
        reason: russh::client::DisconnectReason<russh::Error>,
    ) -> Result<(), Self::Error> {
        // User-initiated closes (ssh_disconnect / tab close) pre-fill the
        // slot; the Error::Disconnect russh reports for those carries no
        // information, so keep the explicit label and report kind "closed".
        let user_initiated = self.disconnect_reason.lock().is_some();
        let (kind, text) = if user_initiated {
            ("closed", "closed by user".to_string())
        } else {
            let (k, t) = classify_disconnect(&reason);
            *self.disconnect_reason.lock() = Some(t.clone());
            (k, t)
        };
        let at_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        let _ = self.app.emit(
            "ssh-disconnect-reason",
            json!({ "tabId": self.tab_id, "kind": kind, "reason": text, "at": at_ms }),
        );
        match reason {
            russh::client::DisconnectReason::ReceivedDisconnect(_) => Ok(()),
            russh::client::DisconnectReason::Error(e) => Err(e),
        }
    }
}

// ── Known hosts (TOFU: Trust On First Use) ──
// 对齐 Electron known-hosts.js: %APPDATA%/ZTerm/known_hosts.json
// 格式: { "host:port": { "algorithm": "ssh-ed25519", "fingerprint": "SHA256:..." } }

fn known_hosts_path() -> PathBuf {
    let base = std::env::var("APPDATA")
        .or_else(|_| std::env::var("HOME"))
        .unwrap_or_else(|_| ".".into());
    PathBuf::from(base).join("ZTerm").join("known_hosts.json")
}

fn load_known_hosts() -> Value {
    let path = known_hosts_path();
    if path.exists() {
        if let Ok(content) = std::fs::read_to_string(&path) {
            if let Ok(v) = serde_json::from_str::<Value>(&content) {
                return v;
            }
        }
    }
    json!({})
}

fn save_known_hosts(hosts: &Value) {
    let path = known_hosts_path();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    // 原子写入: tmp + rename (对齐 known-hosts.js)
    let tmp = path.with_extension("json.tmp");
    if std::fs::write(
        &tmp,
        serde_json::to_string_pretty(hosts).unwrap_or_default(),
    )
    .is_ok()
    {
        let _ = std::fs::rename(&tmp, &path);
    }
}

#[derive(Debug)]
enum HostKeyStatus {
    Known,
    Unknown,
    Mismatch {
        old_algorithm: String,
        old_fingerprint: String,
    },
}

/// 已知主机记录比较（纯逻辑，便于单测）：无记录 → Unknown；
/// 指纹一致 → Known；不一致 → Mismatch（带旧算法与旧指纹）。
fn check_known_host_entry(entry: Option<&Value>, fingerprint: &str) -> HostKeyStatus {
    match entry {
        None => HostKeyStatus::Unknown,
        Some(entry) => {
            let known_fp = entry
                .get("fingerprint")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            if known_fp == fingerprint {
                HostKeyStatus::Known
            } else {
                HostKeyStatus::Mismatch {
                    old_algorithm: entry
                        .get("algorithm")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string(),
                    old_fingerprint: known_fp.to_string(),
                }
            }
        }
    }
}

fn known_hosts_check(host: &str, port: u16, fingerprint: &str) -> HostKeyStatus {
    let id = format!("{}:{}", host, port);
    let hosts = load_known_hosts();
    check_known_host_entry(hosts.get(&id), fingerprint)
}

fn known_hosts_trust(host: &str, port: u16, algorithm: &str, fingerprint: &str) {
    // A6：串行化 load-modify-save，避免并发 trust 互相覆盖记录
    let _guard = KNOWN_HOSTS_WRITE_LOCK.lock();
    let id = format!("{}:{}", host, port);
    let mut hosts = load_known_hosts();
    hosts[id] = json!({ "algorithm": algorithm, "fingerprint": fingerprint });
    save_known_hosts(&hosts);
}

// ── Credential store ──

pub type CredentialStore = Arc<Mutex<HashMap<String, Credential>>>;

pub struct Credential {
    password: Option<String>,
    private_key_path: Option<String>,
}

// ── Config helpers ──

// ── Data directory resolution (aligned with Electron session-store design) ──
// Anchor: %APPDATA%\ZTerm\config.json — holds the optional dataDir pointer
// (custom data dir) and acts as the fallback/mirror.
// Default data dir (no pointer): dev build = anchor dir, release build =
// <install dir>/data (same as the Electron packaged build).

fn anchor_dir() -> PathBuf {
    std::env::var("APPDATA")
        .or_else(|_| std::env::var("HOME"))
        .unwrap_or_else(|_| ".".into())
        .into()
}

fn anchor_config_path() -> PathBuf {
    anchor_dir().join("ZTerm").join("config.json")
}

fn default_data_dir() -> PathBuf {
    #[cfg(debug_assertions)]
    {
        // dev build: keep using the anchor dir (matches Electron dev behavior)
        return anchor_dir().join("ZTerm");
    }
    #[cfg(not(debug_assertions))]
    {
        // release build: <exe dir>/data
        if let Ok(exe) = std::env::current_exe() {
            if let Some(parent) = exe.parent() {
                return parent.join("data");
            }
        }
        anchor_dir().join("ZTerm")
    }
}

// Resolve the effective data dir: anchor dataDir pointer first, else default.
fn resolve_data_dir() -> PathBuf {
    let anchor = anchor_config_path();
    if anchor.exists() {
        if let Ok(content) = std::fs::read_to_string(&anchor) {
            if let Ok(v) = serde_json::from_str::<Value>(&content) {
                if let Some(d) = v.get("dataDir").and_then(|x| x.as_str()) {
                    if !d.is_empty() {
                        return PathBuf::from(d);
                    }
                }
            }
        }
    }
    default_data_dir()
}

// One-time migration: if the default data dir has no config yet but the
// anchor has one (and no custom pointer is set), copy it over. This covers
// first launch of a packaged build and config wipe after reinstall.
pub fn migrate_legacy_config() {
    let anchor = anchor_config_path();
    if !anchor.exists() {
        return;
    }
    // Skip migration when a custom dataDir pointer exists
    if let Ok(content) = std::fs::read_to_string(&anchor) {
        if let Ok(v) = serde_json::from_str::<Value>(&content) {
            if let Some(d) = v.get("dataDir").and_then(|x| x.as_str()) {
                if !d.is_empty() {
                    return;
                }
            }
        }
    }
    let target_dir = default_data_dir();
    let target = target_dir.join("config.json");
    if !target.exists() {
        let _ = std::fs::create_dir_all(&target_dir);
        if std::fs::copy(&anchor, &target).is_ok() {
            eprintln!("[zterm] migrated config to {}", target.display());
        }
    }
}

fn config_path() -> PathBuf {
    resolve_data_dir().join("config.json")
}

fn default_config() -> Value {
    json!({
        "version": 1,
        "profiles": [
            { "id": "powershell", "name": "PowerShell", "type": "local", "command": "powershell.exe", "icon": "local" },
            { "id": "cmd", "name": "Command Prompt", "type": "local", "command": "cmd.exe", "icon": "local" }
        ],
        "sshProfiles": [],
        "lastTabs": [],
        "appearance": {
            "fontFamily": "\"JetBrains Mono\",\"Cascadia Code\",Consolas,monospace",
            "fontSize": 14,
            "fontWeight": "450",
            "fontWeightBold": "700",
            "theme": "dark"
        }
    })
}

/// 递归合并：对象字段逐键合并（用户值优先），非对象整体替换。
/// 这样用户手写部分字段（如只改 appearance.fontSize）时不会丢掉默认字段。
fn merge_value(base: &mut Value, over: &Value) {
    if base.is_object() && over.is_object() {
        for (k, v) in over.as_object().unwrap() {
            if let Some(b) = base.get_mut(k) {
                merge_value(b, v);
            } else {
                base[k] = v.clone();
            }
        }
    } else {
        *base = over.clone();
    }
}

/// 校验并合并用户配置：根值非对象视为损坏（返回 Null + corrupt 标记），
/// 对象则合并到默认配置之上。与 load_config 的文件 IO / 备份逻辑分离，便于单测。
fn sanitize_config(raw: Value) -> (Value, bool) {
    // M2：根值必须是对象（数组/字符串/数字/null 均视为损坏，
    // 否则字段被静默忽略且不触发备份，后续保存会覆盖用户数据）
    if !raw.is_object() {
        return (Value::Null, true);
    }
    let mut merged = default_config();
    merge_value(&mut merged, &raw);
    (merged, false)
}

fn load_config() -> Value {
    let path = config_path();
    if path.exists() {
        if let Ok(content) = std::fs::read_to_string(&path) {
            if let Ok(raw) = serde_json::from_str::<Value>(&content) {
                let (merged, corrupt) = sanitize_config(raw);
                if !corrupt {
                    return merged;
                }
            }
        }
        // 配置损坏：备份原文件并通知 renderer（仅一次），避免后续保存用默认值
        // 无提示覆盖用户数据（SSH 配置/加密密码丢失）
        if !CONFIG_CORRUPT_HANDLED.swap(true, std::sync::atomic::Ordering::SeqCst) {
            let ts = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs();
            let backup = path.with_file_name(format!("config.json.corrupt-{}", ts));
            let _ = std::fs::copy(&path, &backup);
            if let Some(app) = APP_HANDLE.get() {
                let _ = app.emit("config-corrupted", json!({}));
            }
        }
    }
    default_config()
}

fn save_config(config: &Value) {
    let path = config_path();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let content = serde_json::to_string_pretty(config).unwrap_or_default();
    // 原子写：tmp + rename，避免写一半崩溃留下损坏配置
    let tmp = path.with_extension("json.tmp");
    if std::fs::write(&tmp, &content).is_ok() && std::fs::rename(&tmp, &path).is_ok() {
        return;
    }
    let _ = std::fs::remove_file(&tmp);
    // Fallback: default data dir not writable (e.g. no permission in
    // Program Files) — persist to the anchor dir so data is not lost.
    eprintln!(
        "[zterm] write {} failed, falling back to anchor",
        path.display()
    );
    let anchor = anchor_config_path();
    if let Some(parent) = anchor.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = std::fs::write(&anchor, &content);
}

// ── Command: get_profiles (emit profiles event) ──

#[tauri::command]
pub fn get_profiles(app: AppHandle, args: Vec<Value>) -> Result<Value, String> {
    let _ = args;
    let config = load_config();
    let profiles = config.get("profiles").cloned().unwrap_or(json!([]));
    let ssh_profiles = config.get("sshProfiles").cloned().unwrap_or(json!([]));
    let last_tabs = config.get("lastTabs").cloned().unwrap_or(json!([]));
    let _ = app.emit(
        "profiles",
        json!({ "profiles": profiles, "sshProfiles": ssh_profiles, "lastTabs": last_tabs }),
    );
    Ok(json!({ "ok": true }))
}

// ── Command: pty_create (local shell, emits pty-created) ──

/// 解析 OSC 7 cwd（`ESC]7;file://host/pathESC\`，见 _zt_cwd 的 printf 输出）。
/// 纯函数便于单测；返回路径（含前导 /），未匹配返回 None。
fn parse_osc7_cwd(text: &str) -> Option<String> {
    let re = regex::Regex::new(r"\x1b\]7;file://[^/\x07\x1b\\]*(\/[^\x07\x1b\\]*?)(?:\x07|\x1b\\)")
        .ok()?;
    let m = re.captures(text)?;
    m.get(1).map(|g| g.as_str().to_string())
}

/// 解析 iTerm2 OSC 1337 CurrentDir（`ESC]1337;CurrentDir=<path>BEL` 或 `ST`）。
/// fish ≥3.x 每次提示符原生输出该序列（无需任何 shell 集成），是 fish 下
/// follow-cwd 的主来源；iTerm2 风格工具链也常发 `file://host/path` 变体。
/// 纯函数便于单测；返回不含 scheme/host 的绝对路径，未匹配返回 None。
fn parse_1337_currentdir(text: &str) -> Option<String> {
    // path 段：到终止符为止；允许 file://[host] 前缀（取首个 / 之后）
    let re = regex::Regex::new(
        r"\x1b\]1337;CurrentDir=(?:file://[^/\x07\x1b\\]*)?(/[^\x07\x1b\\]*?)(?:\x07|\x1b\\)",
    )
    .ok()?;
    let m = re.captures(text)?;
    let raw = m.get(1)?.as_str();
    // fish 原样输出 $PWD（空格不转义）；iTerm2 变体可能 %XX 编码，尽量还原
    let decoded = percent_decode_loose(raw);
    if decoded.starts_with('/') {
        Some(decoded)
    } else {
        None
    }
}

/// 宽松 %XX 解码：仅还原合法的百分号转义，非法序列保持原样（路径里裸 % 很常见）。
fn percent_decode_loose(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = |b: u8| -> Option<u8> {
                match b {
                    b'0'..=b'9' => Some(b - b'0'),
                    b'a'..=b'f' => Some(b - b'a' + 10),
                    b'A'..=b'F' => Some(b - b'A' + 10),
                    _ => None,
                }
            };
            if i + 2 < bytes.len() {
                if let (Some(hi), Some(lo)) = (hex(bytes[i + 1]), hex(bytes[i + 2])) {
                    out.push(hi * 16 + lo);
                    i += 3;
                    continue;
                }
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}

/// ConPTY emits local echo as ~6 tiny (~9 byte) blocks per keystroke; emitting
/// each read as its own IPC message starves the WebView renderer frame budget
/// (visible as per-keystroke stutter). The PTY reader therefore only appends
/// to a shared outbox and a single flusher thread coalesces it into one
/// message per tick.
const PTY_FLUSH_INTERVAL_MS: u64 = 4;
/// A/B switch (default off): `ZTERM_PTY_COALESCE=loose` widens the flush
/// window to wait out ConPTY's 27-36ms twin-wave output splits. Costs up to
/// PTY_LOOSE_FLUSH_WINDOW_MS of added local typing latency. An explicit
/// `ZTERM_PTY_FLUSH_MS=<n>` always wins, so both settings stay scriptable.
const PTY_LOOSE_FLUSH_WINDOW_MS: u64 = 40;
const PTY_MAX_FLUSH_WINDOW_MS: u64 = 200;

fn pty_flush_interval_ms(loose: bool) -> u64 {
    pty_flush_interval_from(std::env::var("ZTERM_PTY_FLUSH_MS").ok().as_deref(), loose)
}

fn pty_flush_interval_from(explicit: Option<&str>, loose: bool) -> u64 {
    if let Some(raw) = explicit {
        if let Ok(ms) = raw.trim().parse::<u64>() {
            return ms.min(PTY_MAX_FLUSH_WINDOW_MS);
        }
    }
    if loose {
        return PTY_LOOSE_FLUSH_WINDOW_MS;
    }
    PTY_FLUSH_INTERVAL_MS
}

// Every tick drains the available bytes. Equal-sized consecutive bursts are
// unrelated; comparing their lengths can hold the second burst indefinitely.
fn drain_pty_outbox(outbox: &mut Vec<u8>) -> Vec<u8> {
    std::mem::take(outbox)
}

#[tauri::command]
pub fn pty_diagnostics(state: State<'_, SessionMap>, args: Vec<Value>) -> Result<Value, String> {
    let params = args.first().cloned().unwrap_or(json!({}));
    let action = params
        .get("action")
        .and_then(Value::as_str)
        .unwrap_or("snapshot");
    let tab_id = params.get("tabId").and_then(Value::as_str).unwrap_or("");
    let flush_ms = if action == "arm" {
        match state.lock().get(tab_id) {
            Some(SessionType::Local(s)) => s.flush_ms,
            _ => return Err("diagnostics require an existing local session".into()),
        }
    } else {
        0
    };
    native_trace::control(
        action,
        tab_id,
        params
            .get("durationMs")
            .and_then(Value::as_u64)
            .unwrap_or(10000),
        params
            .get("capacity")
            .and_then(Value::as_u64)
            .unwrap_or(4096)
            .min(8192) as usize,
        flush_ms,
    )
}

/// 增量 UTF-8 解码：把新字节接到 carry 上，解码出所有完整字符并返回；
/// 块尾不完整的多字节序列（error_len 为 None）留在 carry 等下一块补齐，
/// 避免单块 from_utf8_lossy 把跨块字符（中文/emoji 等）替换成 U+FFFD（�）。
/// 真非法字节（error_len 为 Some）按 U+FFFD 替换并跳过，与 from_utf8_lossy 一致。
fn drain_utf8(carry: &mut Vec<u8>, data: &[u8]) -> String {
    carry.extend_from_slice(data);
    let mut out = String::new();
    loop {
        match std::str::from_utf8(carry) {
            Ok(s) => {
                out.push_str(s);
                carry.clear();
                break;
            }
            Err(e) => {
                let valid = e.valid_up_to();
                if valid > 0 {
                    // valid_up_to 保证 [..valid] 是有效 UTF-8 前缀
                    out.push_str(
                        std::str::from_utf8(&carry[..valid])
                            .expect("valid_up_to prefix is valid UTF-8"),
                    );
                }
                match e.error_len() {
                    Some(n) => {
                        // 真非法字节：替换并跳过，继续解码剩余部分
                        out.push('\u{FFFD}');
                        carry.drain(..valid + n);
                    }
                    None => {
                        // 块尾不完整序列：保留，等下一块
                        carry.drain(..valid);
                        break;
                    }
                }
            }
        }
    }
    out
}

#[tauri::command]
pub async fn pty_create(
    app: AppHandle,
    state: State<'_, SessionMap>,
    args: Vec<Value>,
) -> Result<Value, String> {
    let params = args.into_iter().next().unwrap_or(json!({}));
    let shell = params
        .get("shell")
        .and_then(|v| v.as_str())
        .unwrap_or("powershell.exe");
    let shell_args: Vec<String> = params
        .get("args")
        .and_then(|v| v.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|x| x.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();
    let cwd = params.get("cwd").and_then(|v| v.as_str()).map(String::from);
    let request_id = params
        .get("requestId")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let cols = params.get("cols").and_then(|v| v.as_u64()).unwrap_or(80) as u16;
    let rows = params.get("rows").and_then(|v| v.as_u64()).unwrap_or(24) as u16;

    static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
    let tab_id = format!(
        "local_{}",
        COUNTER.fetch_add(1, std::sync::atomic::Ordering::SeqCst)
    );

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("openpty failed: {e}"))?;

    let mut cmd = CommandBuilder::new(shell);
    for arg in &shell_args {
        cmd.arg(arg);
    }
    if let Some(ref cwd) = cwd {
        cmd.cwd(cwd);
    }

    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("spawn failed: {e}"))?;
    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("reader failed: {e}"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("writer failed: {e}"))?;

    let loose = std::env::var("ZTERM_PTY_COALESCE")
        .map(|v| v.trim() == "loose")
        .unwrap_or(false);
    let flush_ms = pty_flush_interval_ms(loose);
    let (writer_tx, mut writer_rx) = mpsc::channel::<LocalInput>(64);

    // Announce the session BEFORE starting the output threads: the first
    // output burst carries the ConPTY DA1 handshake, and a chunk that beats
    // pty-created to the renderer would have no owner and be silently dropped.
    {
        let mut map = state.lock();
        map.insert(
            tab_id.clone(),
            SessionType::Local(PtySession {
                writer_tx,
                flush_ms,
                pair,
                child,
            }),
        );
    }
    let _ = app.emit(
        "pty-created",
        json!({ "tabId": tab_id, "requestId": request_id }),
    );

    let writer = Arc::new(Mutex::new(Some(writer)));
    let writer_for_task = writer.clone();
    let writer_tab_id = tab_id.clone();
    tokio::spawn(async move {
        while let Some(input) = writer_rx.recv().await {
            use std::io::Write;
            native_trace::input_stage(
                &writer_tab_id,
                "write-begin",
                input.data.len(),
                input.trace,
                None,
            );
            let mut ok = false;
            if let Some(ref mut w) = *writer_for_task.lock() {
                ok = w.write_all(&input.data).is_ok();
            }
            native_trace::input_stage(
                &writer_tab_id,
                "write-end",
                input.data.len(),
                input.trace,
                Some(ok),
            );
        }
        *writer_for_task.lock() = None;
    });

    let app2 = app.clone();
    let tid = tab_id.clone();
    tokio::task::spawn_blocking(move || {
        // Reader thread: blocking reads only append to the shared outbox.
        let outbox: Arc<Mutex<Vec<u8>>> = Arc::new(Mutex::new(Vec::new()));
        let finished = Arc::new(std::sync::atomic::AtomicBool::new(false));
        {
            let outbox = Arc::clone(&outbox);
            let finished = Arc::clone(&finished);
            let read_tab_id = tid.clone();
            std::thread::spawn(move || {
                let mut buf = [0u8; 8192];
                loop {
                    use std::io::Read;
                    match reader.read(&mut buf) {
                        Ok(0) => break,
                        Ok(n) => {
                            native_trace::record(&read_tab_id, "raw-read", n, None, None, None);
                            outbox.lock().extend_from_slice(&buf[..n]);
                        }
                        Err(_) => break,
                    }
                }
                finished.store(true, std::sync::atomic::Ordering::Release);
            });
        }

        // Flusher thread: the only emitter. Coalesces micro-blocks into one
        // IPC message per tick and preserves output ordering. The UTF-8 carry
        // lives here so multi-byte characters split across reads survive.
        // 跨块字符 carry：read 块边界可能切在 UTF-8 多字节序列中间，
        // 单块 from_utf8_lossy 会把半截字符变成 U+FFFD（�）
        let mut utf8_carry: Vec<u8> = Vec::new();
        loop {
            std::thread::sleep(std::time::Duration::from_millis(flush_ms));
            let taken = {
                let mut guard = outbox.lock();
                if guard.is_empty() {
                    if finished.load(std::sync::atomic::Ordering::Acquire) {
                        break;
                    }
                    continue;
                }
                drain_pty_outbox(&mut guard)
            };
            if !taken.is_empty() {
                let text = drain_utf8(&mut utf8_carry, &taken);
                let stamp = native_trace::record(&tid, "output-emit", taken.len(), None, None, None);
                let mut payload = json!({ "tabId": tid, "data": text });
                if let Some(stamp) = stamp {
                    payload["nativeTrace"] = stamp;
                }
                let _ = app2.emit("pty-output", payload);
            }
        }
        let _ = app2.emit("pty-exit", json!({ "tabId": tid }));
    });

    Ok(json!({ "tabId": tab_id, "requestId": request_id }))
}

// ── Command: ssh_connect (emits ssh-connecting → ssh-connected / ssh-error) ──

/// 解析凭据：返回 (密码, 私钥路径)。两者都为空表示无凭据。
fn resolve_ssh_credential(
    profile: &Value,
    cred_store: &CredentialStore,
) -> (Option<String>, Option<String>) {
    // 优先 credentialId
    if let Some(cred_id) = profile.get("credentialId").and_then(|v| v.as_str()) {
        let store = cred_store.lock();
        if let Some(cred) = store.get(cred_id) {
            return (cred.password.clone(), cred.private_key_path.clone());
        }
    }
    (None, None)
}

async fn open_sftp_channel(
    handle: &mut russh::client::Handle<SshHandler>,
) -> Option<Arc<russh_sftp::client::SftpSession>> {
    let channel = handle.channel_open_session().await.ok()?;
    channel.request_subsystem(true, "sftp").await.ok()?;
    let stream = channel.into_stream();
    russh_sftp::client::SftpSession::new(stream)
        .await
        .ok()
        .map(Arc::new)
}

/// Clean residual injection artifacts from ~/.bash_history and ~/.zsh_history
async fn clean_history_artifacts(sftp: &russh_sftp::client::SftpSession, username: &str) {
    // Resolve home dir from /etc/passwd (SFTP doesn't expand ~)
    let home = {
        let content = sftp.read("/etc/passwd").await.ok();
        content.and_then(|c| {
            let text = String::from_utf8_lossy(&c);
            let prefix = format!("{}:", username);
            text.lines()
                .find_map(|l| l.strip_prefix(&prefix))
                .and_then(|rest| {
                    let fields: Vec<&str> = rest.split(':').collect();
                    fields.get(5).map(|h| h.to_string())
                })
        })
    };
    let home = match home {
        Some(h) if !h.is_empty() => h,
        _ => return,
    };
    let patterns = [
        "_zt_cwd",
        "_zt_hio",
        "ZTERM_INJECTED",
        "hist_ignore_space",
        "set +o history",
        "setopt HIST_IGNORE_SPACE",
    ];
    for name in ["bash_history", "zsh_history"] {
        let path = format!("{}/.{}", home, name);
        let content = match sftp.read(&path).await {
            Ok(c) => c,
            Err(_) => continue,
        };
        let text = String::from_utf8_lossy(&content);
        let filtered: Vec<&str> = text
            .lines()
            .filter(|l| !patterns.iter().any(|p| l.contains(p)))
            .collect();
        if filtered.len() != text.lines().count() {
            let mut cleaned = filtered.join("\n");
            if !cleaned.is_empty() {
                cleaned.push('\n');
            }
            let _ = sftp_write_file(sftp, &path, cleaned.as_bytes()).await;
        }
    }
}

/// Write file via SFTP, creating it if missing (sftp.write() requires existing file)
async fn sftp_write_file(
    sftp: &russh_sftp::client::SftpSession,
    path: &str,
    data: &[u8],
) -> Result<(), String> {
    use russh_sftp::protocol::OpenFlags;
    use tokio::io::AsyncWriteExt;
    let mut file = sftp
        .open_with_flags(
            path,
            OpenFlags::WRITE | OpenFlags::CREATE | OpenFlags::TRUNCATE,
        )
        .await
        .map_err(|e| format!("open {}: {e}", path))?;
    file.write_all(data)
        .await
        .map_err(|e| format!("write {}: {e}", path))?;
    let _ = file.sync_all().await;
    Ok(())
}

/// Detect user's login shell by reading /etc/passwd via SFTP
async fn detect_shell(sftp: &russh_sftp::client::SftpSession, username: &str) -> Option<String> {
    let content = sftp.read("/etc/passwd").await.ok()?;
    let text = String::from_utf8_lossy(&content);
    let prefix = format!("{}:", username);
    for line in text.lines() {
        if let Some(rest) = line.strip_prefix(&prefix) {
            let shell = rest.rsplit(':').next()?.trim().to_string();
            return Some(shell);
        }
    }
    None
}

/// 生成 followCwd RC wrapper 文件（纯函数，便于单测）。
/// 返回 (文件列表 [(远程路径, 内容)], exec 命令)；非 bash/zsh 返回 None。
fn cwd_wrapper_files(shell: &str, stamp: &str) -> Option<(Vec<(String, Vec<u8>)>, String)> {
    if shell.ends_with("/bash") {
        let rc_path = format!("/tmp/.zterm-rc-{}", stamp);
        let rc = format!(
            "{{ [ -f ~/.bash_profile ] && . ~/.bash_profile; }} || {{ [ -f ~/.bash_login ] && . ~/.bash_login; }} || {{ [ -f ~/.profile ] && . ~/.profile; }}\n\
             _zt_cwd() {{ printf '\\033]7;file://%s%s\\033\\\\' \"$HOSTNAME\" \"$PWD\"; }}\n\
             PROMPT_COMMAND=\"_zt_cwd;${{PROMPT_COMMAND}}\"\n\
             rm -f {}\n",
            rc_path
        );
        Some((
            vec![(rc_path.clone(), rc.into_bytes())],
            format!("exec bash --rcfile {} -i", rc_path),
        ))
    } else if shell.ends_with("/zsh") {
        let dir = format!("/tmp/.zterm-zdot-{}", stamp);
        let zshrc = format!(
            "[ -f ~/.zshrc ] && . ~/.zshrc\n\
             _zt_cwd() {{ printf '\\033]7;file://%s%s\\033\\\\' \"$HOSTNAME\" \"$PWD\"; }}\n\
             precmd_functions+=(_zt_cwd)\n\
             rm -rf {}\n",
            dir
        );
        Some((
            vec![
                (format!("{}/.zshrc", dir), zshrc.into_bytes()),
                (
                    format!("{}/.zprofile", dir),
                    b"[ -f ~/.zprofile ] && . ~/.zprofile\n".to_vec(),
                ),
            ],
            format!("exec env ZDOTDIR={} zsh -il", dir),
        ))
    } else {
        None
    }
}

/// Prepare followCwd RC wrapper via SFTP. Returns exec command (bash/zsh) or None to fall back.
async fn prepare_cwd_wrapper(
    sftp: &russh_sftp::client::SftpSession,
    username: &str,
) -> Option<String> {
    let shell = detect_shell(sftp, username).await?;
    let stamp = format!("{}-{}", std::process::id(), rand_suffix());
    let (files, exec) = cwd_wrapper_files(&shell, &stamp)?;
    for (path, content) in &files {
        // zsh 需要先建目录
        if let Some(dir) = path.rsplit_once('/').map(|(d, _)| d) {
            if dir != "/tmp" {
                let _ = sftp.create_dir(dir).await;
            }
        }
        if sftp_write_file(sftp, path, content).await.is_err() {
            return None;
        }
    }
    Some(exec)
}

fn rand_suffix() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .subsec_nanos();
    format!("{:08x}", nanos)
}

#[tauri::command]
pub async fn ssh_connect(
    app: AppHandle,
    state: State<'_, SessionMap>,
    cred_state: State<'_, CredentialStore>,
    decision_state: State<'_, KeyDecisionMap>,
    pending_state: State<'_, PendingMap>,
    args: Vec<Value>,
) -> Result<Value, String> {
    let params = args.into_iter().next().unwrap_or(json!({}));
    let empty_obj = json!({});
    let profile = params.get("profile").unwrap_or(&empty_obj);
    let renderer_id = params
        .get("rendererId")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    // B2：严格校验参数——拒绝非法输入而不是静默采用默认值
    let host = profile
        .get("host")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if host.is_empty() {
        return Err("ssh-connect: missing host".into());
    }
    let port = profile.get("port").and_then(|v| v.as_u64()).unwrap_or(0) as u16;
    if port == 0 {
        return Err("ssh-connect: missing or invalid port".into());
    }
    let username = profile
        .get("username")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if username.is_empty() {
        return Err("ssh-connect: missing username".into());
    }

    // Parse login scripts
    let login_scripts = profile
        .get("loginScripts")
        .map(|v| parse_login_scripts(v))
        .unwrap_or_default();
    let mut login_scripts_mut = login_scripts.clone();

    // Parse followCwd flag
    let follow_cwd = profile
        .get("followCwd")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    static SSH_COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
    let tab_id = format!(
        "ssh_{}",
        SSH_COUNTER.fetch_add(1, std::sync::atomic::Ordering::SeqCst)
    );

    // Emit ssh-connecting immediately
    let _ = app.emit(
        "ssh-connecting",
        json!({ "tabId": tab_id, "rendererId": renderer_id }),
    );

    // in-flight 登记：同一 rendererId 的新连接请求会取消旧的（H4：连接中重连
    // 不再产生双会话）。关闭 tab（pty_destroy/ssh_disconnect）也通过它取消连接。
    let cancel_flag = {
        let mut pm = pending_state.lock();
        if let Some(old) = pm.remove(&renderer_id) {
            old.cancel.store(true, std::sync::atomic::Ordering::Relaxed);
        }
        let c = Arc::new(std::sync::atomic::AtomicBool::new(false));
        pm.insert(renderer_id.clone(), PendingConnection { cancel: c.clone() });
        c
    };
    // 被取消时静默退出（前端已关 tab 或已发起新连接，不再 emit 任何事件）
    macro_rules! cancelled {
        ($h:expr) => {
            if cancel_flag.load(std::sync::atomic::Ordering::Relaxed) {
                // shell 之后 writer/reader task 已启动并持有 handle 克隆：
                // 必须显式断开，否则连接任务因 handle 仍被引用而永不退出（泄漏）
                let _ = $h
                    .disconnect(russh::Disconnect::ByApplication, "ZTerm cancelled", "")
                    .await;
                return Ok(json!({ "cancelled": true, "tabId": tab_id, "rendererId": renderer_id }));
            }
        };
    }

    // Resolve credential (password or private key path)
    let (password, key_path) = resolve_ssh_credential(profile, &cred_state);

    // Connect via russh — use mut handle for auth/channel (needs &mut self)
    let addr = format!("{}:{}", host, port);
    let config = Arc::new(ssh_client_config());
    // Shared disconnect-reason slot: handler callback fills it on
    // session-level death, reader task attaches it to ssh-disconnected when
    // it loses the race, ssh_disconnect/tab-close pre-fill it for
    // user-initiated closes.
    let disconnect_reason = Arc::new(Mutex::new(None::<String>));

    let mut handle = russh::client::connect(
        config,
        &addr,
        SshHandler {
            host: host.clone(),
            port,
            tab_id: tab_id.clone(),
            app: app.clone(),
            decisions: decision_state.inner().clone(),
            disconnect_reason: Arc::clone(&disconnect_reason),
        },
    )
        .await
        .map_err(|e| {
            if cancel_flag.load(std::sync::atomic::Ordering::Relaxed) {
                return "cancelled".to_string();
            }
            // Phase tag: russh's bare Error::Disconnect ("Disconnected") is
            // indistinguishable between TCP drops, handshake failures and
            // auth rejections once wrapped; the phase narrows server-side
            // vs credential-side causes on the first report.
            let _ = app.emit(
                "ssh-error",
                json!({ "tabId": tab_id, "rendererId": renderer_id, "error": format!("SSH connect (tcp/handshake {addr}): {e}") }),
            );
            format!("SSH connect (tcp/handshake {addr}): {e}")
        })?;
    cancelled!(handle);

    // Authenticate (needs &mut self) — password or public key (H1)
    let auth_result = if let Some(ref key_path) = key_path {
        // 私钥认证：读取 OpenSSH/PKCS8 私钥文件（暂不支持带 passphrase 的加密私钥）
        let contents = std::fs::read_to_string(key_path).map_err(|e| {
            let _ = app.emit(
                "ssh-error",
                json!({ "tabId": tab_id, "rendererId": renderer_id, "error": format!("SSH key read: {e}") }),
            );
            format!("SSH key read: {e}")
        })?;
        let key = russh::keys::PrivateKey::from_openssh(contents.as_bytes()).map_err(|e| {
            let _ = app.emit(
                "ssh-error",
                json!({ "tabId": tab_id, "rendererId": renderer_id, "error": format!("SSH key parse: {e}") }),
            );
            format!("SSH key parse: {e}")
        })?;
        let kp = russh::keys::PrivateKeyWithHashAlg::new(Arc::new(key), None);
        handle
            .authenticate_publickey(&username, kp)
            .await
            .map_err(|e| {
                if cancel_flag.load(std::sync::atomic::Ordering::Relaxed) {
                    return "cancelled".to_string();
                }
                let _ = app.emit(
                    "ssh-error",
                    json!({ "tabId": tab_id, "rendererId": renderer_id, "error": format!("SSH auth: {e}") }),
                );
                format!("SSH auth: {e}")
            })?
    } else {
        handle
            .authenticate_password(&username, &password.unwrap_or_default())
            .await
            .map_err(|e| {
                if cancel_flag.load(std::sync::atomic::Ordering::Relaxed) {
                    return "cancelled".to_string();
                }
                let _ = app.emit(
                    "ssh-error",
                    json!({ "tabId": tab_id, "rendererId": renderer_id, "error": format!("SSH auth: {e}") }),
                );
                format!("SSH auth: {e}")
            })?
    };
    cancelled!(handle);

    if !auth_result.success() {
        if cancel_flag.load(std::sync::atomic::Ordering::Relaxed) {
            return Ok(json!({ "cancelled": true, "tabId": tab_id, "rendererId": renderer_id }));
        }
        let _ = app.emit(
            "ssh-error",
            json!({ "tabId": tab_id, "rendererId": renderer_id, "error": "Authentication failed" }),
        );
        return Err("Authentication failed".into());
    }

    // Open session channel
    let mut channel = handle
        .channel_open_session()
        .await
        .map_err(|e| {
            if cancel_flag.load(std::sync::atomic::Ordering::Relaxed) {
                return "cancelled".to_string();
            }
            let _ = app.emit(
                "ssh-error",
                json!({ "tabId": tab_id, "rendererId": renderer_id, "error": format!("SSH channel: {e}") }),
            );
            format!("SSH channel: {e}")
        })?;
    cancelled!(handle);

    // Request PTY (default 80x24, renderer sends resize after fit)
    channel
        .request_pty(false, "xterm-256color", 80, 24, 0, 0, &[])
        .await
        .map_err(|e| {
            let _ = app.emit(
                "ssh-error",
                json!({ "tabId": tab_id, "rendererId": renderer_id, "error": format!("SSH PTY: {e}") }),
            );
            format!("SSH PTY: {e}")
        })?;

    let channel_id = channel.id();

    // Open SFTP channels (panel + transfer, independent from terminal channel)
    let sftp = open_sftp_channel(&mut handle).await;
    let sftp_transfer = open_sftp_channel(&mut handle).await;

    // FollowCwd: prefer RC wrapper (zero-typing injection via SFTP rc file)
    let mut exec_cmd = None;
    if follow_cwd {
        if let Some(ref s) = sftp {
            // Clean up residual injection artifacts from previous sessions
            clean_history_artifacts(s, &username).await;
            exec_cmd = prepare_cwd_wrapper(s, &username).await;
        }
    }

    // Start shell: exec wrapped shell (followCwd) or plain shell
    if let Some(ref cmd) = exec_cmd {
        channel.exec(true, cmd.as_str()).await.map_err(|e| {
            if cancel_flag.load(std::sync::atomic::Ordering::Relaxed) {
                return "cancelled".to_string();
            }
            let _ = app.emit(
                "ssh-error",
                json!({ "tabId": tab_id, "rendererId": renderer_id, "error": format!("SSH shell: {e}") }),
            );
            format!("SSH shell: {e}")
        })?;
    } else {
        channel.request_shell(true).await.map_err(|e| {
            if cancel_flag.load(std::sync::atomic::Ordering::Relaxed) {
                return "cancelled".to_string();
            }
            let _ = app.emit(
                "ssh-error",
                json!({ "tabId": tab_id, "rendererId": renderer_id, "error": format!("SSH shell: {e}") }),
            );
            format!("SSH shell: {e}")
        })?;
    }
    cancelled!(handle);

    // Wrap handle in Arc for writer task & session store (Handle::data takes &self)
    let handle = Arc::new(handle);

    // Create writer channel early (needed by unconditional scripts and reader task)
    let (writer_tx, mut writer_rx) = mpsc::channel::<Vec<u8>>(64);
    let write_handle_spawn = Arc::clone(&handle);
    let cid_spawn = channel_id;
    tokio::spawn(async move {
        while let Some(data) = writer_rx.recv().await {
            let _ = write_handle_spawn.data(cid_spawn, data).await;
        }
    });

    // Execute unconditional login scripts (empty expect = send immediately)
    // Small delay to let shell initialise and show its first prompt
    let unconditional = execute_unconditional(&mut login_scripts_mut);
    if !unconditional.is_empty() {
        let wtx = writer_tx.clone();
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
            for send_text in unconditional {
                let _ = wtx.send(send_text.into_bytes()).await;
            }
        });
    }

    // FollowCwd typed injection: fallback when RC wrapper unavailable
    let inject = follow_cwd && exec_cmd.is_none();
    let track_cwd = follow_cwd; // OSC 7 parsing active for both rc wrapper and typed injection
                                // 注入过滤标志：注入发送时才激活，避免吞掉登录脚本的输出
    let filtering = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let filtering_inject = Arc::clone(&filtering);
    if inject {
        let wtx = writer_tx.clone();
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(800)).await;
            // 所有行以空格开头：zsh 行内设置 HIST_IGNORE_SPACE 后本行不记录，完全无痕
            // marker 在 stty -echo 状态下输出 → 只输出一次，无回显
            filtering_inject.store(true, std::sync::atomic::Ordering::Relaxed);
            let script = " setopt HIST_IGNORE_SPACE 2>/dev/null; set +o history 2>/dev/null\n\
                           stty -echo\n\
                           _zt_cwd() { printf '\\033]7;file://%s%s\\033\\\\' \"$HOSTNAME\" \"$PWD\"; }\n\
                           if [ -n \"$ZSH_VERSION\" ]; then precmd_functions+=(_zt_cwd); else PROMPT_COMMAND=\"_zt_cwd;${PROMPT_COMMAND}\"; fi\n\
                           echo ZTERM_INJECTED\n\
                           stty echo\n";
            let _ = wtx.send(script.as_bytes().to_vec()).await;
        });
    }

    // Spawn reader task (owns Channel — wait() needs &mut, handles resize via select!)
    let app2 = app.clone();
    let tid = tab_id.clone();
    let rid = renderer_id.clone();
    let (resize_tx, mut resize_rx) = mpsc::channel::<(u16, u16)>(8);
    let scripts = Arc::new(Mutex::new(login_scripts_mut));
    let scripts_reader = Arc::clone(&scripts);
    let reader_writer = writer_tx.clone();
    let cwd = Arc::new(Mutex::new(None::<String>));
    let cwd_reader = Arc::clone(&cwd);
    let filtering_reader = Arc::clone(&filtering);
    let reason_reader = Arc::clone(&disconnect_reason);
    tokio::spawn(async move {
        // 跨块字符 carry：SSH channel 数据可切在 UTF-8 多字节序列中间，
        // 单块 from_utf8_lossy 会把半截字符变成 U+FFFD（�）
        let mut utf8_carry: Vec<u8> = Vec::new();
        // OSC 7 跨块窗口：序列被数据块切开时拼接匹配
        let mut osc7_window = String::new();
        // Inject state machine: filter output until ZTERM_INJECTED marker.
        // Filtering only activates when the injection task sets the flag.
        let mut inject_buffer = String::new();
        let inject_timeout = tokio::time::sleep(std::time::Duration::from_secs(5));
        tokio::pin!(inject_timeout);
        loop {
            tokio::select! {
                _ = &mut inject_timeout => {
                    // Timeout: force Normal state to avoid stuck filtering
                    if filtering_reader.swap(false, std::sync::atomic::Ordering::Relaxed) {
                        let remainder = std::mem::take(&mut inject_buffer);
                        if !remainder.is_empty() {
                            let _ = app2.emit("pty-output", json!({ "tabId": tid, "data": remainder }));
                        }
                    }
                }
                msg = channel.wait() => {
                    match msg {
                        Some(russh::ChannelMsg::Data { ref data }) => {
                            let text = drain_utf8(&mut utf8_carry, data);
                            // Feed to login script processor (drop guard before await)
                            let send_text = {
                                let mut s = scripts_reader.lock();
                                feed_login_scripts(&text, &mut s)
                            };
                            if let Some(t) = send_text {
                                let _ = reader_writer.send(t.into_bytes()).await;
                            }
                            if filtering_reader.load(std::sync::atomic::Ordering::Relaxed) {
                                // Filter injection echo until ZTERM_INJECTED marker
                                inject_buffer.push_str(&text);
                                if inject_buffer.contains("ZTERM_INJECTED") {
                                    filtering_reader.store(false, std::sync::atomic::Ordering::Relaxed);
                                    // Strip everything up to and including the marker + trailing newline
                                    let marker_end = inject_buffer.find("ZTERM_INJECTED").unwrap() + "ZTERM_INJECTED".len();
                                    let remainder = inject_buffer[marker_end..].trim_start_matches(['\n', '\r']).to_string();
                                    inject_buffer.clear();
                                    if !remainder.is_empty() {
                                        let _ = app2.emit("pty-output", json!({ "tabId": tid, "data": remainder }));
                                    }
                                }
                            } else {
                                // Parse OSC 7 for cwd tracking (active for both rc wrapper and typed injection)
                                if track_cwd {
                                    // OSC 7 序列可能被 SSH 数据块切开：保留上一块尾部文本拼接匹配，
                                    // 否则跨块序列被逐块正则静默丢弃（cwd 永远跟踪不到）
                                    osc7_window.push_str(&text);
                                    if osc7_window.chars().count() > 1024 {
                                        let keep = osc7_window
                                            .char_indices()
                                            .nth(osc7_window.chars().count() - 512)
                                            .map(|(i, _)| i)
                                            .unwrap_or(0);
                                        osc7_window.drain(..keep);
                                    }
                                    // 两类 cwd 序列可能同时出现在窗口里（登录时
                                    // wrapper 的 OSC 7 + fish 每个提示符的 1337）：
                                    // 取窗口中出现位置更靠后的那个，避免陈旧的
                                    // OSC 7 压住新路径
                                    let osc7_cwd = parse_osc7_cwd(&osc7_window);
                                    let c1337_cwd = parse_1337_currentdir(&osc7_window);
                                    let new_cwd: Option<String> = match (&osc7_cwd, &c1337_cwd) {
                                        (Some(a), Some(b)) => {
                                            let pa = osc7_window.find("\x1b]7;file://").unwrap_or(0);
                                            let pb = osc7_window.find("\x1b]1337;CurrentDir=").unwrap_or(0);
                                            Some(if pb >= pa { b.clone() } else { a.clone() })
                                        }
                                        (Some(a), None) => Some(a.clone()),
                                        (None, Some(b)) => Some(b.clone()),
                                        (None, None) => None,
                                    };
                                    if let Some(new_cwd) = new_cwd {
                                        let changed = {
                                            let mut c = cwd_reader.lock();
                                            if c.as_ref() != Some(&new_cwd) {
                                                *c = Some(new_cwd.clone());
                                                true
                                            } else { false }
                                        };
                                        if changed {
                                            let _ = app2.emit("sftp-cwd-changed", json!({ "tabId": tid, "cwd": new_cwd }));
                                        }
                                    }
                                }
                                let _ = app2.emit("pty-output", json!({ "tabId": tid, "data": text }));
                            }
                        }
                        Some(russh::ChannelMsg::Eof) | Some(russh::ChannelMsg::Close) => {
                            let path = if matches!(msg, Some(russh::ChannelMsg::Eof)) {
                                "channel-eof"
                            } else {
                                "channel-closed"
                            };
                            emit_ssh_disconnected(&app2, &tid, &rid, path, &reason_reader);
                            break;
                        }
                        None => {
                            emit_ssh_disconnected(&app2, &tid, &rid, "session-ended", &reason_reader);
                            break;
                        }
                        _ => {}
                    }
                }
                resize = resize_rx.recv() => {
                    if let Some((cols, rows)) = resize {
                        let _ = channel.window_change(cols as u32, rows as u32, 0, 0).await;
                    } else {
                        break; // channel closed
                    }
                }
            }
        }
    });

    let cancels: Arc<Mutex<HashMap<String, Arc<std::sync::atomic::AtomicBool>>>> =
        Arc::new(Mutex::new(HashMap::new()));

    // 登记前最后检查：期间被取消（关 tab/重连）则不登记、不 emit，连接静默丢弃
    cancelled!(handle);
    pending_state.lock().remove(&renderer_id);

    // Store session
    {
        let mut map = state.lock();
        map.insert(
            tab_id.clone(),
            SessionType::Ssh(SshSession {
                writer_tx: writer_tx.clone(),
                resize_tx,
                handle,
                sftp,
                sftp_transfer,
                transfer_cancels: cancels.clone(),
                cwd,
                disconnect_reason,
            }),
        );
    }

    let _ = app.emit(
        "ssh-connected",
        json!({ "tabId": tab_id, "rendererId": renderer_id }),
    );
    Ok(json!({ "tabId": tab_id }))
}

// ── Command: ssh_disconnect ──

#[tauri::command]
pub async fn ssh_disconnect(
    app: AppHandle,
    state: State<'_, SessionMap>,
    decision_state: State<'_, KeyDecisionMap>,
    pending_state: State<'_, PendingMap>,
    args: Vec<Value>,
) -> Result<Value, String> {
    let params = args.into_iter().next().unwrap_or(json!({}));
    let tab_id = params
        .get("tabId")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let renderer_id = params
        .get("rendererId")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    // 取消 in-flight 连接（H4：连接中重连时旧连接任务在此退出，不再产生双会话）
    if !renderer_id.is_empty() {
        if let Some(p) = pending_state.lock().remove(&renderer_id) {
            p.cancel.store(true, std::sync::atomic::Ordering::Relaxed);
        }
    }
    // tab 关闭时若正卡在 hostkey 决策，拒绝以解除 check_server_key 挂起 (对齐 Electron)
    if let Some(tx) = decision_state.lock().remove(&tab_id) {
        let _ = tx.send(HostKeyDecision {
            accept: false,
            trust: false,
        });
    }
    // 取出 handle 后立即释放 map 锁，再 await 断开（锁不跨 await）
    let close_handle = {
        let mut map = state.lock();
        match map.remove(&tab_id) {
            Some(SessionType::Ssh(session)) => {
                // Pre-fill the reason slot so the handler's disconnected()
                // labels this as a user-initiated close instead of reporting
                // russh's information-free Error::Disconnect.
                *session.disconnect_reason.lock() = Some("closed by user".to_string());
                Some(session.handle.clone())
            }
            _ => None,
        }
    };
    if let Some(h) = close_handle {
        // 显式断开，让远端会话立即结束（H6：不能只靠 Drop 引用计数）
        let _ = h
            .disconnect(russh::Disconnect::ByApplication, "ZTerm closed", "")
            .await
            .ok();
        // Dropping the session drops the writer_tx, which stops the writer task.
        // The reader task will detect EOF and emit ssh-disconnected.
        let _ = app.emit("ssh-disconnected", json!({ "tabId": tab_id }));
    }
    Ok(json!({ "ok": true }))
}

// 用户对 host key 变更的决定: accept(信任并连接/拒绝), trust(是否更新 known_hosts)
// 同时供 tab 关闭/窗口退出时兜底拒绝, 否则 check_server_key 永久挂起
#[tauri::command]
pub fn ssh_hostkey_decision(
    decision_state: State<'_, KeyDecisionMap>,
    args: Vec<Value>,
) -> Result<Value, String> {
    let params = args.into_iter().next().unwrap_or(json!({}));
    let tab_id = params
        .get("tabId")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let accept = params
        .get("accept")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let trust = params
        .get("trust")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    if let Some(tx) = decision_state.lock().remove(&tab_id) {
        let _ = tx.send(HostKeyDecision { accept, trust });
    }
    Ok(json!({ "ok": true }))
}

// ── Unified commands: pty_input, pty_resize, pty_destroy ──

#[tauri::command]
pub async fn pty_input(state: State<'_, SessionMap>, args: Vec<Value>) -> Result<(), String> {
    let params = args.into_iter().next().unwrap_or(json!({}));
    let tab_id = params
        .get("tabId")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let data = params
        .get("data")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    enum InputSender {
        Local(mpsc::Sender<LocalInput>),
        Ssh(mpsc::Sender<Vec<u8>>),
    }
    let writer_tx = {
        let map = state.lock();
        match map.get(&tab_id) {
            Some(SessionType::Local(s)) => InputSender::Local(s.writer_tx.clone()),
            Some(SessionType::Ssh(s)) => InputSender::Ssh(s.writer_tx.clone()),
            None => return Err(format!("no session for {}", tab_id)),
        }
    };
    match writer_tx {
        InputSender::Local(tx) => {
            let bytes = data.len();
            let requested_op = params
                .get("diagnosticInputId")
                .and_then(Value::as_u64)
                .filter(|v| *v > 0 && *v <= 9_007_199_254_740_991);
            let trace = native_trace::input(&tab_id, bytes, requested_op);
            native_trace::input_stage(&tab_id, "channel-wait", bytes, trace, None);
            let result = tx
                .send(LocalInput {
                    data: data.into_bytes(),
                    trace,
                })
                .await;
            native_trace::input_stage(
                &tab_id,
                "channel-accepted",
                bytes,
                trace,
                Some(result.is_ok()),
            );
            result.map_err(|_| "local input channel closed".to_string())?;
        }
        InputSender::Ssh(tx) => {
            tx.send(data.into_bytes()).await.map_err(|e| format!("channel closed: {e}"))?;
        }
    }
    Ok(())
}

#[tauri::command]
pub fn pty_resize(state: State<'_, SessionMap>, args: Vec<Value>) -> Result<(), String> {
    let params = args.into_iter().next().unwrap_or(json!({}));
    let tab_id = params
        .get("tabId")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let cols = params.get("cols").and_then(|v| v.as_u64()).unwrap_or(80) as u16;
    let rows = params.get("rows").and_then(|v| v.as_u64()).unwrap_or(24) as u16;
    let map = state.lock();
    match map.get(&tab_id) {
        Some(SessionType::Local(session)) => {
            session
                .pair
                .master
                .resize(PtySize {
                    rows,
                    cols,
                    pixel_width: 0,
                    pixel_height: 0,
                })
                .map_err(|e| format!("resize failed: {e}"))?;
        }
        Some(SessionType::Ssh(session)) => {
            let _ = session.resize_tx.try_send((cols, rows));
        }
        None => {}
    }
    Ok(())
}

#[tauri::command]
pub async fn pty_destroy(
    app: AppHandle,
    state: State<'_, SessionMap>,
    decision_state: State<'_, KeyDecisionMap>,
    pending_state: State<'_, PendingMap>,
    args: Vec<Value>,
) -> Result<Value, String> {
    let params = args.into_iter().next().unwrap_or(json!({}));
    let tab_id = params
        .get("tabId")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let renderer_id = params
        .get("rendererId")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    // 取消 in-flight SSH 连接（H3：连接握手完成前关闭 tab，会话尚未入 map，
    // 只能通过 pending 取消让连接任务在下一个检查点退出）
    if !renderer_id.is_empty() {
        if let Some(p) = pending_state.lock().remove(&renderer_id) {
            p.cancel.store(true, std::sync::atomic::Ordering::Relaxed);
        }
    }
    // 拒绝挂起的 hostkey 决策，解除 check_server_key 的 await（否则连接任务永久挂起）
    if let Some(tx) = decision_state.lock().remove(&tab_id) {
        let _ = tx.send(HostKeyDecision {
            accept: false,
            trust: false,
        });
    }
    // 取出会话后立即释放 map 锁，再 await 断开（锁不跨 await）
    let close_handle = {
        let mut map = state.lock();
        match map.remove(&tab_id) {
            Some(session) => match session {
                SessionType::Local(mut s) => {
                    let _ = s.child.kill();
                    None
                }
                SessionType::Ssh(s) => {
                    // A4：关闭 tab 时取消所有进行中的 SFTP 传输
                    // （否则传输 task 继续写临时文件，且 renderer 已无法再取消它）
                    {
                        let cancels = s.transfer_cancels.lock();
                        for c in cancels.values() {
                            c.store(true, std::sync::atomic::Ordering::Relaxed);
                        }
                    }
                    // Same pre-fill as ssh_disconnect: user-initiated close.
                    *s.disconnect_reason.lock() = Some("closed by user".to_string());
                    Some(s.handle.clone())
                }
            },
            None => None,
        }
    };
    if let Some(h) = close_handle {
        // 显式断开，让远端会话立即结束（H6：不能只靠 Drop 引用计数）
        let _ = h
            .disconnect(russh::Disconnect::ByApplication, "ZTerm closed", "")
            .await
            .ok();
        // Drop session → drop writer_tx → writer task exits
        // Reader task will detect EOF and emit ssh-disconnected
        let _ = app.emit("ssh-disconnected", json!({ "tabId": tab_id }));
    }
    Ok(json!({ "tabId": tab_id }))
}

// ── Config persistence commands ──

#[tauri::command]
pub fn save_last_tabs(args: Vec<Value>) -> Result<(), String> {
    let tabs = args.into_iter().next().unwrap_or(json!([]));
    let mut config = load_config();
    if let Value::Object(ref mut c) = config {
        let _config_guard = CONFIG_WRITE_LOCK.lock();
        c.insert("lastTabs".into(), tabs);
    }
    save_config(&config);
    Ok(())
}

#[tauri::command]
pub fn save_appearance(args: Vec<Value>) -> Result<(), String> {
    let _config_guard = CONFIG_WRITE_LOCK.lock();
    let appearance = args.into_iter().next().unwrap_or(json!({}));
    let mut config = load_config();
    if let Value::Object(ref mut c) = config {
        c.insert("appearance".into(), appearance);
    }
    save_config(&config);
    Ok(())
}

// ── Window state persistence（与 Tabby 一致：记住上次的位置/大小/最大化状态）──

#[derive(Clone)]
pub struct WindowState {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub maximized: bool,
}

// 从配置值解析窗口状态（纯函数，与文件 IO 分离便于单测；字段缺失/类型错误 → None）
fn window_state_from_config(config: &Value) -> Option<WindowState> {
    let w = config.get("window")?;
    Some(WindowState {
        x: w.get("x")?.as_i64()? as i32,
        y: w.get("y")?.as_i64()? as i32,
        width: w.get("width")?.as_i64()? as u32,
        height: w.get("height")?.as_i64()? as u32,
        maximized: w
            .get("maximized")
            .and_then(|v| v.as_bool())
            .unwrap_or(false),
    })
}

fn window_state_to_config(state: &WindowState) -> Value {
    json!({
        "x": state.x,
        "y": state.y,
        "width": state.width,
        "height": state.height,
        "maximized": state.maximized,
    })
}

pub fn load_window_state() -> Option<WindowState> {
    window_state_from_config(&load_config())
}

pub fn save_window_state(state: &WindowState) {
    let _guard = CONFIG_WRITE_LOCK.lock();
    let mut config = load_config();
    if let Value::Object(ref mut c) = config {
        c.insert("window".into(), window_state_to_config(state));
    }
    save_config(&config);
}

// renderer 加载完成（window-shown 监听已注册）后调用：恢复窗口状态 → 显示窗口 → 通知播放启动动画。
// 用 renderer 主动上报而不是主进程 on_page_load：保证事件 emit 时监听器一定已就绪，
// 否则事件丢失会导致启动界面无法隐藏（卡在启动页）
#[tauri::command]
pub fn renderer_ready(app: AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "main window not found".to_string())?;
    // 已由主进程 5s 兜底显示过（renderer-ready 迟到）则只恢复状态，不重复 emit 淡入
    let already_visible = window.is_visible().unwrap_or(false);
    // 恢复上次关闭时的窗口状态（位置/大小/最大化，与 Tabby 一致）
    if let Some(ws) = load_window_state() {
        if window_position_visible(ws.x, ws.y, ws.width, ws.height, &window) {
            let _ = window.set_position(tauri::PhysicalPosition::new(ws.x, ws.y));
            let _ = window.set_size(tauri::PhysicalSize::new(ws.width, ws.height));
        }
        if ws.maximized {
            let _ = window.maximize();
        }
    }
    if already_visible {
        return Ok(());
    }
    // 状态就绪后显示窗口（最大化/尺寸已应用，无闪现）
    let _ = window.show();
    // 通知 renderer 播放启动动画（renderer 的监听器已注册，不会丢失）
    let _ = app.emit("window-shown", json!({}));
    Ok(())
}

// 显示器矩形（纯数据，便于单测）
struct MonitorRect {
    x: i32,
    y: i32,
    w: u32,
    h: u32,
}

// 窗口中心点是否落在任一显示器矩形内（纯函数，与窗口句柄分离便于单测）
fn center_on_any_monitor(cx: i32, cy: i32, monitors: &[MonitorRect]) -> bool {
    monitors
        .iter()
        .any(|m| cx >= m.x && cx < m.x + m.w as i32 && cy >= m.y && cy < m.y + m.h as i32)
}

// 窗口位置是否落在任一显示器的可见区域内（防止显示器配置变化后窗口"消失"，
// 恢复位置前检查；无法枚举显示器时保守视为可见）
pub fn window_position_visible(
    x: i32,
    y: i32,
    width: u32,
    height: u32,
    window: &tauri::WebviewWindow,
) -> bool {
    if let Ok(monitors) = window.available_monitors() {
        if monitors.is_empty() {
            return true;
        }
        let rects: Vec<MonitorRect> = monitors
            .iter()
            .map(|m| MonitorRect {
                x: m.position().x,
                y: m.position().y,
                w: m.size().width,
                h: m.size().height,
            })
            .collect();
        return center_on_any_monitor(x + (width as i32) / 2, y + (height as i32) / 2, &rects);
    }
    true
}

// ── Window control commands ──

#[tauri::command]
pub fn window_minimize(app: AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.minimize();
    }
}

#[tauri::command]
pub fn window_maximize(app: AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let maximized = w.is_maximized().unwrap_or(false);
        if maximized {
            let _ = w.unmaximize();
        } else {
            let _ = w.maximize();
        }
        // 通知 renderer 更新图标
        let _ = app.emit("window-state-changed", json!({ "maximized": !maximized }));
    }
}

#[tauri::command]
pub fn window_close(app: AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.close();
    }
}

// ── Quick Commands ──

#[tauri::command]
pub fn get_quick_commands(app: AppHandle, args: Vec<Value>) -> Result<Value, String> {
    let _ = args;
    let config = load_config();
    let cmds = config.get("quickCommands").cloned().unwrap_or(json!([]));
    let _ = app.emit("quick-commands", cmds);
    Ok(json!({ "ok": true }))
}

#[tauri::command]
pub fn save_quick_commands(args: Vec<Value>) -> Result<Value, String> {
    let commands = args.into_iter().next().unwrap_or(json!([]));
    let mut config = load_config();
    if let Value::Object(ref mut c) = config {
        let _config_guard = CONFIG_WRITE_LOCK.lock();
        c.insert("quickCommands".into(), commands);
    }
    save_config(&config);
    Ok(json!({ "ok": true }))
}

// ── Highlight Rules ──

#[tauri::command]
pub fn get_highlight_rules(app: AppHandle, args: Vec<Value>) -> Result<Value, String> {
    let _ = args;
    let config = load_config();
    let rules = config.get("highlightRules").cloned().unwrap_or(json!([]));
    let enabled = config
        .get("highlightEnabled")
        .and_then(|v| v.as_bool())
        .unwrap_or(true);
    let alt_disable = config
        .get("highlightAlternateDisable")
        .and_then(|v| v.as_bool())
        .unwrap_or(true);
    let _ = app.emit(
        "highlight-rules",
        json!({ "rules": rules, "settings": { "highlightEnabled": enabled, "highlightAlternateDisable": alt_disable } }),
    );
    Ok(json!({ "ok": true }))
}

#[tauri::command]
pub fn save_highlight_rules(args: Vec<Value>) -> Result<Value, String> {
    let _config_guard = CONFIG_WRITE_LOCK.lock();
    let params = args.into_iter().next().unwrap_or(json!({}));
    let mut config = load_config();
    if let Value::Object(ref mut c) = config {
        if let Some(rules) = params.get("rules") {
            c.insert("highlightRules".into(), rules.clone());
        }
        if let Some(settings) = params.get("settings") {
            if let Some(enabled) = settings.get("highlightEnabled") {
                c.insert("highlightEnabled".into(), enabled.clone());
            }
            if let Some(alt) = settings.get("highlightAlternateDisable") {
                c.insert("highlightAlternateDisable".into(), alt.clone());
            }
        }
    }
    save_config(&config);
    Ok(json!({ "ok": true }))
}

// ── Terminal Settings ──

#[tauri::command]
pub fn save_terminal_settings(args: Vec<Value>) -> Result<Value, String> {
    let _config_guard = CONFIG_WRITE_LOCK.lock();
    let settings = args.into_iter().next().unwrap_or(json!({}));
    let mut config = load_config();
    if let Value::Object(ref mut c) = config {
        c.insert("terminal".into(), settings);
    }
    save_config(&config);
    Ok(json!({ "ok": true }))
}

// ── SSH Profiles ──

#[tauri::command]
pub fn save_ssh_profiles(app: AppHandle, args: Vec<Value>) -> Result<Value, String> {
    let _config_guard = CONFIG_WRITE_LOCK.lock();
    let params = args.into_iter().next().unwrap_or(json!({}));
    let profiles = params.get("sshProfiles").cloned().unwrap_or(json!([]));
    let mut config = load_config();
    if let Value::Object(ref mut c) = config {
        c.insert("sshProfiles".into(), profiles);
    }
    save_config(&config);
    // 渲染进程监听 ssh-profiles-saved 事件来刷新 UI
    let _ = app.emit("ssh-profiles-saved", json!({}));
    Ok(json!({ "ok": true }))
}

// ── Shortcuts ──

#[tauri::command]
pub fn save_shortcuts(args: Vec<Value>) -> Result<Value, String> {
    let _config_guard = CONFIG_WRITE_LOCK.lock();
    let shortcuts = args.into_iter().next().unwrap_or(json!({}));
    let mut config = load_config();
    if let Value::Object(ref mut c) = config {
        c.insert("shortcuts".into(), shortcuts);
    }
    save_config(&config);
    Ok(json!({ "ok": true }))
}

// ── Settings persistence (load at startup) ──

#[tauri::command]
pub fn load_settings(args: Vec<Value>) -> Value {
    let _ = args;
    let config = load_config();
    json!({
        "terminal": config.get("terminal").cloned().unwrap_or(json!({})),
        "appearance": config.get("appearance").cloned().unwrap_or(json!({})),
        "shortcuts": config.get("shortcuts").cloned().unwrap_or(json!({})),
    })
}

// ── Shell / Font / Info ──

// PATH 中查找可执行文件（返回所有匹配，供 git.exe 推导使用）
fn which_all(exe: &str) -> Vec<String> {
    let path = std::env::var("PATH").unwrap_or_default();
    let mut out = Vec::new();
    for dir in path.split(';') {
        let dir = dir.trim().trim_matches('"');
        if dir.is_empty() {
            continue;
        }
        let p = std::path::PathBuf::from(dir).join(exe);
        if p.exists() {
            out.push(p.to_string_lossy().to_string());
            continue;
        }
        if !exe.to_lowercase().ends_with(".exe") {
            let mut p2 = p.clone();
            p2.set_extension("exe");
            if p2.exists() {
                out.push(p2.to_string_lossy().to_string());
            }
        }
    }
    out
}

fn path_which(exe: &str) -> Option<String> {
    which_all(exe).into_iter().next()
}

// 读注册表字符串值（Win32 API，避免 spawn reg.exe 控制台子进程拖慢启动）
fn reg_get_string(
    hive: winapi::shared::minwindef::HKEY,
    subkey: &str,
    value: &str,
) -> Option<String> {
    use std::os::windows::ffi::OsStrExt;
    use winapi::um::winreg::{RegGetValueW, RRF_RT_REG_SZ};
    let subkey_wide: Vec<u16> = std::ffi::OsStr::new(subkey)
        .encode_wide()
        .chain(Some(0))
        .collect();
    let value_wide: Vec<u16> = std::ffi::OsStr::new(value)
        .encode_wide()
        .chain(Some(0))
        .collect();
    let mut buf = [0u16; 1024];
    let mut buf_size = (buf.len() * 2) as u32;
    let ret = unsafe {
        RegGetValueW(
            hive,
            subkey_wide.as_ptr(),
            value_wide.as_ptr(),
            RRF_RT_REG_SZ,
            std::ptr::null_mut(),
            buf.as_mut_ptr() as *mut _,
            &mut buf_size,
        )
    };
    if ret != 0 || buf_size < 2 {
        return None;
    }
    let len = (buf_size as usize / 2).saturating_sub(1); // 去掉结尾 NUL
    Some(String::from_utf16_lossy(&buf[..len]))
}

// 本地 shell 自动探测（对齐 Electron 版 detectLocalShells）:
// - pwsh: PATH 检测
// - Git Bash: 注册表 GitForWindows InstallPath -> 常见安装路径 -> PATH 里 git.exe 推导
// - WSL: PATH 检测
// 本地 shell 自动探测（对齐 Electron 版 detectLocalShells）:
// - pwsh: PATH 检测
// - Git Bash: 注册表 GitForWindows InstallPath -> 常见安装路径 -> PATH 里 git.exe 推导
// - WSL: PATH 检测
#[tauri::command]
pub fn get_local_shells(args: Vec<Value>) -> Result<Value, String> {
    let _ = args;
    let mut shells_arr = vec![
        json!({ "id": "powershell", "name": "Windows PowerShell", "type": "local", "command": "powershell.exe", "icon": "local" }),
        json!({ "id": "cmd", "name": "Command Prompt", "type": "local", "command": "cmd.exe", "icon": "local" }),
    ];

    // PowerShell 7（需单独安装，检测 PATH）
    if path_which("pwsh.exe").is_some() {
        shells_arr.push(json!({ "id": "pwsh", "name": "PowerShell", "type": "local", "command": "pwsh.exe", "icon": "local" }));
    }

    // Git Bash 候选路径（按优先级）
    let mut git_bash_candidates: Vec<String> = Vec::new();
    // 1) 注册表 GitForWindows InstallPath（官方安装器必写，装任意盘都能找到）
    use winapi::um::winreg::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE};
    for hive in [HKEY_LOCAL_MACHINE, HKEY_CURRENT_USER] {
        if let Some(p) = reg_get_string(hive, "SOFTWARE\\GitForWindows", "InstallPath") {
            if !p.is_empty() {
                git_bash_candidates.push(format!("{p}\\bin\\bash.exe"));
            }
        }
    }
    // 2) 常见安装路径（ProgramFiles / ProgramFiles(x86) / winget -> LOCALAPPDATA）
    for base in ["ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"] {
        if let Ok(dir) = std::env::var(base) {
            let p = if base == "LOCALAPPDATA" {
                format!("{dir}\\Programs\\Git\\bin\\bash.exe")
            } else {
                format!("{dir}\\Git\\bin\\bash.exe")
            };
            git_bash_candidates.push(p);
        }
    }
    // 3) PATH 里 git.exe 推导: <root>\cmd\git.exe -> <root>\bin\bash.exe
    for git_path in which_all("git.exe") {
        if let Some(parent) = std::path::Path::new(&git_path).parent() {
            if let Some(grand) = parent.parent() {
                git_bash_candidates.push(
                    grand
                        .join("bin")
                        .join("bash.exe")
                        .to_string_lossy()
                        .to_string(),
                );
            }
        }
    }
    // 去重后取第一个存在的
    let mut seen = std::collections::HashSet::new();
    let git_bash = git_bash_candidates.into_iter().find(|p| {
        if seen.contains(p) {
            return false;
        }
        seen.insert(p.clone());
        std::path::PathBuf::from(p).exists()
    });
    if let Some(path) = git_bash {
        shells_arr.push(json!({
            "id": "gitbash", "name": "Git Bash", "type": "local",
            "command": path, "args": ["--login", "-i"], "icon": "term"
        }));
    }

    // WSL
    if path_which("wsl.exe").is_some() {
        shells_arr.push(json!({ "id": "wsl", "name": "WSL", "type": "local", "command": "wsl.exe", "icon": "term" }));
    }

    Ok(Value::Array(shells_arr))
}

#[tauri::command]
pub fn get_data_dir_info(args: Vec<Value>) -> Value {
    let _ = args;
    let current = resolve_data_dir().to_string_lossy().to_string();
    let default_dir = default_data_dir().to_string_lossy().to_string();
    // Custom data dir = anchor holds a dataDir pointer pointing elsewhere
    let anchor_path = anchor_config_path();
    let is_custom = if anchor_path.exists() {
        std::fs::read_to_string(&anchor_path)
            .ok()
            .and_then(|s| serde_json::from_str::<Value>(&s).ok())
            .and_then(|v| v.get("dataDir").cloned())
            .and_then(|v| v.as_str().map(|s| s.to_string()))
            .map(|d| !d.is_empty() && d != default_dir)
            .unwrap_or(false)
    } else {
        false
    };
    json!({
        "current": current,
        "defaultDir": default_dir,
        "isCustom": is_custom
    })
}

#[tauri::command]
pub fn set_data_dir(args: Vec<Value>) -> Result<Value, String> {
    let _config_guard = CONFIG_WRITE_LOCK.lock();
    let params = args.into_iter().next().unwrap_or(json!({}));
    let dir = params
        .get("dir")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let anchor_dir = PathBuf::from(
        std::env::var("APPDATA")
            .or_else(|_| std::env::var("HOME"))
            .unwrap_or_default(),
    )
    .join("ZTerm");
    let anchor_config = anchor_dir.join("config.json");
    let _ = std::fs::create_dir_all(&anchor_dir);

    if dir.is_empty() {
        let mut anchor: Value = if anchor_config.exists() {
            std::fs::read_to_string(&anchor_config)
                .ok()
                .and_then(|s| serde_json::from_str(&s).ok())
                .unwrap_or(json!({}))
        } else {
            json!({})
        };
        if let Value::Object(ref mut m) = anchor {
            m.remove("dataDir");
        }
        let _ = std::fs::write(
            &anchor_config,
            serde_json::to_string_pretty(&anchor).unwrap_or_default(),
        );
    } else {
        let current_config = load_config();
        let new_dir = PathBuf::from(&dir);
        let _ = std::fs::create_dir_all(&new_dir);
        let new_config_path = new_dir.join("config.json");
        let mut clean_config = current_config.clone();
        if let Value::Object(ref mut m) = clean_config {
            m.remove("dataDir");
        }
        let _ = std::fs::write(
            &new_config_path,
            serde_json::to_string_pretty(&clean_config).unwrap_or_default(),
        );
        let mut anchor: Value = if anchor_config.exists() {
            std::fs::read_to_string(&anchor_config)
                .ok()
                .and_then(|s| serde_json::from_str(&s).ok())
                .unwrap_or(json!({}))
        } else {
            json!({})
        };
        if let Value::Object(ref mut m) = anchor {
            m.insert("dataDir".into(), json!(dir));
        }
        let _ = std::fs::write(
            &anchor_config,
            serde_json::to_string_pretty(&anchor).unwrap_or_default(),
        );
    }
    Ok(json!({ "ok": true }))
}

#[tauri::command]
pub fn get_about_info(args: Vec<Value>) -> Value {
    let _ = args;
    json!({
        "version": env!("CARGO_PKG_VERSION"),
        "electron": "Tauri 2",
        "xterm": "xterm.js",
        "russh": "russh 0.60"
    })
}

// ── Update check (GitHub Releases, check-only) ──

const RELEASES_LATEST_URL: &str = "https://api.github.com/repos/ZouDongj/ZTerm/releases/latest";

/// True when `latest` is a strictly newer version than `current`.
/// Both may carry a leading 'v' and a pre-release/build suffix; only the
/// numeric dotted core is compared (1.0.5-beta.1 counts as 1.0.5).
pub fn version_newer(current: &str, latest: &str) -> bool {
    fn core(v: &str) -> Vec<u64> {
        v.trim()
            .trim_start_matches(['v', 'V'])
            .split(['-', '+'])
            .next()
            .unwrap_or("")
            .split('.')
            .map(|p| p.parse::<u64>().unwrap_or(0))
            .collect()
    }
    let (a, b) = (core(current), core(latest));
    for i in 0..a.len().max(b.len()) {
        let x = a.get(i).copied().unwrap_or(0);
        let y = b.get(i).copied().unwrap_or(0);
        if y != x {
            return y > x;
        }
    }
    false
}

#[tauri::command]
pub async fn check_update(args: Vec<Value>) -> Result<Value, String> {
    let _ = args;
    tokio::task::spawn_blocking(|| {
        let agent = update_http_agent(10);
        let resp = agent
            .get(RELEASES_LATEST_URL)
            .header("User-Agent", concat!("zterm/", env!("CARGO_PKG_VERSION")))
            .header("Accept", "application/vnd.github+json")
            .call();
        let mut resp = match resp {
            Ok(r) => r,
            // 404: the repo has no published release yet — a state, not a failure.
            Err(ureq::Error::StatusCode(404)) => {
                return Ok(json!({
                    "current": env!("CARGO_PKG_VERSION"),
                    "latest": Value::Null,
                    "none": true,
                }));
            }
            Err(e) => return Err(format!("update check failed: {e}")),
        };
        let body: Value = resp
            .body_mut()
            .read_json()
            .map_err(|e| format!("update check: bad response json: {e}"))?;
        let tag = body
            .get("tag_name")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        if tag.is_empty() {
            return Err("update check: response missing tag_name".to_string());
        }
        let url = body
            .get("html_url")
            .and_then(|v| v.as_str())
            .unwrap_or("https://github.com/ZouDongj/ZTerm/releases")
            .to_string();
        let latest = tag.trim_start_matches(['v', 'V']).to_string();
        let newer = version_newer(env!("CARGO_PKG_VERSION"), &latest);
        // Installer reuse across restarts: when a verified setup exe for this
        // release is already in the download dir, report ready so the UI can
        // jump straight to "restart & install". A release without a usable
        // x64 asset still reports newer (manual download page remains).
        let info = if newer {
            newer_asset_info(&body)
        } else {
            NewerAssetInfo::default()
        };
        // Seed the state machine from the on-disk installer, otherwise
        // apply_update (which requires the Ready phase) would refuse the very
        // installer this ready flag advertises — the card would deadlock.
        seed_ready_from_check(&tag, &info);
        Ok(json!({
            "current": env!("CARGO_PKG_VERSION"),
            "latest": latest,
            "tag": tag,
            "url": url,
            "newer": newer,
            "asset_name": info.name,
            "asset_size": info.size,
            "ready": info.ready,
        }))
    })
    .await
    .map_err(|e| format!("update check task: {e}"))?
}

// ── In-app update download & apply ──
// Flow: check_update reports a newer release -> the user clicks download ->
// download_update streams the x64 NSIS setup exe to %TEMP%\zterm-update and
// verifies its sha256 against the GitHub asset digest -> apply_update launches
// it (passive /P /UPDATE /R) and exits so the installer can overwrite us.

/// Directory holding downloaded installers (survives an app restart, so a
/// previously verified installer can be reused without re-downloading).
fn update_download_dir() -> PathBuf {
    std::env::temp_dir().join("zterm-update")
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum UpdateDlPhase {
    Idle,
    Downloading,
    Ready,
    Failed,
}

#[derive(Debug, Clone)]
struct UpdateDlState {
    phase: UpdateDlPhase,
    tag: String,
    file_name: String,
    sha256: String,
    downloaded: u64,
    total: u64,
    error: String,
}

impl UpdateDlState {
    const fn idle() -> Self {
        UpdateDlState {
            phase: UpdateDlPhase::Idle,
            tag: String::new(),
            file_name: String::new(),
            sha256: String::new(),
            downloaded: 0,
            total: 0,
            error: String::new(),
        }
    }

    fn snapshot_json(&self) -> Value {
        let phase = match self.phase {
            UpdateDlPhase::Idle => "idle",
            UpdateDlPhase::Downloading => "downloading",
            UpdateDlPhase::Ready => "ready",
            UpdateDlPhase::Failed => "failed",
        };
        json!({
            "phase": phase,
            "tag": self.tag,
            "file_name": self.file_name,
            "downloaded": self.downloaded,
            "total": self.total,
            "error": self.error,
        })
    }
}

static UPDATE_DL: parking_lot::Mutex<UpdateDlState> =
    parking_lot::Mutex::new(UpdateDlState::idle());

/// Pick the unique Windows x64 NSIS setup asset from a GitHub release's
/// assets array. Returns (name, download_url, size, sha256_hex).
/// Errors when there is not exactly one candidate, the download URL is
/// missing, or GitHub did not provide a sha256 digest for the asset.
fn select_setup_asset(assets: &[Value]) -> Result<(String, String, u64, String), String> {
    let mut hits: Vec<&Value> = assets
        .iter()
        .filter(|a| {
            a.get("name")
                .and_then(|n| n.as_str())
                // Reject anything with path semantics: this name is joined
                // into the download dir and later spawned as the installer.
                .map(|n| {
                    n.starts_with("ZTerm_")
                        && n.ends_with("_x64-setup.exe")
                        && !n.contains(['/', '\\'])
                        && !n.contains("..")
                })
                .unwrap_or(false)
        })
        .collect();
    if hits.is_empty() {
        return Err("release has no ZTerm_*_x64-setup.exe asset".to_string());
    }
    if hits.len() > 1 {
        return Err(format!(
            "release has {} x64 setup assets, expected exactly one",
            hits.len()
        ));
    }
    let a = hits.pop().unwrap();
    let name = a
        .get("name")
        .and_then(|v| v.as_str())
        .unwrap()
        .to_string();
    let url = a
        .get("browser_download_url")
        .and_then(|v| v.as_str())
        .ok_or("setup asset missing browser_download_url")?
        .to_string();
    let size = a.get("size").and_then(|v| v.as_u64()).unwrap_or(0);
    let digest = a.get("digest").and_then(|v| v.as_str()).unwrap_or("");
    let sha = digest
        .strip_prefix("sha256:")
        .filter(|h| h.len() == 64 && h.chars().all(|c| c.is_ascii_hexdigit()))
        .ok_or("setup asset missing sha256 digest")?
        .to_string();
    Ok((name, url, size, sha))
}

/// Streaming SHA-256 of a file, lowercase hex.
fn file_sha256_hex(path: &std::path::Path) -> std::io::Result<String> {
    use sha2::Digest;
    let mut f = std::fs::File::open(path)?;
    let mut hasher = sha2::Sha256::new();
    let mut buf = [0u8; 64 * 1024];
    loop {
        let n = std::io::Read::read(&mut f, &mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hasher
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect())
}

/// When the installer for `asset_name` already sits in the download dir with
/// a sha256 matching the release digest, return its path. Lets check_update
/// offer "restart & install" directly after an app restart.
fn ready_installer_path(asset_name: &str, expected_sha256: &str) -> Option<PathBuf> {
    let p = update_download_dir().join(asset_name);
    if !p.is_file() {
        return None;
    }
    match file_sha256_hex(&p) {
        Ok(h) if h.eq_ignore_ascii_case(expected_sha256) => Some(p),
        _ => None,
    }
}

/// Outcome of inspecting a newer release's assets (see newer_asset_info).
#[derive(Debug, Default)]
struct NewerAssetInfo {
    name: Option<String>,
    size: Option<u64>,
    sha256: Option<String>,
    ready: bool,
}

/// Inspect a newer release's assets: pick the x64 installer and check whether
/// a hash-matching copy already sits in the download dir (downloaded on a
/// previous run). A release without a usable asset yields a default (empty)
/// info — the caller still reports newer so the manual page stays reachable.
fn newer_asset_info(body: &Value) -> NewerAssetInfo {
    let assets = match body.get("assets").and_then(|a| a.as_array()) {
        Some(a) => a,
        None => return NewerAssetInfo::default(),
    };
    match select_setup_asset(assets) {
        Ok((name, _url, size, sha)) => {
            let ready = ready_installer_path(&name, &sha).is_some();
            NewerAssetInfo {
                name: Some(name),
                size: Some(size),
                sha256: Some(sha),
                ready,
            }
        }
        Err(_) => NewerAssetInfo::default(),
    }
}

/// check_update found a verified installer already on disk: seed the download
/// state machine with Ready so apply_update can act on it directly (the
/// download step was completed on a previous run). Only seeds from Idle —
/// never clobbers an in-flight or finished download of this run.
fn seed_ready_from_check(tag: &str, info: &NewerAssetInfo) {
    if !info.ready {
        return;
    }
    let mut st = UPDATE_DL.lock();
    if st.phase != UpdateDlPhase::Idle {
        return;
    }
    st.phase = UpdateDlPhase::Ready;
    st.tag = tag.to_string();
    st.file_name = info.name.clone().unwrap_or_default();
    st.sha256 = info.sha256.clone().unwrap_or_default();
}

/// ureq agent for GitHub update traffic. Honors the proxy env vars
/// (ALL_PROXY/HTTPS_PROXY/HTTP_PROXY, either case, NO_PROXY respected) and,
/// via ureq's win-system-proxy feature, the Windows registry proxy
/// (ProxyEnable/ProxyServer; PAC and per-protocol entries are not read and
/// degrade to direct). No proxy configured → direct connection, unchanged.
fn update_http_agent(timeout_secs: u64) -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_global(Some(std::time::Duration::from_secs(timeout_secs)))
        // Bound any single stalled body read: timeout_global does not cover
        // manual into_reader() streaming, and a hang there would wedge the
        // download state machine until an app restart.
        .timeout_recv_body(Some(std::time::Duration::from_secs(30)))
        .proxy(ureq::Proxy::try_from_env())
        .build()
        .into()
}

/// Fetch the latest-release JSON from GitHub (shared by check/download).
fn fetch_latest_release() -> Result<Value, String> {
    let agent = update_http_agent(10);
    let resp = agent
        .get(RELEASES_LATEST_URL)
        .header("User-Agent", concat!("zterm/", env!("CARGO_PKG_VERSION")))
        .header("Accept", "application/vnd.github+json")
        .call();
    let mut resp = resp.map_err(|e| format!("update: release query failed: {e}"))?;
    resp.body_mut()
        .read_json()
        .map_err(|e| format!("update: bad release json: {e}"))
}

/// Stream the installer to <name>.part, verify sha256, rename to final.
/// Progress is written into UPDATE_DL as (downloaded, total).
fn download_setup_exe(url: &str, name: &str, size_hint: u64, sha256: &str) -> Result<(), String> {
    let dir = update_download_dir();
    std::fs::create_dir_all(&dir).map_err(|e| format!("update: create download dir: {e}"))?;
    // Keep the dir single-version: drop installers and partials of any
    // version, INCLUDING the current target — we are re-downloading it, and
    // a leftover final file would make fs::rename fail on Windows.
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let fname = entry.file_name().to_string_lossy().to_string();
            let is_setup = fname.starts_with("ZTerm_") && fname.contains("_x64-setup.exe");
            if is_setup {
                let _ = std::fs::remove_file(entry.path());
            }
        }
    }
    let part = dir.join(format!("{name}.part"));
    let _ = std::fs::remove_file(&part);
    let final_path = dir.join(name);

    let agent = update_http_agent(300);
    let resp = agent
        .get(url)
        .header("User-Agent", concat!("zterm/", env!("CARGO_PKG_VERSION")))
        .call()
        .map_err(|e| format!("update: download failed: {e}"))?;
    let total = resp
        .headers()
        .get("content-length")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.parse::<u64>().ok())
        .unwrap_or(size_hint);
    {
        let mut st = UPDATE_DL.lock();
        st.total = total;
        st.downloaded = 0;
    }
    let mut reader = resp.into_body().into_reader();
    let mut file = std::fs::File::create(&part)
        .map_err(|e| format!("update: create temp file: {e}"))?;
    let mut buf = [0u8; 64 * 1024];
    let mut downloaded: u64 = 0;
    let io_result: std::io::Result<()> = (|| {
        use std::io::{Read, Write};
        loop {
            let n = reader.read(&mut buf)?;
            if n == 0 {
                break;
            }
            file.write_all(&buf[..n])?;
            downloaded += n as u64;
            UPDATE_DL.lock().downloaded = downloaded;
        }
        Ok(())
    })();
    if let Err(e) = io_result {
        let _ = std::fs::remove_file(&part);
        return Err(format!("update: download interrupted: {e}"));
    }
    drop(file);

    let hex = file_sha256_hex(&part).map_err(|e| format!("update: hash temp file: {e}"))?;
    if !hex.eq_ignore_ascii_case(sha256) {
        let _ = std::fs::remove_file(&part);
        return Err("update: installer sha256 mismatch, file discarded".to_string());
    }
    std::fs::rename(&part, &final_path).map_err(|e| format!("update: finalize file: {e}"))?;
    Ok(())
}

#[tauri::command]
pub async fn download_update(args: Vec<Value>) -> Result<Value, String> {
    let params = args.into_iter().next().unwrap_or(json!({}));
    let want_tag = params
        .get("tag")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    {
        let mut st = UPDATE_DL.lock();
        let short_circuit = match st.phase {
            UpdateDlPhase::Downloading => {
                return Err("update download already in progress".to_string())
            }
            // Same-tag installer already verified: nothing to do — but only
            // while the file is actually still there and intact. A vanished
            // or tampered file falls through and is downloaded again,
            // otherwise the card would deadlock on a phantom Ready.
            UpdateDlPhase::Ready if st.tag == want_tag => {
                let path = update_download_dir().join(&st.file_name);
                file_sha256_hex(&path)
                    .map(|h| h.eq_ignore_ascii_case(&st.sha256))
                    .unwrap_or(false)
            }
            _ => false,
        };
        if short_circuit {
            return Ok(st.snapshot_json());
        }
        // Transition to Downloading while still holding the lock: a
        // concurrent call must be rejected before we release it —
        // otherwise both pass the check and double-download.
        *st = UpdateDlState::idle();
        st.phase = UpdateDlPhase::Downloading;
        st.tag = want_tag.clone();
    }
    tokio::task::spawn_blocking(move || {
        // Re-fetch the release JSON and select the asset here instead of
        // trusting URLs/digests passed from the renderer.
        let work = || -> Result<(), String> {
            let body = fetch_latest_release()?;
            let tag = body
                .get("tag_name")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            if tag.is_empty() {
                return Err("update: release response missing tag_name".to_string());
            }
            if !want_tag.is_empty() && tag != want_tag {
                return Err(format!("update: release changed ({tag} != {want_tag}), re-check first"));
            }
            let assets = body
                .get("assets")
                .and_then(|a| a.as_array())
                .ok_or("update: release response missing assets")?;
            let (name, url, size, sha) = select_setup_asset(assets)?;
            {
                let mut st = UPDATE_DL.lock();
                st.tag = tag.clone();
                st.file_name = name.clone();
                st.sha256 = sha.clone();
            }
            download_setup_exe(&url, &name, size, &sha)
        };
        // Evaluate work() BEFORE taking the lock: work() acquires UPDATE_DL
        // itself for progress updates — locking first would self-deadlock.
        let result = work();
        let mut st = UPDATE_DL.lock();
        match result {
            Ok(()) => {
                st.phase = UpdateDlPhase::Ready;
                Ok(st.snapshot_json())
            }
            // Any failure lands in Failed so the UI offers a retry button.
            Err(e) => {
                st.phase = UpdateDlPhase::Failed;
                st.error = e.clone();
                st.downloaded = 0;
                Err(e)
            }
        }
    })
    .await
    .map_err(|e| format!("update download task: {e}"))?
}

#[tauri::command]
pub fn update_download_state(args: Vec<Value>) -> Value {
    let _ = args;
    UPDATE_DL.lock().snapshot_json()
}

#[tauri::command]
pub fn apply_update(args: Vec<Value>) -> Result<Value, String> {
    let params = args.into_iter().next().unwrap_or(json!({}));
    let dry_run = params
        .get("dry_run")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let st = UPDATE_DL.lock();
    if st.phase != UpdateDlPhase::Ready {
        return Err("apply-update: no verified update ready".to_string());
    }
    let path = update_download_dir().join(&st.file_name);
    let sha = st.sha256.clone();
    let tag = st.tag.clone();
    drop(st);
    if !path.is_file() {
        return Err("apply-update: installer file missing, download again".to_string());
    }
    // Re-verify before handing the file to the user account's installer:
    // the bytes on disk must still be the ones we validated at download time.
    let hex = file_sha256_hex(&path).map_err(|e| format!("apply-update: hash installer: {e}"))?;
    if !hex.eq_ignore_ascii_case(&sha) {
        return Err("apply-update: installer sha256 changed, download again".to_string());
    }
    let cmdline = format!("\"{}\" /P /UPDATE /R", path.display());
    if dry_run {
        return Ok(json!({
            "ok": true,
            "dry_run": true,
            "tag": tag,
            "cmdline": cmdline,
        }));
    }
    std::process::Command::new(&path)
        .args(["/P", "/UPDATE", "/R"])
        .spawn()
        .map_err(|e| format!("apply-update: failed to launch installer: {e}"))?;
    // Let the installer come up before we vanish; NSIS CheckIfAppIsRunning
    // would kill us anyway, exiting here is just the clean path.
    std::thread::sleep(std::time::Duration::from_millis(300));
    std::process::exit(0);
}

// ADR-0003: pure validation for URLs the renderer asks us to open with the OS
// shell. Every rejection carries a stable category prefix (invalidUrl /
// blockedProtocol) the UI can key on; OS-level failures are osOpenFailed.
fn validate_open_url(raw: &str) -> Result<tauri::Url, &'static str> {
    if raw.is_empty() {
        return Err("invalidUrl: empty");
    }
    if raw.chars().count() > 4096 {
        return Err("invalidUrl: too long");
    }
    if raw.chars().any(|c| (c as u32) < 0x20 || c as u32 == 0x7F) {
        return Err("invalidUrl: control character");
    }
    let url = tauri::Url::parse(raw).map_err(|_| "invalidUrl: unparseable")?;
    match url.scheme() {
        "http" | "https" => {}
        _ => return Err("blockedProtocol"),
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("invalidUrl: userinfo not allowed");
    }
    if url.host_str().map_or(true, |h| h.is_empty()) {
        return Err("invalidUrl: empty host");
    }
    // Percent-encoded C0/DEL anywhere would decode into raw control bytes
    // downstream. Scan every %XX triplet (case-insensitive via uppercase) and
    // reject values < 0x20 or == 0x7F; a literal "%2500" (double-encoded) is
    // %25 = '%' and passes as harmless text.
    fn hex_val(b: u8) -> Option<u8> {
        match b {
            b'0'..=b'9' => Some(b - b'0'),
            b'A'..=b'F' => Some(b - b'A' + 10),
            _ => None,
        }
    }
    let upper = raw.to_ascii_uppercase();
    let bytes = upper.as_bytes();
    let mut i = 0;
    while i + 2 < bytes.len() {
        if bytes[i] == b'%' {
            if let (Some(h), Some(l)) = (hex_val(bytes[i + 1]), hex_val(bytes[i + 2])) {
                let v = h * 16 + l;
                if v < 0x20 || v == 0x7F {
                    return Err("invalidUrl: encoded control character");
                }
            }
        }
        i += 1;
    }
    Ok(url)
}

#[cfg(windows)]
fn shell_execute_open(target: &str) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use winapi::um::shellapi::ShellExecuteW;
    use winapi::um::winuser::SW_SHOWNORMAL;
    let wide = |s: &str| -> Vec<u16> {
        std::ffi::OsStr::new(s).encode_wide().chain(Some(0)).collect()
    };
    let verb = wide("open");
    let file = wide(target);
    // "open" verb with a NULL parameters field: the URL is the document
    // itself, no shell argument parsing is involved (unlike cmd /c start).
    let ret = unsafe {
        ShellExecuteW(
            std::ptr::null_mut(),
            verb.as_ptr(),
            file.as_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            SW_SHOWNORMAL,
        )
    };
    // MSDN: the HINSTANCE return is a success indicator when > 32, otherwise
    // it is one of the SE_ERR_* codes.
    if (ret as isize) > 32 {
        Ok(())
    } else {
        Err(format!("osOpenFailed: ShellExecuteW code {}", ret as isize))
    }
}

#[cfg(not(windows))]
fn shell_execute_open(_target: &str) -> Result<(), String> {
    Err("osOpenFailed: unsupported platform".to_string())
}

// Testable core of the open-url command: validation always precedes dispatch,
// so a rejected target never reaches the OS and an accepted one is dispatched
// exactly once, in its normalized form. Tests inject a counting dispatcher.
fn validate_then_dispatch(
    raw: &str,
    dispatch: impl FnOnce(&str) -> Result<(), String>,
) -> Result<(), String> {
    let url = validate_open_url(raw).map_err(|e| format!("open-url: {e}"))?;
    dispatch(url.as_str()).map_err(|e| format!("open-url: {e}"))
}

#[tauri::command]
pub fn open_url(args: Vec<Value>) -> Result<Value, String> {
    let params = args.into_iter().next().unwrap_or(json!({}));
    let raw = params
        .get("url")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    validate_then_dispatch(&raw, shell_execute_open)?;
    Ok(json!({ "ok": true }))
}


#[tauri::command]
pub fn get_system_fonts(args: Vec<Value>) -> Result<Value, String> {
    let _ = args;
    // 用 Win32 EnumFontFamiliesExW 枚举系统字体，避免 spawn 控制台子进程
    // （GUI 进程 spawn powershell 会触发系统默认终端激活，弹出 Windows Terminal）
    let fonts = filter_system_fonts(enumerate_system_fonts());
    if fonts.is_empty() {
        return Ok(json!([
            "JetBrains Mono",
            "Cascadia Code",
            "Consolas",
            "Courier New",
            "Fira Code",
            "Source Code Pro",
        ]));
    }
    Ok(Value::Array(fonts.into_iter().map(|s| json!(s)).collect()))
}

// 过滤系统字体列表：排除 "@" 竖排变体（@宋体 等 Windows 垂直书写字体）
// 和系统保留字体（System/Terminal/Fixedsys 等），避免污染字体下拉列表
fn filter_system_fonts(fonts: Vec<String>) -> Vec<String> {
    fonts
        .into_iter()
        .filter(|f| !f.starts_with('@'))
        .filter(|f| {
            !matches!(
                f.as_str(),
                "System" | "Terminal" | "Fixedsys" | "MS Sans Serif" | "MS Serif"
            )
        })
        .collect()
}

fn enumerate_system_fonts() -> Vec<String> {
    unsafe {
        use winapi::shared::minwindef::{DWORD, LPARAM};
        use winapi::um::wingdi::{
            EnumFontFamiliesExW, FONTENUMPROCW, LF_FACESIZE, LOGFONTW, TEXTMETRICW,
        };
        use winapi::um::winuser::{GetDC, ReleaseDC};

        let mut fonts: Vec<String> = Vec::new();
        let hdc = GetDC(std::ptr::null_mut());
        if hdc.is_null() {
            return fonts;
        }
        let mut lf: LOGFONTW = std::mem::zeroed();
        lf.lfCharSet = 1; // DEFAULT_CHARSET
        unsafe extern "system" fn enum_proc(
            lplf: *const LOGFONTW,
            _lptm: *const TEXTMETRICW,
            _font_type: DWORD,
            lparam: LPARAM,
        ) -> i32 {
            let fonts = &mut *(lparam as *mut Vec<String>);
            let face = (*lplf).lfFaceName;
            let mut len = 0usize;
            while len < LF_FACESIZE && face[len] != 0 {
                len += 1;
            }
            if len > 0 {
                let name = String::from_utf16_lossy(&face[..len]);
                if !fonts.contains(&name) {
                    fonts.push(name);
                }
            }
            1
        }
        let proc: FONTENUMPROCW = Some(enum_proc);
        EnumFontFamiliesExW(
            hdc,
            &mut lf,
            proc,
            &mut fonts as *mut Vec<String> as LPARAM,
            0,
        );
        ReleaseDC(std::ptr::null_mut(), hdc);
        fonts
    }
}

// ── Credential management ──

fn base64_decode_raw(s: &str) -> Vec<u8> {
    let mut result = Vec::new();
    let bytes = s.as_bytes();
    let mut buffer = 0u32;
    let mut bits = 0;
    for &b in bytes {
        if b == b'=' {
            break;
        }
        let val = match b {
            b'A'..=b'Z' => b - b'A',
            b'a'..=b'z' => b - b'a' + 26,
            b'0'..=b'9' => b - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            _ => continue,
        } as u32;
        buffer = (buffer << 6) | val;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            result.push((buffer >> bits) as u8);
            buffer &= (1 << bits) - 1;
        }
    }
    result
}

fn base64_encode_bytes(data: &[u8]) -> String {
    const CHARS: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut result = String::new();
    for chunk in data.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = if chunk.len() > 1 { chunk[1] as u32 } else { 0 };
        let b2 = if chunk.len() > 2 { chunk[2] as u32 } else { 0 };
        let n = (b0 << 16) | (b1 << 8) | b2;
        result.push(CHARS[((n >> 18) & 63) as usize] as char);
        result.push(CHARS[((n >> 12) & 63) as usize] as char);
        if chunk.len() > 1 {
            result.push(CHARS[((n >> 6) & 63) as usize] as char);
        } else {
            result.push('=');
        }
        if chunk.len() > 2 {
            result.push(CHARS[(n & 63) as usize] as char);
        } else {
            result.push('=');
        }
    }
    result
}

// ── DPAPI password encryption (对齐 Electron safeStorage) ──

fn dpapi_encrypt(plaintext: &str) -> Result<Vec<u8>, String> {
    unsafe {
        use winapi::um::dpapi::{CryptProtectData, CRYPTPROTECT_UI_FORBIDDEN};
        use winapi::um::wincrypt::DATA_BLOB;
        let bytes = plaintext.as_bytes();
        let mut in_blob = DATA_BLOB {
            cbData: bytes.len() as u32,
            pbData: bytes.as_ptr() as *mut u8,
        };
        let mut out_blob = DATA_BLOB {
            cbData: 0,
            pbData: std::ptr::null_mut(),
        };
        if CryptProtectData(
            &mut in_blob,
            std::ptr::null(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut out_blob,
        ) == 0
        {
            return Err(format!(
                "CryptProtectData failed: {}",
                std::io::Error::last_os_error()
            ));
        }
        let out = std::slice::from_raw_parts(out_blob.pbData, out_blob.cbData as usize).to_vec();
        winapi::um::winbase::LocalFree(out_blob.pbData as *mut _);
        Ok(out)
    }
}

fn dpapi_decrypt(data: &[u8]) -> Result<Vec<u8>, String> {
    unsafe {
        use winapi::um::dpapi::{CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN};
        use winapi::um::wincrypt::DATA_BLOB;
        let mut in_blob = DATA_BLOB {
            cbData: data.len() as u32,
            pbData: data.as_ptr() as *mut u8,
        };
        let mut out_blob = DATA_BLOB {
            cbData: 0,
            pbData: std::ptr::null_mut(),
        };
        if CryptUnprotectData(
            &mut in_blob,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut out_blob,
        ) == 0
        {
            return Err(format!(
                "CryptUnprotectData failed: {}",
                std::io::Error::last_os_error()
            ));
        }
        let out = std::slice::from_raw_parts(out_blob.pbData, out_blob.cbData as usize).to_vec();
        winapi::um::winbase::LocalFree(out_blob.pbData as *mut _);
        Ok(out)
    }
}

// ── Electron safeStorage (OSCrypt) 兼容 ──
// Electron 的 safeStorage 在 Windows 上使用 Chromium OSCrypt：
// 输出 = "v10"/"v11" 3 字节版本头 + nonce(12) + AES-256-GCM 密文；
// AES 密钥由 DPAPI 加密后存在 Electron userData 的 Local State
// （os_crypt.encrypted_key = base64("DPAPI" + DPAPI 密文)）。

// AES-256-GCM 解密 payload（nonce 12 字节 + 密文，AAD 为空）
fn aes_gcm_decrypt_payload(key: &[u8], payload: &[u8]) -> Option<Vec<u8>> {
    use aes_gcm::aead::{Aead, KeyInit};
    if key.len() != 32 || payload.len() < 12 + 16 {
        return None;
    }
    let cipher = aes_gcm::Aes256Gcm::new_from_slice(key).ok()?;
    cipher
        .decrypt(aes_gcm::Nonce::from_slice(&payload[..12]), &payload[12..])
        .ok()
}

// 读取 Electron Local State 中的 OSCrypt AES key（DPAPI 解密）
fn load_oscrypt_key() -> Option<Vec<u8>> {
    let appdata = std::env::var("APPDATA").ok()?;
    let path = std::path::Path::new(&appdata)
        .join("ZTerm")
        .join("Local State");
    let content = std::fs::read_to_string(path).ok()?;
    let v: Value = serde_json::from_str(&content).ok()?;
    let enc = v.get("os_crypt")?.get("encrypted_key")?.as_str()?;
    let all = base64_decode_raw(enc);
    // 前 5 字节是 "DPAPI" 标记，其余为 DPAPI 加密的 AES key
    if all.len() < 6 || &all[..5] != b"DPAPI" {
        return None;
    }
    dpapi_decrypt(&all[5..]).ok()
}

// Electron OSCrypt blob 解密（v10/v11 头 + nonce + AES-GCM）
fn electron_oscrypt_decrypt(blob: &[u8]) -> Option<String> {
    let key = load_oscrypt_key()?;
    let plain = aes_gcm_decrypt_payload(&key, &blob[3..])?;
    Some(String::from_utf8_lossy(&plain).to_string())
}

// 解密已加密的密码值，兼容三种格式：
// 1) "dpapi:<b64>" — Tauri 当前格式（DPAPI 加密）
// 2) Electron safeStorage（Windows = OSCrypt）："v10"/"v11" 头 + nonce + AES-GCM
//    —— 老 Electron 用户升级后 config 里保存的密码（纯 base64，无前缀）
// 3) 早期 Tauri 的明文 base64（"tauri:" 前缀或无前缀）
fn decrypt_password_value(value: &str) -> Option<String> {
    if let Some(rest) = value.strip_prefix("dpapi:") {
        return dpapi_decrypt(&base64_decode_raw(rest))
            .ok()
            .map(|plain| String::from_utf8_lossy(&plain).to_string());
    }
    let rest = value.strip_prefix("tauri:").unwrap_or(value);
    let bytes = base64_decode_raw(rest);
    // Electron OSCrypt 格式探测：3 字节版本头 "v10"/"v11"
    if bytes.len() >= 3 && (&bytes[0..3] == b"v10" || &bytes[0..3] == b"v11") {
        // 优先 AES-GCM（Local State key）；失败回退剥头 DPAPI（部分实现/早期变体）。
        // 两者都失败不降级为明文——带版本头说明是密文，降级只会把乱码当密码
        if let Some(plain) = electron_oscrypt_decrypt(&bytes) {
            return Some(plain);
        }
        return dpapi_decrypt(&bytes[3..])
            .ok()
            .map(|plain| String::from_utf8_lossy(&plain).to_string());
    }
    // 无版本头：先试纯 DPAPI（Electron 早期 safeStorage 直接 DPAPI），
    // 失败回退明文（早期 Tauri 的明文 base64）
    if let Ok(plain) = dpapi_decrypt(&bytes) {
        return Some(String::from_utf8_lossy(&plain).to_string());
    }
    Some(String::from_utf8_lossy(&bytes).to_string())
}

#[tauri::command]
pub fn encrypt_password(app: AppHandle, args: Vec<Value>) -> Result<Value, String> {
    let params = args.into_iter().next().unwrap_or(json!({}));
    let plaintext = params
        .get("plaintext")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    // DPAPI 加密 (对齐 Electron safeStorage), 输出 "dpapi:<base64>"
    let encrypted = match dpapi_encrypt(plaintext) {
        Ok(cipher) => format!("dpapi:{}", base64_encode_bytes(&cipher)),
        Err(e) => return Err(format!("Password encryption failed: {e}")),
    };
    // emit 事件（兼容 ssh.js 里 saveSSHEdit 的 once 监听）
    let _ = app.emit("encrypt-password-result", json!({ "encrypted": encrypted }));
    // 返回值供 invoke 直接读取
    Ok(json!({ "encrypted": encrypted }))
}

#[tauri::command]
pub fn register_credential(
    cred_state: State<'_, CredentialStore>,
    args: Vec<Value>,
) -> Result<Value, String> {
    let params = args.into_iter().next().unwrap_or(json!({}));
    let encrypted_pwd = params
        .get("encryptedPassword")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let key_path = params
        .get("privateKeyPath")
        .and_then(|v| v.as_str())
        .unwrap_or("");

    static CRED_COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
    let cred_id = format!(
        "cred_{}",
        CRED_COUNTER.fetch_add(1, std::sync::atomic::Ordering::SeqCst)
    );

    let password = if !encrypted_pwd.is_empty() {
        decrypt_password_value(&encrypted_pwd)
    } else {
        None
    };
    let private_key_path = if !key_path.is_empty() {
        Some(key_path.to_string())
    } else {
        None
    };

    {
        let mut store = cred_state.lock();
        store.insert(
            cred_id.clone(),
            Credential {
                password,
                private_key_path,
            },
        );
    }

    Ok(json!({ "credId": cred_id }))
}

#[tauri::command]
pub fn revoke_credential(
    cred_state: State<'_, CredentialStore>,
    args: Vec<Value>,
) -> Result<Value, String> {
    let params = args.into_iter().next().unwrap_or(json!({}));
    let cred_id = params.get("credId").and_then(|v| v.as_str()).unwrap_or("");
    let mut store = cred_state.lock();
    store.remove(cred_id);
    Ok(json!({ "ok": true }))
}

// ── SFTP commands ──

fn find_sftp(tab_id: &str, state: &SessionMap) -> Option<Arc<russh_sftp::client::SftpSession>> {
    let map = state.lock();
    match map.get(tab_id) {
        Some(SessionType::Ssh(s)) => s.sftp.clone(),
        _ => None,
    }
}

fn find_sftp_transfer(
    tab_id: &str,
    state: &SessionMap,
) -> Option<(
    Arc<russh_sftp::client::SftpSession>,
    Arc<Mutex<HashMap<String, Arc<std::sync::atomic::AtomicBool>>>>,
)> {
    let map = state.lock();
    match map.get(tab_id) {
        Some(SessionType::Ssh(s)) => Some((s.sftp_transfer.clone()?, s.transfer_cancels.clone())),
        _ => None,
    }
}

#[tauri::command]
pub async fn sftp_open(state: State<'_, SessionMap>, args: Vec<Value>) -> Result<Value, String> {
    let params = args.into_iter().next().unwrap_or(json!({}));
    let tab_id = params.get("tabId").and_then(|v| v.as_str()).unwrap_or("");
    // 初始路径：优先 SSH 会话已跟踪的 cwd（OSC 7），否则 home 目录
    let tracked_cwd = {
        let map = state.lock();
        match map.get(tab_id) {
            Some(SessionType::Ssh(s)) => s.cwd.lock().clone(),
            _ => None,
        }
    };
    let sftp = find_sftp(tab_id, &state).ok_or("SFTP not available")?;
    let path = match tracked_cwd {
        Some(c) if !c.is_empty() => c,
        _ => sftp.canonicalize(".").await.unwrap_or_else(|_| "/".into()),
    };
    match sftp.read_dir(&path).await {
        Ok(entries) => {
            let mut files: Vec<Value> = Vec::new();
            for e in entries {
                let name = e.file_name();
                let meta = e.metadata();
                let mtime = meta
                    .modified()
                    .ok()
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_secs())
                    .unwrap_or(0);
                files.push(json!({
                    "name": name,
                    "isDir": e.file_type().is_dir(),
                    "isLink": e.file_type().is_symlink(),
                    "size": meta.len(),
                    "mtime": mtime,
                    "mode": 0,
                }));
            }
            Ok(json!({ "path": path, "files": files }))
        }
        Err(e) => Ok(json!({ "error": format!("{e}") })),
    }
}

#[tauri::command]
pub async fn sftp_readdir(state: State<'_, SessionMap>, args: Vec<Value>) -> Result<Value, String> {
    let params = args.into_iter().next().unwrap_or(json!({}));
    let tab_id = params.get("tabId").and_then(|v| v.as_str()).unwrap_or("");
    let path = params.get("path").and_then(|v| v.as_str()).unwrap_or(".");
    let sftp = find_sftp(tab_id, &state).ok_or("SFTP not available")?;
    match sftp.read_dir(path).await {
        Ok(entries) => {
            let mut files: Vec<Value> = Vec::new();
            for e in entries {
                let name = e.file_name();
                let meta = e.metadata();
                let mtime = meta
                    .modified()
                    .ok()
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_secs())
                    .unwrap_or(0);
                files.push(json!({
                    "name": name,
                    "isDir": e.file_type().is_dir(),
                    "isLink": e.file_type().is_symlink(),
                    "size": meta.len(),
                    "mtime": mtime,
                    "mode": 0,
                }));
            }
            Ok(json!({ "files": files }))
        }
        Err(e) => Ok(json!({ "error": format!("{e}") })),
    }
}

#[tauri::command]
pub async fn sftp_mkdir(state: State<'_, SessionMap>, args: Vec<Value>) -> Result<Value, String> {
    let params = args.into_iter().next().unwrap_or(json!({}));
    let tab_id = params.get("tabId").and_then(|v| v.as_str()).unwrap_or("");
    let path = params
        .get("path")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if path.is_empty() {
        return Ok(json!({ "error": "missing path" }));
    }
    let sftp = find_sftp(tab_id, &state).ok_or("SFTP not available")?;
    match sftp.create_dir(path).await {
        Ok(_) => Ok(json!({ "ok": true })),
        Err(e) => Ok(json!({ "error": format!("{e}") })),
    }
}

#[tauri::command]
pub async fn sftp_download(
    app: AppHandle,
    state: State<'_, SessionMap>,
    args: Vec<Value>,
) -> Result<Value, String> {
    let params = args.into_iter().next().unwrap_or(json!({}));
    let tab_id = params.get("tabId").and_then(|v| v.as_str()).unwrap_or("");
    let remote_path = params
        .get("remotePath")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let local_path = params
        .get("localPath")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let transfer_id_num: u64 = params
        .get("transferId")
        .and_then(|v| v.as_u64())
        .unwrap_or(0);
    let transfer_id_key = transfer_id_num.to_string();

    let (sftp, cancels) =
        find_sftp_transfer(tab_id, &state).ok_or("SFTP transfer not available")?;
    let cancelled = Arc::new(std::sync::atomic::AtomicBool::new(false));
    {
        let mut c = cancels.lock();
        c.insert(transfer_id_key.clone(), cancelled.clone());
    }

    // 初始化（打开远端/本地文件）失败时清理 cancel registry（M1），
    // 避免长期运行后残留失效条目
    let init_result: Result<_, String> = async {
        use russh_sftp::protocol::OpenFlags;
        let file = sftp
            .open_with_flags(remote_path, OpenFlags::READ)
            .await
            .map_err(|e| format!("open: {e}"))?;
        let metadata = file
            .metadata()
            .await
            .map_err(|e| format!("metadata: {e}"))?;
        // L3：先写本地临时文件，成功后 rename——取消/失败时删除临时文件，
        // 不再残留半截文件冒充完整文件
        let tmp_local = format!("{}.zterm-tmp-{}", local_path, transfer_id_num);
        let local = tokio::fs::File::create(&tmp_local)
            .await
            .map_err(|e| format!("create: {e}"))?;
        Ok::<_, String>((file, metadata, tmp_local, local))
    }
    .await;
    let (mut file, metadata, tmp_local, mut local) = match init_result {
        Ok(v) => v,
        Err(e) => {
            cancels.lock().remove(&transfer_id_key);
            return Ok(json!({ "error": e }));
        }
    };
    let total = metadata.len();

    let (done_tx, done_rx) = tokio::sync::oneshot::channel();
    let app2 = app.clone();
    let tid = tab_id.to_string();
    let tid_num = transfer_id_num; // number for JSON event
    let key = transfer_id_key.clone();
    let cancels3 = cancels.clone();
    let local_final = local_path.to_string(); // 'static，供 rename
    tokio::spawn(async move {
        let result = async {
            let mut buf = vec![0u8; 262144];
            let mut transferred: u64 = 0;
            loop {
                if cancelled.load(std::sync::atomic::Ordering::Relaxed) {
                    return Err("Transfer cancelled".to_string());
                }
                use tokio::io::AsyncReadExt;
                let n = file
                    .read(&mut buf)
                    .await
                    .map_err(|e| format!("read: {e}"))?;
                if n == 0 {
                    break;
                }
                use tokio::io::AsyncWriteExt;
                local
                    .write_all(&buf[..n])
                    .await
                    .map_err(|e| format!("write: {e}"))?;
                transferred += n as u64;
                let _ = app2.emit(
                    "sftp-progress",
                    json!({
                        "tabId": tid, "transferId": tid_num,
                        "transferred": transferred, "total": total
                    }),
                );
            }
            // 成功后原子落位
            local.sync_all().await.map_err(|e| format!("sync: {e}"))?;
            drop(local);
            tokio::fs::rename(&tmp_local, &local_final)
                .await
                .map_err(|e| format!("rename: {e}"))?;
            Ok::<_, String>(total)
        }
        .await;
        // 失败/取消：清理临时文件
        if result.is_err() {
            let _ = tokio::fs::remove_file(&tmp_local).await;
        }
        let _ = done_tx.send(result);
        {
            let mut c = cancels3.lock();
            c.remove(&key);
        }
    });

    let result = done_rx.await.unwrap_or(Err("Transfer failed".to_string()));
    match result {
        Ok(total) => Ok(json!({ "ok": true, "total": total })),
        Err(e) => Ok(json!({ "error": e })),
    }
}

#[tauri::command]
pub async fn sftp_upload(
    app: AppHandle,
    state: State<'_, SessionMap>,
    args: Vec<Value>,
) -> Result<Value, String> {
    let params = args.into_iter().next().unwrap_or(json!({}));
    let tab_id = params.get("tabId").and_then(|v| v.as_str()).unwrap_or("");
    let local_path = params
        .get("localPath")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let remote_path = params
        .get("remotePath")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let transfer_id_num: u64 = params
        .get("transferId")
        .and_then(|v| v.as_u64())
        .unwrap_or(0);
    let transfer_id_key = transfer_id_num.to_string();

    let (sftp, cancels) =
        find_sftp_transfer(tab_id, &state).ok_or("SFTP transfer not available")?;
    let cancelled = Arc::new(std::sync::atomic::AtomicBool::new(false));
    {
        let mut c = cancels.lock();
        c.insert(transfer_id_key.clone(), cancelled.clone());
    }

    // 初始化失败时清理 cancel registry（M1）
    let init_result: Result<_, String> = async {
        use russh_sftp::protocol::OpenFlags;
        // 拦截本地目录（拖拽上传时前端只做同步判断，这里兜底，Electron 端行为一致）
        let local_meta = tokio::fs::metadata(local_path)
            .await
            .map_err(|e| format!("stat: {e}"))?;
        if local_meta.is_dir() {
            return Err("暂不支持上传文件夹".to_string());
        }
        // L3：先写远端临时文件，成功后 rename——取消/失败时删除远端临时文件，
        // 不再残留半截文件（也避免 TRUNCATE 直接破坏已存在的同名文件）
        let tmp_remote = format!("{}.zterm-tmp-{}", remote_path, transfer_id_num);
        let file = sftp
            .open_with_flags(
                &tmp_remote,
                OpenFlags::CREATE | OpenFlags::TRUNCATE | OpenFlags::WRITE,
            )
            .await
            .map_err(|e| format!("open: {e}"))?;
        let local = tokio::fs::File::open(local_path)
            .await
            .map_err(|e| format!("open: {e}"))?;
        Ok::<_, String>((local_meta, tmp_remote, file, local))
    }
    .await;
    let (local_meta, tmp_remote, mut file, mut local) = match init_result {
        Ok(v) => v,
        Err(e) => {
            cancels.lock().remove(&transfer_id_key);
            return Ok(json!({ "error": e }));
        }
    };
    let total = local_meta.len();

    let (done_tx, done_rx) = tokio::sync::oneshot::channel();
    let app2 = app.clone();
    let tid = tab_id.to_string();
    let tid_num = transfer_id_num;
    let key = transfer_id_key.clone();
    let cancels3 = cancels.clone();
    let sftp2 = sftp.clone();
    let remote_final = remote_path.to_string(); // 'static，供 rename
    tokio::spawn(async move {
        let result = async {
            let mut buf = vec![0u8; 262144];
            let mut transferred: u64 = 0;
            loop {
                if cancelled.load(std::sync::atomic::Ordering::Relaxed) {
                    return Err("Transfer cancelled".to_string());
                }
                use tokio::io::{AsyncReadExt, AsyncWriteExt};
                let n = local
                    .read(&mut buf)
                    .await
                    .map_err(|e| format!("read: {e}"))?;
                if n == 0 {
                    break;
                }
                file.write_all(&buf[..n])
                    .await
                    .map_err(|e| format!("write: {e}"))?;
                transferred += n as u64;
                let _ = app2.emit(
                    "sftp-progress",
                    json!({
                        "tabId": tid, "transferId": tid_num,
                        "transferred": transferred, "total": total
                    }),
                );
            }
            file.sync_all().await.map_err(|e| format!("sync: {e}"))?;
            drop(file);
            // 成功后原子落位
            sftp2
                .rename(&tmp_remote, &remote_final)
                .await
                .map_err(|e| format!("rename: {e}"))?;
            Ok::<_, String>(total)
        }
        .await;
        // 失败/取消：清理远端临时文件
        if result.is_err() {
            let _ = sftp2.remove_file(&tmp_remote).await;
        }
        let _ = done_tx.send(result);
        {
            let mut c = cancels3.lock();
            c.remove(&key);
        }
    });

    let result = done_rx.await.unwrap_or(Err("Transfer failed".to_string()));
    match result {
        Ok(total) => Ok(json!({ "ok": true, "total": total })),
        Err(e) => Ok(json!({ "error": e })),
    }
}

#[tauri::command]
pub fn sftp_cancel_transfer(
    state: State<'_, SessionMap>,
    args: Vec<Value>,
) -> Result<Value, String> {
    let params = args.into_iter().next().unwrap_or(json!({}));
    let tab_id = params.get("tabId").and_then(|v| v.as_str()).unwrap_or("");
    let transfer_id_num: u64 = params
        .get("transferId")
        .and_then(|v| v.as_u64())
        .unwrap_or(0);
    let transfer_id_str = transfer_id_num.to_string();
    let transfer_id = transfer_id_str; // for HashMap key
    let map = state.lock();
    if let Some(SessionType::Ssh(s)) = map.get(tab_id) {
        let cancels = s.transfer_cancels.lock();
        if let Some(c) = cancels.get(&transfer_id) {
            c.store(true, std::sync::atomic::Ordering::Relaxed);
        }
    }
    Ok(json!({ "ok": true }))
}

#[tauri::command]
pub fn open_in_explorer(args: Vec<Value>) -> Result<Value, String> {
    let params = args.into_iter().next().unwrap_or(json!({}));
    let path = params
        .get("path")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if path.is_empty() {
        return Ok(json!({ "error": "missing path" }));
    }
    // Windows: open explorer and select the file
    if !path.is_empty() {
        let _ = std::process::Command::new("explorer")
            .arg("/select,")
            .arg(path)
            .spawn();
    }
    Ok(json!({ "ok": true }))
}

// ── Native file dialogs ──

#[tauri::command]
pub async fn show_open_dialog(app: AppHandle, args: Vec<Value>) -> Result<Value, String> {
    let _ = args;
    use tauri_plugin_dialog::DialogExt;
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog().file().pick_files(move |paths| {
        let _ = tx.send(paths);
    });
    let paths = rx.await.unwrap_or(None);
    match paths {
        Some(p) => {
            let file_paths: Vec<Value> = p.iter().map(|p| json!(p.to_string())).collect();
            Ok(json!({ "filePaths": file_paths }))
        }
        None => Ok(json!({ "canceled": true, "filePaths": [] })),
    }
}

#[tauri::command]
pub async fn show_save_dialog(app: AppHandle, args: Vec<Value>) -> Result<Value, String> {
    let params = args.into_iter().next().unwrap_or(json!({}));
    let default_path = params
        .get("defaultPath")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    use tauri_plugin_dialog::DialogExt;
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_file_name(default_path)
        .save_file(move |path| {
            let _ = tx.send(path);
        });
    let path = rx.await.unwrap_or(None);
    match path {
        Some(p) => Ok(json!({ "filePath": p.to_string() })),
        None => Ok(json!({ "canceled": true })),
    }
}

// ── Quit ready ──

#[tauri::command]
pub fn quit_ready() -> Value {
    std::process::exit(0);
}

// ── Clipboard (OSC 52 copy/paste) ──
// OSC 52 由终端输出触发（vim/tmux yank），不在 WebView2 用户手势内，
// navigator.clipboard 会抛 NotAllowedError，必须走系统剪贴板 API

#[tauri::command]
pub fn clipboard_write_text(args: Vec<Value>) -> Result<Value, String> {
    let params = args.into_iter().next().unwrap_or(json!({}));
    let text = params.get("text").and_then(|v| v.as_str()).unwrap_or("");
    let mut cb = arboard::Clipboard::new().map_err(|e| format!("clipboard: {e}"))?;
    cb.set_text(text).map_err(|e| format!("clipboard: {e}"))?;
    Ok(json!({ "ok": true }))
}

#[tauri::command]
pub fn clipboard_read_text(args: Vec<Value>) -> Result<String, String> {
    let _ = args;
    let mut cb = arboard::Clipboard::new().map_err(|e| format!("clipboard: {e}"))?;
    cb.get_text().map_err(|e| format!("clipboard: {e}"))
}

// ── Unit tests ──

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_roundtrip() {
        let long = "a".repeat(1000);
        let cases: Vec<String> = vec!["", "hello", "密码🔑", &long]
            .into_iter()
            .map(String::from)
            .collect();
        for c in cases {
            let enc = base64_encode_bytes(c.as_bytes());
            let dec = base64_decode_raw(&enc);
            assert_eq!(dec, c.as_bytes(), "base64 roundtrip failed");
        }
    }

    #[test]
    fn base64_padding() {
        // 单字节与双字节输入的 padding 正确性
        assert_eq!(base64_encode_bytes(b"a"), "YQ==");
        assert_eq!(base64_encode_bytes(b"ab"), "YWI=");
        assert_eq!(base64_encode_bytes(b"abc"), "YWJj");
    }

    #[test]
    fn login_script_unescape() {
        assert_eq!(unescape(r"ls\n"), "ls\n");
        assert_eq!(unescape(r"a\tb\c"), "a\tb\\c");
        assert_eq!(unescape(r"no-escape"), "no-escape");
        assert_eq!(unescape("trailing\\"), "trailing\\");
    }

    #[test]
    fn login_script_ensure_newline() {
        assert_eq!(ensure_newline("cmd"), "cmd\n");
        assert_eq!(ensure_newline("cmd\n"), "cmd\n");
        assert_eq!(ensure_newline("cmd\r"), "cmd\r");
    }

    #[test]
    fn parse_login_scripts_filters_empty() {
        let val = json!([
            { "expect": "Password:", "send": "secret", "isRegex": false },
            { "expect": "", "send": "" }, // 空条目应被过滤
            { "expect": "Are you sure?", "send": "y\n", "optional": true },
        ]);
        let scripts = parse_login_scripts(&val);
        assert_eq!(scripts.len(), 2);
        assert_eq!(scripts[0].expect, "Password:");
        assert_eq!(scripts[0].send, "secret");
        assert_eq!(scripts[1].expect, "Are you sure?");
        assert_eq!(scripts[1].send, "y\n");
        assert!(scripts[1].optional);
    }

    #[test]
    fn parse_login_scripts_non_array() {
        assert!(parse_login_scripts(&json!({"expect": "x"})).is_empty());
        assert!(parse_login_scripts(&json!(null)).is_empty());
    }

    #[test]
    fn decrypt_password_legacy_tauri_format() {
        // 旧格式 tauri:<base64> 兼容
        let plain = "secret123";
        let enc = format!("tauri:{}", base64_encode_bytes(plain.as_bytes()));
        assert_eq!(decrypt_password_value(&enc).as_deref(), Some(plain));
    }

    #[test]
    fn decrypt_password_plain_base64_no_prefix() {
        // 早期 Tauri 无前缀明文 base64
        let plain = "pw-明文-🔑";
        let enc = base64_encode_bytes(plain.as_bytes());
        assert_eq!(decrypt_password_value(&enc).as_deref(), Some(plain));
    }

    #[test]
    fn decrypt_password_electron_v10_format() {
        // Electron OSCrypt："v10" 头 + nonce(12) + AES-GCM 密文（Local State 的 AES key）
        // 本机存在 Electron 的 Local State 时验证完整链路；否则跳过
        let Some(key) = load_oscrypt_key() else {
            eprintln!("skip: no Electron Local State on this machine");
            return;
        };
        let plain = "electron-secret-密码";
        let blob = build_oscrypt_blob(b"v10", &key, plain);
        let enc = base64_encode_bytes(&blob);
        assert_eq!(decrypt_password_value(&enc).as_deref(), Some(plain));
    }

    #[test]
    fn decrypt_password_electron_v11_format() {
        let Some(key) = load_oscrypt_key() else {
            eprintln!("skip: no Electron Local State on this machine");
            return;
        };
        let plain = "electron-v11-secret";
        let blob = build_oscrypt_blob(b"v11", &key, plain);
        let enc = base64_encode_bytes(&blob);
        assert_eq!(decrypt_password_value(&enc).as_deref(), Some(plain));
    }

    #[test]
    fn decrypt_password_electron_format_corrupt_not_fallback() {
        // 带 v10 头但密文损坏：不降级为明文（避免把乱码当密码）
        let enc = base64_encode_bytes(b"v10garbage-not-valid-cipher");
        assert_eq!(decrypt_password_value(&enc), None);
    }

    #[test]
    fn aes_gcm_payload_roundtrip() {
        // 纯函数级验证：AES-256-GCM 加密 → 解密 roundtrip
        use aes_gcm::aead::{Aead, KeyInit};
        let key = [7u8; 32];
        let plain = b"roundtrip payload";
        let nonce = [1u8; 12];
        let cipher = aes_gcm::Aes256Gcm::new_from_slice(&key).unwrap();
        let ct = cipher
            .encrypt(aes_gcm::Nonce::from_slice(&nonce), plain.as_slice())
            .expect("encrypt");
        let mut payload = nonce.to_vec();
        payload.extend_from_slice(&ct);
        let dec = aes_gcm_decrypt_payload(&key, &payload).expect("decrypt");
        assert_eq!(dec, plain);
        // 错误 key 解密失败
        let bad_key = [8u8; 32];
        assert!(aes_gcm_decrypt_payload(&bad_key, &payload).is_none());
        // 非法输入
        assert!(aes_gcm_decrypt_payload(&key, &[]).is_none());
        assert!(aes_gcm_decrypt_payload(&[1u8; 16], &payload).is_none());
    }

    #[test]
    fn filter_system_fonts_excludes_at_and_system_fonts() {
        let fonts = vec![
            "JetBrains Mono".into(),
            "@JetBrains Mono".into(),
            "System".into(),
            "@System".into(),
            "宋体".into(),
            "@宋体".into(),
            "Terminal".into(),
            "Cascadia Code".into(),
            "Consolas".into(),
        ];
        let filtered = filter_system_fonts(fonts);
        assert_eq!(
            filtered,
            vec!["JetBrains Mono", "宋体", "Cascadia Code", "Consolas"]
        );
        // 正常字体保留，@ 前缀与 System 类字体全部排除
        assert!(!filtered.iter().any(|f| f.starts_with('@')));
        assert!(!filtered
            .iter()
            .any(|f| matches!(f.as_str(), "System" | "Terminal")));
    }

    #[test]
    fn filter_system_fonts_empty_input() {
        assert!(filter_system_fonts(vec![]).is_empty());
        // 中文正常字体名不被误伤
        let filtered = filter_system_fonts(vec!["微软雅黑".into()]);
        assert_eq!(filtered, vec!["微软雅黑"]);
    }

    #[test]
    fn oscrypt_key_from_local_state() {
        // 本机存在 Electron Local State 时：DPAPI 解出的 AES key 应为 32 字节
        let appdata = std::env::var("APPDATA").unwrap_or_default();
        let ls = std::path::Path::new(&appdata)
            .join("ZTerm")
            .join("Local State");
        if !ls.exists() {
            eprintln!("skip: no Electron Local State on this machine");
            return;
        }
        let key = load_oscrypt_key().expect("load oscrypt key");
        assert_eq!(key.len(), 32);
    }

    #[test]
    fn known_hosts_id_format() {
        // known_hosts 键格式：host:port
        let id = format!("{}:{}", "example.com", 2222);
        assert_eq!(id, "example.com:2222");
    }

    #[test]
    fn known_host_entry_unknown() {
        assert!(matches!(
            check_known_host_entry(None, "fp1"),
            HostKeyStatus::Unknown
        ));
    }

    #[test]
    fn known_host_entry_known_when_fingerprint_matches() {
        let entry = json!({ "algorithm": "ssh-ed25519", "fingerprint": "fp1" });
        assert!(matches!(
            check_known_host_entry(Some(&entry), "fp1"),
            HostKeyStatus::Known
        ));
    }

    #[test]
    fn known_host_entry_mismatch_reports_old_data() {
        let entry = json!({ "algorithm": "ssh-rsa", "fingerprint": "old-fp" });
        match check_known_host_entry(Some(&entry), "new-fp") {
            HostKeyStatus::Mismatch {
                old_algorithm,
                old_fingerprint,
            } => {
                assert_eq!(old_algorithm, "ssh-rsa");
                assert_eq!(old_fingerprint, "old-fp");
            }
            other => panic!("expected Mismatch, got {:?}", other),
        }
    }

    #[test]
    fn known_host_entry_missing_fields_handled() {
        // 记录缺少 fingerprint/algorithm 字段时不应 panic，且视为不匹配
        let entry = json!({});
        match check_known_host_entry(Some(&entry), "fp") {
            HostKeyStatus::Mismatch {
                old_algorithm,
                old_fingerprint,
            } => {
                assert!(old_algorithm.is_empty());
                assert!(old_fingerprint.is_empty());
            }
            other => panic!("expected Mismatch, got {:?}", other),
        }
    }

    #[test]
    fn default_config_shape() {
        let cfg = default_config();
        assert_eq!(cfg["version"], 1);
        assert!(cfg["profiles"].is_array());
        let names: Vec<&str> = cfg["profiles"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|p| p["name"].as_str())
            .collect();
        assert!(names.contains(&"PowerShell"));
        assert!(names.contains(&"Command Prompt"));
        assert!(cfg["sshProfiles"].as_array().unwrap().is_empty());
        assert!(cfg["lastTabs"].as_array().unwrap().is_empty());
        assert_eq!(cfg["appearance"]["theme"], "dark");
    }

    #[test]
    fn sanitize_config_merges_user_values_over_defaults() {
        let raw = json!({
            "version": 1,
            "profiles": [{ "id": "git-bash", "name": "Git Bash", "type": "local" }],
            "appearance": { "fontSize": 16 },
            "customKey": { "nested": true },
        });
        let (cfg, corrupt) = sanitize_config(raw);
        assert!(!corrupt);
        // 用户字段覆盖默认
        assert_eq!(cfg["profiles"].as_array().unwrap().len(), 1);
        assert_eq!(cfg["profiles"][0]["name"], "Git Bash");
        assert_eq!(cfg["appearance"]["fontSize"], 16);
        // 默认字段保留
        assert_eq!(cfg["appearance"]["theme"], "dark");
        assert!(cfg["lastTabs"].is_array());
        // 自定义字段保留
        assert_eq!(cfg["customKey"]["nested"], true);
    }

    #[test]
    fn sanitize_config_rejects_non_object_roots() {
        for raw in [
            json!(null),
            json!([]),
            json!("string"),
            json!(42),
            json!(true),
        ] {
            let raw_desc = format!("{:?}", raw);
            let (cfg, corrupt) = sanitize_config(raw);
            assert!(corrupt, "root {} should be marked corrupt", raw_desc);
            assert!(cfg.is_null(), "corrupt root must not yield a config value");
        }
    }

    #[test]
    fn sanitize_config_preserves_ssh_profiles() {
        let raw = json!({
            "sshProfiles": [{ "id": "s1", "name": "prod", "host": "example.com", "port": 22 }],
        });
        let (cfg, corrupt) = sanitize_config(raw);
        assert!(!corrupt);
        let ssh = cfg["sshProfiles"].as_array().unwrap();
        assert_eq!(ssh.len(), 1);
        assert_eq!(ssh[0]["host"], "example.com");
        assert_eq!(ssh[0]["port"], 22);
    }

    // ADR-0003 open_url validation matrix (pure; no OS side effects).
    #[test]
    fn validate_open_url_accepts_realistic_targets() {
        for raw in [
            "https://example.com",
            "https://example.com/path?q=1&r=2#frag",
            "http://192.168.1.1:8080/admin",
            "https://[2001:db8::1]:8443/x",
            "https://sub.domain.example:443/a%20b",
            "https://example.com/%2500",           // double-encoded literal stays text
            "https://xn--nxasmq6b.example/",       // punycode IDN
            "HTTP://EXAMPLE.COM",                  // case-insensitive scheme
        ] {
            assert!(validate_open_url(raw).is_ok(), "should accept: {raw}");
        }
    }

    #[test]
    fn validate_open_url_rejects_bad_inputs() {
        let long = format!("https://example.com/{}", "a".repeat(4096));
        for (raw, prefix) in [
            ("", "invalidUrl"),
            ("   ", "invalidUrl"),
            ("not-a-url", "invalidUrl"),
            ("ftp://example.com/file", "blockedProtocol"),
            ("file:///C:/Windows/System32", "blockedProtocol"),
            ("javascript:alert(1)", "blockedProtocol"),
            ("mailto:a@example.com", "blockedProtocol"),
            ("https://user:pass@example.com/", "invalidUrl"), // userinfo
            ("https://user@example.com/", "invalidUrl"),
            ("https://", "invalidUrl"),                        // empty host
            ("https://exa\nmple.com/", "invalidUrl"),          // raw control
            ("https://example.com/%00", "invalidUrl"),         // encoded NUL
            ("https://example.com/a%0Ad", "invalidUrl"),       // encoded LF
            ("https://example.com/?q=%0d", "invalidUrl"),      // encoded CR (lowercase hex)
            ("https://example.com/#x%7Fy", "invalidUrl"),      // encoded DEL
            ("https://example.com/%1B[2J", "invalidUrl"),      // encoded ESC
            ("https://example.com/%08", "invalidUrl"),         // encoded BS
            ("https://example.com/\u{7f}", "invalidUrl"),      // raw DEL
            ("https://example.com:99999/x", "invalidUrl"),     // bad port
            ("//example.com/x", "invalidUrl"),                 // protocol-relative
            (long.as_str(), "invalidUrl"),                     // >4096 chars
        ] {
            let err = validate_open_url(raw).expect_err(&format!("should reject: {raw:?}"));
            assert!(err.starts_with(prefix), "{raw:?} → {err}, want prefix {prefix}");
        }
    }

    #[test]
    fn validate_open_url_normalizes_for_shell() {
        // The value handed to ShellExecuteW is the normalized form.
        let url = validate_open_url("https://EXAMPLE.com:443/a b?x=1").unwrap();
        assert_eq!(url.as_str(), "https://example.com/a%20b?x=1");
    }

    // ADR-0003 seam: rejected targets must never reach the dispatcher, and an
    // accepted target is dispatched exactly once with the normalized URL.
    #[test]
    fn open_url_dispatch_seam() {
        use std::cell::RefCell;
        let calls: RefCell<Vec<String>> = RefCell::new(Vec::new());
        let recorder = |target: &str| -> Result<(), String> {
            calls.borrow_mut().push(target.to_string());
            Ok(())
        };
        assert!(validate_then_dispatch("https://EXAMPLE.com:443/a b?x=1", recorder).is_ok());
        assert!(validate_then_dispatch("javascript:alert(1)", recorder).is_err());
        assert!(validate_then_dispatch("https://example.com/%00", recorder).is_err());
        assert_eq!(calls.borrow().as_slice(), ["https://example.com/a%20b?x=1"]);
    }

    fn script(expect: &str, send: &str) -> LoginScript {
        LoginScript {
            expect: expect.into(),
            send: send.into(),
            is_regex: false,
            optional: false,
        }
    }

    // 测试辅助：构造 Electron OSCrypt blob（版本头 + nonce(12) + AES-GCM 密文）
    fn build_oscrypt_blob(version: &[u8], key: &[u8], plaintext: &str) -> Vec<u8> {
        use aes_gcm::aead::{Aead, KeyInit};
        let nonce = [3u8; 12];
        let cipher = aes_gcm::Aes256Gcm::new_from_slice(key).unwrap();
        let ct = cipher
            .encrypt(aes_gcm::Nonce::from_slice(&nonce), plaintext.as_bytes())
            .unwrap();
        let mut blob = version.to_vec();
        blob.extend_from_slice(&nonce);
        blob.extend_from_slice(&ct);
        blob
    }

    #[test]
    fn feed_login_scripts_contains_match_consumes_script() {
        let mut scripts = vec![script("Password:", "secret")];
        let send = feed_login_scripts("Password: ", &mut scripts);
        assert_eq!(send.as_deref(), Some("secret\n"));
        assert!(scripts.is_empty(), "matched script must be consumed");
    }

    #[test]
    fn feed_login_scripts_regex_match() {
        let mut scripts = vec![LoginScript {
            expect: r"(\[sudo\] )?password.*".into(),
            send: "pw".into(),
            is_regex: true,
            optional: false,
        }];
        let send = feed_login_scripts("[sudo] password for user:", &mut scripts);
        assert_eq!(send.as_deref(), Some("pw\n"));
        assert!(scripts.is_empty());
    }

    #[test]
    fn feed_login_scripts_invalid_regex_is_no_match() {
        let mut scripts = vec![LoginScript {
            expect: "([unclosed".into(),
            send: "x".into(),
            is_regex: true,
            optional: false,
        }];
        // 非法正则按不匹配处理：不 panic；非 optional 时脚本保留等待后续输入
        let send = feed_login_scripts("anything", &mut scripts);
        assert_eq!(send, None);
        assert_eq!(scripts.len(), 1);
    }

    #[test]
    fn feed_login_scripts_optional_miss_is_consumed() {
        let mut scripts = vec![LoginScript {
            expect: "NotPresent".into(),
            send: "x".into(),
            is_regex: false,
            optional: true,
        }];
        let send = feed_login_scripts("Hello world", &mut scripts);
        assert_eq!(send, None);
        assert!(
            scripts.is_empty(),
            "optional script must be dropped on miss"
        );
    }

    #[test]
    fn feed_login_scripts_required_miss_kept_for_later_output() {
        let mut scripts = vec![script("Password:", "secret")];
        let send = feed_login_scripts("Hello", &mut scripts);
        assert_eq!(send, None);
        // 非 optional 未命中：保留脚本，等待下一次输出再次尝试
        assert_eq!(scripts.len(), 1);
        let send = feed_login_scripts("Password:", &mut scripts);
        assert_eq!(send.as_deref(), Some("secret\n"));
        assert!(scripts.is_empty());
    }

    #[test]
    fn feed_login_scripts_skips_unconditional_entries() {
        // 空 expect 的条目由 execute_unconditional 负责，feed 阶段跳过
        let mut scripts = vec![script("", "first"), script("Password:", "secret")];
        let send = feed_login_scripts("Password:", &mut scripts);
        assert_eq!(send.as_deref(), Some("secret\n"));
        assert_eq!(
            scripts.len(),
            1,
            "unconditional entry must be skipped, not consumed"
        );
        assert_eq!(scripts[0].send, "first");
    }

    #[test]
    fn execute_unconditional_consumes_leading_empty_expects() {
        let mut scripts = vec![script("", "a"), script("", "b"), script("Password:", "c")];
        let sends = execute_unconditional(&mut scripts);
        assert_eq!(sends, vec!["a\n", "b\n"]);
        assert_eq!(scripts.len(), 1);
        assert_eq!(scripts[0].expect, "Password:");
    }

    #[test]
    fn execute_unconditional_no_op_when_no_leading_empty() {
        let mut scripts = vec![script("Password:", "c")];
        let sends = execute_unconditional(&mut scripts);
        assert!(sends.is_empty());
        assert_eq!(scripts.len(), 1);
    }

    #[test]
    fn base64_decode_invalid_input_no_panic() {
        // 非法字符被跳过、'=' 截断，不应 panic
        assert!(base64_decode_raw("!!!").is_empty());
        assert!(base64_decode_raw("").is_empty());
        assert_eq!(base64_decode_raw("YWJj"), b"abc");
        assert_eq!(base64_decode_raw("YWJj=="), b"abc");
    }

    #[test]
    fn dpapi_encrypt_decrypt_roundtrip() {
        // DPAPI 绑定本机用户会话；加密解密同上下文，roundtrip 无副作用
        let plain = "secret-密码-🔑";
        let enc = dpapi_encrypt(plain).expect("dpapi encrypt");
        let dec = dpapi_decrypt(&enc).expect("dpapi decrypt");
        assert_eq!(String::from_utf8(dec).unwrap(), plain);
    }

    #[test]
    fn window_state_roundtrip() {
        let state = WindowState {
            x: -50,
            y: 120,
            width: 900,
            height: 700,
            maximized: true,
        };
        let mut cfg = json!({});
        cfg["window"] = window_state_to_config(&state);
        let parsed = window_state_from_config(&cfg).expect("parse");
        assert_eq!(parsed.x, -50);
        assert_eq!(parsed.y, 120);
        assert_eq!(parsed.width, 900);
        assert_eq!(parsed.height, 700);
        assert!(parsed.maximized);
    }

    #[test]
    fn window_state_missing_field_returns_none() {
        assert!(window_state_from_config(&json!({})).is_none());
        // window 存在但字段缺失
        assert!(window_state_from_config(&json!({"window": {"x": 1}})).is_none());
        // 字段类型错误（字符串而非数字）
        assert!(
            window_state_from_config(&json!({"window": {"x": "a", "y": 2, "width": 3, "height": 4}}))
                .is_none()
        );
        // maximized 缺失 → 默认 false
        let s = window_state_from_config(&json!({"window": {"x": 1, "y": 2, "width": 3, "height": 4}}))
            .unwrap();
        assert!(!s.maximized);
    }

    #[test]
    fn pty_flush_interval_pure_branches() {
        // Env parsing is isolated in pty_flush_interval_from so the matrix is
        // testable without mutating process-global env (cargo test is parallel).
        assert_eq!(pty_flush_interval_from(None, false), PTY_FLUSH_INTERVAL_MS);
        assert_eq!(pty_flush_interval_from(None, true), PTY_LOOSE_FLUSH_WINDOW_MS);
        // Explicit value always wins over the loose toggle, clamped at max.
        assert_eq!(pty_flush_interval_from(Some("56"), true), 56);
        assert_eq!(
            pty_flush_interval_from(Some("999999"), false),
            PTY_MAX_FLUSH_WINDOW_MS
        );
        // Unparsable explicit value falls through to the toggle-based default.
        assert_eq!(pty_flush_interval_from(Some("abc"), false), PTY_FLUSH_INTERVAL_MS);
        assert_eq!(pty_flush_interval_from(Some("  80  "), true), 80);
    }

    #[test]
    fn pty_outbox_equal_sized_bursts_drain_without_later_input() {
        for interval in [4, 40, 80, 200] {
            assert_eq!(pty_flush_interval_from(Some(&interval.to_string()), false), interval);
            let mut outbox = b"first!".to_vec();
            assert_eq!(drain_pty_outbox(&mut outbox), b"first!");
            outbox.extend_from_slice(b"second");
            assert_eq!(drain_pty_outbox(&mut outbox), b"second");
            assert!(drain_pty_outbox(&mut outbox).is_empty());
        }
    }

    #[test]
    fn drain_utf8_ascii_passthrough() {
        let mut carry = Vec::new();
        let mut out = String::new();
        out.push_str(&drain_utf8(&mut carry, b"hello\r\n"));
        out.push_str(&drain_utf8(&mut carry, b"world"));
        assert!(carry.is_empty());
        assert_eq!(out, "hello\r\nworld");
    }

    #[test]
    fn drain_utf8_multibyte_split_across_chunks() {
        // "你好" = E4 BD A0 E5 A5 BD：切在 3 字节序列中间，不允许出现 U+FFFD
        let mut carry = Vec::new();
        let mut out = String::new();
        out.push_str(&drain_utf8(&mut carry, &[0xE4])); // "你" 的第 1 字节
        assert_eq!(out, "");
        assert_eq!(carry, vec![0xE4], "不完整序列必须留在 carry");
        out.push_str(&drain_utf8(&mut carry, &[0xBD, 0xA0, 0xE5])); // 补全"你" + "好" 第 1 字节
        assert_eq!(out, "你");
        assert_eq!(carry, vec![0xE5]);
        out.push_str(&drain_utf8(&mut carry, &[0xA5, 0xBD]));
        assert_eq!(out, "你好");
        assert!(carry.is_empty());
        assert!(!out.contains('\u{FFFD}'));
    }

    #[test]
    fn drain_utf8_emoji_split_across_chunks() {
        // 😀 = F0 9F 98 80（4 字节）：切 3+1
        let mut carry = Vec::new();
        let mut out = String::new();
        out.push_str(&drain_utf8(&mut carry, &[0xF0, 0x9F, 0x98]));
        assert_eq!(out, "");
        out.push_str(&drain_utf8(&mut carry, &[0x80, b'x']));
        assert_eq!(out, "😀x");
        assert!(carry.is_empty());
    }

    #[test]
    fn drain_utf8_invalid_byte_replaced_and_continue() {
        // 真非法字节（0xFF）按 U+FFFD 替换，剩余部分继续解码
        let mut carry = Vec::new();
        let mut out = String::new();
        out.push_str(&drain_utf8(&mut carry, &[b'a', 0xFF, b'b']));
        assert_eq!(out, "a\u{FFFD}b");
        assert!(carry.is_empty());
        // 非法字节在块尾：替换后不阻塞后续块
        out.push_str(&drain_utf8(&mut carry, &[0xFF]));
        assert_eq!(out, "a\u{FFFD}b\u{FFFD}");
        out.push_str(&drain_utf8(&mut carry, b"c"));
        assert_eq!(out, "a\u{FFFD}b\u{FFFD}c");
        assert!(carry.is_empty());
    }

    #[test]
    fn drain_utf8_empty_input() {
        let mut carry = vec![0xE4];
        let out = drain_utf8(&mut carry, b"");
        assert_eq!(out, "");
        assert_eq!(carry, vec![0xE4], "空输入不得动 carry");
    }

    #[test]
    fn parse_osc7_bash_rc_wrapper_format() {
        // bash rc wrapper：_zt_cwd() { printf '\033]7;file://%s%s\033\\' "$HOSTNAME" "$PWD"; }
        // 输出 = ESC]7;file://myserver/home/userESC\
        let out = format!("\x1b]7;file://myserver/home/user\x1b\\");
        assert_eq!(parse_osc7_cwd(&out).as_deref(), Some("/home/user"));
        // 根目录
        let out = format!("\x1b]7;file://myserver/\x1b\\");
        assert_eq!(parse_osc7_cwd(&out).as_deref(), Some("/"));
        // 带空格/特殊字符的路径
        let out = format!("\x1b]7;file://srv/opt/my app/logs\x1b\\");
        assert_eq!(parse_osc7_cwd(&out).as_deref(), Some("/opt/my app/logs"));
    }

    #[test]
    fn parse_osc7_with_bel_terminator() {
        // 部分终端/OSC 实现以 BEL 结尾
        let out = format!("\x1b]7;file://host/var/log\x07");
        assert_eq!(parse_osc7_cwd(&out).as_deref(), Some("/var/log"));
    }

    #[test]
    fn parse_osc7_split_across_chunks() {
        // 序列被 SSH 数据块切开：单块匹配必然失败，拼接窗口后必须成功
        let head = "\x1b]7;file://myserver/home/use";
        let tail = "r/project\x1b\\";
        assert_eq!(parse_osc7_cwd(head), None, "半截序列单独匹配必须失败");
        assert_eq!(parse_osc7_cwd(tail), None, "半截序列尾部单独匹配必须失败");
        let combined = format!("{head}{tail}");
        assert_eq!(parse_osc7_cwd(&combined).as_deref(), Some("/home/user/project"));
        // 前有大量输出（大文本场景）时同样能匹配
        let noisy = format!("ls output line\nanother\n{combined}");
        assert_eq!(parse_osc7_cwd(&noisy).as_deref(), Some("/home/user/project"));
    }

    #[test]
    fn parse_1337_currentdir_fish_native() {
        // fish ≥3.x 每个提示符原生输出（实测 rig 192.168.41.88 的捕获流）
        assert_eq!(
            parse_1337_currentdir("\u{1b}]1337;CurrentDir=/root\u{7}"),
            Some("/root".to_string())
        );
        assert_eq!(
            parse_1337_currentdir("\u{1b}]1337;CurrentDir=/tmp\u{1b}\\"),
            Some("/tmp".to_string())
        );
        // 路径含空格：fish 原样输出，不转义
        assert_eq!(
            parse_1337_currentdir("\u{1b}]1337;CurrentDir=/opt/my app/logs\u{7}"),
            Some("/opt/my app/logs".to_string())
        );
        // iTerm2 file:// 变体：剥掉 scheme+host
        assert_eq!(
            parse_1337_currentdir("\u{1b}]1337;CurrentDir=file://box.local/var/log\u{7}"),
            Some("/var/log".to_string())
        );
        // %XX 编码变体：解码
        assert_eq!(
            parse_1337_currentdir("\u{1b}]1337;CurrentDir=/home/my%20dir\u{7}"),
            Some("/home/my dir".to_string())
        );
        // 裸 % 不做解码（真实路径常见）
        assert_eq!(
            parse_1337_currentdir("\u{1b}]1337;CurrentDir=/data/100%load\u{7}"),
            Some("/data/100%load".to_string())
        );
        // 噪声中匹配
        assert_eq!(
            parse_1337_currentdir(&format!("prompt ❯ some output\n\u{1b}]1337;CurrentDir=/srv\u{7}\nmore")),
            Some("/srv".to_string())
        );
    }

    #[test]
    fn parse_1337_currentdir_no_match() {
        // 无终止符（跨块时上游窗口拼接后才会匹配，单块必须返回 None）
        assert_eq!(parse_1337_currentdir("\u{1b}]1337;CurrentDir=/root"), None);
        // 相对路径/空路径不接受
        assert_eq!(parse_1337_currentdir("\u{1b}]1337;CurrentDir=relative\u{7}"), None);
        assert_eq!(parse_1337_currentdir("\u{1b}]1337;CurrentDir=\u{7}"), None);
        assert_eq!(parse_1337_currentdir("plain text"), None);
        assert_eq!(parse_1337_currentdir(""), None);
    }

    #[test]
    fn mixed_cwd_sequences_prefer_latest_position() {
        // 登录时 wrapper 的 OSC 7 (/root) + 之后 fish 每个提示符的 1337 (/tmp)：
        // 窗口里两者并存时，位置靠后的 1337 必须赢（or_else 短路会永远卡在旧值）
        let window = "\u{1b}]7;file://host/root\u{1b}\\\u{1b}]0;title\u{7}prompt\u{1b}]1337;CurrentDir=/tmp\u{7}";
        let osc7 = parse_osc7_cwd(window);
        let c1337 = parse_1337_currentdir(window);
        assert_eq!(osc7.as_deref(), Some("/root"));
        assert_eq!(c1337.as_deref(), Some("/tmp"));
        let pa = window.find("\u{1b}]7;file://").unwrap_or(0);
        let pb = window.find("\u{1b}]1337;CurrentDir=").unwrap_or(0);
        assert!(pb > pa, "1337 必须出现在更靠后的位置");
    }

    #[test]
    fn parse_osc7_no_match_returns_none() {
        assert_eq!(parse_osc7_cwd("plain text"), None);
        assert_eq!(parse_osc7_cwd("\x1b]7;file://host"), None, "无终止符不匹配");
        assert_eq!(parse_osc7_cwd(""), None);
    }

    #[test]
    fn bash_rc_wrapper_end_to_end() {
        // 用真实 bash 执行 RC wrapper（本机无 bash 则跳过）：验证生成的 rc 文件
        // 能让 shell 输出可解析的 OSC 7 cwd。隔离 HOME 避免污染测试机用户配置。
        let bash = ["bash", "D:/Program Files/Git/bin/bash.exe", "C:/Program Files/Git/bin/bash.exe"]
            .iter()
            .find(|p| {
                std::process::Command::new(p)
                    .arg("--version")
                    .stdout(std::process::Stdio::null())
                    .stderr(std::process::Stdio::null())
                    .status()
                    .map(|s| s.success())
                    .unwrap_or(false)
            });
        let Some(bash) = bash else {
            eprintln!("skip: no bash on this machine");
            return;
        };
        let (files, exec) = cwd_wrapper_files("/bin/bash", "e2e-test").expect("bash wrapper");
        assert_eq!(files.len(), 1);
        assert!(exec.contains("exec bash --rcfile"), "exec 命令: {exec}");
        let (_, rc_content) = &files[0];
        let dir = std::env::temp_dir().join("zterm-cwd-wrapper-test");
        let _ = std::fs::create_dir_all(&dir);
        let win_rc = dir.join("rcfile");
        std::fs::write(&win_rc, rc_content).expect("write rc");
        let home = dir.join("home");
        std::fs::create_dir_all(&home).unwrap();
        let mut child = std::process::Command::new(bash)
            .arg("--rcfile")
            .arg(&win_rc)
            .arg("-i")
            .env("HOME", &home)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .spawn()
            .expect("spawn bash");
        use std::io::Write;
        child
            .stdin
            .take()
            .unwrap()
            .write_all(b"exit\n")
            .expect("feed stdin");
        let out = child.wait_with_output().expect("wait bash");
        let text = String::from_utf8_lossy(&out.stdout);
        assert!(
            text.contains("\x1b]7;file://"),
            "bash 未输出 OSC 7：{}",
            text.escape_debug().take(300).collect::<String>()
        );
        let cwd = parse_osc7_cwd(&text).expect("解析 OSC 7 失败");
        assert!(cwd.starts_with('/'), "cwd 应为绝对路径: {cwd}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn window_center_on_any_monitor() {
        let one = [MonitorRect { x: 0, y: 0, w: 1920, h: 1080 }];
        assert!(center_on_any_monitor(960, 540, &one));
        assert!(center_on_any_monitor(0, 0, &one));
        // 边界外：左侧/右侧/下侧
        assert!(!center_on_any_monitor(-1, 540, &one));
        assert!(!center_on_any_monitor(1920, 540, &one));
        assert!(!center_on_any_monitor(960, 1080, &one));
        // 双显示器（副屏在左侧，负坐标）
        let two = [
            MonitorRect { x: 0, y: 0, w: 1920, h: 1080 },
            MonitorRect { x: -1920, y: 0, w: 1920, h: 1080 },
        ];
        assert!(center_on_any_monitor(-960, 540, &two));
        assert!(center_on_any_monitor(-1920, 540, &two), "左屏左边缘在内");
        assert!(!center_on_any_monitor(-1921, 540, &two));
        assert!(!center_on_any_monitor(2000, 540, &two));
    }

    #[test]
    fn ssh_client_config_keepalive() {
        let c = ssh_client_config();
        // Keepalive on, inactivity timeout off: an idle-but-alive session is
        // exactly what a terminal must keep; silent death must surface fast.
        assert_eq!(
            c.keepalive_interval,
            Some(std::time::Duration::from_secs(30))
        );
        assert_eq!(c.inactivity_timeout, None);
        assert_eq!(c.keepalive_max, 3);
    }

    #[test]
    fn classify_disconnect_kinds() {
        use russh::client::DisconnectReason as R;
        let (k, t) = classify_disconnect(&R::Error(russh::Error::KeepaliveTimeout));
        assert_eq!(k, "keepalive");
        assert!(t.contains("keepalive"), "text should name the cause: {t}");
        // Bare Disconnect is the user-initiated / information-free path.
        let (k, _) = classify_disconnect(&R::Error(russh::Error::Disconnect));
        assert_eq!(k, "closed");
        let (k, t) = classify_disconnect(&R::ReceivedDisconnect(
            russh::client::RemoteDisconnectInfo {
                reason_code: russh::Disconnect::ByApplication,
                message: "session terminated".to_string(),
                lang_tag: String::new(),
            },
        ));
        assert_eq!(k, "server");
        assert!(t.contains("session terminated"), "server message kept: {t}");
        // Any other error maps to the generic error kind.
        let (k, _) = classify_disconnect(&R::Error(russh::Error::InactivityTimeout));
        assert_eq!(k, "error");
    }

    #[test]
    fn version_newer_semver_core() {
        assert!(version_newer("1.0.5", "1.1.0"));
        assert!(version_newer("1.0.5", "v1.0.6"));
        assert!(version_newer("1.0.5", "2.0"));
        assert!(!version_newer("1.0.5", "1.0.5"));
        assert!(!version_newer("1.0.5", "v1.0.5"));
        assert!(!version_newer("1.0.5", "1.0.4"));
        // Pre-release suffix is stripped: 1.0.6-beta.1 counts as 1.0.6.
        assert!(version_newer("1.0.5", "v1.0.6-beta.1"));
        assert!(!version_newer("1.0.5", "1.0.5-beta.1"));
        // Two-component tag pads with zeros.
        assert!(version_newer("1.0.5", "1.1"));
        assert!(!version_newer("1.0.5", "1.0"));
    }

    // ── In-app update download ──

    fn gh_asset(name: &str, size: u64, digest: Option<&str>) -> Value {
        json!({
            "name": name,
            "browser_download_url": format!("https://github.com/ZouDongj/ZTerm/releases/download/v1.0.8/{name}"),
            "size": size,
            "digest": digest,
        })
    }

    #[test]
    fn select_setup_asset_happy_path() {
        let sha = "a".repeat(64);
        let assets = vec![
            gh_asset("ZTerm_1.0.8_x64-setup.exe", 4_700_000, Some(&format!("sha256:{sha}"))),
            gh_asset("ZTerm_1.0.8_arm64-setup.exe", 4_100_000, Some(&format!("sha256:{sha}"))),
        ];
        let (name, url, size, got_sha) = select_setup_asset(&assets).unwrap();
        assert_eq!(name, "ZTerm_1.0.8_x64-setup.exe");
        assert!(url.ends_with("/ZTerm_1.0.8_x64-setup.exe"));
        assert_eq!(size, 4_700_000);
        assert_eq!(got_sha, sha);
    }

    #[test]
    fn select_setup_asset_rejects_bad_sets() {
        let sha = format!("sha256:{}", "b".repeat(64));
        // No x64 setup asset at all.
        let none = vec![gh_asset("ZTerm_1.0.8_arm64-setup.exe", 1, Some(&sha))];
        assert!(select_setup_asset(&none).unwrap_err().contains("no ZTerm_"));
        // Two candidates: ambiguous, refuse to guess.
        let two = vec![
            gh_asset("ZTerm_1.0.8_x64-setup.exe", 1, Some(&sha)),
            gh_asset("ZTerm_1.0.9_x64-setup.exe", 2, Some(&sha)),
        ];
        assert!(select_setup_asset(&two).unwrap_err().contains("expected exactly one"));
        // Missing digest field entirely.
        let no_digest = vec![gh_asset("ZTerm_1.0.8_x64-setup.exe", 1, None)];
        assert!(select_setup_asset(&no_digest).unwrap_err().contains("sha256 digest"));
        // Digest with a wrong algorithm prefix.
        let wrong_alg = vec![gh_asset("ZTerm_1.0.8_x64-setup.exe", 1, Some("md5:abc"))];
        assert!(select_setup_asset(&wrong_alg).unwrap_err().contains("sha256 digest"));
        // Truncated hash is not a valid sha256 digest.
        let short = format!("sha256:{}", "c".repeat(32));
        let bad_len = vec![gh_asset("ZTerm_1.0.8_x64-setup.exe", 1, Some(&short))];
        assert!(select_setup_asset(&bad_len).unwrap_err().contains("sha256 digest"));
        // Right length but non-hex characters are not a valid sha256 digest.
        let non_hex = format!("sha256:{}", "zz".repeat(32));
        let bad_hex = vec![gh_asset("ZTerm_1.0.8_x64-setup.exe", 1, Some(&non_hex))];
        assert!(select_setup_asset(&bad_hex).unwrap_err().contains("sha256 digest"));
        // Download URL missing.
        let no_url = vec![json!({
            "name": "ZTerm_1.0.8_x64-setup.exe",
            "size": 1,
            "digest": sha,
        })];
        assert!(select_setup_asset(&no_url).unwrap_err().contains("browser_download_url"));
        // Path separators / parent refs in the asset name are rejected (the
        // name is joined into the download dir and spawned as the installer).
        let sha2 = format!("sha256:{}", "e".repeat(64));
        for evil in ["ZTerm_a\\..\\x_x64-setup.exe", "ZTerm_a/b_x64-setup.exe", "ZTerm_.._x64-setup.exe"] {
            let v = vec![gh_asset(evil, 1, Some(&sha2))];
            assert!(select_setup_asset(&v).is_err(), "traversal name must be rejected: {evil}");
        }
    }

    #[test]
    fn newer_asset_info_wiring() {
        let sha = "d".repeat(64);
        // Asset present but nothing on disk: name/size/sha surface, ready=false.
        let body = json!({ "assets": [gh_asset("ZTerm_0.0.0nonexistent_x64-setup.exe", 42, Some(&format!("sha256:{sha}")))] });
        let info = newer_asset_info(&body);
        assert_eq!(info.name.as_deref(), Some("ZTerm_0.0.0nonexistent_x64-setup.exe"));
        assert_eq!(info.size, Some(42));
        assert_eq!(info.sha256.as_deref(), Some(sha.as_str()));
        assert!(!info.ready);
        // Hash-matching file already on disk: ready=true.
        let dir = update_download_dir();
        std::fs::create_dir_all(&dir).unwrap();
        let fname = "ZTerm_9.9.9wiring_x64-setup.exe";
        std::fs::write(dir.join(fname), b"abc").unwrap();
        let abc_sha = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
        let body = json!({ "assets": [gh_asset(fname, 3, Some(&format!("sha256:{abc_sha}")))] });
        let info = newer_asset_info(&body);
        assert!(info.ready, "matching on-disk installer must report ready");
        let _ = std::fs::remove_file(dir.join(fname));
        // No assets key at all: empty info, not ready.
        let info = newer_asset_info(&json!({}));
        assert!(info.name.is_none() && info.size.is_none() && !info.ready);
        // Asset unusable (no digest): empty info, not ready — caller still reports newer.
        let body = json!({ "assets": [gh_asset("ZTerm_1.0.8_x64-setup.exe", 1, None)] });
        let info = newer_asset_info(&body);
        assert!(info.name.is_none() && info.size.is_none() && !info.ready);
    }

    #[test]
    fn seed_ready_from_check_only_seeds_from_idle() {
        let info = NewerAssetInfo {
            name: Some("ZTerm_9.9.9seed_x64-setup.exe".to_string()),
            size: Some(7),
            sha256: Some("f".repeat(64)),
            ready: true,
        };
        // From Idle the state machine adopts the ready installer.
        {
            let mut st = UPDATE_DL.lock();
            *st = UpdateDlState::idle();
        }
        seed_ready_from_check("v9.9.9", &info);
        {
            let st = UPDATE_DL.lock();
            assert_eq!(st.phase, UpdateDlPhase::Ready);
            assert_eq!(st.tag, "v9.9.9");
            assert_eq!(st.file_name, "ZTerm_9.9.9seed_x64-setup.exe");
            assert_eq!(st.sha256, "f".repeat(64));
        }
        // A non-Idle phase (e.g. an in-flight download) is never clobbered.
        {
            let mut st = UPDATE_DL.lock();
            *st = UpdateDlState::idle();
            st.phase = UpdateDlPhase::Downloading;
            st.tag = "v1.1.1".to_string();
        }
        seed_ready_from_check("v9.9.9", &info);
        {
            let st = UPDATE_DL.lock();
            assert_eq!(st.phase, UpdateDlPhase::Downloading);
            assert_eq!(st.tag, "v1.1.1");
        }
        // Leave the global idle again for other tests.
        *UPDATE_DL.lock() = UpdateDlState::idle();
        // Not-ready info never seeds.
        seed_ready_from_check("v9.9.9", &NewerAssetInfo::default());
        assert_eq!(UPDATE_DL.lock().phase, UpdateDlPhase::Idle);
    }

    #[test]
    fn file_sha256_known_vector() {
        let dir = std::env::temp_dir().join(format!("zterm-sha2test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("abc.bin");
        std::fs::write(&p, b"abc").unwrap();
        // SHA-256("abc") from FIPS 180-4.
        assert_eq!(
            file_sha256_hex(&p).unwrap(),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn update_dl_state_snapshot_phases() {
        let mut st = UpdateDlState::idle();
        assert_eq!(st.snapshot_json()["phase"], "idle");
        st.phase = UpdateDlPhase::Downloading;
        st.tag = "v1.0.8".to_string();
        st.file_name = "ZTerm_1.0.8_x64-setup.exe".to_string();
        st.total = 100;
        st.downloaded = 42;
        let j = st.snapshot_json();
        assert_eq!(j["phase"], "downloading");
        assert_eq!(j["tag"], "v1.0.8");
        assert_eq!(j["downloaded"], 42);
        assert_eq!(j["total"], 100);
        st.phase = UpdateDlPhase::Ready;
        assert_eq!(st.snapshot_json()["phase"], "ready");
        st.phase = UpdateDlPhase::Failed;
        st.error = "boom".to_string();
        let j = st.snapshot_json();
        assert_eq!(j["phase"], "failed");
        assert_eq!(j["error"], "boom");
    }

    #[test]
    fn ready_installer_path_requires_matching_hash() {
        // No file on disk for this asset name -> not ready.
        assert!(ready_installer_path("ZTerm_0.0.0nonexistent_x64-setup.exe", &"0".repeat(64)).is_none());
        // A file whose hash does not match the expected digest -> not ready.
        let dir = update_download_dir();
        std::fs::create_dir_all(&dir).unwrap();
        let name = "ZTerm_9.9.9test_x64-setup.exe";
        std::fs::write(dir.join(name), b"abc").unwrap();
        assert!(ready_installer_path(name, &"0".repeat(64)).is_none());
        // Correct digest -> ready with the full path.
        let abc_sha = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
        let p = ready_installer_path(name, abc_sha).expect("matching hash must be ready");
        assert!(p.ends_with(name));
        let _ = std::fs::remove_file(dir.join(name));
    }
}
