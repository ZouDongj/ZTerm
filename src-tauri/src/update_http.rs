//! WinHTTP client for the in-app update channel (release check + installer
//! download).
//!
//! Why WinHTTP instead of a plain Rust HTTP client: corporate networks
//! publish their GitHub path through a domain proxy that authenticates with
//! Windows SSO (Negotiate/NTLM), usually handed out via PAC or per-protocol
//! registry entries. WinHTTP is the same OS stack browsers use: it reads the
//! current user's WinINET proxy configuration (static proxy + bypass list,
//! per-protocol entries, or PAC via WinHttpGetProxyForUrl) and answers a
//! proxy 407 challenge with the interactive logon session's default
//! credentials — the account password never passes through this process.
//! The explicit `terminal.updateProxy` setting stays the highest-priority
//! override, and Basic credentials parsed from its URL userinfo are applied
//! only to that explicit proxy.
//!
//! Proxy resolution order (mirrors the previous ureq-based stack):
//!   1. explicit `terminal.updateProxy` (http/https only; socks rejected)
//!   2. HTTPS_PROXY / HTTP_PROXY / ALL_PROXY env vars (NO_PROXY respected)
//!   3. WinINET current-user config: PAC (per-URL resolution) or static
//!      registry proxy (per-protocol entries collapsed to the https= entry)
//!   4. direct

use std::ffi::c_void;
use std::time::{Duration, Instant};

use windows::core::{Error as WinError, PCWSTR, PWSTR};
use windows::Win32::Foundation::{GlobalFree, HGLOBAL};
use windows::Win32::Networking::WinHttp::WinHttpAddRequestHeaders;
use windows::Win32::Networking::WinHttp::WinHttpCloseHandle;
use windows::Win32::Networking::WinHttp::WinHttpConnect;
use windows::Win32::Networking::WinHttp::WinHttpCrackUrl;
use windows::Win32::Networking::WinHttp::WinHttpGetIEProxyConfigForCurrentUser;
use windows::Win32::Networking::WinHttp::WinHttpGetProxyForUrl;
use windows::Win32::Networking::WinHttp::WinHttpOpen;
use windows::Win32::Networking::WinHttp::WinHttpOpenRequest;
use windows::Win32::Networking::WinHttp::WinHttpQueryAuthSchemes;
use windows::Win32::Networking::WinHttp::WinHttpQueryDataAvailable;
use windows::Win32::Networking::WinHttp::WinHttpQueryHeaders;
use windows::Win32::Networking::WinHttp::WinHttpReadData;
use windows::Win32::Networking::WinHttp::WinHttpReceiveResponse;
use windows::Win32::Networking::WinHttp::WinHttpSendRequest;
use windows::Win32::Networking::WinHttp::WinHttpSetCredentials;
use windows::Win32::Networking::WinHttp::WinHttpSetOption;
use windows::Win32::Networking::WinHttp::WinHttpSetTimeouts;
use windows::Win32::Networking::WinHttp::URL_COMPONENTS;
use windows::Win32::Networking::WinHttp::WINHTTP_ACCESS_TYPE_NAMED_PROXY;
use windows::Win32::Networking::WinHttp::WINHTTP_ACCESS_TYPE_NO_PROXY;
use windows::Win32::Networking::WinHttp::WINHTTP_ADDREQ_FLAG_ADD;
use windows::Win32::Networking::WinHttp::WINHTTP_ADDREQ_FLAG_REPLACE;
use windows::Win32::Networking::WinHttp::WINHTTP_AUTH_SCHEME_BASIC;
use windows::Win32::Networking::WinHttp::WINHTTP_AUTH_SCHEME_NEGOTIATE;
use windows::Win32::Networking::WinHttp::WINHTTP_AUTH_SCHEME_NTLM;
use windows::Win32::Networking::WinHttp::WINHTTP_AUTH_TARGET_PROXY;
use windows::Win32::Networking::WinHttp::WINHTTP_AUTOPROXY_AUTO_DETECT;
use windows::Win32::Networking::WinHttp::WINHTTP_AUTOPROXY_CONFIG_URL;
use windows::Win32::Networking::WinHttp::WINHTTP_AUTOPROXY_OPTIONS;
use windows::Win32::Networking::WinHttp::WINHTTP_AUTO_DETECT_TYPE_DHCP;
use windows::Win32::Networking::WinHttp::WINHTTP_AUTO_DETECT_TYPE_DNS_A;
use windows::Win32::Networking::WinHttp::WINHTTP_CURRENT_USER_IE_PROXY_CONFIG;
use windows::Win32::Networking::WinHttp::WINHTTP_FLAG_SECURE;
use windows::Win32::Networking::WinHttp::WINHTTP_INTERNET_SCHEME_HTTPS;
use windows::Win32::Networking::WinHttp::WINHTTP_OPEN_REQUEST_FLAGS;
use windows::Win32::Networking::WinHttp::WINHTTP_OPTION_PROXY;
use windows::Win32::Networking::WinHttp::WINHTTP_PROXY_INFO;
use windows::Win32::Networking::WinHttp::WINHTTP_QUERY_CONTENT_LENGTH;
use windows::Win32::Networking::WinHttp::WINHTTP_QUERY_FLAG_NUMBER;
use windows::Win32::Networking::WinHttp::WINHTTP_QUERY_STATUS_CODE;

/// WinHTTP handles are opaque pointers; null means the call failed.
type Handle = *mut c_void;

/// Which proxy source to use for a request. `Auto` runs the env → WinINET
/// (PAC/static) → direct chain; `Explicit` is the validated user setting
/// (Basic userinfo, when present, is used for the proxy challenge only).
pub enum ProxyChoice {
    Auto,
    Explicit(String),
}

/// Timeout profile for a call. WinHTTP bounds each phase separately
/// (resolve/connect/send/receive); the overall deadline additionally aborts
/// stalled body reads (a trickling stream can outlive every phase timeout).
/// `Check` uses ~10s phases with a 30s body budget; `Download` keeps
/// single-read stalls at 30s with a 300s body budget, matching the old
/// stack's global cap for the transfer phase.
#[derive(Clone, Copy)]
pub enum Preset {
    Check,
    Download,
}

impl Preset {
    fn timeouts(self) -> (i32, i32, i32, i32) {
        match self {
            Preset::Check => (10_000, 10_000, 10_000, 10_000),
            Preset::Download => (10_000, 10_000, 30_000, 30_000),
        }
    }
    fn overall_deadline(self) -> Duration {
        match self {
            Preset::Check => Duration::from_secs(30),
            Preset::Download => Duration::from_secs(300),
        }
    }
}

/// A failed exchange. `tag` is the stable classification the frontend maps
/// to friendly guidance (timeout / resolve / connect / http / other); the
/// previous ureq-based tag semantics are preserved.
pub struct HttpFail {
    pub tag: &'static str,
    pub detail: String,
}

impl std::fmt::Debug for HttpFail {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "HttpFail[{}]: {}", self.tag, self.detail)
    }
}

impl HttpFail {
    fn from_win32(context: &str, err: &WinError) -> Self {
        HttpFail {
            tag: winhttp_error_tag(win32_code(err.code().0)),
            detail: format!("{context}: {err}"),
        }
    }
}

/// windows::core::Error carries an HRESULT; WinHTTP failures raised through
/// HRESULT_FROM_WIN32 (0x8007xxxx) hide the real code in the low 16 bits.
/// Map either shape to the bare Win32 code the tag table expects.
fn win32_code(hresult: i32) -> u32 {
    let raw = hresult as u32;
    if raw & 0xFFFF_0000 == 0x8007_0000 {
        raw & 0xFFFF
    } else {
        raw
    }
}

/// Wrap the last Win32 error into an HttpFail (for handle-returning calls
/// that signal failure with null instead of a Result).
fn last_error(context: &str) -> HttpFail {
    HttpFail::from_win32(context, &WinError::from_win32())
}

/// Classify a Win32/WinHTTP error code into the update channel's stable tag
/// set. Values are the documented winhttp.h constants.
fn winhttp_error_tag(code: u32) -> &'static str {
    match code {
        12_002 => "timeout", // ERROR_WINHTTP_TIMEOUT
        12_007 => "resolve", // ERROR_WINHTTP_NAME_NOT_RESOLVED
        12_029 => "connect", // ERROR_WINHTTP_CANNOT_CONNECT
        12_030 => "connect", // ERROR_WINHTTP_CONNECTION_ERROR
        _ => "other",
    }
}

/// NUL-terminated UTF-16 for PCWSTR parameters.
fn to_wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

fn from_wide(pw: PWSTR) -> String {
    if pw.is_null() {
        return String::new();
    }
    unsafe {
        let mut len = 0usize;
        while *pw.0.add(len) != 0 {
            len += 1;
        }
        String::from_utf16_lossy(std::slice::from_raw_parts(pw.0, len))
    }
}

/// Free a string the WinHTTP API allocated with GlobalAlloc; a null pointer
/// frees nothing.
fn free_winhttp_string(pw: PWSTR) {
    if !pw.is_null() {
        unsafe {
            let _ = GlobalFree(Some(HGLOBAL(pw.0 as *mut _)));
        }
    }
}

struct UrlParts {
    https: bool,
    host: String,
    port: u16,
    path_and_query: String,
}

fn crack_url(url: &str) -> Result<UrlParts, HttpFail> {
    let wide = to_wide(url);
    let mut scheme = vec![0u16; 32];
    let mut host = vec![0u16; 256];
    let mut path = vec![0u16; 4096];
    let mut extra = vec![0u16; 1024];
    let mut uc = URL_COMPONENTS::default();
    uc.dwStructSize = std::mem::size_of::<URL_COMPONENTS>() as u32;
    uc.dwSchemeLength = scheme.len() as u32;
    uc.lpszScheme = PWSTR(scheme.as_mut_ptr());
    uc.dwHostNameLength = host.len() as u32;
    uc.lpszHostName = PWSTR(host.as_mut_ptr());
    uc.dwUrlPathLength = path.len() as u32;
    uc.lpszUrlPath = PWSTR(path.as_mut_ptr());
    uc.dwExtraInfoLength = extra.len() as u32;
    uc.lpszExtraInfo = PWSTR(extra.as_mut_ptr());
    unsafe {
        WinHttpCrackUrl(&wide, 0, &mut uc)
            .map_err(|e| HttpFail::from_win32("WinHttpCrackUrl", &e))?;
    }
    Ok(UrlParts {
        https: uc.nScheme == WINHTTP_INTERNET_SCHEME_HTTPS,
        host: String::from_utf16_lossy(&host[..uc.dwHostNameLength as usize]),
        port: uc.nPort,
        path_and_query: format!(
            "{}{}",
            String::from_utf16_lossy(&path[..uc.dwUrlPathLength as usize]),
            String::from_utf16_lossy(&extra[..uc.dwExtraInfoLength as usize])
        ),
    })
}

/// A fully parsed explicit proxy URL. `server` is always plain `host:port`.
#[derive(Debug)]
pub struct ParsedProxy {
    pub server: String,
    pub user: Option<String>,
    pub pass: Option<String>,
}

/// Redact any userinfo (user:pass@) before echoing a proxy URL in an error
/// message — the config stores it plaintext, but error text travels further
/// (UI, logs, bug reports).
pub fn redact_proxy_userinfo(url: &str) -> String {
    match url.find('@') {
        Some(at) => {
            let scheme_end = url.find("://").map(|i| i + 3).unwrap_or(0);
            format!("{}***@{}", &url[..scheme_end], &url[at + 1..])
        }
        None => url.to_string(),
    }
}

/// Validate and parse an explicit proxy URL: http(s) only (socks is rejected
/// outright — we cannot speak it) with an optional user:pass@ userinfo used
/// for Basic auth against the proxy. Error strings are part of the contract:
/// the "invalid update proxy" prefix is composed by the caller and the
/// message text is pinned by E2E.
pub fn parse_explicit_proxy(url: &str) -> Result<ParsedProxy, String> {
    let (scheme, rest) = match url.split_once("://") {
        Some((s, r)) => (s.to_ascii_lowercase(), r.to_string()),
        None => (String::new(), url.to_string()),
    };
    if !scheme.is_empty() && scheme != "http" && scheme != "https" {
        return Err(format!(
            "only http(s) proxies are supported (got '{scheme}://')"
        ));
    }
    let (creds, hostport) = match rest.rfind('@') {
        Some(at) => (Some(rest[..at].to_string()), rest[at + 1..].to_string()),
        None => (None, rest),
    };
    let (user, pass) = match creds {
        Some(c) => match c.split_once(':') {
            Some((u, p)) => (Some(u.to_string()), Some(p.to_string())),
            None => (Some(c), Some(String::new())),
        },
        None => (None, None),
    };
    let (host, port) = match hostport.rsplit_once(':') {
        Some((h, p)) if !h.is_empty() && !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()) => {
            let n: u16 = p.parse().map_err(|_| format!("bad port '{p}'"))?;
            (h.to_string(), n)
        }
        _ => {
            if hostport.is_empty() {
                return Err("missing host".to_string());
            }
            // A colon here means an empty host or a non-numeric port
            // (":8080", "host:http") — neither is a usable proxy address.
            if hostport.contains(':') {
                return Err(format!("invalid proxy address '{hostport}'"));
            }
            (hostport.clone(), if scheme == "https" { 443 } else { 8080 })
        }
    };
    // Host sanity: DNS names, IPv4 and bracketed IPv6 only. Free text like
    // "not a url" must fail validation instead of silently becoming a proxy
    // host (the E2E-pinned "invalid update proxy" contract).
    let valid_host_char =
        |c: char| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_' | ':' | '[' | ']');
    if host.is_empty() || !host.chars().all(valid_host_char) {
        return Err(format!("invalid host '{host}'"));
    }
    Ok(ParsedProxy {
        server: format!("{host}:{port}"),
        user,
        pass,
    })
}

/// Full validation of a configured proxy URL with the contract error prefix
/// (message text is pinned by E2E) and userinfo redaction.
pub fn validate_proxy_url(url: &str) -> Result<(), String> {
    parse_explicit_proxy(url)
        .map(|_| ())
        .map_err(|e| format!("invalid update proxy '{}': {e}", redact_proxy_userinfo(url)))
}

/// A proxy server picked by the resolution chain.
struct ResolvedProxy {
    server: Option<String>,
    bypass: Option<String>,
}

/// Pick a proxy from the environment (legacy parity with the previous
/// stack: HTTPS_PROXY / HTTP_PROXY / ALL_PROXY, either case, NO_PROXY
/// respected).
fn resolve_env_proxy(lookup: impl Fn(&str) -> Option<String>, target_host: &str) -> Option<String> {
    let raw = lookup("HTTPS_PROXY")
        .or_else(|| lookup("https_proxy"))
        .or_else(|| lookup("HTTP_PROXY"))
        .or_else(|| lookup("http_proxy"))
        .or_else(|| lookup("ALL_PROXY"))
        .or_else(|| lookup("all_proxy"))?;
    if no_proxy_matches(
        lookup("NO_PROXY").or_else(|| lookup("no_proxy")),
        target_host,
    ) {
        return None;
    }
    parse_explicit_proxy(raw.trim()).ok().map(|p| p.server)
}

/// True when the NO_PROXY list (comma-separated hosts/domains, `*` for all)
/// covers the target host.
fn no_proxy_matches(no_proxy: Option<String>, host: &str) -> bool {
    let Some(list) = no_proxy else { return false };
    let host = host.to_ascii_lowercase();
    for entry in list.split(',') {
        let entry = entry.trim().to_ascii_lowercase();
        if entry.is_empty() {
            continue;
        }
        if entry == "*" || entry == host || (entry.starts_with('.') && host.ends_with(&entry)) {
            return true;
        }
    }
    false
}

/// Collapse a WinINET static ProxyServer value to a single `host:port`.
/// Registry per-protocol form ("http=a:80;https=b:443") uses the https=
/// entry (falling back to http=); a bare value passes through.
fn collapse_wininet_static(raw: &str) -> Option<String> {
    let raw = raw.trim();
    if raw.is_empty() {
        return None;
    }
    if raw.contains('=') {
        let mut https = None;
        let mut http = None;
        for part in raw.split(';') {
            if let Some((k, v)) = part.split_once('=') {
                let v = v.trim();
                match k.trim().to_ascii_lowercase().as_str() {
                    "https" => https = Some(v.to_string()),
                    "http" => http = Some(v.to_string()),
                    _ => {}
                }
            }
        }
        return collapse_wininet_static(&https.or(http)?);
    }
    let stripped = raw
        .strip_prefix("http://")
        .or_else(|| raw.strip_prefix("https://"))
        .unwrap_or(raw);
    Some(stripped.to_string())
}

/// Resolve the effective proxy under ProxyChoice::Auto: env vars, then the
/// user's WinINET configuration (PAC per-URL, else static registry proxy),
/// else direct. A PAC/WPAD failure degrades to direct — the same behavior a
/// browser shows when the script is unreachable.
fn resolve_auto_proxy(session: Handle, url: &str, host: &str) -> ResolvedProxy {
    if let Some(server) = resolve_env_proxy(|name| std::env::var(name).ok(), host) {
        return ResolvedProxy {
            server: Some(server),
            bypass: None,
        };
    }
    unsafe {
        let mut cfg = WINHTTP_CURRENT_USER_IE_PROXY_CONFIG::default();
        if WinHttpGetIEProxyConfigForCurrentUser(&mut cfg).is_err() {
            return ResolvedProxy {
                server: None,
                bypass: None,
            };
        }
        let auto_config_url = from_wide(cfg.lpszAutoConfigUrl);
        let static_proxy = from_wide(cfg.lpszProxy);
        let bypass = from_wide(cfg.lpszProxyBypass);
        free_winhttp_string(cfg.lpszAutoConfigUrl);
        free_winhttp_string(cfg.lpszProxy);
        free_winhttp_string(cfg.lpszProxyBypass);

        if !auto_config_url.is_empty() || cfg.fAutoDetect.as_bool() {
            let mut opts = WINHTTP_AUTOPROXY_OPTIONS {
                fAutoLogonIfChallenged: windows::core::BOOL::default(),
                ..Default::default()
            };
            let ac_url_w;
            if auto_config_url.is_empty() {
                opts.dwFlags = WINHTTP_AUTOPROXY_AUTO_DETECT;
                opts.dwAutoDetectFlags =
                    WINHTTP_AUTO_DETECT_TYPE_DHCP | WINHTTP_AUTO_DETECT_TYPE_DNS_A;
            } else {
                ac_url_w = to_wide(&auto_config_url);
                opts.dwFlags = WINHTTP_AUTOPROXY_CONFIG_URL;
                opts.lpszAutoConfigUrl = PCWSTR(ac_url_w.as_ptr());
            }
            let mut info = WINHTTP_PROXY_INFO::default();
            let url_w = to_wide(url);
            if WinHttpGetProxyForUrl(session, PCWSTR(url_w.as_ptr()), &mut opts, &mut info).is_ok()
            {
                let server = from_wide(info.lpszProxy);
                let bypass = from_wide(info.lpszProxyBypass);
                free_winhttp_string(info.lpszProxy);
                free_winhttp_string(info.lpszProxyBypass);
                return ResolvedProxy {
                    server: collapse_wininet_static(&server),
                    bypass: if bypass.is_empty() {
                        None
                    } else {
                        Some(bypass)
                    },
                };
            }
            return ResolvedProxy {
                server: None,
                bypass: None,
            };
        }
        ResolvedProxy {
            server: collapse_wininet_static(&static_proxy),
            bypass: if bypass.is_empty() {
                None
            } else {
                Some(bypass)
            },
        }
    }
}

/// Full response of a completed exchange (any status — the caller decides
/// what counts as an error, e.g. 404 "no releases yet").
pub struct HttpResponse {
    pub status: u16,
    pub body: Vec<u8>,
}

/// Streaming body for downloads: headers (and proxy authentication) are
/// complete when this returns; chunks are read on demand so the caller can
/// update progress state between reads. Handles close on drop.
pub struct HttpStream {
    session: Handle,
    connect: Handle,
    request: Handle,
    deadline: Instant,
}

impl Drop for HttpStream {
    fn drop(&mut self) {
        close_handle(self.request);
        close_handle(self.connect);
        close_handle(self.session);
    }
}

fn close_handle(h: Handle) {
    if !h.is_null() {
        unsafe {
            let _ = WinHttpCloseHandle(h);
        }
    }
}

impl HttpStream {
    /// Read the next chunk into `buf`; Ok(0) means end of body. The overall
    /// deadline aborts a stalled-but-trickling transfer, which the per-read
    /// receive timeout alone cannot bound.
    pub fn read_chunk(&mut self, buf: &mut [u8]) -> Result<usize, HttpFail> {
        if Instant::now() >= self.deadline {
            return Err(HttpFail {
                tag: "timeout",
                detail: "overall transfer deadline exceeded".to_string(),
            });
        }
        let mut available: u32 = 0;
        unsafe {
            WinHttpQueryDataAvailable(self.request, &mut available)
                .map_err(|e| HttpFail::from_win32("WinHttpQueryDataAvailable", &e))?;
        }
        if available == 0 {
            return Ok(0);
        }
        let to_read = (available as usize).min(buf.len());
        let mut read: u32 = 0;
        unsafe {
            WinHttpReadData(
                self.request,
                buf.as_mut_ptr() as *mut c_void,
                to_read as u32,
                &mut read,
            )
            .map_err(|e| HttpFail::from_win32("WinHttpReadData", &e))?;
        }
        Ok(read as usize)
    }
}

/// Open a GET exchange and carry it through proxy authentication and header
/// completion. Returns (session, connect, request, status, content_length).
fn send_get(
    url: &str,
    extra_headers: &[(&str, &str)],
    proxy: &ProxyChoice,
    preset: Preset,
) -> Result<(Handle, Handle, Handle, u16, Option<u64>), HttpFail> {
    let parts = crack_url(url)?;

    // Validate/crack the explicit override before opening any handle, so a
    // bad value cannot leak a session on its error path. Both http:// and
    // https:// proxy URLs are dialed as plain HTTP proxies (CONNECT
    // tunneling); a TLS-to-proxy link is not supported.
    let mut explicit_basic: Option<(String, String)> = None;
    let mut proxy_server_w: Vec<u16> = Vec::new();
    let mut proxy_bypass_w: Vec<u16> = Vec::new();
    if let ProxyChoice::Explicit(raw) = proxy {
        let parsed = parse_explicit_proxy(raw).map_err(|e| HttpFail {
            tag: "other",
            detail: format!("invalid update proxy '{}': {e}", redact_proxy_userinfo(raw)),
        })?;
        explicit_basic = parsed.user.map(|u| (u, parsed.pass.unwrap_or_default()));
        proxy_server_w = to_wide(&parsed.server);
    }
    let ua = to_wide(concat!("zterm/", env!("CARGO_PKG_VERSION")));
    let (resolve, connect_t, send_t, recv_t) = preset.timeouts();
    let session = unsafe {
        let h = WinHttpOpen(
            PCWSTR(ua.as_ptr()),
            WINHTTP_ACCESS_TYPE_NO_PROXY,
            PCWSTR::null(),
            PCWSTR::null(),
            0,
        );
        if h.is_null() {
            return Err(last_error("WinHttpOpen"));
        }
        let _ = WinHttpSetTimeouts(h, resolve, connect_t, send_t, recv_t);
        h
    };

    if proxy_server_w.is_empty() {
        if let ProxyChoice::Auto = proxy {
            // NO_PROXY only suppresses the env-var layer; the WinINET
            // (PAC/static) chain is independent and still applies.
            let resolved = resolve_auto_proxy(session, url, &parts.host);
            if let Some(server) = resolved.server {
                proxy_server_w = to_wide(&server);
                if let Some(b) = resolved.bypass {
                    proxy_bypass_w = to_wide(&b);
                }
            }
        }
    }

    let mut proxy_info = WINHTTP_PROXY_INFO {
        dwAccessType: WINHTTP_ACCESS_TYPE_NO_PROXY,
        lpszProxy: PWSTR::null(),
        lpszProxyBypass: PWSTR::null(),
    };
    // Buffers backing proxy_info pointers; must outlive the SetOption call.

    if !proxy_server_w.is_empty() {
        proxy_info.dwAccessType = WINHTTP_ACCESS_TYPE_NAMED_PROXY;
        proxy_info.lpszProxy = PWSTR(proxy_server_w.as_mut_ptr());
        if !proxy_bypass_w.is_empty() {
            proxy_info.lpszProxyBypass = PWSTR(proxy_bypass_w.as_mut_ptr());
        }
    }

    unsafe {
        let host_w = to_wide(&parts.host);
        let connect = WinHttpConnect(session, PCWSTR(host_w.as_ptr()), parts.port, 0);
        if connect.is_null() {
            close_handle(session);
            return Err(last_error("WinHttpConnect"));
        }
        let verb_w = to_wide("GET");
        let path_w = to_wide(&parts.path_and_query);
        let request = WinHttpOpenRequest(
            connect,
            PCWSTR(verb_w.as_ptr()),
            PCWSTR(path_w.as_ptr()),
            PCWSTR::null(),
            PCWSTR::null(),
            std::ptr::null(),
            if parts.https {
                WINHTTP_FLAG_SECURE
            } else {
                WINHTTP_OPEN_REQUEST_FLAGS(0)
            },
        );
        if request.is_null() {
            close_handle(connect);
            close_handle(session);
            return Err(last_error("WinHttpOpenRequest"));
        }
        let proxy_bytes = std::slice::from_raw_parts(
            &proxy_info as *const WINHTTP_PROXY_INFO as *const u8,
            std::mem::size_of::<WINHTTP_PROXY_INFO>(),
        );
        if WinHttpSetOption(Some(request), WINHTTP_OPTION_PROXY, Some(proxy_bytes)).is_err() {
            let _ = WinHttpCloseHandle(request);
            close_handle(connect);
            close_handle(session);
            return Err(HttpFail {
                tag: "other",
                detail: "WinHttpSetOption(PROXY) failed".to_string(),
            });
        }
        for (name, value) in extra_headers {
            let line = to_wide(&format!("{name}: {value}\r\n"));
            let _ = WinHttpAddRequestHeaders(
                request,
                &line,
                WINHTTP_ADDREQ_FLAG_ADD | WINHTTP_ADDREQ_FLAG_REPLACE,
            );
        }

        if let Err(e) = run_auth_rounds(request, &explicit_basic) {
            let _ = WinHttpCloseHandle(request);
            close_handle(connect);
            close_handle(session);
            return Err(e);
        }

        let status = match status_of(request) {
            Ok(s) => s,
            Err(e) => {
                let _ = WinHttpCloseHandle(request);
                close_handle(connect);
                close_handle(session);
                return Err(e);
            }
        };
        let content_length = query_content_length(request);
        Ok((session, connect, request, status, content_length))
    }
}

/// Send + receive, and while the response is 407, retry with credentials:
/// Negotiate or NTLM (preferred, with the interactive logon session's
/// default credentials — SSO), or Basic when the explicit proxy URL carried
/// userinfo. Bounded to three rounds.
fn run_auth_rounds(
    request: Handle,
    explicit_basic: &Option<(String, String)>,
) -> Result<(), HttpFail> {
    unsafe {
        for _round in 0..3 {
            WinHttpSendRequest(request, None, None, 0, 0, 0)
                .map_err(|e| HttpFail::from_win32("WinHttpSendRequest", &e))?;
            WinHttpReceiveResponse(request, std::ptr::null_mut())
                .map_err(|e| HttpFail::from_win32("WinHttpReceiveResponse", &e))?;
            if status_of(request)? != 407 {
                return Ok(());
            }
            let mut supported: u32 = 0;
            let mut first: u32 = 0;
            let mut target: u32 = 0;
            if WinHttpQueryAuthSchemes(request, &mut supported, &mut first, &mut target).is_err() {
                return Ok(()); // no scheme info — surface the 407 as-is
            }
            let _ = target;
            if supported & WINHTTP_AUTH_SCHEME_NEGOTIATE.0 != 0 {
                let _ = WinHttpSetCredentials(
                    request,
                    WINHTTP_AUTH_TARGET_PROXY,
                    WINHTTP_AUTH_SCHEME_NEGOTIATE.0,
                    PCWSTR::null(),
                    PCWSTR::null(),
                    std::ptr::null_mut(),
                );
            } else if supported & WINHTTP_AUTH_SCHEME_NTLM.0 != 0 {
                let _ = WinHttpSetCredentials(
                    request,
                    WINHTTP_AUTH_TARGET_PROXY,
                    WINHTTP_AUTH_SCHEME_NTLM.0,
                    PCWSTR::null(),
                    PCWSTR::null(),
                    std::ptr::null_mut(),
                );
            } else if supported & WINHTTP_AUTH_SCHEME_BASIC.0 != 0 {
                let Some((user, pass)) = explicit_basic else {
                    return Ok(()); // Basic offered but no credentials — 407 as-is
                };
                let u = to_wide(user);
                let p = to_wide(pass);
                let _ = WinHttpSetCredentials(
                    request,
                    WINHTTP_AUTH_TARGET_PROXY,
                    WINHTTP_AUTH_SCHEME_BASIC.0,
                    PCWSTR(u.as_ptr()),
                    PCWSTR(p.as_ptr()),
                    std::ptr::null_mut(),
                );
            } else {
                return Ok(());
            }
        }
        Ok(())
    }
}

fn status_of(request: Handle) -> Result<u16, HttpFail> {
    let mut status: u32 = 0;
    let mut size = std::mem::size_of::<u32>() as u32;
    unsafe {
        WinHttpQueryHeaders(
            request,
            WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
            PCWSTR::null(),
            Some(&mut status as *mut u32 as *mut c_void),
            &mut size,
            std::ptr::null_mut(),
        )
        .map_err(|e| HttpFail::from_win32("WinHttpQueryHeaders(STATUS)", &e))?;
    }
    Ok(status as u16)
}

fn query_content_length(request: Handle) -> Option<u64> {
    let mut len = [0u16; 32];
    let mut size = (len.len() * 2) as u32;
    let ok = unsafe {
        WinHttpQueryHeaders(
            request,
            WINHTTP_QUERY_CONTENT_LENGTH,
            PCWSTR::null(),
            Some(len.as_mut_ptr() as *mut c_void),
            &mut size,
            std::ptr::null_mut(),
        )
    };
    if ok.is_err() {
        return None;
    }
    let end = (size as usize / 2).min(len.len());
    String::from_utf16_lossy(&len[..end])
        .trim()
        .parse::<u64>()
        .ok()
}

/// GET returning the whole body. Used by the release check (small JSON).
pub fn http_get(
    url: &str,
    extra_headers: &[(&str, &str)],
    proxy: &ProxyChoice,
    preset: Preset,
) -> Result<HttpResponse, HttpFail> {
    let (status, content_length, mut stream) = http_open_stream(url, extra_headers, proxy, preset)?;
    let mut body = Vec::new();
    if let Some(cap) = content_length {
        body.reserve(cap.min(64 * 1024 * 1024) as usize);
    }
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        let n = stream.read_chunk(&mut buf)?;
        if n == 0 {
            break;
        }
        body.extend_from_slice(&buf[..n]);
    }
    Ok(HttpResponse { status, body })
}

/// GET returning a streaming body for large downloads.
pub fn http_open_stream(
    url: &str,
    extra_headers: &[(&str, &str)],
    proxy: &ProxyChoice,
    preset: Preset,
) -> Result<(u16, Option<u64>, HttpStream), HttpFail> {
    let (session, connect, request, status, content_length) =
        send_get(url, extra_headers, proxy, preset)?;
    let deadline = Instant::now() + preset.overall_deadline();
    Ok((
        status,
        content_length,
        HttpStream {
            session,
            connect,
            request,
            deadline,
        },
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn explicit_proxy_parses_scheme_userinfo_and_port() {
        let p = parse_explicit_proxy("http://u:p@proxy.corp:8080").unwrap();
        assert_eq!(p.server, "proxy.corp:8080");
        assert_eq!(p.user.as_deref(), Some("u"));
        assert_eq!(p.pass.as_deref(), Some("p"));
    }

    #[test]
    fn explicit_proxy_rejects_socks() {
        let e = parse_explicit_proxy("socks5://127.0.0.1:1080").unwrap_err();
        assert!(e.contains("only http(s) proxies are supported"), "{e}");
    }

    #[test]
    fn explicit_proxy_without_port_uses_scheme_default() {
        let p = parse_explicit_proxy("proxy.corp").unwrap();
        assert_eq!(p.server, "proxy.corp:8080");
        let p = parse_explicit_proxy("https://proxy.corp").unwrap();
        assert_eq!(p.server, "proxy.corp:443");
    }

    #[test]
    fn explicit_proxy_rejects_empty_host() {
        assert!(parse_explicit_proxy(":8080").is_err());
        assert!(parse_explicit_proxy("http://").is_err());
    }

    #[test]
    fn userinfo_without_password_yields_empty_password() {
        let p = parse_explicit_proxy("http://user@proxy:80").unwrap();
        assert_eq!(p.user.as_deref(), Some("user"));
        assert_eq!(p.pass.as_deref(), Some(""));
    }

    #[test]
    fn redact_keeps_scheme_and_host() {
        let r = redact_proxy_userinfo("http://emp001:s3cret@proxy.corp:8080");
        assert_eq!(r, "http://***@proxy.corp:8080");
        assert!(!r.contains("s3cret"));
        assert_eq!(redact_proxy_userinfo("proxy.corp:8080"), "proxy.corp:8080");
    }

    #[test]
    fn explicit_proxy_rejects_free_text_host() {
        // E2E pins "not a url" to the validation error, so free text must
        // not silently parse as a schemeless host.
        assert!(parse_explicit_proxy("not a url").is_err());
        assert!(parse_explicit_proxy("proxy.corp").is_ok());
        assert!(parse_explicit_proxy("[::1]:8080").is_ok());
    }

    #[test]
    fn validate_proxy_url_composes_contract_prefix() {
        let err = validate_proxy_url("not a url").unwrap_err();
        assert!(err.contains("invalid update proxy"), "{err}");
        let err = validate_proxy_url("socks5://alice:s3cret@127.0.0.1:1080").unwrap_err();
        assert!(err.contains("invalid update proxy"), "{err}");
        assert!(!err.contains("s3cret"), "{err}");
        assert!(err.contains("***@"), "{err}");
        assert!(validate_proxy_url("http://127.0.0.1:7890").is_ok());
    }

    #[test]
    fn wininet_per_protocol_collapses_to_https_entry() {
        let raw = "http=10.0.0.1:80;https=10.0.0.2:443;socks=10.0.0.3:1080";
        assert_eq!(
            collapse_wininet_static(raw).as_deref(),
            Some("10.0.0.2:443")
        );
        // https= missing falls back to http=
        assert_eq!(
            collapse_wininet_static("http=10.0.0.1:80;ftp=1.2.3.4:21").as_deref(),
            Some("10.0.0.1:80")
        );
        // bare value passes through, scheme stripped
        assert_eq!(
            collapse_wininet_static("http://proxy.corp:8080").as_deref(),
            Some("proxy.corp:8080")
        );
        assert_eq!(collapse_wininet_static("  "), None);
    }

    #[test]
    fn no_proxy_matching_covers_exact_suffix_and_wildcard() {
        let np = Some("localhost,.corp.example.com,api.internal".to_string());
        assert!(no_proxy_matches(np.clone(), "localhost"));
        assert!(no_proxy_matches(np.clone(), "host.corp.example.com"));
        assert!(no_proxy_matches(np.clone(), "api.internal"));
        assert!(!no_proxy_matches(np.clone(), "api.github.com"));
        assert!(!no_proxy_matches(None, "api.github.com"));
        assert!(no_proxy_matches(Some("*".to_string()), "anything.host"));
    }

    #[test]
    fn env_proxy_priority_https_first_and_no_proxy_wins() {
        let vars = |name: &str| match name {
            "HTTPS_PROXY" => Some("https-proxy.corp:8443".to_string()),
            "HTTP_PROXY" => Some("http-proxy.corp:8080".to_string()),
            _ => None,
        };
        assert_eq!(
            resolve_env_proxy(vars, "api.github.com").as_deref(),
            Some("https-proxy.corp:8443")
        );
        let vars2 = |name: &str| match name {
            "HTTPS_PROXY" => Some("https-proxy.corp:8443".to_string()),
            "NO_PROXY" => Some(".github.com".to_string()),
            _ => None,
        };
        assert!(resolve_env_proxy(vars2, "api.github.com").is_none());
    }

    #[test]
    fn winhttp_error_tags_match_documented_codes() {
        assert_eq!(winhttp_error_tag(12_002), "timeout");
        assert_eq!(winhttp_error_tag(12_007), "resolve");
        assert_eq!(winhttp_error_tag(12_029), "connect");
        assert_eq!(winhttp_error_tag(12_030), "connect");
        assert_eq!(winhttp_error_tag(12_001), "other");
    }

    #[test]
    fn hresult_wrapped_winhttp_codes_map_to_the_same_tag() {
        // The live shapes observed from windows::core::Error: HRESULT_FROM_WIN32
        // wrapping (0x8007xxxx) must classify identically to the bare code —
        // the dead-proxy E2E pins [connect] for a refused 127.0.0.1:1.
        assert_eq!(win32_code(0x8007_2EFD_u32 as i32), 12_029);
        assert_eq!(
            winhttp_error_tag(win32_code(0x8007_2EFD_u32 as i32)),
            "connect"
        );
        assert_eq!(
            winhttp_error_tag(win32_code(0x8007_2EE2_u32 as i32)),
            "timeout"
        );
        assert_eq!(
            winhttp_error_tag(win32_code(0x8007_2EE7_u32 as i32)),
            "resolve"
        );
        assert_eq!(winhttp_error_tag(win32_code(12_002_i32)), "timeout");
    }

    #[test]
    fn presets_bound_check_tighter_than_download() {
        assert_eq!(Preset::Check.timeouts(), (10_000, 10_000, 10_000, 10_000));
        assert_eq!(
            Preset::Download.timeouts(),
            (10_000, 10_000, 30_000, 30_000)
        );
        assert_eq!(Preset::Check.overall_deadline(), Duration::from_secs(30));
        assert_eq!(
            Preset::Download.overall_deadline(),
            Duration::from_secs(300)
        );
    }

    /// Live-network smoke probe for the WinHTTP stack (direct or whatever
    /// proxy the machine resolves). Not part of the regular suite:
    /// `cargo test -- --ignored update_live_probe` runs it on demand.
    #[test]
    #[ignore = "live network probe"]
    fn update_live_probe() {
        let resp = http_get(
            "https://api.github.com/repos/ZouDongj/ZTerm/releases/latest",
            &[
                ("User-Agent", concat!("zterm/", env!("CARGO_PKG_VERSION"))),
                ("Accept", "application/vnd.github+json"),
            ],
            &ProxyChoice::Auto,
            Preset::Check,
        )
        .expect("live probe failed");
        let ascii = String::from_utf8_lossy(&resp.body[..resp.body.len().min(400)]);
        println!(
            "live probe: status={} bytes={} body_head={:?}",
            resp.status,
            resp.body.len(),
            ascii
        );
        assert_eq!(resp.status, 200, "unexpected status");
    }
}
