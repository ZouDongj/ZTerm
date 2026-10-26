//! Shared configuration is data, not permission to execute on another account.
//! Tickets bind one immutable launch to one live owner. Persistent SSH grants
//! are keyed fingerprints sealed with CurrentUser DPAPI in a Windows Known Folder.

use hmac::{Hmac, Mac};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs::{File, OpenOptions};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

const LIFETIME: Duration = Duration::from_secs(15 * 60);
const MAX_PENDING: usize = 128;
const MAX_GRANTS: usize = 2048;
const MAX_EXECUTABLE_BYTES: u64 = 128 * 1024 * 1024;

#[derive(Clone, Debug, PartialEq)]
pub struct AuthSource {
    pub identity: Value,
    pub rememberable: bool,
}

impl AuthSource {
    pub fn none() -> Self {
        Self { identity: json!({"kind":"none"}), rememberable: true }
    }
}

#[derive(Clone)]
struct Context {
    store: PathBuf,
    default_cwd: PathBuf,
    system: PathBuf,
    git_bash: Vec<PathBuf>,
    current: PathBuf,
    search: Vec<PathBuf>,
    elevated: bool,
}

#[derive(Serialize, Deserialize)]
struct Database {
    version: u32,
    key: Vec<u8>,
    grants: Vec<String>,
}

impl Database {
    fn new() -> Result<Self, String> {
        Ok(Self { version: 1, key: random_bytes()?.to_vec(), grants: Vec::new() })
    }
    fn fingerprint(&self, descriptor: &Value) -> Result<String, String> {
        let mut mac = Hmac::<Sha256>::new_from_slice(&self.key).map_err(|_| "invalid trust key")?;
        mac.update(&serde_json::to_vec(descriptor).map_err(|_| "invalid execution descriptor")?);
        Ok(hex(&mac.finalize().into_bytes()))
    }
}

#[derive(Clone)]
struct Record {
    owner: String,
    kind: String,
    original: Value,
    frozen: Value,
    descriptor: Value,
    description: String,
    auth: AuthSource,
    safe_builtin: bool,
    rememberable: bool,
    expires: Instant,
}

#[derive(Default)]
struct Gate {
    challenges: HashMap<String, Record>,
    tickets: HashMap<String, Record>,
    in_flight: HashMap<String, InFlight>,
    cancelled: HashMap<String, Instant>,
    blocked_until: Option<Instant>,
}

struct InFlight {
    generation: String,
    cancel: Arc<AtomicBool>,
    expires: Instant,
    started: bool,
}

impl Gate {
    fn prune(&mut self) {
        let now = Instant::now();
        self.challenges.retain(|_, value| value.expires > now);
        self.tickets.retain(|_, value| value.expires > now);
        self.in_flight.retain(|_, value| {
            if value.expires > now { return true; }
            value.cancel.store(true, Ordering::Release);
            false
        });
        self.cancelled.retain(|_, expiry| *expiry > now);
    }
    fn check_owner(&self, owner: &str) -> Result<(), String> {
        if self.blocked_until.is_some_and(|until| until > Instant::now()) { return Err("startup authorization capacity reached; retry later".into()); }
        if self.cancelled.contains_key(owner) { return Err("execution cancelled".into()); }
        Ok(())
    }
    fn insert(&mut self, record: Record, trusted: bool) -> Result<Value, String> {
        self.prune();
        self.check_owner(&record.owner)?;
        if self.challenges.len() + self.tickets.len() + self.in_flight.len() >= MAX_PENDING {
            return Err("too many pending startup confirmations".into());
        }
        let id = nonce()?;
        if trusted {
            self.tickets.insert(id.clone(), record);
            Ok(json!({"ticket":id}))
        } else {
            let response = json!({"challengeId":id,"description":record.description,
                "canRemember":record.rememberable,"elevated":record.descriptor["elevated"]});
            self.challenges.insert(id, record);
            Ok(response)
        }
    }
    fn cancel(&mut self, owner: &str) -> Result<bool, String> {
        self.prune();
        if self.cancelled.len() >= MAX_GRANTS && !self.cancelled.contains_key(owner) {
            self.challenges.clear();
            self.tickets.clear();
            for (_, flight) in self.in_flight.drain() { flight.cancel.store(true, Ordering::Release); }
            self.blocked_until = Some(Instant::now() + LIFETIME);
            return Ok(true);
        }
        let flight = self.in_flight.remove(owner);
        let existed = flight.is_some() || self.challenges.values().chain(self.tickets.values()).any(|record| record.owner == owner);
        if let Some(flight) = flight { flight.cancel.store(true, Ordering::Release); }
        self.cancelled.insert(owner.to_owned(), Instant::now() + LIFETIME);
        self.challenges.retain(|_, record| record.owner != owner);
        self.tickets.retain(|_, record| record.owner != owner);
        Ok(existed)
    }
    fn take(&mut self, kind: &str, owner: &str, ticket: &str, original: &Value, auth: &AuthSource) -> Result<Record, String> {
        self.prune();
        self.check_owner(owner)?;
        let record = self.tickets.remove(ticket).ok_or("startup authorization is missing, expired or already used")?;
        if record.owner != owner || record.kind != kind || record.original != *original || record.auth != *auth {
            return Err("startup authorization does not match this request".into());
        }
        Ok(record)
    }
    fn review(&mut self, challenge: &str, allow: bool, elevated: bool) -> Result<Option<Record>, String> {
        self.prune();
        let record = self.challenges.remove(challenge).ok_or("startup confirmation expired or was cancelled")?;
        self.check_owner(&record.owner)?;
        if !allow { self.cancel(&record.owner)?; return Ok(None); }
        if record.descriptor["elevated"] != json!(elevated) { return Err("startup permission level changed".into()); }
        Ok(Some(record))
    }
}

fn gate() -> &'static Arc<Mutex<Gate>> {
    static GATE: OnceLock<Arc<Mutex<Gate>>> = OnceLock::new();
    GATE.get_or_init(|| Arc::new(Mutex::new(Gate::default())))
}

fn store_lock() -> &'static Mutex<()> {
    static LOCK: Mutex<()> = Mutex::new(());
    &LOCK
}

fn hex(bytes: &[u8]) -> String { bytes.iter().map(|byte| format!("{byte:02x}")).collect() }

#[cfg(windows)]
fn random_bytes() -> Result<[u8; 32], String> {
    use winapi::shared::bcrypt::{BCryptGenRandom, BCRYPT_USE_SYSTEM_PREFERRED_RNG};
    let mut bytes = [0; 32];
    let status = unsafe { BCryptGenRandom(std::ptr::null_mut(), bytes.as_mut_ptr(), bytes.len() as u32, BCRYPT_USE_SYSTEM_PREFERRED_RNG) };
    if status < 0 { Err("secure startup token generation failed".into()) } else { Ok(bytes) }
}

#[cfg(not(windows))]
fn random_bytes() -> Result<[u8; 32], String> { Err("execution authorization requires Windows".into()) }

pub fn nonce() -> Result<String, String> { Ok(hex(&random_bytes()?)) }

#[cfg(windows)]
fn known_folder(id: &winapi::shared::guiddef::GUID) -> Result<PathBuf, String> {
    use std::os::windows::ffi::OsStringExt;
    let mut ptr = std::ptr::null_mut();
    // DONT_VERIFY retrieves the account mapping without probing redirected storage.
    let result = unsafe { winapi::um::shlobj::SHGetKnownFolderPath(id, 0x4000, std::ptr::null_mut(), &mut ptr) };
    if result < 0 || ptr.is_null() { return Err("Windows account folder is unavailable".into()); }
    let path = unsafe {
        let mut len = 0;
        while *ptr.add(len) != 0 { len += 1; }
        let value = std::ffi::OsString::from_wide(std::slice::from_raw_parts(ptr, len));
        winapi::um::combaseapi::CoTaskMemFree(ptr.cast());
        PathBuf::from(value)
    };
    Ok(path)
}

fn git_bash_paths() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    for variable in ["ProgramFiles", "ProgramW6432"] {
        if let Some(value) = std::env::var_os(variable).filter(|value| !value.is_empty()) {
            roots.push(PathBuf::from(value));
        }
    }
    if roots.is_empty() { roots.push(PathBuf::from(r"C:\Program Files")); }
    if let Some(value) = std::env::var_os("ProgramFiles(x86)").filter(|value| !value.is_empty()) {
        roots.push(PathBuf::from(value));
    }
    let mut paths: Vec<PathBuf> = Vec::new();
    for root in roots {
        let path = root.join("Git/bin/bash.exe");
        if !paths.iter().any(|existing| path_key(existing) == path_key(&path)) { paths.push(path); }
    }
    paths
}

#[cfg(windows)]
fn context() -> Result<Context, String> {
    use winapi::um::knownfolders::{FOLDERID_LocalAppData, FOLDERID_Profile};
    use winapi::um::winnt::{TokenElevation, TOKEN_ELEVATION, TOKEN_QUERY};
    let mut token = std::ptr::null_mut();
    let opened = unsafe { winapi::um::processthreadsapi::OpenProcessToken(winapi::um::processthreadsapi::GetCurrentProcess(), TOKEN_QUERY, &mut token) };
    if opened == 0 { return Err("could not determine startup permission level".into()); }
    let mut elevation: TOKEN_ELEVATION = unsafe { std::mem::zeroed() };
    let mut size = 0;
    let ok = unsafe {
        let ok = winapi::um::securitybaseapi::GetTokenInformation(token, TokenElevation,
            (&mut elevation as *mut TOKEN_ELEVATION).cast(), std::mem::size_of::<TOKEN_ELEVATION>() as u32, &mut size);
        winapi::um::handleapi::CloseHandle(token);
        ok
    };
    if ok == 0 { return Err("could not determine startup permission level".into()); }
    let mut system = vec![0u16; 32768];
    let len = unsafe { winapi::um::sysinfoapi::GetSystemDirectoryW(system.as_mut_ptr(), system.len() as u32) } as usize;
    if len == 0 || len >= system.len() { return Err("Windows system directory is unavailable".into()); }
    Ok(Context {
        store: select_store(crate::background_e2e::execution_grant_store(), || {
            Ok(known_folder(&FOLDERID_LocalAppData)?.join("ZTerm").join("execution-trust.v1.bin"))
        })?,
        default_cwd: known_folder(&FOLDERID_Profile)?,
        system: PathBuf::from(String::from_utf16_lossy(&system[..len])),
        git_bash: git_bash_paths(),
        current: std::env::current_dir().map_err(|_| "current directory is unavailable")?,
        search: std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default()).collect(),
        elevated: elevation.TokenIsElevated != 0,
    })
}

fn select_store(background: Result<Option<PathBuf>, String>, account_store: impl FnOnce() -> Result<PathBuf, String>) -> Result<PathBuf, String> {
    match background? {
        Some(path) => Ok(path),
        None => account_store(),
    }
}

#[cfg(not(windows))]
fn context() -> Result<Context, String> { Err("execution authorization requires Windows".into()) }

fn local_path(path: &str, base: &Path) -> Result<PathBuf, String> {
    if path.is_empty() || path.contains('\0') { return Err("startup path is empty or invalid".into()); }
    let normalized = path.replace('/', "\\");
    let path = PathBuf::from(dos_path(&normalized)?);
    Ok(if path.is_absolute() { path } else { base.join(path) })
}

fn dos_path(path: &str) -> Result<&str, String> {
    if let Some(dos) = path.strip_prefix(r"\\?\") {
        if dos.len() >= 3 && dos.as_bytes()[0].is_ascii_alphabetic() && dos.as_bytes()[1] == b':' && dos.as_bytes()[2] == b'\\' { return Ok(dos); }
        return Err("network and device startup paths are not supported; select a local path".into());
    }
    if path.starts_with(r"\\") || path.starts_with(r"\??\") { return Err("network and device startup paths are not supported; select a local path".into()); }
    Ok(path)
}

fn on_local_volume<T>(kind: u32, action: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
    if ![2, 3, 5, 6].contains(&kind) { return Err("startup paths must use a local drive, not a network or unknown volume".into()); }
    action()
}

fn on_regular_node<T>(attributes: u32, action: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
    if attributes & 0x400 != 0 { return Err("startup paths through junctions, symlinks or cloud placeholders are not supported; select the real local path".into()); }
    action()
}

struct PinnedPath {
    path: PathBuf,
    file: Option<File>,
    // Denying write/delete sharing keeps checked ancestors from being replaced
    // by reparse points while a descendant is opened or the program is spawned.
    _ancestors: Vec<File>,
}

#[cfg(windows)]
fn full_local_path(path: &Path) -> Result<(PathBuf, u32), String> {
    use std::os::windows::ffi::{OsStrExt, OsStringExt};
    let input = path.to_str().ok_or("startup path is not valid Unicode")?.replace('/', "\\");
    let input = dos_path(&input)?;
    if input.contains('\0') { return Err("startup path contains a null character".into()); }
    let input: Vec<u16> = std::ffi::OsStr::new(input).encode_wide().chain(Some(0)).collect();
    let mut full = vec![0u16; 32768];
    let len = unsafe { winapi::um::fileapi::GetFullPathNameW(input.as_ptr(), full.len() as u32, full.as_mut_ptr(), std::ptr::null_mut()) } as usize;
    if len == 0 || len >= full.len() { return Err("startup path is invalid or too long".into()); }
    let full = PathBuf::from(std::ffi::OsString::from_wide(&full[..len]));
    let text = full.to_string_lossy();
    if text.len() < 3 || text.as_bytes()[1] != b':' || !text.as_bytes()[0].is_ascii_alphabetic() { return Err("startup paths must use a local drive".into()); }
    let root: Vec<u16> = text[..3].encode_utf16().chain(Some(0)).collect();
    let kind = unsafe { winapi::um::fileapi::GetDriveTypeW(root.as_ptr()) };
    Ok((full, kind))
}

#[cfg(windows)]
fn pin_local(path: &Path, directory: bool, allow_missing: bool, create: bool) -> Result<PinnedPath, String> {
    use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
    use std::path::Component;
    use winapi::um::winbase::{FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT};
    use winapi::um::winnt::{FILE_READ_ATTRIBUTES, FILE_SHARE_READ, GENERIC_READ};
    let (full, kind) = full_local_path(path)?;
    on_local_volume(kind, || {
        let mut pieces = Vec::new();
        let mut current = PathBuf::new();
        for component in full.components() {
            current.push(component.as_os_str());
            if matches!(component, Component::RootDir | Component::Normal(_)) { pieces.push(current.clone()); }
        }
        let mut ancestors = Vec::new();
        for (index, node) in pieces.iter().enumerate() {
            let last = index + 1 == pieces.len();
            let is_directory = !last || directory;
            let open = || {
                OpenOptions::new().read(true)
                    .access_mode(FILE_READ_ATTRIBUTES | if is_directory { 0 } else { GENERIC_READ })
                    .share_mode(FILE_SHARE_READ)
                    .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
                    .open(node)
            };
            let file = match open() {
                Ok(file) => file,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound && create && is_directory => {
                    match std::fs::create_dir(node) {
                        Ok(()) => {},
                        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {},
                        Err(_) => return Err("account authorization directory could not be created".into()),
                    }
                    open().map_err(|_| "local startup path could not be pinned")?
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound && allow_missing => {
                    return Ok(PinnedPath { path: full, file: None, _ancestors: ancestors });
                }
                Err(_) => return Err(format!("local startup path is unavailable or being changed: {}", node.display())),
            };
            let metadata = file.metadata().map_err(|_| "local startup metadata is unavailable")?;
            on_regular_node(metadata.file_attributes(), || Ok(()))?;
            if metadata.is_dir() != is_directory { return Err("startup path has an unexpected file type".into()); }
            if last { return Ok(PinnedPath { path: full, file: Some(file), _ancestors: ancestors }); }
            ancestors.push(file);
        }
        Err("startup path has no local components".into())
    })
}

#[cfg(not(windows))]
fn pin_local(_path: &Path, _directory: bool, _allow_missing: bool, _create: bool) -> Result<PinnedPath, String> {
    Err("execution authorization requires Windows".into())
}

fn canonical_local(path: &Path, directory: bool) -> Result<PathBuf, String> {
    Ok(pin_local(path, directory, false, false)?.path)
}

fn path_key(path: &Path) -> String {
    path.to_string_lossy().trim_start_matches(r"\\?\").replace('/', "\\").to_lowercase()
}

fn executable_file(path: &Path) -> Result<PinnedPath, String> {
    pin_local(path, false, false, false)
}

fn file_digest(file: &mut File) -> Result<String, String> {
    let size = file.metadata().map_err(|_| "executable metadata is unavailable")?.len();
    if size > MAX_EXECUTABLE_BYTES { return Err("executable exceeds the startup verification size limit".into()); }
    let mut digest = Sha256::new();
    let mut buffer = [0; 65536];
    loop {
        let read = file.read(&mut buffer).map_err(|_| "executable could not be verified")?;
        if read == 0 { break; }
        digest.update(&buffer[..read]);
    }
    Ok(hex(&digest.finalize()))
}

fn quoted(value: &str) -> String {
    let text = serde_json::to_string(value).unwrap_or_else(|_| "\"invalid\"".into());
    text.chars().map(|ch| match ch {
        '\u{200b}'..='\u{200f}' | '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}' | '\u{feff}' => format!("\\u{:04x}", ch as u32),
        _ => ch.to_string(),
    }).collect()
}

fn clean_original(payload: &Value) -> Value {
    let mut value = payload.clone();
    if let Some(object) = value.as_object_mut() {
        object.remove("executionOwner");
        object.remove("executionTicket");
    }
    value
}

fn make_record(kind: &str, owner: &str, payload: &Value, auth: AuthSource, context: &Context) -> Result<Record, String> {
    if !owner.starts_with(&format!("{kind}:")) || owner.len() > 256 || payload.to_string().len() > 262144 { return Err("invalid startup request".into()); }
    let original = clean_original(payload);
    let mut frozen = original.clone();
    let (descriptor, description, safe_builtin) = if kind == "local" {
        let shell = original.get("shell").and_then(Value::as_str).unwrap_or("powershell.exe");
        let shell_args = match original.get("args") {
            None | Some(Value::Null) => Vec::new(),
            Some(Value::Array(args)) => args.iter().map(|arg| arg.as_str().map(str::to_owned).ok_or("startup arguments must be strings")).collect::<Result<Vec<_>, _>>()?,
            _ => return Err("startup arguments must be an array".into()),
        };
        if shell_args.iter().any(|arg| arg.contains('\0')) || shell_args.iter().map(String::len).sum::<usize>() > 32768 { return Err("startup arguments are invalid or too long".into()); }
        let cwd = match original.get("cwd").and_then(Value::as_str).filter(|value| !value.is_empty()) {
            Some(path) => canonical_local(&local_path(path, &context.current)?, true)?,
            None => canonical_local(&context.default_cwd, true)?,
        };
        let lower = shell.to_ascii_lowercase();
        let program = match lower.as_str() {
            "powershell" | "powershell.exe" => context.system.join("WindowsPowerShell/v1.0/powershell.exe"),
            "cmd" | "cmd.exe" => context.system.join("cmd.exe"),
            _ => {
                if shell.contains(['/', '\\', ':']) { local_path(shell, &context.current)? }
                else {
                    context.search.iter().filter_map(|dir| local_path(&dir.to_string_lossy(), &context.current).ok())
                        .flat_map(|dir| [dir.join(shell), dir.join(format!("{shell}.exe"))])
                        .find_map(|path| executable_file(&path).ok().map(|file| file.path))
                        .ok_or("startup executable was not found in verified local PATH entries; use an absolute local path")?
                }
            }
        };
        let program = canonical_local(&program, false)?;
        let is_powershell = path_key(&program) == path_key(&context.system.join("WindowsPowerShell/v1.0/powershell.exe"));
        let is_cmd = path_key(&program) == path_key(&context.system.join("cmd.exe"));
        let is_git_bash = context.git_bash.iter().any(|path| path_key(&program) == path_key(path));
        let harmless_system_args = shell_args.iter().all(|arg| {
            let arg = arg.to_ascii_lowercase();
            (is_powershell && ["-noprofile", "-nologo", "-noexit"].contains(&arg.as_str())) || (is_cmd && ["/d", "/q"].contains(&arg.as_str()))
        });
        let harmless_git_args = shell_args.iter().all(|arg| ["-i", "-l", "--login", "-il", "-li"].contains(&arg.as_str()));
        let safe = (((is_powershell || is_cmd) && harmless_system_args) || (is_git_bash && harmless_git_args)) && path_key(&cwd) == path_key(&context.default_cwd);
        let digest = if safe { None } else { Some(file_digest(executable_file(&program)?.file.as_mut().ok_or("missing executable")?)?) };
        frozen["shell"] = json!(program.to_string_lossy());
        frozen["args"] = json!(shell_args);
        frozen["cwd"] = json!(cwd.to_string_lossy());
        let mut description = format!("共享启动配置需要本账户确认。\n程序：{}\n参数：{}\n目录：{}{}",
            quoted(&program.to_string_lossy()), shell_args.iter().map(|arg| quoted(arg)).collect::<Vec<_>>().join(" "), quoted(&cwd.to_string_lossy()),
            if context.elevated { "\n将以管理员权限运行；授权仅限本次。" } else if safe { "\n如需以后自动启动，可选择记住此配置；更改后会再次确认。" } else { "" });
        if !safe { description.push_str("\n自定义本地启动的授权仅限本次；标准 shell 可直接启动，SSH 连接可记住授权。"); }
        (json!({"version":1,"kind":"local","program":path_key(&program),"image":digest,"args":shell_args,"cwd":path_key(&cwd),"elevated":context.elevated}), description, safe)
    } else if kind == "ssh" {
        let host = original.get("host").and_then(Value::as_str).unwrap_or("").trim();
        let username = original.get("username").and_then(Value::as_str).unwrap_or("").trim();
        if host.is_empty() || username.is_empty() || host.contains('\0') || username.contains('\0') { return Err("SSH startup requires a host and username".into()); }
        let port = crate::zterm::parse_ssh_port(&original)?;
        if let Some(key) = auth.identity.get("keyPath").and_then(Value::as_str).filter(|key| !key.is_empty()) {
            local_path(key, &context.current)?;
        }
        let scripts = original.get("loginScripts").cloned().unwrap_or(json!([]));
        if !scripts.is_array() || scripts.as_array().unwrap().len() > 128 { return Err("invalid SSH startup scripts".into()); }
        let script_text = scripts.as_array().unwrap().iter().enumerate().map(|(index, script)| {
            format!("脚本 {} [{}，{}]：等待 {} → 发送 {}", index + 1,
                if script.get("isRegex").and_then(Value::as_bool).unwrap_or(false) { "正则" } else { "文本" },
                if script.get("optional").and_then(Value::as_bool).unwrap_or(false) { "可选" } else { "必需" },
                quoted(script.get("expect").and_then(Value::as_str).unwrap_or("")),
                quoted(script.get("send").and_then(Value::as_str).unwrap_or("")))
        }).collect::<Vec<_>>().join("\n");
        frozen["host"] = json!(host);
        frozen["username"] = json!(username);
        frozen["port"] = json!(port);
        let description = format!("共享连接配置需要本账户确认。\n地址：{}:{}\n用户：{}\n密钥路径：{}\n目录跟随：{}\n登录脚本：{}{}{}",
            quoted(host), port, quoted(username), quoted(auth.identity.get("keyPath").and_then(Value::as_str).unwrap_or("无")),
            if original.get("followCwd").and_then(Value::as_bool).unwrap_or(false) { "开启" } else { "关闭" }, scripts.as_array().unwrap().len(),
            if script_text.is_empty() { String::new() } else { format!("\n{script_text}") },
            if context.elevated || !auth.rememberable { "\n此授权仅限本次；密码和私钥内容不会显示或保存到授权记录。" } else { "\n可选择记住此连接及启动脚本；更改后会再次确认。" });
        (json!({"version":1,"kind":"ssh","host":host.to_lowercase(),"port":port,"username":username,
            "scripts":scripts,"followCwd":original.get("followCwd").and_then(Value::as_bool).unwrap_or(false),
            "auth":auth.identity,"elevated":context.elevated}), description, false)
    } else { return Err("unknown startup kind".into()); };
    if description.len() > 65536 { return Err("startup description is too large to review".into()); }
    Ok(Record { owner: owner.into(), kind: kind.into(), original, frozen, descriptor, description, auth: auth.clone(),
        safe_builtin, rememberable: !context.elevated && auth.rememberable && (kind != "local" || safe_builtin), expires: Instant::now() + LIFETIME })
}

fn load_database(path: &Path) -> Result<Option<Database>, String> {
    let mut pinned = pin_local(path, false, true, false)?;
    let Some(file) = pinned.file.as_mut() else { return Ok(None); };
    if file.metadata().map_err(|_| "invalid account authorization file")?.len() > 4 * 1024 * 1024 { return Err("invalid account authorization file".into()); }
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes).map_err(|_| "account startup authorizations could not be read")?;
    let plaintext = crate::zterm::dpapi_decrypt(&bytes).map_err(|_| "account startup authorizations could not be verified")?;
    let database: Database = serde_json::from_slice(&plaintext).map_err(|_| "invalid account authorization file")?;
    if database.version != 1 || database.key.len() != 32 || database.grants.len() > MAX_GRANTS { return Err("invalid account authorization file".into()); }
    Ok(Some(database))
}

fn save_database(path: &Path, database: &Database) -> Result<(), String> {
    let plaintext = serde_json::to_string(database).map_err(|_| "could not encode startup authorizations")?;
    let bytes = crate::zterm::dpapi_encrypt(&plaintext).map_err(|_| "could not protect startup authorizations")?;
    let parent = path.parent().ok_or("invalid account authorization directory")?;
    let _directory = pin_local(parent, true, false, true)?;
    let temp = parent.join(format!("execution-trust-{}.tmp", nonce()?));
    use std::io::Write;
    let result = (|| {
        let mut file = OpenOptions::new().write(true).create_new(true).open(&temp)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        std::fs::rename(&temp, path)
    })();
    if result.is_err() { let _ = std::fs::remove_file(&temp); }
    result.map_err(|_| "could not save account startup authorizations".into())
}

pub fn prepare(kind: &str, owner: &str, payload: &Value, auth: AuthSource) -> Result<Value, String> {
    let context = context()?;
    prepare_record(make_record(kind, owner, payload, auth, &context)?, &context.store, gate())
}

fn prepare_record(mut record: Record, store: &Path, registry: &Mutex<Gate>) -> Result<Value, String> {
    // Safe, code-defined bootstrap never reads or writes an account grant file.
    let mut trusted = record.safe_builtin;
    if !trusted && record.rememberable {
        let _lock = store_lock().lock();
        match load_database(store) {
            Ok(Some(database)) => trusted = database.grants.contains(&database.fingerprint(&record.descriptor)?),
            Ok(None) => {}
            Err(_) => { record.rememberable = false; record.description.push_str("\n已有授权记录不可用，此次不会记忆授权。"); }
        }
    }
    registry.lock().insert(record, trusted)
}

pub fn decide(challenge: &str, allow: bool, remember: bool) -> Result<Value, String> {
    let context = context()?;
    decide_record(challenge, allow, remember, &context, gate())
}

fn decide_record(challenge: &str, allow: bool, remember: bool, context: &Context, registry: &Mutex<Gate>) -> Result<Value, String> {
    let mut gate = registry.lock();
    let Some(record) = gate.review(challenge, allow, context.elevated)? else { return Ok(json!({"cancelled":true})); };
    let mut warning = None;
    if remember && record.rememberable {
        let _lock = store_lock().lock();
        let save = (|| {
            let mut database = match load_database(&context.store)? { Some(database) => database, None => Database::new()? };
            let fingerprint = database.fingerprint(&record.descriptor)?;
            if !database.grants.contains(&fingerprint) {
                if database.grants.len() == MAX_GRANTS { database.grants.remove(0); }
                database.grants.push(fingerprint);
            }
            save_database(&context.store, &database)
        })();
        if save.is_err() { warning = Some("本次已允许，但未能记住启动授权；下次仍会询问"); }
    }
    let mut result = gate.insert(record, true)?;
    if let Some(warning) = warning { result["warning"] = json!(warning); }
    Ok(result)
}

pub fn cancel(owner: &str) -> Result<bool, String> {
    if owner.is_empty() || owner.len() > 256 { return Err("invalid startup owner".into()); }
    gate().lock().cancel(owner)
}

struct ExecutionGuard {
    registry: Arc<Mutex<Gate>>,
    owner: String,
    generation: String,
    cancel: Arc<AtomicBool>,
}

impl ExecutionGuard {
    fn start<T>(&self, launch: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
        let mut registry = self.registry.lock();
        registry.prune();
        registry.check_owner(&self.owner)?;
        let flight = registry.in_flight.get_mut(&self.owner).filter(|flight| flight.generation == self.generation)
            .ok_or("startup authorization is no longer active")?;
        if flight.started || flight.cancel.load(Ordering::Acquire) { return Err("startup authorization was cancelled or already started".into()); }
        flight.started = true;
        // This synchronous callback is the launch decision. Holding the same
        // mutex as cancel makes their order final; no await may run here.
        // A later cancellation cannot undo a process that already started.
        launch()
    }
}

impl Drop for ExecutionGuard {
    fn drop(&mut self) {
        let mut registry = self.registry.lock();
        if registry.in_flight.get(&self.owner).is_some_and(|flight| flight.generation == self.generation) {
            registry.in_flight.remove(&self.owner);
        }
    }
}

struct ConsumedExecution {
    record: Record,
    authorization: ExecutionGuard,
}

fn consume_from(registry: Arc<Mutex<Gate>>, kind: &str, owner: &str, ticket: &str, payload: &Value, auth: &AuthSource, elevated: bool) -> Result<ConsumedExecution, String> {
    let cancel = Arc::new(AtomicBool::new(false));
    let record = {
        let mut state = registry.lock();
        let record = state.take(kind, owner, ticket, &clean_original(payload), auth)?;
        if record.descriptor["elevated"] != json!(elevated) { return Err("startup permission level changed".into()); }
        if let Some(previous) = state.in_flight.insert(owner.into(), InFlight {
            generation: ticket.into(), cancel: Arc::clone(&cancel), expires: record.expires, started: false,
        }) { previous.cancel.store(true, Ordering::Release); }
        record
    };
    let authorization = ExecutionGuard { registry, owner: owner.into(), generation: ticket.into(), cancel };
    Ok(ConsumedExecution { record, authorization })
}

fn consume(kind: &str, owner: &str, ticket: &str, payload: &Value, auth: &AuthSource) -> Result<ConsumedExecution, String> {
    consume_from(Arc::clone(gate()), kind, owner, ticket, payload, auth, context()?.elevated)
}

pub struct LocalExecution {
    pub payload: Value,
    authorization: ExecutionGuard,
    // Denying write/delete sharing pins the verified executable through spawn.
    _image_guard: PinnedPath,
    _directory_guard: PinnedPath,
}

impl LocalExecution {
    pub fn start<T>(&self, launch: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
        self.authorization.start(launch)
    }
}

pub fn take_local(payload: &Value) -> Result<LocalExecution, String> {
    let owner = payload.get("executionOwner").and_then(Value::as_str).unwrap_or("");
    let ticket = payload.get("executionTicket").and_then(Value::as_str).unwrap_or("");
    verify_local(consume("local", owner, ticket, payload, &AuthSource::none())?)
}

fn verify_local(consumed: ConsumedExecution) -> Result<LocalExecution, String> {
    verify_local_with_checkpoint(consumed, || {})
}

fn verify_local_with_checkpoint(consumed: ConsumedExecution, before_digest: impl FnOnce()) -> Result<LocalExecution, String> {
    let ConsumedExecution { record, authorization } = consumed;
    let program = record.frozen["shell"].as_str().ok_or("invalid approved executable")?;
    let cwd = record.frozen["cwd"].as_str().ok_or("invalid approved directory")?;
    let directory = pin_local(Path::new(cwd), true, false, false)?;
    let mut image = executable_file(Path::new(program))?;
    before_digest();
    if let Some(expected) = record.descriptor["image"].as_str() {
        if file_digest(image.file.as_mut().ok_or("missing executable")?)? != expected { return Err("the executable changed after confirmation; open the terminal again to review it".into()); }
    }
    Ok(LocalExecution { payload: record.frozen, authorization, _image_guard: image, _directory_guard: directory })
}

pub struct SshExecution {
    pub payload: Value,
    authorization: ExecutionGuard,
}

impl SshExecution {
    fn from_consumed(consumed: ConsumedExecution) -> Self {
        Self { payload: consumed.record.frozen, authorization: consumed.authorization }
    }
    pub fn start<T>(&self, register: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
        self.authorization.start(register)
    }
    pub fn cancel_flag(&self) -> Arc<AtomicBool> { Arc::clone(&self.authorization.cancel) }
}

pub fn take_ssh(profile: &Value, owner: &str, ticket: &str, auth: &AuthSource) -> Result<SshExecution, String> {
    Ok(SshExecution::from_consumed(consume("ssh", owner, ticket, profile, auth)?))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    struct Fixture { root: PathBuf, context: Context, program: PathBuf }
    impl Fixture {
        fn new() -> Self {
            let checkout = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap().canonicalize().unwrap();
            let scratch = checkout.join("artifacts/e2e-tmp");
            std::fs::create_dir_all(&scratch).unwrap();
            let scratch = scratch.canonicalize().unwrap();
            assert!(scratch.starts_with(&checkout));
            let root = scratch.join(format!("execution-trust-{}-{}", std::process::id(), nonce().unwrap()));
            std::fs::create_dir(&root).unwrap();
            let home = root.join("home");
            let system = root.join("system");
            std::fs::create_dir_all(system.join("WindowsPowerShell/v1.0")).unwrap();
            std::fs::create_dir(&home).unwrap();
            std::fs::write(system.join("cmd.exe"), b"inert system cmd fixture").unwrap();
            std::fs::write(system.join("WindowsPowerShell/v1.0/powershell.exe"), b"inert system shell fixture").unwrap();
            let program = root.join("custom shell.exe");
            std::fs::write(&program, b"inert executable fixture; never launched").unwrap();
            let git_bash = root.join("Program Files/Git/bin/bash.exe");
            let git_bash_x86 = root.join("Program Files (x86)/Git/bin/bash.exe");
            for path in [&git_bash, &git_bash_x86] {
                std::fs::create_dir_all(path.parent().unwrap()).unwrap();
                std::fs::write(path, b"inert Git Bash fixture").unwrap();
            }
            let context = Context { store: root.join("account/grants.bin"), default_cwd: home,
                system, git_bash: vec![git_bash, git_bash_x86], current: root.clone(), search: vec![root.clone()], elevated: false };
            Self { root, context, program }
        }
        fn local(&self, owner: &str) -> Record {
            make_record("local", owner, &json!({"shell":self.program,"args":["--fixture"],"requestId":"view"}), AuthSource::none(), &self.context).unwrap()
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let expected = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap().join("artifacts/e2e-tmp").canonicalize().unwrap();
            if let Ok(path) = self.root.canonicalize() {
                if path.parent() == Some(expected.as_path()) { let _ = std::fs::remove_dir_all(path); }
            }
        }
    }

    fn consume_fixture(record: Record) -> (Arc<Mutex<Gate>>, ConsumedExecution) {
        let registry = Arc::new(Mutex::new(Gate::default()));
        let consumed = consume_fixture_in(Arc::clone(&registry), record);
        (registry, consumed)
    }

    fn consume_fixture_in(registry: Arc<Mutex<Gate>>, record: Record) -> ConsumedExecution {
        let owner = record.owner.clone();
        let kind = record.kind.clone();
        let payload = record.original.clone();
        let auth = record.auth.clone();
        let ticket = registry.lock().insert(record, true).unwrap()["ticket"].as_str().unwrap().to_owned();
        consume_from(registry, &kind, &owner, &ticket, &payload, &auth, false).unwrap()
    }

    #[test]
    fn execution_trust_system_bootstrap_is_exact_and_does_not_need_a_store() {
        let fixture = Fixture::new();
        let record = make_record("local", "local:bootstrap", &json!({"shell":"powershell.exe","args":["-NoProfile"]}), AuthSource::none(), &fixture.context).unwrap();
        assert!(record.safe_builtin);
        assert!(Path::new(record.frozen["shell"].as_str().unwrap()).is_absolute());
        assert!(!fixture.context.store.exists());
        for args in [json!(["-Command","Write-Output fixture"]), json!(["/c","fixture"])] {
            let record = make_record("local", "local:custom", &json!({"shell":"powershell.exe","args":args}), AuthSource::none(), &fixture.context).unwrap();
            assert!(!record.safe_builtin);
        }
        let cwd = fixture.root.join("another"); std::fs::create_dir(&cwd).unwrap();
        assert!(!make_record("local", "local:cwd", &json!({"shell":"cmd.exe","args":["/d"],"cwd":cwd}), AuthSource::none(), &fixture.context).unwrap().safe_builtin);
    }

    #[test]
    fn execution_trust_custom_local_launches_are_one_time_even_when_remember_requested() {
        let fixture = Fixture::new();
        let registry = Mutex::new(Gate::default());
        let record = fixture.local("local:custom-decision");
        assert!(!record.safe_builtin);
        assert!(!record.rememberable);
        assert!(record.description.contains("自定义本地启动的授权仅限本次；标准 shell 可直接启动，SSH 连接可记住授权。"));
        assert!(!record.description.contains("可选择记住此配置"));
        let original = record.original.clone();
        let challenge = prepare_record(record, &fixture.context.store, &registry).unwrap();
        assert_eq!(challenge["canRemember"], json!(false));
        assert!(challenge.get("ticket").is_none());
        let approved = decide_record(challenge["challengeId"].as_str().unwrap(), true, true, &fixture.context, &registry).unwrap();
        let ticket = approved["ticket"].as_str().unwrap().to_owned();
        assert!(!ticket.is_empty());
        assert!(!fixture.context.store.exists());
        registry.lock().take("local", "local:custom-decision", &ticket, &original, &AuthSource::none()).unwrap();
        assert!(registry.lock().take("local", "local:custom-decision", &ticket, &original, &AuthSource::none()).is_err());
        assert!(!fixture.context.store.exists());
    }

    #[test]
    fn execution_trust_powershell_file_is_a_one_time_custom_local_launch() {
        let fixture = Fixture::new();
        let record = make_record("local", "local:powershell-file", &json!({"shell":"powershell.exe","args":["-File","x.ps1"]}), AuthSource::none(), &fixture.context).unwrap();
        assert!(!record.safe_builtin);
        assert!(!record.rememberable);
        assert!(record.description.contains("自定义本地启动的授权仅限本次"));
    }

    #[test]
    fn execution_trust_only_program_files_git_bash_harmless_args_are_safe_builtin() {
        let fixture = Fixture::new();
        let cases = [json!([]), json!(["-i","-l"]), json!(["--login"]), json!(["-il"]), json!(["-li"])];
        for (path_index, program) in fixture.context.git_bash.clone().into_iter().enumerate() {
            for (arg_index, args) in cases.clone().into_iter().enumerate() {
                let record = make_record("local", &format!("local:git-{path_index}-{arg_index}"), &json!({"shell":program.clone(),"args":args}), AuthSource::none(), &fixture.context).unwrap();
                assert!(record.safe_builtin);
                assert!(record.rememberable);
                let response = prepare_record(record, &fixture.context.store, &Mutex::new(Gate::default())).unwrap();
                assert!(response.get("ticket").is_some());
                assert!(response.get("challengeId").is_none());
                assert!(!fixture.context.store.exists());
            }
        }
        let program = fixture.context.git_bash[0].clone();
        let record = make_record("local", "local:git-command", &json!({"shell":program.clone(),"args":["-c","echo hi"]}), AuthSource::none(), &fixture.context).unwrap();
        assert!(!record.safe_builtin);
        assert!(!record.rememberable);
        let cwd = fixture.root.join("git-cwd");
        std::fs::create_dir(&cwd).unwrap();
        let record = make_record("local", "local:git-cwd", &json!({"shell":program,"args":["-i"],"cwd":cwd}), AuthSource::none(), &fixture.context).unwrap();
        assert!(!record.safe_builtin);
        assert!(!record.rememberable);
        let other_bash = fixture.root.join("bash.exe");
        std::fs::write(&other_bash, b"inert non-standard bash fixture").unwrap();
        let record = make_record("local", "local:other-bash", &json!({"shell":other_bash,"args":["-i","-l"]}), AuthSource::none(), &fixture.context).unwrap();
        assert!(!record.safe_builtin);
        assert!(!record.rememberable);
    }

    #[test]
    fn execution_trust_legacy_custom_local_grants_are_inert() {
        let fixture = Fixture::new();
        let record = fixture.local("local:legacy-grant");
        let mut database = Database::new().unwrap();
        database.grants.push(database.fingerprint(&record.descriptor).unwrap());
        save_database(&fixture.context.store, &database).unwrap();
        let response = prepare_record(record, &fixture.context.store, &Mutex::new(Gate::default())).unwrap();
        assert!(response.get("challengeId").is_some());
        assert!(response.get("ticket").is_none());
        assert_eq!(response["canRemember"], json!(false));
    }

    #[test]
    fn execution_trust_ssh_definitions_remain_rememberable() {
        let fixture = Fixture::new();
        let auth = AuthSource { identity: json!({"kind":"key","keyPath":"","credentialId":"fixture-provenance"}), rememberable: true };
        let profile = json!({"host":"192.0.2.10","port":22,"username":"fixture","followCwd":false,"loginScripts":[]});
        let record = make_record("ssh", "ssh:remembered", &profile, auth, &fixture.context).unwrap();
        assert!(record.rememberable);
        let mut database = Database::new().unwrap();
        database.grants.push(database.fingerprint(&record.descriptor).unwrap());
        save_database(&fixture.context.store, &database).unwrap();
        let response = prepare_record(record, &fixture.context.store, &Mutex::new(Gate::default())).unwrap();
        assert!(response.get("ticket").is_some());
        assert!(response.get("challengeId").is_none());
    }

    #[test]
    fn execution_trust_safe_builtin_system_shells_remain_tickets_without_dialogs() {
        let fixture = Fixture::new();
        for (index, (shell, args)) in [("powershell.exe", json!(["-NoProfile","-NoLogo"])), ("cmd.exe", json!(["/d","/q"]))].into_iter().enumerate() {
            let record = make_record("local", &format!("local:safe-system-{index}"), &json!({"shell":shell,"args":args}), AuthSource::none(), &fixture.context).unwrap();
            assert!(record.safe_builtin);
            assert!(record.rememberable);
            let response = prepare_record(record, &fixture.context.store, &Mutex::new(Gate::default())).unwrap();
            assert!(response.get("ticket").is_some());
            assert!(response.get("challengeId").is_none());
        }
        assert!(!fixture.context.store.exists());
    }

    #[test]
    fn execution_trust_background_selection_never_probes_the_account_store() {
        let reads = Cell::new(0);
        let isolated = PathBuf::from(r"D:\inert-owned-sandbox\execution-trust.v1.bin");
        assert_eq!(select_store(Ok(Some(isolated.clone())), || { reads.set(reads.get() + 1); Err("account store must not be queried".into()) }).unwrap(), isolated);
        assert!(select_store(Err("invalid background runtime".into()), || { reads.set(reads.get() + 1); Ok(PathBuf::new()) }).is_err());
        assert_eq!(reads.get(), 0);
        let normal = select_store(Ok(None), || { reads.set(reads.get() + 1); Ok(PathBuf::from(r"D:\inert-account-store")) }).unwrap();
        assert_eq!(normal, PathBuf::from(r"D:\inert-account-store"));
        assert_eq!(reads.get(), 1);
    }

    #[test]
    fn execution_trust_isolated_store_does_not_bypass_confirmation_or_tickets() {
        let fixture = Fixture::new();
        let registry = Mutex::new(Gate::default());
        let record = make_record("ssh", "ssh:isolated", &json!({"host":"192.0.2.10","port":22,"username":"fixture"}), AuthSource::none(), &fixture.context).unwrap();
        let original = record.original.clone();
        let response = prepare_record(record, &fixture.context.store, &registry).unwrap();
        assert!(response.get("ticket").is_none());
        assert!(registry.lock().take("ssh", "ssh:isolated", response["challengeId"].as_str().unwrap(), &original, &AuthSource::none()).is_err());
        let approved = registry.lock().review(response["challengeId"].as_str().unwrap(), true, false).unwrap().unwrap();
        let ticket = registry.lock().insert(approved, true).unwrap()["ticket"].as_str().unwrap().to_owned();
        assert!(registry.lock().take("ssh", "ssh:isolated", &ticket, &original, &AuthSource::none()).is_ok());
        assert!(registry.lock().take("ssh", "ssh:isolated", &ticket, &original, &AuthSource::none()).is_err());
        assert!(!fixture.context.store.exists());
    }

    #[test]
    fn execution_trust_unapproved_challenge_never_becomes_a_ticket_implicitly() {
        let fixture = Fixture::new();
        let record = fixture.local("local:one");
        let original = record.original.clone();
        let mut gate = Gate::default();
        let challenge = gate.insert(record, false).unwrap();
        assert!(challenge.get("ticket").is_none());
        assert!(gate.take("local", "local:one", challenge["challengeId"].as_str().unwrap(), &original, &AuthSource::none()).is_err());
        assert!(gate.tickets.is_empty());
    }

    #[test]
    fn execution_trust_approval_is_one_use_owner_bound_and_payload_bound() {
        let fixture = Fixture::new();
        let mut gate = Gate::default();
        let record = fixture.local("local:one");
        let original = record.original.clone();
        let response = gate.insert(record, false).unwrap();
        let id = response["challengeId"].as_str().unwrap();
        let approved = gate.review(id, true, false).unwrap().unwrap();
        assert!(gate.review(id, true, false).is_err());
        let ticket = gate.insert(approved, true).unwrap()["ticket"].as_str().unwrap().to_owned();
        let frozen = gate.take("local", "local:one", &ticket, &original, &AuthSource::none()).unwrap();
        assert_eq!(frozen.frozen["args"], json!(["--fixture"]));
        assert!(gate.take("local", "local:one", &ticket, &original, &AuthSource::none()).is_err());
        for wrong_owner in [false, true] {
            let record = fixture.local("local:next");
            let mut altered = record.original.clone();
            if !wrong_owner { altered["args"] = json!(["--changed-after-confirmation"]); }
            let ticket = gate.insert(record, true).unwrap()["ticket"].as_str().unwrap().to_owned();
            assert!(gate.take("local", if wrong_owner {"local:other"} else {"local:next"}, &ticket, &altered, &AuthSource::none()).is_err());
        }
    }

    #[test]
    fn execution_trust_cancel_before_prepare_after_prepare_and_after_approval_is_final() {
        let fixture = Fixture::new();
        let mut gate = Gate::default();
        gate.cancel("local:before").unwrap();
        assert!(gate.insert(fixture.local("local:before"), false).is_err());
        let record = fixture.local("local:waiting");
        let challenge = gate.insert(record, false).unwrap();
        gate.cancel("local:waiting").unwrap();
        assert!(gate.review(challenge["challengeId"].as_str().unwrap(), true, false).is_err());
        let record = fixture.local("local:approved");
        let original = record.original.clone();
        let ticket = gate.insert(record, true).unwrap()["ticket"].as_str().unwrap().to_owned();
        gate.cancel("local:approved").unwrap();
        assert!(gate.take("local", "local:approved", &ticket, &original, &AuthSource::none()).is_err());
    }

    #[test]
    fn execution_trust_expiry_elevation_and_capacity_fail_closed() {
        let fixture = Fixture::new();
        let mut gate = Gate::default();
        let challenge = gate.insert(fixture.local("local:expired"), false).unwrap();
        let id = challenge["challengeId"].as_str().unwrap();
        gate.challenges.get_mut(id).unwrap().expires = Instant::now() - Duration::from_secs(1);
        assert!(gate.review(id, true, false).is_err());
        let challenge = gate.insert(fixture.local("local:elevation"), false).unwrap();
        assert!(gate.review(challenge["challengeId"].as_str().unwrap(), true, true).is_err());
        let template = fixture.local("local:capacity");
        for index in 0..MAX_PENDING {
            let mut record = template.clone(); record.owner = format!("local:{index}");
            gate.insert(record, false).unwrap();
        }
        assert!(gate.insert(template, false).is_err());
    }

    #[test]
    fn execution_trust_changed_executable_cannot_run_the_checked_snapshot() {
        let fixture = Fixture::new();
        let record = fixture.local("local:changed");
        std::fs::write(&fixture.program, b"changed executable bytes").unwrap();
        assert!(verify_local(consume_fixture(record).1).is_err());
        let record = fixture.local("local:pinned");
        let verified = verify_local(consume_fixture(record).1).unwrap();
        assert!(std::fs::write(&fixture.program, b"cannot replace while verified").is_err());
        drop(verified);
        std::fs::write(&fixture.program, b"released after launch scope").unwrap();
    }

    #[test]
    fn execution_trust_cancel_during_local_verification_prevents_launch() {
        let fixture = Fixture::new();
        let (registry, consumed) = consume_fixture(fixture.local("local:verify"));
        let execution = verify_local_with_checkpoint(consumed, || { registry.lock().cancel("local:verify").unwrap(); }).unwrap();
        let launches = Cell::new(0);
        let result = execution.start(|| { launches.set(launches.get() + 1); Ok(()) });
        assert_eq!(launches.get(), 0, "cancellation during verification must prevent the spawn callback");
        assert!(result.is_err());
    }

    #[test]
    fn execution_trust_cancel_immediately_before_local_spawn_prevents_launch() {
        let fixture = Fixture::new();
        let (registry, consumed) = consume_fixture(fixture.local("local:spawn"));
        let execution = verify_local(consumed).unwrap();
        registry.lock().cancel("local:spawn").unwrap();
        let launches = Cell::new(0);
        let result = execution.start(|| { launches.set(launches.get() + 1); Ok(()) });
        assert_eq!(launches.get(), 0, "cancellation after verification must prevent the spawn callback");
        assert!(result.is_err());
    }

    #[test]
    fn execution_trust_cancel_before_ssh_registration_prevents_start() {
        let fixture = Fixture::new();
        let record = make_record("ssh", "ssh:register", &json!({"host":"192.0.2.10","port":22,"username":"fixture"}), AuthSource::none(), &fixture.context).unwrap();
        let (registry, consumed) = consume_fixture(record);
        let execution = SshExecution::from_consumed(consumed);
        registry.lock().cancel("ssh:register").unwrap();
        let starts = Cell::new(0);
        let pending = Arc::new(Mutex::new(HashMap::new()));
        let result = execution.start(|| {
            starts.set(starts.get() + 1);
            Ok(crate::zterm::PendingGuard::with_cancel_flag(Arc::clone(&pending), "register".into(), "ssh_fixture".into(), execution.cancel_flag()))
        });
        assert_eq!(starts.get(), 0, "a canceled consumed ticket must not register or start SSH");
        assert!(result.is_err());
        assert!(pending.lock().is_empty());
    }

    #[test]
    fn execution_trust_ssh_handoff_retains_the_same_cancellation_flag() {
        let fixture = Fixture::new();
        let record = make_record("ssh", "ssh:handoff", &json!({"host":"192.0.2.10","port":22,"username":"fixture"}), AuthSource::none(), &fixture.context).unwrap();
        let (registry, consumed) = consume_fixture(record);
        let execution = SshExecution::from_consumed(consumed);
        let pending = Arc::new(Mutex::new(HashMap::new()));
        let guard = execution.start(|| Ok(crate::zterm::PendingGuard::with_cancel_flag(
            Arc::clone(&pending), "handoff".into(), "ssh_fixture".into(), execution.cancel_flag()))).unwrap();
        registry.lock().cancel("ssh:handoff").unwrap();
        assert!(guard.cancel_flag().load(Ordering::Relaxed), "trust cancellation must reach the registered SSH attempt");
    }

    #[test]
    fn execution_trust_launch_decision_serializes_with_cancel_and_is_one_use() {
        let fixture = Fixture::new();
        let (registry, consumed) = consume_fixture(fixture.local("local:decision"));
        let execution = verify_local(consumed).unwrap();
        let launches = Cell::new(0);
        let mut cancellation = None;
        execution.start(|| {
            assert!(registry.try_lock().is_none(), "the final decision must hold cancel's mutex");
            let registry = Arc::clone(&registry);
            let (enter, entered) = std::sync::mpsc::channel();
            cancellation = Some(std::thread::spawn(move || {
                enter.send(()).unwrap();
                registry.lock().cancel("local:decision").unwrap()
            }));
            entered.recv().unwrap();
            launches.set(launches.get() + 1);
            Ok(())
        }).unwrap();
        assert!(cancellation.unwrap().join().unwrap());
        assert_eq!(launches.get(), 1, "a decision that wins cannot be undone by later cancellation");
        assert!(execution.start(|| { launches.set(launches.get() + 1); Ok(()) }).is_err());
        assert_eq!(launches.get(), 1);
    }

    #[test]
    fn execution_trust_old_guard_cannot_remove_a_successor_generation() {
        let fixture = Fixture::new();
        let (registry, previous) = consume_fixture(fixture.local("local:reused"));
        let successor = consume_fixture_in(Arc::clone(&registry), fixture.local("local:reused"));
        let generation = successor.authorization.generation.clone();
        assert!(previous.authorization.cancel.load(Ordering::Acquire));
        assert!(previous.authorization.start(|| Ok(())).is_err());
        drop(previous);
        assert_eq!(registry.lock().in_flight["local:reused"].generation, generation);
        let execution = verify_local(successor).unwrap();
        execution.start(|| Ok(())).unwrap();
        drop(execution);
        assert!(registry.lock().in_flight.is_empty());
    }

    #[test]
    fn execution_trust_verification_failure_releases_its_registration() {
        let fixture = Fixture::new();
        let (registry, consumed) = consume_fixture(fixture.local("local:failed-verification"));
        assert_eq!(registry.lock().in_flight.len(), 1);
        std::fs::write(&fixture.program, b"changed before verification").unwrap();
        assert!(verify_local(consumed).is_err());
        assert!(registry.lock().in_flight.is_empty());
    }

    #[test]
    fn execution_trust_ssh_descriptor_changes_require_new_account_keyed_grants() {
        let fixture = Fixture::new();
        let database = Database::new().unwrap();
        let auth = AuthSource { identity: json!({"encryptedSource":"OPAQUE_DPAPI_SOURCE","keyPath":"","credentialId":"fixture"}), rememberable: true };
        let profile = json!({"host":"192.0.2.10","port":22,"username":"fixture","followCwd":false,"loginScripts":[{"expect":"","send":"echo fixture"}]});
        let ssh = make_record("ssh", "ssh:attempt", &profile, auth.clone(), &fixture.context).unwrap();
        let key = database.fingerprint(&ssh.descriptor).unwrap();
        for (field, value) in [("host",json!("192.0.2.11")),("port",json!(2222)),("username",json!("other")),("followCwd",json!(true)),("loginScripts",json!([]))] {
            let mut changed = profile.clone(); changed[field] = value;
            assert_ne!(database.fingerprint(&make_record("ssh","ssh:next",&changed,auth.clone(),&fixture.context).unwrap().descriptor).unwrap(), key);
        }
        let mut provenance = auth.clone(); provenance.identity["credentialId"] = json!("other");
        assert_ne!(database.fingerprint(&make_record("ssh","ssh:provenance",&profile,provenance,&fixture.context).unwrap().descriptor).unwrap(), key);
        assert_ne!(Database::new().unwrap().fingerprint(&ssh.descriptor).unwrap(), key);
        let mut renamed = profile.clone(); renamed["name"] = json!("a harmless display rename");
        assert_eq!(database.fingerprint(&make_record("ssh","ssh:renamed",&renamed,auth,&fixture.context).unwrap().descriptor).unwrap(), key);
    }

    #[test]
    fn execution_trust_account_store_is_sealed_and_tampering_is_not_trust() {
        let fixture = Fixture::new();
        let mut database = Database::new().unwrap();
        let record = make_record("ssh", "ssh:store", &json!({"host":"192.0.2.10","port":22,"username":"fixture"}), AuthSource::none(), &fixture.context).unwrap();
        database.grants.push(database.fingerprint(&record.descriptor).unwrap());
        save_database(&fixture.context.store, &database).unwrap();
        let bytes = std::fs::read(&fixture.context.store).unwrap();
        assert!(!String::from_utf8_lossy(&bytes).contains("192.0.2.10"));
        assert!(!serde_json::to_string(&database).unwrap().contains("192.0.2.10"));
        assert_eq!(load_database(&fixture.context.store).unwrap().unwrap().grants, database.grants);
        std::fs::write(&fixture.context.store, b"foreign or tampered DPAPI data").unwrap();
        assert!(load_database(&fixture.context.store).is_err());
    }

    #[test]
    fn execution_trust_remote_volume_and_reparse_rejection_precede_content_access() {
        let reads = Cell::new(0);
        assert!(on_local_volume(4, || { reads.set(reads.get()+1); Ok(()) }).is_err());
        assert!(on_regular_node(0x400, || { reads.set(reads.get()+1); Ok(()) }).is_err());
        assert_eq!(reads.get(), 0);
        on_local_volume(3, || on_regular_node(0, || { reads.set(reads.get()+1); Ok(()) })).unwrap();
        assert_eq!(reads.get(), 1);
        let fixture = Fixture::new();
        assert!(local_path(r"\\untrusted\share\shell.exe", &fixture.root).is_err());
        assert!(local_path(r"\\.\device", &fixture.root).is_err());
    }
}
