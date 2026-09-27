//! Owned loopback-only SSH fixture for batch-01 native validation (ADR-0004
//! scenarios: A-above-B extract, preserve-content reconnect, disconnect
//! survivor).
//!
//! A minimal SSH server built ONLY from already-declared dependencies
//! (russh 0.60 server + tokio). It binds strictly 127.0.0.1 on an ephemeral
//! port, accepts ONLY the synthetic client key it generates itself (no
//! passwords, no other identities), and never runs a real shell: clients get
//! deterministic per-identity marker banners plus a tagged echo. All state
//! files (ephemeral host/client keys, JSONL event log) live under the
//! `--state-dir` given by the harness, which must be a sandbox created via
//! `scripts/e2e-isolation.mjs` (artifacts/e2e-tmp). No user SSH config, keys,
//! agents or credentials are read; nothing outside loopback is contacted.
//!
//! Usage:
//!   ssh_loopback_fixture.exe serve    --state-dir <dir>
//!   ssh_loopback_fixture.exe selftest --state-dir <dir>
//!
//! Contract (serve):
//!   - One JSON "ready" line on stdout (also first JSONL record):
//!       {"type":"ready","version":1,"pid":..,"bind":"127.0.0.1","port":N,
//!        "hostKeyAlg":"ssh-ed25519","hostKeyFp":"SHA256:...",
//!        "clientKey":"<dir>/client_key","clientKeyPub":"<dir>/client_key.pub",
//!        "users":["fa","fb"],"logFile":"<dir>/fixture.jsonl"}
//!     `clientKey` is the synthetic OpenSSH private key ZTerm profiles use
//!     with authType "key" + privateKeyPath; the fixture accepts only it.
//!   - Every event is appended to fixture.jsonl AND mirrored to stdout, one
//!     JSON object per line: identity (conn/user/gen), channel id, PTY and
//!     window-change cols/rows, lifecycle. Data payloads are recorded as byte
//!     counts only - never key material or terminal content.
//!   - stdin control, one JSON object per line (UTF-8, LF):
//!       {"op":"disconnect","conn":N}  deterministically disconnects conn N
//!       {"op":"holdauth","ms":N}      one-shot delay of the NEXT accepted
//!                                     publickey auth (batch-02 native
//!                                     close-while-connecting probes; emits
//!                                     an auth_hold event when consumed)
//!       {"op":"status"}               active connection summary on stdout
//!       {"op":"shutdown"}             graceful stop (also on stdin EOF)
//!     Results come back as {"type":"control-result",...} lines on stdout.
//!
//! Contract (selftest): spawns a child `serve` instance from the same exe and
//! exercises the full protocol with russh clients: loopback-only listening
//! (netstat evidence), rejection of a wrong key / wrong user / password, two
//! independent A/B sessions with distinct markers, initial PTY sizes plus
//! subsequent distinct resize payloads, tagged echo, controlled disconnect of
//! one connection while the other survives, and a reconnect that creates a
//! new user generation. Prints SELFCHECK lines and exits 0/1.
//!
//! Run with: `cargo run --example ssh_loopback_fixture -- serve --state-dir <dir>`

use std::collections::HashMap;
use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use parking_lot::Mutex;
use russh::keys::ssh_key::LineEnding;
use russh::keys::{Algorithm, HashAlg, PrivateKey, PrivateKeyWithHashAlg, PublicKey};
use russh::{ChannelId, Disconnect, MethodKind, MethodSet};
use serde_json::{json, Value};

/// Synthetic accounts: (username, marker tag). Only these users, only the
/// fixture-generated client key.
const USERS: &[(&str, &str)] = &[("fa", "A"), ("fb", "B")];
/// Marker prefix used in banners and echoed data (synthetic, distinct per user).
const MARKER: &str = "ZTFX";

fn tag_for(user: &str) -> Option<&'static str> {
    USERS.iter().find(|(u, _)| *u == user).map(|(_, t)| *t)
}

/// ChannelId keeps its u32 private (only SSH wire Encode/Decode), so the JSONL
/// log extracts the number via its derived Debug form ("ChannelId(3)").
fn chan_u32(id: ChannelId) -> u32 {
    let debug = format!("{id:?}");
    let digits: String = debug.chars().filter(|c| c.is_ascii_digit()).collect();
    digits.parse().unwrap_or(0)
}

// ---------------------------------------------------------------------------
// Event log: JSONL file + stdout mirror, metadata only.
// ---------------------------------------------------------------------------

struct EventLog {
    file: Mutex<std::fs::File>,
    seq: AtomicU64,
}

impl EventLog {
    fn new(file: std::fs::File) -> Self {
        Self {
            file: Mutex::new(file),
            seq: AtomicU64::new(0),
        }
    }

    /// Append one event; `value` must be a JSON object.
    fn emit(&self, mut value: Value) {
        let seq = self.seq.fetch_add(1, Ordering::Relaxed) + 1;
        if let Some(obj) = value.as_object_mut() {
            obj.insert("ts".into(), json!(iso_now()));
            obj.insert("seq".into(), json!(seq));
        }
        let line = serde_json::to_string(&value).unwrap_or_else(|_| "{}".to_string());
        {
            let mut f = self.file.lock();
            let _ = f.write_all(line.as_bytes());
            let _ = f.write_all(b"\n");
            let _ = f.flush();
        }
        let mut out = std::io::stdout().lock();
        let _ = out.write_all(line.as_bytes());
        let _ = out.write_all(b"\n");
        let _ = out.flush();
    }
}

/// Print a control reply on stdout (not part of the JSONL file).
fn print_reply(value: &Value) {
    let mut out = std::io::stdout().lock();
    let _ = writeln!(out, "{value}");
    let _ = out.flush();
}

/// Indexed ASCII grid painted on demand (control op `paint`) at the current
/// reported rows/cols. Contract: `\x1b[2J\x1b[H` (clear visible screen, home
/// — scrollback untouched), then EXACTLY `rows` lines, each exactly `cols`
/// wide: `R{rr}` + dots + `E{rr}`. Lines are joined with `\r\n` and the LAST
/// line has NO trailing newline, so the payload occupies exactly the visible
/// `rows` lines with no wrap and no scroll: the top marker row `R00..E00` and
/// the bottom marker row `R{rows-1}..E{rows-1}` are simultaneously visible.
/// (A trailing CRLF on the last row scrolls the top row away - a payload
/// artifact, NOT product clipping.) Exact byte size:
/// 7 (clear+home) + rows*cols + (rows-1)*2.
fn build_paint_grid(cols: u32, rows: u32) -> Vec<u8> {
    let mut out = String::new();
    out.push_str("\u{1b}[2J\u{1b}[H");
    let fill = cols.saturating_sub(6) as usize;
    for r in 0..rows {
        if r > 0 {
            out.push_str("\r\n");
        }
        out.push_str(&format!("R{r:02}"));
        for _ in 0..fill {
            out.push('.');
        }
        out.push_str(&format!("E{r:02}"));
    }
    out.into_bytes()
}

fn now_unix_ms() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

/// UTC ISO-8601 timestamp from the system clock (std-only, Howard Hinnant's
/// civil-from-days algorithm).
fn iso_now() -> String {
    let ms_total = now_unix_ms();
    let secs = (ms_total / 1000) as i64;
    let ms = (ms_total % 1000) as u32;
    let days = secs.div_euclid(86_400);
    let sod = secs.rem_euclid(86_400);
    let (y, m, d) = civil_from_days(days);
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.{ms:03}Z",
        sod / 3600,
        (sod % 3600) / 60,
        sod % 60
    )
}

fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

// ---------------------------------------------------------------------------
// Shared fixture state.
// ---------------------------------------------------------------------------

struct ConnInfo {
    user: Option<String>,
    user_gen: Option<u32>,
    peer: String,
    handle: russh::server::Handle,
    /// Channel that got shell + its last reported size (for the paint grid).
    shell_chan: Option<ChannelId>,
    size: Option<(u32, u32)>,
}

struct Fixture {
    log: EventLog,
    next_conn: AtomicU32,
    conns: Mutex<HashMap<u32, ConnInfo>>,
    /// Per-user connection generation counter (reconnect increments).
    user_gens: Mutex<HashMap<String, u32>>,
    /// SHA256 fingerprint of the only accepted client public key.
    authorized_fp: String,
    /// One-shot deterministic auth delay (batch 02): armed by the `holdauth`
    /// control, consumed by the NEXT accepted publickey auth. Gives native
    /// probes a reliable claimed/auth-pending window to close inside — the
    /// SFTP-init path became fast after the phase-2b fail-and-close fix, so
    /// timing luck is no longer a usable window. Loopback-only, opt-in per
    /// probe run, never armed by the selftest.
    hold_next_ms: Mutex<Option<u64>>,
}

impl Fixture {
    fn conn_open(&self, conn: u32, peer: String, handle: russh::server::Handle) {
        self.log.emit(json!({
            "type": "conn_open",
            "conn": conn,
            "peer": peer,
        }));
        self.conns.lock().insert(
            conn,
            ConnInfo {
                user: None,
                user_gen: None,
                peer,
                handle,
                shell_chan: None,
                size: None,
            },
        );
    }

    fn conn_close(&self, conn: u32, reason: &str) {
        self.log.emit(json!({
            "type": "conn_close",
            "conn": conn,
            "reason": reason,
        }));
        self.conns.lock().remove(&conn);
    }

    /// Register a successful auth: returns the per-user generation number.
    fn auth_accept(&self, conn: u32, user: &str) -> u32 {
        let gen = {
            let mut gens = self.user_gens.lock();
            let g = gens.entry(user.to_string()).or_insert(0);
            *g += 1;
            *g
        };
        if let Some(entry) = self.conns.lock().get_mut(&conn) {
            entry.user = Some(user.to_string());
            entry.user_gen = Some(gen);
        }
        self.log.emit(json!({
            "type": "auth_succeeded",
            "conn": conn,
            "user": user,
            "userGen": gen,
        }));
        gen
    }

    /// Track the shell channel and current PTY size per connection (input for
    /// the `paint` control op).
    fn note_shell(&self, conn: u32, chan: ChannelId, size: (u32, u32)) {
        let mut conns = self.conns.lock();
        if let Some(entry) = conns.get_mut(&conn) {
            entry.shell_chan = Some(chan);
            entry.size = Some(size);
        }
    }

    fn note_size(&self, conn: u32, size: (u32, u32)) {
        let mut conns = self.conns.lock();
        if let Some(entry) = conns.get_mut(&conn) {
            entry.size = Some(size);
        }
    }

    /// Shell channel + current size for the paint grid.
    fn shell_target(
        &self,
        conn: u32,
    ) -> Result<(russh::server::Handle, ChannelId, u32, u32), String> {
        let conns = self.conns.lock();
        let entry = conns
            .get(&conn)
            .ok_or_else(|| format!("no such connection: {conn}"))?;
        match (entry.shell_chan, entry.size) {
            (Some(chan), Some((cols, rows))) => Ok((entry.handle.clone(), chan, cols, rows)),
            _ => Err(format!("connection {conn} has no shell/size yet")),
        }
    }

    fn status(&self) -> Value {
        let conns: Vec<Value> = self
            .conns
            .lock()
            .iter()
            .map(|(conn, entry)| {
                json!({
                    "conn": conn,
                    "user": entry.user,
                    "userGen": entry.user_gen,
                    "peer": entry.peer,
                })
            })
            .collect();
        json!({
            "op": "status",
            "ok": true,
            "conns": conns,
        })
    }
}

// ---------------------------------------------------------------------------
// Server-side per-connection handler.
// ---------------------------------------------------------------------------

struct ConnHandler {
    fx: Arc<Fixture>,
    conn: u32,
    auth_user: Option<String>,
    auth_gen: Option<u32>,
    /// Last reported PTY size per channel (for shell banners).
    pty_size: HashMap<ChannelId, (u32, u32)>,
    /// Channel that was granted a shell — ONLY this channel gets the tagged
    /// echo. Data on other channels (e.g. a client's SFTP INIT after its
    /// subsystem request was failed) must be dropped, not echoed: echoing
    /// garbage back into a protocol negotiation channel stalls the client
    /// (observed: ZTerm's second connection never reached its shell request).
    shell_chan: Option<ChannelId>,
}

impl ConnHandler {
    fn new(fx: Arc<Fixture>, conn: u32) -> Self {
        Self {
            fx,
            conn,
            auth_user: None,
            auth_gen: None,
            pty_size: HashMap::new(),
            shell_chan: None,
        }
    }

    fn log(&self, value: Value) {
        self.fx.log.emit(value);
    }

    fn banner(&self, channel: ChannelId) -> Vec<u8> {
        let user = self.auth_user.as_deref().unwrap_or("?");
        let tag = tag_for(user).unwrap_or("?");
        let (cols, rows) = self.pty_size.get(&channel).copied().unwrap_or((0, 0));
        format!(
            "{MARKER}[{tag}] conn={} gen={} cols={cols} rows={rows}\r\n",
            self.conn,
            self.auth_gen.unwrap_or(0),
        )
        .into_bytes()
    }
}

impl russh::server::Handler for ConnHandler {
    type Error = russh::Error;

    async fn auth_publickey(
        &mut self,
        user: &str,
        public_key: &PublicKey,
    ) -> Result<russh::server::Auth, Self::Error> {
        let fx = &self.fx;
        let offered_fp = public_key.fingerprint(HashAlg::Sha256).to_string();
        let user_ok = USERS.iter().any(|(u, _)| *u == user);
        let key_ok = offered_fp == fx.authorized_fp;
        let accept = user_ok && key_ok;
        self.log(json!({
            "type": "auth",
            "conn": self.conn,
            "user": user,
            "method": "publickey",
            "result": if accept { "accept" } else { "reject" },
            "reason": if accept { "" }
                else if !user_ok { "user-not-allowed" }
                else { "key-not-authorized" },
        }));
        if accept {
            // Optional one-shot auth hold (holdauth control): consumed here,
            // before the Accept is returned, so the client stays inside its
            // auth await — a cancel arriving during the hold takes effect at
            // the client's first checkpoint AFTER the hold expires, which is
            // exactly the checkpoint-delay behavior native probes must
            // observe rather than assume.
            let hold_ms = fx.hold_next_ms.lock().take();
            if let Some(ms) = hold_ms {
                self.log(json!({
                    "type": "auth_hold",
                    "conn": self.conn,
                    "ms": ms,
                }));
                if ms > 0 {
                    tokio::time::sleep(std::time::Duration::from_millis(ms)).await;
                }
            }
            self.auth_user = Some(user.to_string());
        }
        Ok(if accept {
            russh::server::Auth::Accept
        } else {
            russh::server::Auth::reject()
        })
    }

    async fn auth_password(
        &mut self,
        user: &str,
        _password: &str,
    ) -> Result<russh::server::Auth, Self::Error> {
        // The fixture advertises publickey only; any password attempt is
        // rejected. The password value is never logged.
        self.log(json!({
            "type": "auth",
            "conn": self.conn,
            "user": user,
            "method": "password",
            "result": "reject",
            "reason": "password-auth-disabled",
        }));
        Ok(russh::server::Auth::reject())
    }

    async fn auth_succeeded(
        &mut self,
        _session: &mut russh::server::Session,
    ) -> Result<(), Self::Error> {
        let user = self.auth_user.clone().unwrap_or_else(|| "?".to_string());
        self.auth_gen = Some(self.fx.auth_accept(self.conn, &user));
        Ok(())
    }

    async fn channel_open_session(
        &mut self,
        channel: russh::Channel<russh::server::Msg>,
        _session: &mut russh::server::Session,
    ) -> Result<bool, Self::Error> {
        self.log(json!({
            "type": "channel_open",
            "conn": self.conn,
            "chan": chan_u32(channel.id()),
            "kind": "session",
        }));
        Ok(true)
    }

    async fn pty_request(
        &mut self,
        channel: ChannelId,
        term: &str,
        col_width: u32,
        row_height: u32,
        _pix_width: u32,
        _pix_height: u32,
        _modes: &[(russh::Pty, u32)],
        session: &mut russh::server::Session,
    ) -> Result<(), Self::Error> {
        self.pty_size.insert(channel, (col_width, row_height));
        self.fx.note_size(self.conn, (col_width, row_height));
        self.log(json!({
            "type": "pty",
            "conn": self.conn,
            "chan": chan_u32(channel),
            "term": term,
            "cols": col_width,
            "rows": row_height,
        }));
        session.channel_success(channel)?;
        Ok(())
    }

    async fn shell_request(
        &mut self,
        channel: ChannelId,
        session: &mut russh::server::Session,
    ) -> Result<(), Self::Error> {
        session.channel_success(channel)?;
        self.shell_chan = Some(channel);
        let banner = self.banner(channel);
        let bytes = banner.len();
        let size = self.pty_size.get(&channel).copied().unwrap_or((0, 0));
        self.fx.note_shell(self.conn, channel, size);
        session.data(channel, banner)?;
        self.log(json!({
            "type": "shell",
            "conn": self.conn,
            "chan": chan_u32(channel),
        }));
        self.log(json!({
            "type": "data_meta",
            "conn": self.conn,
            "chan": chan_u32(channel),
            "dir": "s2c",
            "bytes": bytes,
            "note": "banner",
        }));
        Ok(())
    }

    async fn window_change_request(
        &mut self,
        channel: ChannelId,
        col_width: u32,
        row_height: u32,
        _pix_width: u32,
        _pix_height: u32,
        session: &mut russh::server::Session,
    ) -> Result<(), Self::Error> {
        self.pty_size.insert(channel, (col_width, row_height));
        self.fx.note_size(self.conn, (col_width, row_height));
        self.log(json!({
            "type": "resize",
            "conn": self.conn,
            "chan": chan_u32(channel),
            "cols": col_width,
            "rows": row_height,
        }));
        session.channel_success(channel)?;
        Ok(())
    }

    async fn subsystem_request(
        &mut self,
        channel: ChannelId,
        name: &str,
        session: &mut russh::server::Session,
    ) -> Result<(), Self::Error> {
        // No SFTP by design: ZTerm tolerates a failing SFTP channel and keeps
        // the terminal session. Reject AND CLOSE the channel deterministically:
        // with only a failure reply, russh-sftp's SftpSession::new can keep
        // waiting for its INIT reply forever (observed stalling ZTerm's second
        // concurrent connect before its shell request). A real sshd terminates
        // the negotiation; eof+close does the same here.
        self.log(json!({
            "type": "subsystem_rejected",
            "conn": self.conn,
            "chan": chan_u32(channel),
            "name": name,
        }));
        session.channel_failure(channel)?;
        session.eof(channel)?;
        session.close(channel)?;
        Ok(())
    }

    async fn exec_request(
        &mut self,
        channel: ChannelId,
        _data: &[u8],
        session: &mut russh::server::Session,
    ) -> Result<(), Self::Error> {
        self.log(json!({
            "type": "exec_rejected",
            "conn": self.conn,
            "chan": chan_u32(channel),
        }));
        session.channel_failure(channel)?;
        Ok(())
    }

    async fn data(
        &mut self,
        channel: ChannelId,
        data: &[u8],
        session: &mut russh::server::Session,
    ) -> Result<(), Self::Error> {
        self.log(json!({
            "type": "data_meta",
            "conn": self.conn,
            "chan": chan_u32(channel),
            "dir": "c2s",
            "bytes": data.len(),
        }));
        if self.shell_chan != Some(channel) {
            // Non-shell channel (e.g. a rejected SFTP negotiation): drop the
            // payload silently — echoing into a protocol handshake would
            // corrupt the client's failure handling.
            return Ok(());
        }
        // Tagged echo so the CLIENT can also observe which session received
        // its input: ZTFX[tag]<conn:gen> <payload>
        let user = self.auth_user.as_deref().unwrap_or("?");
        let tag = tag_for(user).unwrap_or("?");
        let mut echo = format!(
            "{MARKER}[{tag}]<{}:{}> ",
            self.conn,
            self.auth_gen.unwrap_or(0),
        )
        .into_bytes();
        echo.extend_from_slice(data);
        let bytes = echo.len();
        session.data(channel, echo)?;
        self.log(json!({
            "type": "data_meta",
            "conn": self.conn,
            "chan": chan_u32(channel),
            "dir": "s2c",
            "bytes": bytes,
            "note": "echo",
        }));
        Ok(())
    }

    async fn channel_eof(
        &mut self,
        channel: ChannelId,
        _session: &mut russh::server::Session,
    ) -> Result<(), Self::Error> {
        self.log(json!({
            "type": "channel_eof",
            "conn": self.conn,
            "chan": chan_u32(channel),
        }));
        Ok(())
    }

    async fn channel_close(
        &mut self,
        channel: ChannelId,
        _session: &mut russh::server::Session,
    ) -> Result<(), Self::Error> {
        self.log(json!({
            "type": "channel_close",
            "conn": self.conn,
            "chan": chan_u32(channel),
        }));
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// serve mode
// ---------------------------------------------------------------------------

async fn serve(state_dir: PathBuf) -> Result<()> {
    std::fs::create_dir_all(&state_dir)
        .with_context(|| format!("creating state dir {}", state_dir.display()))?;

    // Ephemeral keys: host key stays in memory; the client key is written to
    // the sandbox so a ZTerm profile can point privateKeyPath at it.
    let mut rng_host = russh::keys::key::safe_rng();
    let host_key = PrivateKey::random(&mut rng_host, Algorithm::Ed25519)
        .context("generating ephemeral host key")?;
    let mut rng_client = russh::keys::key::safe_rng();
    let client_key = PrivateKey::random(&mut rng_client, Algorithm::Ed25519)
        .context("generating ephemeral client key")?;
    let client_pem = client_key
        .to_openssh(LineEnding::LF)
        .context("encoding client key")?;
    let client_key_path = state_dir.join("client_key");
    let mut key_file = std::fs::File::create(&client_key_path)
        .with_context(|| format!("creating {}", client_key_path.display()))?;
    // to_openssh already ends with a newline. Do NOT append another: the
    // strict RFC 7468 encapsulation parser (pem-rfc7468 via russh keys)
    // rejects a trailing blank line after the END boundary.
    key_file.write_all(client_pem.as_bytes())?;
    key_file.flush()?;
    drop(key_file);
    let client_pub = client_key
        .public_key()
        .to_openssh()
        .context("encoding client public key")?;
    let client_pub_path = state_dir.join("client_key.pub");
    std::fs::write(&client_pub_path, format!("{client_pub}\n"))?;

    let host_fp = host_key
        .public_key()
        .fingerprint(HashAlg::Sha256)
        .to_string();
    let authorized_fp = client_key
        .public_key()
        .fingerprint(HashAlg::Sha256)
        .to_string();

    let log_path = state_dir.join("fixture.jsonl");
    let log_file = std::fs::File::create(&log_path)
        .with_context(|| format!("creating {}", log_path.display()))?;
    let log = EventLog::new(log_file);

    // Loopback-only, ephemeral port.
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .context("binding 127.0.0.1:0")?;
    let port = listener.local_addr()?.port();

    let fixture = Arc::new(Fixture {
        log,
        next_conn: AtomicU32::new(0),
        conns: Mutex::new(HashMap::new()),
        user_gens: Mutex::new(HashMap::new()),
        authorized_fp,
        hold_next_ms: Mutex::new(None),
    });

    fixture.log.emit(json!({
        "type": "ready",
        "version": 1,
        "pid": std::process::id(),
        "bind": "127.0.0.1",
        "port": port,
        "hostKeyAlg": "ssh-ed25519",
        "hostKeyFp": host_fp,
        "clientKey": client_key_path,
        "clientKeyPub": client_pub_path,
        "users": USERS.iter().map(|(u, _)| u).collect::<Vec<_>>(),
        "logFile": log_path,
        "marker": MARKER,
    }));

    let mut server_config = russh::server::Config::default();
    server_config.keys.push(host_key);
    server_config.methods = MethodSet::from(&[MethodKind::PublicKey][..]);
    server_config.auth_rejection_time = Duration::from_millis(50);
    // Idle sessions must survive (disconnect-survivor scenario depends on a
    // live A while B is killed).
    server_config.inactivity_timeout = None;
    let server_config = Arc::new(server_config);

    // stdin control: a blocking thread feeds lines into the async loop; EOF
    // (or channel close) means shutdown.
    let (ctrl_tx, mut ctrl_rx) = tokio::sync::mpsc::unbounded_channel::<String>();
    std::thread::spawn(move || {
        let stdin = std::io::stdin();
        for line in stdin.lock().lines() {
            match line {
                // UnboundedSender::send is synchronous by design.
                Ok(l) => {
                    if ctrl_tx.send(l).is_err() {
                        return;
                    }
                }
                Err(_) => return,
            }
        }
    });

    let mut shutdown = false;
    while !shutdown {
        tokio::select! {
            maybe_cmd = ctrl_rx.recv() => match maybe_cmd {
                None => {
                    fixture.log.emit(json!({"type": "control", "op": "shutdown", "origin": "stdin-eof"}));
                    shutdown = true;
                }
                Some(line) => handle_control_line(&fixture, &line, &mut shutdown).await,
            },
            accepted = listener.accept() => match accepted {
                Ok((socket, peer)) => {
                    let conn = fixture.next_conn.fetch_add(1, Ordering::Relaxed) + 1;
                    let peer_s = peer.to_string();
                    let fx = fixture.clone();
                    let cfg = server_config.clone();
                    tokio::spawn(async move {
                        let handler = ConnHandler::new(fx.clone(), conn);
                        match russh::server::run_stream(cfg, socket, handler).await {
                            Ok(session) => {
                                fx.conn_open(conn, peer_s, session.handle());
                                let reason = match session.await {
                                    Ok(()) => "closed".to_string(),
                                    Err(e) => format!("error: {e}"),
                                };
                                fx.conn_close(conn, &reason);
                            }
                            Err(e) => {
                                fx.conn_open_failed(conn, &peer_s, &format!("handshake: {e}"));
                            }
                        }
                    });
                }
                Err(e) => {
                    fixture.log.emit(json!({"type": "accept_error", "error": e.to_string()}));
                }
            },
        }
    }

    // Teardown: disconnect every still-open connection, flush, exit.
    let handles: Vec<russh::server::Handle> = {
        let mut conns = fixture.conns.lock();
        conns.drain().map(|(_, e)| e.handle).collect()
    };
    for handle in handles {
        let _ = handle
            .disconnect(
                Disconnect::ByApplication,
                "fixture-shutdown".to_string(),
                "en".to_string(),
            )
            .await;
    }
    fixture.log.emit(json!({"type": "shutdown"}));
    // Give connection tasks a moment to flush their close events.
    tokio::time::sleep(Duration::from_millis(300)).await;
    Ok(())
}

async fn handle_control_line(fixture: &Arc<Fixture>, line: &str, shutdown: &mut bool) {
    let cmd: Value = match serde_json::from_str(line) {
        Ok(v) => v,
        Err(e) => {
            fixture
                .log
                .emit(json!({"type": "control_parse_error", "error": e.to_string()}));
            print_reply(&json!({"type": "control-result", "op": "parse-error", "ok": false}));
            return;
        }
    };
    let op = cmd.get("op").and_then(|o| o.as_str()).unwrap_or("");
    match op {
        "disconnect" => {
            let conn = cmd.get("conn").and_then(|c| c.as_u64());
            let result = match conn {
                Some(conn) if conn <= u32::MAX as u64 => {
                    match fixture.take_disconnect_handle(conn as u32) {
                        Ok(handle) => {
                            let sent = handle
                                .disconnect(
                                    Disconnect::ByApplication,
                                    "fixture-control-disconnect".to_string(),
                                    "en".to_string(),
                                )
                                .await
                                .is_ok();
                            if sent {
                                fixture.log.emit(json!({
                                    "type": "disconnect_issued",
                                    "conn": conn,
                                    "origin": "control",
                                }));
                            }
                            Ok(sent)
                        }
                        Err(e) => Err(e),
                    }
                }
                _ => Err(format!("invalid conn field: {:?}", cmd.get("conn"))),
            };
            let ok = matches!(&result, Ok(true));
            print_reply(&json!({
                "type": "control-result",
                "op": "disconnect",
                "conn": conn,
                "ok": ok,
                "error": if ok { Value::Null } else { json!(result.unwrap_err()) },
            }));
        }
        "paint" => {
            // Paint an indexed grid at the connection's current reported size
            // on its shell channel (fit/clipping evidence; scrollback is kept
            // because only the visible screen is cleared).
            let conn = cmd.get("conn").and_then(|c| c.as_u64());
            let result = match conn {
                Some(conn) if conn <= u32::MAX as u64 => match fixture.shell_target(conn as u32) {
                    Ok((handle, chan, cols, rows)) => {
                        let grid = build_paint_grid(cols, rows);
                        let bytes = grid.len();
                        match handle.data(chan, grid).await {
                            Ok(()) => {
                                fixture.log.emit(json!({
                                    "type": "data_meta",
                                    "conn": conn,
                                    "chan": chan_u32(chan),
                                    "dir": "s2c",
                                    "bytes": bytes,
                                    "note": "paint",
                                }));
                                Ok(format!("{cols}x{rows}:{bytes}"))
                            }
                            Err(_) => Err("send failed".to_string()),
                        }
                    }
                    Err(e) => Err(e),
                },
                _ => Err(format!("invalid conn field: {:?}", cmd.get("conn"))),
            };
            let ok = result.is_ok();
            print_reply(&json!({
                "type": "control-result",
                "op": "paint",
                "conn": conn,
                "ok": ok,
                "detail": if ok { json!(result.clone().unwrap()) } else { json!(result.unwrap_err()) },
            }));
        }
        "status" => {
            let status = fixture.status();
            fixture.log.emit(json!({"type": "control", "op": "status"}));
            let mut reply = status;
            reply["type"] = json!("control-result");
            print_reply(&reply);
        }
        "holdauth" => {
            // One-shot auth delay for the NEXT accepted publickey auth
            // (batch-02 close-while-connecting probes). See Fixture::hold_next_ms.
            let ms = cmd.get("ms").and_then(|m| m.as_u64());
            let ok = match ms {
                Some(ms) if ms <= 120_000 => {
                    fixture.hold_next_ms.lock().replace(ms);
                    true
                }
                _ => false,
            };
            fixture.log.emit(json!({"type": "control", "op": "holdauth", "ms": ms, "ok": ok }));
            print_reply(&json!({ "type": "control-result", "op": "holdauth", "ok": ok, "ms": ms }));
        }
        "shutdown" => {
            fixture
                .log
                .emit(json!({"type": "control", "op": "shutdown", "origin": "stdin"}));
            print_reply(&json!({"type": "control-result", "op": "shutdown", "ok": true}));
            *shutdown = true;
        }
        other => {
            print_reply(&json!({
                "type": "control-result",
                "op": other,
                "ok": false,
                "error": format!("unknown op: {other}"),
            }));
        }
    }
}

impl Fixture {
    /// Take the russh handle of a connection out of the registry so the
    /// controller can disconnect it; returns Err when the id is unknown.
    fn take_disconnect_handle(&self, conn: u32) -> Result<russh::server::Handle, String> {
        match self.conns.lock().get(&conn) {
            Some(entry) => Ok(entry.handle.clone()),
            None => Err(format!("no such connection: {conn}")),
        }
    }

    fn conn_open_failed(&self, conn: u32, peer: &str, reason: &str) {
        self.log.emit(json!({
            "type": "conn_open_failed",
            "conn": conn,
            "peer": peer,
            "reason": reason,
        }));
    }
}

// ---------------------------------------------------------------------------
// selftest mode: child serve process + russh clients.
// ---------------------------------------------------------------------------

struct ClientHandler {
    expect_host_fp: String,
}

impl russh::client::Handler for ClientHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &PublicKey,
    ) -> Result<bool, Self::Error> {
        let fp = server_public_key.fingerprint(HashAlg::Sha256).to_string();
        Ok(fp == self.expect_host_fp)
    }
}

struct Checks {
    pass: u32,
    fail: u32,
}

impl Checks {
    fn ok(&mut self, name: &str, cond: bool, detail: &str) {
        if cond {
            self.pass += 1;
            println!("SELFCHECK {name} PASS {detail}");
        } else {
            self.fail += 1;
            println!("SELFCHECK {name} FAIL {detail}");
        }
    }
}

/// Reader side of the child's stdout: keeps the pipe drained and hands lines
/// to the main task.
fn spawn_stdout_reader(
    child_stdout: std::process::ChildStdout,
) -> std::sync::mpsc::Receiver<String> {
    let (tx, rx) = std::sync::mpsc::channel::<String>();
    std::thread::spawn(move || {
        let reader = std::io::BufReader::new(child_stdout);
        for line in reader.lines() {
            match line {
                Ok(l) => {
                    if tx.send(l).is_err() {
                        return;
                    }
                }
                Err(_) => return,
            }
        }
    });
    rx
}

async fn selftest(state_dir: PathBuf) -> Result<i32> {
    let child_dir = state_dir.join("selftest-child");
    std::fs::create_dir_all(&child_dir)?;
    let mut checks = Checks { pass: 0, fail: 0 };

    let exe = std::env::current_exe().context("locating current exe")?;
    let mut child = Command::new(&exe)
        .arg("serve")
        .arg("--state-dir")
        .arg(&child_dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .context("spawning fixture serve child")?;
    let stdout_rx = spawn_stdout_reader(child.stdout.take().expect("piped stdout"));

    // Fail-safe cleanup: only OUR child is ever killed.
    struct ChildGuard<'a> {
        child: &'a mut Child,
    }
    impl Drop for ChildGuard<'_> {
        fn drop(&mut self) {
            if self.child.try_wait().map(|s| s.is_none()).unwrap_or(false) {
                let _ = self.child.kill();
            }
            let _ = self.child.wait();
        }
    }
    let guard = ChildGuard { child: &mut child };

    // --- ready record -----------------------------------------------------
    let mut ready: Option<Value> = None;
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    while std::time::Instant::now() < deadline {
        match stdout_rx.recv_timeout(Duration::from_millis(200)) {
            Ok(line) => {
                if let Ok(v) = serde_json::from_str::<Value>(&line) {
                    if v.get("type").and_then(|t| t.as_str()) == Some("ready") {
                        ready = Some(v);
                        break;
                    }
                }
            }
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => continue,
        }
    }
    let ready = match ready {
        Some(v) => v,
        None => {
            println!("SELFCHECK ready FAIL child never announced readiness");
            return Ok(1);
        }
    };
    let port = ready.get("port").and_then(|p| p.as_u64()).unwrap_or(0) as u16;
    let host_fp = ready
        .get("hostKeyFp")
        .and_then(|f| f.as_str())
        .unwrap_or("")
        .to_string();
    let client_key_path = ready
        .get("clientKey")
        .and_then(|p| p.as_str())
        .unwrap_or("")
        .to_string();
    let log_path = ready
        .get("logFile")
        .and_then(|p| p.as_str())
        .unwrap_or("")
        .to_string();
    checks.ok(
        "ready-record",
        port > 0 && host_fp.starts_with("SHA256:") && Path::new(&client_key_path).exists(),
        &format!("port={port} fp={host_fp}"),
    );
    checks.ok(
        "ready-bind-loopback",
        ready.get("bind").and_then(|b| b.as_str()) == Some("127.0.0.1"),
        "",
    );

    // --- loopback-only listening evidence (netstat) ------------------------
    let netstat = Command::new("netstat").args(["-ano"]).output();
    let loopback_only = match netstat {
        Ok(out) => {
            let text = String::from_utf8_lossy(&out.stdout);
            let exact = format!("127.0.0.1:{port}");
            let suffix = format!(":{port}");
            let mut saw_listener = false;
            let mut all_loopback = true;
            for line in text.lines() {
                let cols: Vec<&str> = line.split_whitespace().collect();
                // Proto Local Foreign State Pid
                if cols.len() >= 5
                    && cols[0].eq_ignore_ascii_case("TCP")
                    && cols[3].eq_ignore_ascii_case("LISTENING")
                    && cols[1].ends_with(&suffix)
                {
                    saw_listener = true;
                    // A suffix match over-detects (":154321" for port 54321),
                    // which only ever fails the check, never hides a miss.
                    if cols[1] != exact {
                        all_loopback = false;
                    }
                }
            }
            saw_listener && all_loopback
        }
        Err(_) => false,
    };
    checks.ok(
        "loopback-only-listen",
        loopback_only,
        &format!("port={port}"),
    );

    // --- client key --------------------------------------------------------
    let client_pem = std::fs::read_to_string(&client_key_path).context("reading client key")?;
    let client_key =
        PrivateKey::from_openssh(client_pem.as_bytes()).context("parsing client key")?;
    let addr = format!("127.0.0.1:{port}");

    // helper: connect + authenticate with the given key/user; returns (handle, success)
    async fn connect_and_auth(
        addr: &str,
        host_fp: &str,
        user: &str,
        key: &PrivateKey,
    ) -> (Option<russh::client::Handle<ClientHandler>>, bool) {
        let cfg = Arc::new(russh::client::Config::default());
        let handler = ClientHandler {
            expect_host_fp: host_fp.to_string(),
        };
        let mut handle = match russh::client::connect(cfg, addr, handler).await {
            Ok(h) => h,
            Err(_) => return (None, false),
        };
        let kp = PrivateKeyWithHashAlg::new(Arc::new(key.clone()), None);
        let success = matches!(
            handle.authenticate_publickey(user, kp).await,
            Ok(a) if a.success()
        );
        (Some(handle), success)
    }

    // --- negative auth: wrong key / wrong user / password -------------------
    let mut rng_wrong = russh::keys::key::safe_rng();
    let wrong_key = PrivateKey::random(&mut rng_wrong, Algorithm::Ed25519)?;
    let (wrong_key_h, wrong_key_ok) = connect_and_auth(&addr, &host_fp, "fa", &wrong_key).await;
    checks.ok("auth-wrong-key-rejected", !wrong_key_ok, "");
    if let Some(h) = wrong_key_h {
        let _ = h
            .disconnect(
                Disconnect::ByApplication,
                "selftest-done".into(),
                "en".into(),
            )
            .await;
    }

    let (wrong_user_h, wrong_user_ok) = connect_and_auth(&addr, &host_fp, "eve", &client_key).await;
    checks.ok("auth-wrong-user-rejected", !wrong_user_ok, "");
    if let Some(h) = wrong_user_h {
        let _ = h
            .disconnect(
                Disconnect::ByApplication,
                "selftest-done".into(),
                "en".into(),
            )
            .await;
    }

    {
        let cfg = Arc::new(russh::client::Config::default());
        let handler = ClientHandler {
            expect_host_fp: host_fp.clone(),
        };
        let mut h: Option<russh::client::Handle<ClientHandler>> =
            russh::client::connect(cfg, addr.as_str(), handler)
                .await
                .ok();
        if h.is_none() {
            // Server restricted to publickey can refuse early; that still
            // counts as "password not accepted".
            checks.ok("auth-password-rejected", true, "connect failed");
        }
        if let Some(h) = h.as_mut() {
            let success = matches!(
                h.authenticate_password("fa", "nope").await,
                Ok(a) if a.success()
            );
            checks.ok("auth-password-rejected", !success, "");
            let _ = h
                .disconnect(
                    Disconnect::ByApplication,
                    "selftest-done".into(),
                    "en".into(),
                )
                .await;
        }
    }

    // --- positive A/B sessions ---------------------------------------------
    async fn open_session(
        addr: &str,
        host_fp: &str,
        user: &str,
        key: &PrivateKey,
        cols: u32,
        rows: u32,
    ) -> Result<(
        russh::client::Handle<ClientHandler>,
        russh::Channel<russh::client::Msg>,
        String,
    )> {
        let cfg = Arc::new(russh::client::Config::default());
        let handler = ClientHandler {
            expect_host_fp: host_fp.to_string(),
        };
        let mut handle = russh::client::connect(cfg, addr, handler)
            .await
            .map_err(|e| anyhow!("connect {user}: {e}"))?;
        let kp = PrivateKeyWithHashAlg::new(Arc::new(key.clone()), None);
        let auth = handle
            .authenticate_publickey(user, kp)
            .await
            .map_err(|e| anyhow!("auth {user}: {e}"))?;
        if !auth.success() {
            bail!("auth failed for {user}");
        }
        let mut channel = handle
            .channel_open_session()
            .await
            .map_err(|e| anyhow!("channel {user}: {e}"))?;
        channel
            .request_pty(false, "xterm-256color", cols, rows, 0, 0, &[])
            .await
            .map_err(|e| anyhow!("pty {user}: {e}"))?;
        channel
            .request_shell(false)
            .await
            .map_err(|e| anyhow!("shell {user}: {e}"))?;
        let banner = read_until(&mut channel, "cols=", Duration::from_secs(10)).await?;
        Ok((handle, channel, banner))
    }

    let (a_handle, mut a_channel, a_banner) =
        open_session(&addr, &host_fp, "fa", &client_key, 80, 24).await?;
    let (b_handle, mut b_channel, b_banner) =
        open_session(&addr, &host_fp, "fb", &client_key, 110, 30).await?;

    checks.ok(
        "banner-A",
        a_banner.contains("ZTFX[A]")
            && a_banner.contains("cols=80 ")
            && a_banner.contains("rows=24")
            && a_banner.contains("gen=1 "),
        a_banner.trim_end(),
    );
    checks.ok(
        "banner-B",
        b_banner.contains("ZTFX[B]")
            && b_banner.contains("cols=110 ")
            && b_banner.contains("rows=30")
            && b_banner.contains("gen=1 "),
        b_banner.trim_end(),
    );
    checks.ok("banners-distinct", a_banner != b_banner, "");

    fn parse_conn(banner: &str) -> Option<u32> {
        let idx = banner.find("conn=")? + 5;
        banner[idx..]
            .chars()
            .take_while(|c| c.is_ascii_digit())
            .collect::<String>()
            .parse()
            .ok()
    }
    let a_conn = parse_conn(&a_banner);
    let b_conn = parse_conn(&b_banner);
    checks.ok(
        "conn-ids-distinct",
        matches!((a_conn, b_conn), (Some(a), Some(b)) if a != b),
        &format!("a={a_conn:?} b={b_conn:?}"),
    );

    // --- resize payloads (distinct values per session) ----------------------
    a_channel.window_change(120, 40, 0, 0).await?;
    b_channel.window_change(90, 28, 0, 0).await?;
    a_channel.window_change(100, 50, 0, 0).await?;

    // --- tagged echo ---------------------------------------------------------
    async fn echo_round(
        channel: &mut russh::Channel<russh::client::Msg>,
        payload: &str,
        expect: &str,
    ) -> Result<bool> {
        channel.data(payload.as_bytes()).await?;
        let reply = read_until(channel, expect, Duration::from_secs(10)).await?;
        Ok(reply.contains(expect))
    }
    let a_echo_tag = format!("ZTFX[A]<{}:1> ping-A-1", a_conn.unwrap_or(0));
    checks.ok(
        "echo-A",
        echo_round(&mut a_channel, "ping-A-1", &a_echo_tag)
            .await
            .unwrap_or(false),
        "",
    );
    let b_echo_tag = format!("ZTFX[B]<{}:1> ping-B-1", b_conn.unwrap_or(0));
    checks.ok(
        "echo-B",
        echo_round(&mut b_channel, "ping-B-1", &b_echo_tag)
            .await
            .unwrap_or(false),
        "",
    );

    // --- controlled disconnect of B while A survives -------------------------
    let mut stdin = guard.child.stdin.take().expect("piped stdin");
    fn send_cmd<W: std::io::Write>(w: &mut W, cmd: &Value) -> Result<()> {
        w.write_all(format!("{cmd}\n").as_bytes())?;
        w.flush()?;
        Ok(())
    }
    send_cmd(
        &mut stdin,
        &json!({"op": "disconnect", "conn": b_conn.unwrap_or(0)}),
    )?;
    // control-result on stdout
    let mut control_ok = false;
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    while std::time::Instant::now() < deadline {
        match stdout_rx.recv_timeout(Duration::from_millis(200)) {
            Ok(line) => {
                if let Ok(v) = serde_json::from_str::<Value>(&line) {
                    if v.get("type").and_then(|t| t.as_str()) == Some("control-result") {
                        control_ok = v.get("ok").and_then(|o| o.as_bool()).unwrap_or(false);
                        break;
                    }
                }
            }
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => continue,
        }
    }
    checks.ok("control-disconnect-accepted", control_ok, "");

    // B channel must die
    let b_dead = async {
        match tokio::time::timeout(Duration::from_secs(10), b_channel.wait()).await {
            Ok(Some(russh::ChannelMsg::Close)) | Ok(Some(russh::ChannelMsg::Eof)) | Ok(None) => {
                true
            }
            Ok(Some(russh::ChannelMsg::Data { .. })) => false, // still alive
            _ => true, // session-level termination also counts as dead
        }
    }
    .await;
    checks.ok("control-disconnect-B-dead", b_dead, "");

    // A must still be alive and echo
    let a_alive = echo_round(
        &mut a_channel,
        "ping-A-2",
        &format!("ZTFX[A]<{}:1> ping-A-2", a_conn.unwrap_or(0)),
    )
    .await
    .unwrap_or(false);
    checks.ok("survivor-A-alive", a_alive, "");

    // --- reconnect B: new generation ----------------------------------------
    let (_b2_handle, mut b2_channel, b2_banner) =
        open_session(&addr, &host_fp, "fb", &client_key, 95, 31).await?;
    checks.ok(
        "reconnect-B-gen2",
        b2_banner.contains("ZTFX[B]")
            && b2_banner.contains("gen=2 ")
            && b2_banner.contains("cols=95 ")
            && b2_banner.contains("rows=31"),
        b2_banner.trim_end(),
    );
    let b2_echo = echo_round(
        &mut b2_channel,
        "ping-B-2",
        &format!(
            "ZTFX[B]<{}:2> ping-B-2",
            parse_conn(&b2_banner).unwrap_or(0)
        ),
    )
    .await
    .unwrap_or(false);
    checks.ok("reconnect-B-echo", b2_echo, "");

    // --- paint control: indexed grid at the current reported size ----------
    send_cmd(
        &mut stdin,
        &json!({"op": "paint", "conn": a_conn.unwrap_or(0)}),
    )?;
    let mut paint_ok = false;
    let mut paint_detail = String::new();
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    while std::time::Instant::now() < deadline {
        match stdout_rx.recv_timeout(Duration::from_millis(200)) {
            Ok(line) => {
                if let Ok(v) = serde_json::from_str::<Value>(&line) {
                    if v.get("type").and_then(|t| t.as_str()) == Some("control-result")
                        && v.get("op").and_then(|o| o.as_str()) == Some("paint")
                    {
                        paint_ok = v.get("ok").and_then(|o| o.as_bool()).unwrap_or(false);
                        paint_detail = v
                            .get("detail")
                            .and_then(|d| d.as_str())
                            .unwrap_or("")
                            .to_string();
                        break;
                    }
                }
            }
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => continue,
        }
    }
    // A's live size at this point: pty 80x24, then resizes 120x40 -> 100x50.
    // Grid bytes: clear+home ESC sequence (7) + rows*cols + (rows-1)*2 (the
    // last line carries no trailing newline, so nothing scrolls).
    let expected_grid = 7 + 50 * 100 + 49 * 2;
    checks.ok(
        "control-paint",
        paint_ok && paint_detail == format!("100x50:{expected_grid}"),
        &paint_detail,
    );

    // --- JSONL evidence ------------------------------------------------------
    tokio::time::sleep(Duration::from_millis(300)).await;
    let jsonl = std::fs::read_to_string(&log_path).context("reading fixture.jsonl")?;
    let events: Vec<Value> = jsonl
        .lines()
        .filter_map(|l| serde_json::from_str(l).ok())
        .collect();
    let has_type = |t: &str, pred: &dyn Fn(&Value) -> bool| {
        events
            .iter()
            .any(|e| e.get("type").and_then(|x| x.as_str()) == Some(t) && pred(e))
    };
    checks.ok(
        "jsonl-auth-reject-wrong-key",
        has_type("auth", &|e| {
            e.get("reason").and_then(|r| r.as_str()) == Some("key-not-authorized")
        }),
        "",
    );
    checks.ok(
        "jsonl-auth-reject-wrong-user",
        has_type("auth", &|e| {
            e.get("reason").and_then(|r| r.as_str()) == Some("user-not-allowed")
        }),
        "",
    );
    // Per-conn pty-before-resize with exact sizes
    let ordered_sizes = |conn: u32, sizes: &[(u32, u32)]| -> bool {
        let mut events_for_conn: Vec<&Value> = events
            .iter()
            .filter(|e| {
                e.get("conn").and_then(|c| c.as_u64()) == Some(conn as u64)
                    && matches!(
                        e.get("type").and_then(|t| t.as_str()),
                        Some("pty") | Some("resize")
                    )
            })
            .collect();
        events_for_conn.sort_by_key(|e| e.get("seq").and_then(|s| s.as_u64()).unwrap_or(0));
        let actual: Vec<(u32, u32)> = events_for_conn
            .iter()
            .filter_map(|e| {
                Some((
                    e.get("cols")?.as_u64()? as u32,
                    e.get("rows")?.as_u64()? as u32,
                ))
            })
            .collect();
        actual == sizes.to_vec()
    };
    if let Some(a_conn) = a_conn {
        checks.ok(
            "jsonl-A-size-sequence",
            ordered_sizes(a_conn, &[(80, 24), (120, 40), (100, 50)]),
            "",
        );
    } else {
        checks.ok("jsonl-A-size-sequence", false, "missing A conn id");
    }
    if let Some(b_conn) = b_conn {
        checks.ok(
            "jsonl-B-size-sequence",
            ordered_sizes(b_conn, &[(110, 30), (90, 28)]),
            "",
        );
        checks.ok(
            "jsonl-B-conn-close",
            has_type("conn_close", &|e| {
                e.get("conn").and_then(|c| c.as_u64()) == Some(b_conn as u64)
            }),
            "",
        );
    } else {
        checks.ok("jsonl-B-size-sequence", false, "missing B conn id");
    }
    checks.ok(
        "jsonl-fb-gen2",
        has_type("auth_succeeded", &|e| {
            e.get("user").and_then(|u| u.as_str()) == Some("fb")
                && e.get("userGen").and_then(|g| g.as_u64()) == Some(2)
        }),
        "",
    );

    // --- shutdown & listener release ----------------------------------------
    send_cmd(&mut stdin, &json!({"op": "shutdown"}))?;
    let exit_deadline = std::time::Instant::now() + Duration::from_secs(10);
    let exited_cleanly = loop {
        if std::time::Instant::now() > exit_deadline {
            break false;
        }
        match guard.child.try_wait() {
            Ok(Some(status)) => break status.success(),
            Ok(None) => tokio::time::sleep(Duration::from_millis(100)).await,
            Err(_) => break false,
        }
    };
    checks.ok("shutdown-clean-exit", exited_cleanly, "");

    // Listener released: loopback connect must fail within a few seconds.
    let mut refused = false;
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    while std::time::Instant::now() < deadline {
        match std::net::TcpStream::connect_timeout(
            &format!("127.0.0.1:{port}").parse().unwrap(),
            Duration::from_millis(300),
        ) {
            Ok(_) => std::thread::sleep(Duration::from_millis(200)),
            Err(_) => {
                refused = true;
                break;
            }
        }
    }
    checks.ok("listener-released", refused, "");

    // Close surviving client sessions (owned children of this test).
    drop(stdin);
    for h in [a_handle, b_handle] {
        let _ = h
            .disconnect(
                Disconnect::ByApplication,
                "selftest-done".into(),
                "en".into(),
            )
            .await;
    }

    println!(
        "SELFCHECK RESULT {} pass={} fail={}",
        if checks.fail == 0 { "PASS" } else { "FAIL" },
        checks.pass,
        checks.fail
    );
    Ok(if checks.fail == 0 { 0 } else { 1 })
}

/// Read channel data until `needle` appears, EOF/close, or timeout.
async fn read_until(
    channel: &mut russh::Channel<russh::client::Msg>,
    needle: &str,
    timeout: Duration,
) -> Result<String> {
    let deadline = tokio::time::Instant::now() + timeout;
    let mut buf = String::new();
    loop {
        let remain = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remain.is_zero() {
            bail!("timeout waiting for {needle:?}; got so far: {buf:?}");
        }
        match tokio::time::timeout(remain, channel.wait()).await {
            Err(_) => bail!("timeout waiting for {needle:?}; got so far: {buf:?}"),
            Ok(None) => bail!("channel closed waiting for {needle:?}; got so far: {buf:?}"),
            Ok(Some(russh::ChannelMsg::Data { data })) => {
                buf.push_str(&String::from_utf8_lossy(&data));
                if buf.contains(needle) {
                    return Ok(buf);
                }
            }
            Ok(Some(russh::ChannelMsg::ExtendedData { data, .. })) => {
                buf.push_str(&String::from_utf8_lossy(&data));
            }
            Ok(Some(russh::ChannelMsg::Close)) | Ok(Some(russh::ChannelMsg::Eof)) => {
                bail!("channel EOF waiting for {needle:?}; got so far: {buf:?}")
            }
            Ok(Some(_)) => {}
        }
    }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

fn print_usage() {
    println!(
        "usage: ssh_loopback_fixture <serve|selftest> --state-dir <dir>\n\
         serve:    run the loopback fixture (see module docs for the contract)\n\
         selftest: spawn a serve child and run the phase-1 self checks"
    );
}

#[tokio::main]
async fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().collect();
    let mode = args.get(1).map(|s| s.as_str()).unwrap_or("");
    let state_dir = args
        .iter()
        .position(|a| a == "--state-dir")
        .and_then(|i| args.get(i + 1))
        .map(PathBuf::from);
    let state_dir = match state_dir {
        Some(d) => d,
        None => {
            print_usage();
            bail!("--state-dir is required");
        }
    };
    match mode {
        "serve" => serve(state_dir).await,
        "selftest" => {
            let code = selftest(state_dir).await?;
            std::process::exit(code);
        }
        _ => {
            print_usage();
            bail!("unknown mode: {mode:?}");
        }
    }
}
