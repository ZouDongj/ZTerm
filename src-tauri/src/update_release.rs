//! Release resolution for the in-app updater.
//!
//! The GitHub API is rate-limited (60 requests/hour per IP without a token),
//! which is easy to exhaust on a shared corporate egress. The stable tag is
//! therefore resolved from the public release page's redirect, which does not
//! spend that budget, and the API is kept as the primary source for asset
//! metadata. When the API is limited, the release's `expanded_assets` HTML
//! page carries the same asset names and SHA-256 digests without
//! authentication; it is used as a best-effort fallback.
//!
//! The stable channel is intentional: `/releases/latest` and the release-page
//! redirect both exclude pre-releases, and a pre-release is never offered as
//! an update to a stable build.

use std::cmp::Ordering;

use serde_json::Value;

use crate::update_http::{
    http_get, http_get_no_redirect, HttpFail, HttpResponse, Preset, ProxyChoice,
};

const REPO: &str = "ZouDongj/ZTerm";
pub const RELEASES_LATEST_PAGE: &str = "https://github.com/ZouDongj/ZTerm/releases/latest";
const RELEASES_LATEST_API: &str = "https://api.github.com/repos/ZouDongj/ZTerm/releases/latest";

/// Transport seam so release resolution can be tested without the network.
pub trait ReleaseHttp {
    fn get_no_redirect(
        &self,
        url: &str,
        headers: &[(&str, &str)],
        preset: Preset,
    ) -> Result<HttpResponse, HttpFail>;
    fn get(
        &self,
        url: &str,
        headers: &[(&str, &str)],
        preset: Preset,
    ) -> Result<HttpResponse, HttpFail>;
}

/// Production transport: WinHTTP with the update proxy choice.
pub struct WinHttpRelease {
    pub proxy: ProxyChoice,
}

impl ReleaseHttp for WinHttpRelease {
    fn get_no_redirect(
        &self,
        url: &str,
        headers: &[(&str, &str)],
        preset: Preset,
    ) -> Result<HttpResponse, HttpFail> {
        http_get_no_redirect(url, headers, &self.proxy, preset)
    }

    fn get(
        &self,
        url: &str,
        headers: &[(&str, &str)],
        preset: Preset,
    ) -> Result<HttpResponse, HttpFail> {
        http_get(url, headers, &self.proxy, preset)
    }
}

fn json_headers() -> [(&'static str, &'static str); 2] {
    [
        (
            "User-Agent",
            concat!("zterm/", env!("CARGO_PKG_VERSION")),
        ),
        ("Accept", "application/vnd.github+json"),
    ]
}

fn html_headers() -> [(&'static str, &'static str); 2] {
    [
        (
            "User-Agent",
            concat!("zterm/", env!("CARGO_PKG_VERSION")),
        ),
        ("Accept", "text/html,application/xhtml+xml"),
    ]
}

/// An installer asset selected from a release.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SetupAsset {
    pub name: String,
    pub url: String,
    pub size: u64,
    pub sha256: String,
}

/// Result of looking up one tag's installer. `limited` is set only when the
/// API was rate-limited and the HTML fallback also failed to provide an
/// asset, so the UI can distinguish "try again later" from "no asset".
#[derive(Debug, Clone, Default)]
pub struct AssetResolution {
    pub asset: Option<SetupAsset>,
    pub limited: Option<RateLimit>,
}

/// A rate-limit signal extracted from response headers and body. The detail
/// contains only numeric hints, never the response body.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct RateLimit {
    pub reset_at: Option<u64>,
    pub retry_in: Option<u64>,
}

impl RateLimit {
    pub fn detail(&self) -> String {
        match (self.reset_at, self.retry_in) {
            (Some(reset), Some(retry)) => format!("reset_at={reset} retry_in={retry}"),
            (Some(reset), None) => format!("reset_at={reset}"),
            (None, Some(retry)) => format!("retry_in={retry}"),
            (None, None) => "unspecified".to_string(),
        }
    }
}

/// Classify a response as rate-limited. A plain 403 is left to the generic
/// HTTP error path; 403 with quota evidence (headers or GitHub's message) and
/// every 429 are classified here.
pub fn rate_limit_for(response: &HttpResponse) -> Option<RateLimit> {
    let reset_at = response
        .headers
        .rate_limit_reset
        .as_deref()
        .and_then(|value| value.trim().parse::<u64>().ok());
    let retry_in = response
        .headers
        .retry_after
        .as_deref()
        .and_then(|value| value.trim().parse::<u64>().ok());
    let remaining_zero = response
        .headers
        .rate_limit_remaining
        .as_deref()
        .and_then(|value| value.trim().parse::<u64>().ok())
        == Some(0);
    let body = String::from_utf8_lossy(&response.body).to_ascii_lowercase();
    let body_says_rate_limit =
        body.contains("rate limit") || body.contains("rate-limit") || body.contains("abuse");

    if response.status == 429 {
        return Some(RateLimit {
            reset_at,
            retry_in,
        });
    }
    if response.status == 403
        && (remaining_zero || reset_at.is_some() || retry_in.is_some() || body_says_rate_limit)
    {
        return Some(RateLimit {
            reset_at,
            retry_in,
        });
    }
    None
}

pub fn rate_limit_error(prefix: &str, rate: &RateLimit) -> String {
    format!("{prefix} rate-limit: {}", rate.detail())
}

/// Extract a valid tag from a release-page Location such as
/// `https://github.com/ZouDongj/ZTerm/releases/tag/v1.2.4`.
/// Absolute and relative URLs are accepted; the tag must be a valid SemVer.
pub fn tag_from_location(location: &str) -> Option<String> {
    let path = location
        .split(|c| c == '?' || c == '#')
        .next()
        .unwrap_or(location);
    let prefix = format!("/{REPO}/releases/tag/");
    let tag = if let Some(rest) = path.strip_prefix("https://github.com") {
        rest.strip_prefix(prefix.as_str())?
    } else {
        path.strip_prefix(prefix.as_str())?
    };
    if tag.is_empty()
        || tag.contains('/')
        || !tag
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '+'))
    {
        return None;
    }
    parse_semver(tag).ok()?;
    Some(tag.to_string())
}

/// Resolve the latest stable tag without spending API quota. The release
/// page redirect is the primary probe; the API is a fallback for networks
/// where the HTML page is unavailable.
pub fn resolve_latest_tag(http: &dyn ReleaseHttp) -> Result<Option<String>, String> {
    let page = http.get_no_redirect(RELEASES_LATEST_PAGE, &html_headers(), Preset::Check);
    let mut page_rate: Option<RateLimit> = None;
    let mut page_error: Option<String> = None;
    match page {
        Ok(response) => {
            if response.status == 404 {
                return Ok(None);
            }
            if (300..400).contains(&response.status) {
                if let Some(location) = response.headers.location.as_deref() {
                    if let Some(tag) = tag_from_location(location) {
                        return Ok(Some(tag));
                    }
                }
                page_error = Some(format!(
                    "release page redirected without a valid tag (status {})",
                    response.status
                ));
            } else if let Some(rate) = rate_limit_for(&response) {
                page_rate = Some(rate);
            }
        }
        Err(error) => {
            page_error = Some(format!("[{}] {}", error.tag, error.detail));
        }
    }

    match http.get(RELEASES_LATEST_API, &json_headers(), Preset::Check) {
        Ok(response) if response.status == 404 => Ok(None),
        Ok(response) if response.status == 200 => {
            stable_tag_from_release_json(&response.body).map(Some)
        }
        Ok(response) => {
            if let Some(rate) = rate_limit_for(&response) {
                Err(rate_limit_error("update check failed", &rate))
            } else {
                Err(format!(
                    "update check failed [http]: status {}",
                    response.status
                ))
            }
        }
        Err(error) => {
            if let Some(rate) = page_rate {
                return Err(rate_limit_error("update check failed", &rate));
            }
            match page_error {
                Some(page) => Err(format!(
                    "update check failed: release page {page}; API [{}]: {}",
                    error.tag, error.detail
                )),
                None => Err(format!(
                    "update check failed [{}]: {}",
                    error.tag, error.detail
                )),
            }
        }
    }
}

fn stable_tag_from_release_json(body: &[u8]) -> Result<String, String> {
    let release: Value =
        serde_json::from_slice(body).map_err(|e| format!("release response is not JSON: {e}"))?;
    if release
        .get("draft")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        return Err("latest release is a draft".to_string());
    }
    if release
        .get("prerelease")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        return Err("latest release is a pre-release; stable channel only".to_string());
    }
    let tag = release
        .get("tag_name")
        .and_then(Value::as_str)
        .ok_or_else(|| "release response has no tag_name".to_string())?;
    parse_semver(tag).map_err(|e| format!("invalid release tag '{tag}': {e}"))?;
    Ok(tag.to_string())
}

/// Fetch the installer metadata for one tag. The API is tried first; when it
/// is rate-limited or unavailable, the expanded-assets HTML page is parsed.
pub fn resolve_release_asset(http: &dyn ReleaseHttp, tag: &str) -> AssetResolution {
    let mut api_limited: Option<RateLimit> = None;
    let api_url = format!("https://api.github.com/repos/{REPO}/releases/tags/{tag}");
    match http.get(&api_url, &json_headers(), Preset::Check) {
        Ok(response) if response.status == 200 => {
            if let Some(asset) = asset_from_release_json(&response.body, tag) {
                return AssetResolution {
                    asset: Some(asset),
                    limited: None,
                };
            }
        }
        Ok(response) => {
            api_limited = rate_limit_for(&response);
        }
        Err(_) => {}
    }

    let expanded_url = format!("https://github.com/{REPO}/releases/expanded_assets/{tag}");
    let mut html_ok = false;
    let mut html_limited: Option<RateLimit> = None;
    match http.get(&expanded_url, &html_headers(), Preset::Check) {
        Ok(response) if response.status == 200 => {
            html_ok = true;
            let html = String::from_utf8_lossy(&response.body);
            if let Ok(asset) = parse_expanded_assets(&html, tag) {
                return AssetResolution {
                    asset: Some(asset),
                    limited: None,
                };
            }
        }
        Ok(response) => {
            html_limited = rate_limit_for(&response);
        }
        Err(_) => {}
    }

    AssetResolution {
        asset: None,
        limited: if html_ok {
            None
        } else {
            html_limited.or(api_limited)
        },
    }
}

fn asset_from_release_json(body: &[u8], tag: &str) -> Option<SetupAsset> {
    let release: Value = serde_json::from_slice(body).ok()?;
    if release
        .get("draft")
        .and_then(Value::as_bool)
        .unwrap_or(false)
        || release
            .get("prerelease")
            .and_then(Value::as_bool)
            .unwrap_or(false)
    {
        return None;
    }
    let release_tag = release.get("tag_name").and_then(Value::as_str)?;
    if !same_tag(release_tag, tag) {
        return None;
    }
    let assets = release.get("assets")?.as_array()?;
    select_setup_asset(assets).ok()
}

fn strip_tag_prefix(value: &str) -> &str {
    value
        .strip_prefix('v')
        .or_else(|| value.strip_prefix('V'))
        .unwrap_or(value)
}

pub fn same_tag(left: &str, right: &str) -> bool {
    strip_tag_prefix(left) == strip_tag_prefix(right)
}

/// GitHub's release assets are served from this repository's download path.
/// The API is trusted, but a strict URL keeps a tampered response from
/// pointing the downloader at another origin.
fn is_github_release_download(url: &str) -> bool {
    let Some(path) = url.strip_prefix("https://github.com") else {
        return false;
    };
    let prefix = format!("/{REPO}/releases/download/");
    path.starts_with(prefix.as_str())
        && !path.contains(['\\', '?', '#', '@'])
        && !path.contains("..")
}

/// Select exactly one x64 NSIS setup asset and validate its URL and digest.
pub fn select_setup_asset(assets: &[Value]) -> Result<SetupAsset, String> {
    let candidates: Vec<&Value> = assets
        .iter()
        .filter(|asset| {
            asset
                .get("name")
                .and_then(Value::as_str)
                .map(valid_setup_name)
                .unwrap_or(false)
        })
        .collect();
    if candidates.is_empty() {
        return Err("no ZTerm_*_x64-setup.exe asset in release".to_string());
    }
    if candidates.len() != 1 {
        return Err(format!(
            "expected exactly one ZTerm_*_x64-setup.exe asset, found {}",
            candidates.len()
        ));
    }
    let asset = candidates[0];
    let name = asset
        .get("name")
        .and_then(Value::as_str)
        .ok_or_else(|| "asset has no name".to_string())?
        .to_string();
    let url = asset
        .get("browser_download_url")
        .and_then(Value::as_str)
        .filter(|url| is_github_release_download(url))
        .ok_or_else(|| "asset has no valid GitHub release download URL".to_string())?
        .to_string();
    let size = asset
        .get("size")
        .and_then(Value::as_u64)
        .ok_or_else(|| "asset has no size".to_string())?;
    let digest = asset
        .get("digest")
        .and_then(Value::as_str)
        .ok_or_else(|| "asset has no sha256 digest".to_string())?;
    let sha256 = digest
        .strip_prefix("sha256:")
        .filter(|value| {
            value.len() == 64 && value.chars().all(|c| c.is_ascii_hexdigit())
        })
        .ok_or_else(|| "asset has no sha256 digest".to_string())?
        .to_ascii_lowercase();
    Ok(SetupAsset {
        name,
        url,
        size,
        sha256,
    })
}

fn valid_setup_name(name: &str) -> bool {
    name.starts_with("ZTerm_")
        && name.ends_with("_x64-setup.exe")
        && !name.contains(['/', '\\'])
        && !name.contains("..")
}

/// Parse GitHub's expanded-assets HTML. This page is undocumented, so every
/// field is validated exactly like the JSON API shape; a missing or ambiguous
/// digest makes the fallback fail rather than downloading unverified bytes.
pub fn parse_expanded_assets(html: &str, tag: &str) -> Result<SetupAsset, String> {
    if tag.is_empty() || tag.contains(['/', '\\']) {
        return Err("invalid release tag".to_string());
    }
    let mut tags = vec![tag.to_string()];
    let with_v = format!("v{}", tag.trim_start_matches('v'));
    if !tags.contains(&with_v) {
        tags.push(with_v);
    }

    let mut found: Vec<SetupAsset> = Vec::new();
    for chunk in html.split("<li").skip(1) {
        let Some((tag_used, name)) = tags.iter().find_map(|tag| {
            let prefix = format!("/{REPO}/releases/download/{tag}/");
            let start = chunk.find(&prefix)? + prefix.len();
            let rest = &chunk[start..];
            let end = rest
                .find(|c: char| c == '"' || c == '\'' || c == '<' || c == '&' || c == '?')
                .unwrap_or(rest.len());
            let name = &rest[..end];
            valid_setup_name(name).then_some((tag, name))
        }) else {
            continue;
        };
        let Some(sha256) = unique_sha256(chunk) else {
            continue;
        };
        let url = format!("https://github.com/{REPO}/releases/download/{tag_used}/{name}");
        let asset = SetupAsset {
            name: name.to_string(),
            url,
            size: 0,
            sha256,
        };
        if !found.iter().any(|existing| {
            existing.name == asset.name && existing.sha256 == asset.sha256
        }) {
            found.push(asset);
        }
    }

    match found.len() {
        0 => Err("asset list has no ZTerm_*_x64-setup.exe entry".to_string()),
        1 => Ok(found.remove(0)),
        count => Err(format!(
            "expected exactly one ZTerm_*_x64-setup.exe entry, found {count}"
        )),
    }
}

fn unique_sha256(chunk: &str) -> Option<String> {
    let mut found: Option<String> = None;
    let mut offset = 0;
    while let Some(position) = chunk[offset..].find("sha256:") {
        let start = offset + position + "sha256:".len();
        let candidate: String = chunk[start..].chars().take(64).collect();
        let boundary_ok = chunk[start + candidate.len()..]
            .chars()
            .next()
            .map(|c| !c.is_ascii_hexdigit())
            .unwrap_or(true);
        if candidate.len() == 64
            && candidate.chars().all(|c| c.is_ascii_hexdigit())
            && boundary_ok
        {
            let candidate = candidate.to_ascii_lowercase();
            if let Some(existing) = &found {
                if existing != &candidate {
                    return None;
                }
            } else {
                found = Some(candidate);
            }
        }
        offset = start + 1;
    }
    found
}

// ── SemVer ──

#[derive(Debug, PartialEq, Eq)]
struct SemVer {
    core: [u64; 3],
    pre: Vec<PreId>,
}

#[derive(Debug, PartialEq, Eq)]
enum PreId {
    Numeric(u64),
    Text(String),
}

impl Ord for SemVer {
    fn cmp(&self, other: &Self) -> Ordering {
        self.core
            .cmp(&other.core)
            .then_with(|| compare_prerelease(&self.pre, &other.pre))
    }
}

impl PartialOrd for SemVer {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

fn compare_prerelease(left: &[PreId], right: &[PreId]) -> Ordering {
    // SemVer 2.0.0 §11.3: a release without a pre-release suffix has higher
    // precedence than the same core with one.
    match (left.is_empty(), right.is_empty()) {
        (true, true) => return Ordering::Equal,
        (true, false) => return Ordering::Greater,
        (false, true) => return Ordering::Less,
        (false, false) => {}
    }
    for (a, b) in left.iter().zip(right) {
        let ordering = match (a, b) {
            (PreId::Numeric(a), PreId::Numeric(b)) => a.cmp(b),
            (PreId::Numeric(_), PreId::Text(_)) => Ordering::Less,
            (PreId::Text(_), PreId::Numeric(_)) => Ordering::Greater,
            (PreId::Text(a), PreId::Text(b)) => a.cmp(b),
        };
        if ordering != Ordering::Equal {
            return ordering;
        }
    }
    left.len().cmp(&right.len())
}

fn parse_semver(raw: &str) -> Result<SemVer, String> {
    let raw = raw.trim();
    let raw = raw
        .strip_prefix('v')
        .or_else(|| raw.strip_prefix('V'))
        .unwrap_or(raw);
    if raw.is_empty() {
        return Err("empty version".to_string());
    }
    let (without_build, build) = match raw.split_once('+') {
        Some((version, build)) => (version, Some(build)),
        None => (raw, None),
    };
    if let Some(build) = build {
        if build.is_empty()
            || build.split('.').any(|identifier| {
                identifier.is_empty()
                    || !identifier
                        .chars()
                        .all(|c| c.is_ascii_alphanumeric() || c == '-')
            })
        {
            return Err("invalid build metadata".to_string());
        }
    }
    let (core, prerelease) = match without_build.split_once('-') {
        Some((core, pre)) => (core, Some(pre)),
        None => (without_build, None),
    };
    let parts: Vec<&str> = core.split('.').collect();
    if parts.is_empty() || parts.len() > 3 {
        return Err("version core must have one to three dot-separated numbers".to_string());
    }
    let mut numbers = [0u64; 3];
    for (index, part) in parts.iter().enumerate() {
        if part.is_empty() || !part.chars().all(|c| c.is_ascii_digit()) {
            return Err("version core is not numeric".to_string());
        }
        numbers[index] = part
            .parse::<u64>()
            .map_err(|_| "version number is too large".to_string())?;
    }
    let pre = match prerelease {
        None => Vec::new(),
        Some(value) => {
            if value.is_empty() {
                return Err("empty pre-release suffix".to_string());
            }
            let mut identifiers = Vec::new();
            for identifier in value.split('.') {
                if identifier.is_empty()
                    || !identifier
                        .chars()
                        .all(|c| c.is_ascii_alphanumeric() || c == '-')
                {
                    return Err(format!("invalid pre-release identifier '{identifier}'"));
                }
                if identifier.chars().all(|c| c.is_ascii_digit()) {
                    if identifier.len() > 1 && identifier.starts_with('0') {
                        return Err("numeric pre-release identifiers cannot have leading zeroes"
                            .to_string());
                    }
                    identifiers.push(PreId::Numeric(
                        identifier
                            .parse::<u64>()
                            .map_err(|_| "pre-release number is too large".to_string())?,
                    ));
                } else {
                    identifiers.push(PreId::Text(identifier.to_string()));
                }
            }
            identifiers
        }
    };
    Ok(SemVer {
        core: numbers,
        pre,
    })
}

/// Lenient comparison used by the UI-facing check: an unparsable version on
/// either side is simply "not newer" (the strict path reports the reason).
#[cfg(test)]
pub fn version_newer(current: &str, latest: &str) -> bool {
    match (parse_semver(current), parse_semver(latest)) {
        (Ok(current), Ok(latest)) => latest > current,
        _ => false,
    }
}

/// Strict comparison for the update check: a malformed release tag is a
/// visible error instead of a silent "already up to date".
pub fn version_newer_checked(current: &str, latest: &str) -> Result<bool, String> {
    let current =
        parse_semver(current).map_err(|e| format!("invalid current version '{current}': {e}"))?;
    let latest =
        parse_semver(latest).map_err(|e| format!("invalid release tag '{latest}': {e}"))?;
    Ok(latest > current)
}

#[cfg(test)]
pub(crate) mod test_support {
    use std::cell::RefCell;
    use std::collections::{HashMap, VecDeque};

    use super::*;
    use crate::update_http::ResponseHeaders;

    pub(crate) enum FakeReply {
        Response(HttpResponse),
        Fail(&'static str, String),
    }

    impl FakeReply {
        pub(crate) fn response(status: u16, body: &str) -> Self {
            FakeReply::Response(HttpResponse {
                status,
                body: body.as_bytes().to_vec(),
                headers: ResponseHeaders::default(),
            })
        }

        pub(crate) fn with_headers(
            status: u16,
            body: &str,
            headers: ResponseHeaders,
        ) -> Self {
            FakeReply::Response(HttpResponse {
                status,
                body: body.as_bytes().to_vec(),
                headers,
            })
        }

        pub(crate) fn fail(tag: &'static str, detail: &str) -> Self {
            FakeReply::Fail(tag, detail.to_string())
        }
    }

    pub(crate) struct FakeHttp {
        responses: RefCell<HashMap<(bool, String), VecDeque<FakeReply>>>,
        calls: RefCell<Vec<(bool, String)>>,
    }

    impl FakeHttp {
        pub(crate) fn new() -> Self {
            FakeHttp {
                responses: RefCell::new(HashMap::new()),
                calls: RefCell::new(Vec::new()),
            }
        }

        pub(crate) fn on_get(&self, url: &str, reply: FakeReply) -> &Self {
            self.responses
                .borrow_mut()
                .entry((true, url.to_string()))
                .or_default()
                .push_back(reply);
            self
        }

        pub(crate) fn on_no_redirect(&self, url: &str, reply: FakeReply) -> &Self {
            self.responses
                .borrow_mut()
                .entry((false, url.to_string()))
                .or_default()
                .push_back(reply);
            self
        }

        pub(crate) fn calls(&self) -> Vec<(bool, String)> {
            self.calls.borrow().clone()
        }
    }

    impl ReleaseHttp for FakeHttp {
        fn get_no_redirect(
            &self,
            url: &str,
            _headers: &[(&str, &str)],
            _preset: Preset,
        ) -> Result<HttpResponse, HttpFail> {
            self.calls.borrow_mut().push((false, url.to_string()));
            match self
                .responses
                .borrow_mut()
                .get_mut(&(false, url.to_string()))
                .and_then(VecDeque::pop_front)
            {
                Some(FakeReply::Response(response)) => Ok(response),
                Some(FakeReply::Fail(tag, detail)) => Err(HttpFail { tag, detail }),
                None => Err(HttpFail {
                    tag: "other",
                    detail: format!("unexpected no-redirect request: {url}"),
                }),
            }
        }

        fn get(
            &self,
            url: &str,
            _headers: &[(&str, &str)],
            _preset: Preset,
        ) -> Result<HttpResponse, HttpFail> {
            self.calls.borrow_mut().push((true, url.to_string()));
            match self
                .responses
                .borrow_mut()
                .get_mut(&(true, url.to_string()))
                .and_then(VecDeque::pop_front)
            {
                Some(FakeReply::Response(response)) => Ok(response),
                Some(FakeReply::Fail(tag, detail)) => Err(HttpFail { tag, detail }),
                None => Err(HttpFail {
                    tag: "other",
                    detail: format!("unexpected request: {url}"),
                }),
            }
        }
    }

    pub(crate) fn headers(
        location: Option<&str>,
        retry_after: Option<&str>,
        reset: Option<&str>,
        remaining: Option<&str>,
    ) -> ResponseHeaders {
        ResponseHeaders {
            location: location.map(str::to_string),
            retry_after: retry_after.map(str::to_string),
            rate_limit_reset: reset.map(str::to_string),
            rate_limit_remaining: remaining.map(str::to_string),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::*;
    use super::*;

    #[test]
    fn semver_orders_prereleases_before_the_release() {
        assert!(version_newer("1.2.5-dev.1", "1.2.5"));
        assert!(!version_newer("1.2.5", "1.2.5-dev.1"));
        assert!(version_newer("1.2.5-dev.1", "1.2.5-dev.2"));
        assert!(version_newer("1.2.5-alpha.2", "1.2.5-alpha.10"));
        assert!(version_newer("1.2.5-alpha", "1.2.5-alpha.1"));
        assert!(!version_newer("1.2.5+build.2", "1.2.5+build.1"));
        assert!(!version_newer("1.2.5", "1.2.5"));
        assert!(version_newer("1.0.5", "v1.0.6-beta.1"));
        assert!(!version_newer("1.0.5", "1.0.5-beta.1"));
    }

    #[test]
    fn semver_numeric_prerelease_identifiers_compare_numerically() {
        assert!(version_newer("1.0.0-rc.2", "1.0.0-rc.10"));
        assert!(!version_newer("1.0.0-rc.10", "1.0.0-rc.2"));
        assert!(version_newer("1.0.0-rc.1", "1.0.0"));
    }

    #[test]
    fn semver_rejects_malformed_tags_in_the_strict_path() {
        for tag in [
            "v",
            "1.2.x",
            "1.2.3.4",
            "1.2.3-",
            "1.2.3-?",
            "",
            "1..2",
            "1.2.3+",
            "1.2.3+abc..def",
            "1.2.3+abc+def",
            "1.2.3-01",
            "1.2.3-alpha.01",
        ] {
            assert!(version_newer_checked("1.0.0", tag).is_err(), "{tag}");
        }
        assert_eq!(version_newer_checked("1.0.0", "v1.0.1").unwrap(), true);
        // Build metadata is ignored for precedence but must still be valid.
        assert_eq!(version_newer_checked("1.0.0", "1.0.0+build.7").unwrap(), false);
    }

    #[test]
    fn tag_from_location_accepts_absolute_and_relative_paths() {
        assert_eq!(
            tag_from_location("https://github.com/ZouDongj/ZTerm/releases/tag/v1.2.4")
                .as_deref(),
            Some("v1.2.4")
        );
        assert_eq!(
            tag_from_location("/ZouDongj/ZTerm/releases/tag/1.2.4?x=1#y").as_deref(),
            Some("1.2.4")
        );
        for bad in [
            "https://github.com/ZouDongj/ZTerm/releases/tag/",
            "https://github.com/ZouDongj/ZTerm/releases/tag/v1.2.4/extra",
            "https://github.com/ZouDongj/ZTerm/releases/tag/not-semver",
            "https://github.com/ZouDongj/ZTerm/releases/tag/v1.2.%34",
            "https://github.com/ZouDongj/ZTerm/releases",
            "https://github.com.evil/ZouDongj/ZTerm/releases/tag/v1.2.4",
            "https://evil.example/ZouDongj/ZTerm/releases/tag/v1.2.4",
            "https://github.com/Other/ZTerm/releases/tag/v1.2.4",
            "http://github.com/ZouDongj/ZTerm/releases/tag/v1.2.4",
            "/Other/ZTerm/releases/tag/v1.2.4",
            "/prefix/https://github.com/ZouDongj/ZTerm/releases/tag/v1.2.4",
        ] {
            assert!(tag_from_location(bad).is_none(), "{bad}");
        }
    }

    #[test]
    fn latest_tag_uses_the_release_page_redirect_without_the_api() {
        let http = FakeHttp::new();
        http.on_no_redirect(
            RELEASES_LATEST_PAGE,
            FakeReply::with_headers(
                302,
                "",
                headers(
                    Some("https://github.com/ZouDongj/ZTerm/releases/tag/v1.2.4"),
                    None,
                    None,
                    None,
                ),
            ),
        );
        assert_eq!(
            resolve_latest_tag(&http).unwrap().as_deref(),
            Some("v1.2.4")
        );
        assert_eq!(http.calls(), vec![(false, RELEASES_LATEST_PAGE.to_string())]);
    }

    #[test]
    fn latest_tag_falls_back_to_the_api_after_a_plain_page_failure() {
        let http = FakeHttp::new();
        http.on_no_redirect(RELEASES_LATEST_PAGE, FakeReply::response(200, "<html>"));
        http.on_get(
            RELEASES_LATEST_API,
            FakeReply::response(
                200,
                r#"{"tag_name":"v1.3.0","prerelease":false,"draft":false}"#,
            ),
        );
        assert_eq!(resolve_latest_tag(&http).unwrap().as_deref(), Some("v1.3.0"));
    }

    #[test]
    fn latest_tag_falls_back_after_a_page_transport_failure() {
        let http = FakeHttp::new();
        http.on_no_redirect(
            RELEASES_LATEST_PAGE,
            FakeReply::fail("timeout", "connect timed out"),
        );
        http.on_get(
            RELEASES_LATEST_API,
            FakeReply::response(
                200,
                r#"{"tag_name":"v1.3.1","prerelease":false,"draft":false}"#,
            ),
        );
        assert_eq!(resolve_latest_tag(&http).unwrap().as_deref(), Some("v1.3.1"));
    }

    #[test]
    fn latest_tag_reports_no_release_on_404() {
        let http = FakeHttp::new();
        http.on_no_redirect(RELEASES_LATEST_PAGE, FakeReply::response(404, ""));
        assert_eq!(resolve_latest_tag(&http).unwrap(), None);
    }

    #[test]
    fn latest_tag_surfaces_rate_limit_with_reset_hint() {
        let http = FakeHttp::new();
        http.on_no_redirect(
            RELEASES_LATEST_PAGE,
            FakeReply::with_headers(
                403,
                r#"{"message":"API rate limit exceeded"}"#,
                headers(None, None, Some("1730000000"), Some("0")),
            ),
        );
        http.on_get(
            RELEASES_LATEST_API,
            FakeReply::with_headers(
                403,
                r#"{"message":"API rate limit exceeded"}"#,
                headers(None, None, Some("1730000000"), Some("0")),
            ),
        );
        let error = resolve_latest_tag(&http).unwrap_err();
        assert!(error.contains("rate-limit:"), "{error}");
        assert!(error.contains("reset_at=1730000000"), "{error}");
    }

    #[test]
    fn latest_tag_rejects_a_prerelease_api_response() {
        let http = FakeHttp::new();
        http.on_no_redirect(RELEASES_LATEST_PAGE, FakeReply::response(200, "<html>"));
        http.on_get(
            RELEASES_LATEST_API,
            FakeReply::response(
                200,
                r#"{"tag_name":"v1.2.5-dev.1","prerelease":true,"draft":false}"#,
            ),
        );
        let error = resolve_latest_tag(&http).unwrap_err();
        assert!(error.contains("pre-release"), "{error}");
    }

    #[test]
    fn expanded_assets_html_parses_the_setup_asset_and_digest() {
        let sha = "a".repeat(64);
        let html = format!(
            r#"<ul><li class="Box-row"><a href="/ZouDongj/ZTerm/releases/download/v1.2.4/ZTerm_1.2.4_x64-setup.exe"><span class="text-bold">ZTerm_1.2.4_x64-setup.exe</span></a><span class="Truncate-text">sha256:{sha}</span></li></ul>"#
        );
        let asset = parse_expanded_assets(&html, "v1.2.4").unwrap();
        assert_eq!(asset.name, "ZTerm_1.2.4_x64-setup.exe");
        assert_eq!(
            asset.url,
            "https://github.com/ZouDongj/ZTerm/releases/download/v1.2.4/ZTerm_1.2.4_x64-setup.exe"
        );
        assert_eq!(asset.sha256, sha);
        assert_eq!(asset.size, 0);
    }

    #[test]
    fn expanded_assets_html_rejects_ambiguous_or_unverified_entries() {
        let sha = "b".repeat(64);
        let two = format!(
            r#"<li><a href="/ZouDongj/ZTerm/releases/download/v1.2.4/ZTerm_1.2.4_x64-setup.exe">x</a>sha256:{sha}</li><li><a href="/ZouDongj/ZTerm/releases/download/v1.2.4/ZTerm_1.2.5_x64-setup.exe">x</a>sha256:{sha}</li>"#
        );
        assert!(parse_expanded_assets(&two, "v1.2.4")
            .unwrap_err()
            .contains("expected exactly one"));
        let no_digest = r#"<li><a href="/ZouDongj/ZTerm/releases/download/v1.2.4/ZTerm_1.2.4_x64-setup.exe">x</a></li>"#;
        assert!(parse_expanded_assets(no_digest, "v1.2.4").is_err());
        let wrong_tag = format!(
            r#"<li><a href="/ZouDongj/ZTerm/releases/download/v9.9.9/ZTerm_9.9.9_x64-setup.exe">x</a>sha256:{sha}</li>"#
        );
        assert!(parse_expanded_assets(&wrong_tag, "v1.2.4").is_err());
    }

    #[test]
    fn asset_lookup_prefers_the_api_and_skips_html() {
        let http = FakeHttp::new();
        let sha = "c".repeat(64);
        http.on_get(
            "https://api.github.com/repos/ZouDongj/ZTerm/releases/tags/v1.2.4",
            FakeReply::response(
                200,
                &format!(
                    r#"{{"tag_name":"v1.2.4","prerelease":false,"draft":false,"assets":[{{"name":"ZTerm_1.2.4_x64-setup.exe","size":42,"digest":"sha256:{sha}","browser_download_url":"https://github.com/ZouDongj/ZTerm/releases/download/v1.2.4/ZTerm_1.2.4_x64-setup.exe"}}]}}"#
                ),
            ),
        );
        let result = resolve_release_asset(&http, "v1.2.4");
        assert_eq!(result.asset.unwrap().size, 42);
        assert_eq!(http.calls().len(), 1);
    }

    #[test]
    fn asset_lookup_uses_html_when_the_api_is_rate_limited() {
        let http = FakeHttp::new();
        let sha = "d".repeat(64);
        http.on_get(
            "https://api.github.com/repos/ZouDongj/ZTerm/releases/tags/v1.2.4",
            FakeReply::with_headers(
                403,
                r#"{"message":"API rate limit exceeded"}"#,
                headers(None, None, Some("1730000000"), Some("0")),
            ),
        );
        http.on_get(
            "https://github.com/ZouDongj/ZTerm/releases/expanded_assets/v1.2.4",
            FakeReply::response(
                200,
                &format!(
                    r#"<li><a href="/ZouDongj/ZTerm/releases/download/v1.2.4/ZTerm_1.2.4_x64-setup.exe">x</a>sha256:{sha}</li>"#
                ),
            ),
        );
        let result = resolve_release_asset(&http, "v1.2.4");
        assert_eq!(result.asset.unwrap().sha256, sha);
        assert!(result.limited.is_none());
    }

    #[test]
    fn asset_lookup_reports_rate_limit_when_both_sources_fail() {
        let http = FakeHttp::new();
        http.on_get(
            "https://api.github.com/repos/ZouDongj/ZTerm/releases/tags/v1.2.4",
            FakeReply::with_headers(
                403,
                r#"{"message":"API rate limit exceeded"}"#,
                headers(None, None, Some("1730000000"), Some("0")),
            ),
        );
        http.on_get(
            "https://github.com/ZouDongj/ZTerm/releases/expanded_assets/v1.2.4",
            FakeReply::with_headers(
                403,
                "",
                headers(None, None, Some("1730000000"), Some("0")),
            ),
        );
        let result = resolve_release_asset(&http, "v1.2.4");
        assert!(result.asset.is_none());
        assert_eq!(result.limited.unwrap().reset_at, Some(1_730_000_000));
    }

    #[test]
    fn asset_lookup_tolerates_a_missing_or_stale_api_tag() {
        let http = FakeHttp::new();
        let sha = "e".repeat(64);
        http.on_get(
            "https://api.github.com/repos/ZouDongj/ZTerm/releases/tags/v1.2.4",
            FakeReply::response(
                200,
                r#"{"tag_name":"v9.9.9","prerelease":false,"draft":false,"assets":[]}"#,
            ),
        );
        http.on_get(
            "https://github.com/ZouDongj/ZTerm/releases/expanded_assets/v1.2.4",
            FakeReply::response(
                200,
                &format!(
                    r#"<li><a href="/ZouDongj/ZTerm/releases/download/v1.2.4/ZTerm_1.2.4_x64-setup.exe">x</a>sha256:{sha}</li>"#
                ),
            ),
        );
        assert_eq!(resolve_release_asset(&http, "v1.2.4").asset.unwrap().sha256, sha);
    }
}
