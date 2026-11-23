//! Release resolution for the in-app updater.
//!
//! The GitHub API is rate-limited (60 requests/hour per IP without a token),
//! which is easy to exhaust on a shared corporate egress. Tag discovery
//! therefore uses quota-free public endpoints first on both channels:
//! - Stable builds (`UpdateChannel::Stable`) resolve the latest stable tag from
//!   `/releases/latest` (redirect primary, `/releases/latest` API fallback) and
//!   reject pre-releases across every path.
//! - Pre-release builds (`UpdateChannel::Prerelease`, e.g. `1.2.5-dev.3`)
//!   resolve the highest valid SemVer tag across all published non-draft
//!   releases (both stable and pre-release) from `releases.atom` (primary) with
//!   `/releases?per_page=30` API fallback. Once a pre-release build upgrades to
//!   a stable version, it automatically runs on `UpdateChannel::Stable`.
//!
//! The API is kept as the primary source for installer asset metadata. When the
//! API is limited or unavailable, the release's `expanded_assets` HTML page
//! carries the same asset names and mandatory SHA-256 digests without
//! authentication and is used as a best-effort fallback.

use std::cmp::Ordering;

use serde_json::Value;

use crate::update_http::{
    http_get, http_get_no_redirect, HttpFail, HttpResponse, Preset, ProxyChoice,
};

const REPO: &str = "ZouDongj/ZTerm";
pub const RELEASES_LATEST_PAGE: &str = "https://github.com/ZouDongj/ZTerm/releases/latest";
const RELEASES_LATEST_API: &str = "https://api.github.com/repos/ZouDongj/ZTerm/releases/latest";
pub const RELEASES_ATOM_FEED: &str = "https://github.com/ZouDongj/ZTerm/releases.atom";
pub const RELEASES_LIST_API: &str =
    "https://api.github.com/repos/ZouDongj/ZTerm/releases?per_page=30";

/// Update channel automatically derived from the running application's SemVer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UpdateChannel {
    /// Stable builds only: excludes pre-releases across tag, API, and asset
    /// resolution paths.
    Stable,
    /// Pre-release builds: considers all published non-draft releases (both
    /// stable and pre-release) and selects the highest valid SemVer tag.
    Prerelease,
}

impl UpdateChannel {
    /// Derive the update channel from the running version string.
    /// Versions carrying a valid SemVer pre-release suffix follow `Prerelease`;
    /// stable versions (and any malformed version, failing closed) follow
    /// `Stable`.
    pub fn for_version(version: &str) -> Self {
        match parse_semver(version) {
            Ok(ver) if !ver.pre.is_empty() => UpdateChannel::Prerelease,
            _ => UpdateChannel::Stable,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            UpdateChannel::Stable => "stable",
            UpdateChannel::Prerelease => "prerelease",
        }
    }
}

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
        ("User-Agent", concat!("zterm/", env!("CARGO_PKG_VERSION"))),
        ("Accept", "application/vnd.github+json"),
    ]
}

fn html_headers() -> [(&'static str, &'static str); 2] {
    [
        ("User-Agent", concat!("zterm/", env!("CARGO_PKG_VERSION"))),
        ("Accept", "text/html,application/xhtml+xml"),
    ]
}

fn atom_headers() -> [(&'static str, &'static str); 2] {
    [
        ("User-Agent", concat!("zterm/", env!("CARGO_PKG_VERSION"))),
        ("Accept", "application/atom+xml,application/xml,text/xml"),
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
/// asset; `rejected` is set when the release is explicitly refused by channel
/// policy (draft on any channel, or pre-release on the stable channel); `error`
/// preserves transport or HTTP failures (or channel rejection detail) when
/// neither source returned a usable 200 response.
#[derive(Debug, Clone, Default)]
pub struct AssetResolution {
    pub asset: Option<SetupAsset>,
    pub limited: Option<RateLimit>,
    pub rejected: bool,
    pub error: Option<String>,
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
    let body_says_rate_limit = body.contains("rate limit")
        || body.contains("rate-limit")
        || body.contains("abuse detection");

    if response.status == 429 {
        return Some(RateLimit { reset_at, retry_in });
    }
    // GitHub sends X-RateLimit-Reset on nearly every response, even with quota
    // remaining, so reset_at alone must not turn an unrelated 403 into a rate
    // limit.
    if response.status == 403 && (remaining_zero || retry_in.is_some() || body_says_rate_limit) {
        return Some(RateLimit { reset_at, retry_in });
    }
    None
}

pub fn rate_limit_error(prefix: &str, rate: &RateLimit) -> String {
    format!("{prefix} rate-limit: {}", rate.detail())
}

/// Validate a release tag string before using it in URLs or comparisons.
/// Requires a clean ASCII SemVer token with no whitespace or path separators.
pub fn is_valid_tag(tag: &str) -> bool {
    !tag.is_empty()
        && !tag.contains('/')
        && tag
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '+'))
        && parse_semver(tag).is_ok()
}

/// Validate that `tag` is a syntactically clean stable SemVer release tag
/// (no pre-release suffix). Used by the stable update channel to reject
/// pre-releases even when the API is rate-limited.
pub fn is_stable_tag(tag: &str) -> bool {
    is_valid_tag(tag) && parse_semver(tag).is_ok_and(|ver| ver.pre.is_empty())
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
    if !is_stable_tag(tag) {
        return None;
    }
    Some(tag.to_string())
}

/// Resolve the latest stable tag without spending API quota. The release
/// page redirect is the primary probe; the API is a fallback for networks
/// where the HTML page is unavailable.
#[cfg(test)]
pub fn resolve_latest_tag(http: &dyn ReleaseHttp) -> Result<Option<String>, String> {
    resolve_latest_tag_for_channel(http, UpdateChannel::Stable)
}

/// Resolve the latest eligible release tag for `channel` without spending API
/// quota on the primary path.
pub fn resolve_latest_tag_for_channel(
    http: &dyn ReleaseHttp,
    channel: UpdateChannel,
) -> Result<Option<String>, String> {
    match channel {
        UpdateChannel::Stable => resolve_latest_stable_tag(http),
        UpdateChannel::Prerelease => resolve_latest_prerelease_tag(http),
    }
}

fn resolve_latest_stable_tag(http: &dyn ReleaseHttp) -> Result<Option<String>, String> {
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
                    "redirected without a valid tag (status {})",
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

/// Resolve the highest valid SemVer tag across published non-draft releases
/// (both stable and pre-release) for the pre-release channel. The public
/// `releases.atom` feed is probed first (zero API quota); non-200, malformed,
/// or transport failures fall back to the paginated releases API.
fn resolve_latest_prerelease_tag(http: &dyn ReleaseHttp) -> Result<Option<String>, String> {
    let mut feed_rate: Option<RateLimit> = None;
    let mut feed_error: Option<String> = None;
    match http.get(RELEASES_ATOM_FEED, &atom_headers(), Preset::Check) {
        Ok(response) if response.status == 200 => match std::str::from_utf8(&response.body) {
            Ok(xml) => match parse_releases_atom_latest_tag(xml) {
                Ok(tag) => return Ok(tag),
                Err(reason) => feed_error = Some(reason),
            },
            Err(_) => feed_error = Some("Atom feed is not valid UTF-8".to_string()),
        },
        Ok(response) => {
            if let Some(rate) = rate_limit_for(&response) {
                feed_rate = Some(rate);
            } else {
                // Deliberately omit `[http]` here so a transport `[connect]`/`[timeout]`
                // error from the API fallback remains the first bracketed tag.
                feed_error = Some(format!("HTTP status {}", response.status));
            }
        }
        Err(error) => {
            feed_error = Some(format!("[{}] {}", error.tag, error.detail));
        }
    }

    match http.get(RELEASES_LIST_API, &json_headers(), Preset::Check) {
        Ok(response) if response.status == 404 => Ok(None),
        Ok(response) if response.status == 200 => {
            latest_tag_from_releases_list_json(&response.body)
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
            if let Some(rate) = feed_rate {
                return Err(rate_limit_error("update check failed", &rate));
            }
            match feed_error {
                Some(feed) => Err(format!(
                    "update check failed: releases feed {feed}; API [{}]: {}",
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

fn find_bytes(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || needle.len() > haystack.len() {
        return None;
    }
    haystack.windows(needle.len()).position(|w| w == needle)
}

fn is_xml_name_start(b: u8) -> bool {
    b.is_ascii_alphabetic() || matches!(b, b'_' | b':')
}

fn is_xml_name_char(b: u8) -> bool {
    b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'.' | b':')
}

fn skip_ascii_ws(bytes: &[u8], i: &mut usize) {
    while *i < bytes.len() && bytes[*i].is_ascii_whitespace() {
        *i += 1;
    }
}

fn unescape_xml_entities(input: &str) -> Option<String> {
    if !input.contains('&') {
        return Some(input.to_string());
    }
    let mut out = String::with_capacity(input.len());
    let mut rest = input;
    while let Some(amp) = rest.find('&') {
        out.push_str(&rest[..amp]);
        rest = &rest[amp + 1..];
        let semi = rest.find(';')?;
        match &rest[..semi] {
            "amp" => out.push('&'),
            "lt" => out.push('<'),
            "gt" => out.push('>'),
            "quot" => out.push('"'),
            "apos" => out.push('\''),
            _ => return None,
        }
        rest = &rest[semi + 1..];
    }
    out.push_str(rest);
    Some(out)
}

fn tag_from_atom_href(href: &str) -> Option<String> {
    let prefix = format!("https://github.com/{REPO}/releases/tag/");
    let tag = href.strip_prefix(prefix.as_str())?;
    if !is_valid_tag(tag) {
        return None;
    }
    Some(tag.to_string())
}

/// Skip the entire body of an Atom text element (`<content>` / `<summary>`) up
/// to its matching closing tag, respecting XML comments, CDATA sections, and
/// nested elements of the same name so release notes can never spoof an entry
/// `<link>` or inject a fake `<entry>`.
fn skip_element_body(bytes: &[u8], i: &mut usize, tag_name: &[u8]) -> Result<(), String> {
    let mut depth: usize = 0;
    while let Some(rel) = bytes[*i..].iter().position(|&b| b == b'<') {
        *i += rel + 1;
        if bytes[*i..].starts_with(b"![CDATA[") {
            *i += 8;
            let Some(end) = find_bytes(&bytes[*i..], b"]]>") else {
                return Err("unterminated CDATA section in Atom feed".to_string());
            };
            *i += end + 3;
            continue;
        }
        if bytes[*i..].starts_with(b"!--") {
            *i += 3;
            let Some(end) = find_bytes(&bytes[*i..], b"-->") else {
                return Err("unterminated XML comment in Atom feed".to_string());
            };
            *i += end + 3;
            continue;
        }
        if bytes[*i..].starts_with(b"/") {
            let after_slash = *i + 1;
            if bytes[after_slash..].starts_with(tag_name) {
                let mut j = after_slash + tag_name.len();
                skip_ascii_ws(bytes, &mut j);
                if j < bytes.len() && bytes[j] == b'>' {
                    *i = j + 1;
                    if depth == 0 {
                        return Ok(());
                    }
                    depth -= 1;
                    continue;
                }
            }
        } else if bytes[*i..].starts_with(tag_name) {
            let after_name = *i + tag_name.len();
            if after_name < bytes.len()
                && (bytes[after_name].is_ascii_whitespace()
                    || bytes[after_name] == b'>'
                    || bytes[after_name] == b'/')
            {
                let mut j = after_name;
                let mut quote: Option<u8> = None;
                while j < bytes.len() {
                    let b = bytes[j];
                    if let Some(q) = quote {
                        if b == q {
                            quote = None;
                        }
                    } else if b == b'"' || b == b'\'' {
                        quote = Some(b);
                    } else if b == b'>' {
                        let self_closing = j > after_name && bytes[j - 1] == b'/';
                        *i = j + 1;
                        if !self_closing {
                            depth += 1;
                        }
                        break;
                    }
                    j += 1;
                }
            }
        }
    }
    Err(format!(
        "unterminated <{}> element in Atom feed",
        String::from_utf8_lossy(tag_name)
    ))
}

/// Parse GitHub's `releases.atom` feed and return the highest valid SemVer tag
/// referenced by a direct `<entry>/<link rel="alternate" href="..."/>`.
/// Returns `Ok(None)` when the feed is structurally valid Atom with no valid
/// SemVer entries; returns `Err` when the document is malformed or non-Atom so
/// callers fall back to the JSON API.
pub fn parse_releases_atom_latest_tag(xml: &str) -> Result<Option<String>, String> {
    const MAX_XML_DEPTH: usize = 64;
    let xml = xml.strip_prefix('\u{FEFF}').unwrap_or(xml);
    let bytes = xml.as_bytes();
    let mut i: usize = 0;
    let mut stack: Vec<&str> = Vec::new();
    let mut saw_closed_feed = false;
    let mut entry_tag: Option<String> = None;
    let mut entry_ambiguous = false;
    let mut best: Option<(SemVer, String)> = None;

    while let Some(rel) = bytes[i..].iter().position(|&b| b == b'<') {
        i += rel + 1;
        if i >= bytes.len() {
            return Err("truncated markup in Atom feed".to_string());
        }
        if bytes[i..].starts_with(b"!--") {
            i += 3;
            let Some(end) = find_bytes(&bytes[i..], b"-->") else {
                return Err("unterminated XML comment in Atom feed".to_string());
            };
            i += end + 3;
            continue;
        }
        if bytes[i..].starts_with(b"![CDATA[") {
            i += 8;
            let Some(end) = find_bytes(&bytes[i..], b"]]>") else {
                return Err("unterminated CDATA section in Atom feed".to_string());
            };
            i += end + 3;
            continue;
        }
        if bytes[i] == b'?' {
            i += 1;
            let Some(end) = find_bytes(&bytes[i..], b"?>") else {
                return Err("unterminated processing instruction in Atom feed".to_string());
            };
            i += end + 2;
            continue;
        }
        if bytes[i] == b'!' {
            i += 1;
            let mut quote: Option<u8> = None;
            let mut closed = false;
            while i < bytes.len() {
                let b = bytes[i];
                i += 1;
                if let Some(q) = quote {
                    if b == q {
                        quote = None;
                    }
                } else if b == b'"' || b == b'\'' {
                    quote = Some(b);
                } else if b == b'[' {
                    return Err("unsupported DTD subset in Atom feed".to_string());
                } else if b == b'>' {
                    closed = true;
                    break;
                }
            }
            if !closed {
                return Err("unterminated declaration in Atom feed".to_string());
            }
            continue;
        }
        if bytes[i] == b'/' {
            i += 1;
            let name_start = i;
            if i >= bytes.len() || !is_xml_name_start(bytes[i]) {
                return Err("malformed closing tag in Atom feed".to_string());
            }
            while i < bytes.len() && is_xml_name_char(bytes[i]) {
                i += 1;
            }
            let close_name = &xml[name_start..i];
            skip_ascii_ws(bytes, &mut i);
            if i >= bytes.len() || bytes[i] != b'>' {
                return Err("unterminated closing tag in Atom feed".to_string());
            }
            i += 1;
            let Some(open_name) = stack.pop() else {
                return Err(format!(
                    "unexpected closing tag </{close_name}> in Atom feed"
                ));
            };
            if open_name != close_name {
                return Err(format!(
                    "mismatched closing tag </{close_name}> for <{open_name}> in Atom feed"
                ));
            }
            if close_name == "entry" && stack.as_slice() == ["feed"] {
                if !entry_ambiguous {
                    if let Some(tag) = entry_tag.take() {
                        if let Ok(ver) = parse_semver(&tag) {
                            let is_newer = match &best {
                                None => true,
                                Some((best_ver, _)) => ver > *best_ver,
                            };
                            if is_newer {
                                best = Some((ver, tag));
                            }
                        }
                    }
                }
                entry_tag = None;
                entry_ambiguous = false;
            } else if close_name == "feed" && stack.is_empty() {
                saw_closed_feed = true;
            }
            continue;
        }

        // Opening or self-closing tag.
        let name_start = i;
        if !is_xml_name_start(bytes[i]) {
            return Err("malformed start tag in Atom feed".to_string());
        }
        while i < bytes.len() && is_xml_name_char(bytes[i]) {
            i += 1;
        }
        let tag_name = &xml[name_start..i];

        if saw_closed_feed {
            return Err("unexpected element after </feed> in Atom feed".to_string());
        }
        if stack.is_empty() && tag_name != "feed" {
            return Err(format!("root element <{tag_name}> is not Atom <feed>"));
        }

        let inspect_entry_link = tag_name == "link" && stack.as_slice() == ["feed", "entry"];
        let mut link_rel: Option<&str> = None;
        let mut link_href: Option<&str> = None;
        let self_closing: bool;

        loop {
            skip_ascii_ws(bytes, &mut i);
            if i >= bytes.len() {
                return Err("unterminated start tag in Atom feed".to_string());
            }
            if bytes[i] == b'>' {
                i += 1;
                self_closing = false;
                break;
            }
            if bytes[i..].starts_with(b"/>") {
                i += 2;
                self_closing = true;
                break;
            }
            let attr_start = i;
            if !is_xml_name_start(bytes[i]) {
                return Err("malformed attribute name in Atom feed".to_string());
            }
            while i < bytes.len() && is_xml_name_char(bytes[i]) {
                i += 1;
            }
            let attr_name = &xml[attr_start..i];
            skip_ascii_ws(bytes, &mut i);
            if i >= bytes.len() || bytes[i] != b'=' {
                return Err(format!("attribute '{attr_name}' missing '=' in Atom feed"));
            }
            i += 1;
            skip_ascii_ws(bytes, &mut i);
            if i >= bytes.len() || (bytes[i] != b'"' && bytes[i] != b'\'') {
                return Err(format!(
                    "attribute '{attr_name}' is not quoted in Atom feed"
                ));
            }
            let quote = bytes[i];
            i += 1;
            let val_start = i;
            let Some(val_len) = bytes[i..].iter().position(|&b| b == quote) else {
                return Err(format!(
                    "unterminated attribute value for '{attr_name}' in Atom feed"
                ));
            };
            let attr_val = &xml[val_start..val_start + val_len];
            i = val_start + val_len + 1;
            if inspect_entry_link {
                match attr_name {
                    "rel" if link_rel.is_none() => link_rel = Some(attr_val),
                    "href" if link_href.is_none() => link_href = Some(attr_val),
                    _ => {}
                }
            }
        }

        if inspect_entry_link {
            let rel_is_alternate = match link_rel {
                None => true,
                Some(raw_rel) => {
                    unescape_xml_entities(raw_rel).is_some_and(|rel| rel == "alternate")
                }
            };
            if rel_is_alternate {
                if let Some(raw_href) = link_href {
                    if let Some(href) = unescape_xml_entities(raw_href) {
                        if let Some(tag) = tag_from_atom_href(&href) {
                            match &entry_tag {
                                None => entry_tag = Some(tag),
                                Some(existing) if existing == &tag => {}
                                Some(_) => entry_ambiguous = true,
                            }
                        }
                    }
                }
            }
        }

        if self_closing {
            if stack.is_empty() && tag_name == "feed" {
                saw_closed_feed = true;
            }
            continue;
        }

        if stack.as_slice() == ["feed", "entry"] && (tag_name == "content" || tag_name == "summary")
        {
            skip_element_body(bytes, &mut i, tag_name.as_bytes())?;
            continue;
        }

        if stack.len() >= MAX_XML_DEPTH {
            return Err("Atom feed nesting too deep".to_string());
        }
        if stack.as_slice() == ["feed"] && tag_name == "entry" {
            entry_tag = None;
            entry_ambiguous = false;
        }
        stack.push(tag_name);
    }

    if !saw_closed_feed || !stack.is_empty() {
        return Err("incomplete Atom feed".to_string());
    }
    Ok(best.map(|(_, tag)| tag))
}

fn latest_tag_from_releases_list_json(body: &[u8]) -> Result<Option<String>, String> {
    let value: Value =
        serde_json::from_slice(body).map_err(|e| format!("releases response is not JSON: {e}"))?;
    let releases = value
        .as_array()
        .ok_or_else(|| "releases response is not a JSON array".to_string())?;
    let mut best: Option<(SemVer, String)> = None;
    for release in releases {
        if release
            .get("draft")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        {
            continue;
        }
        let Some(tag) = release.get("tag_name").and_then(Value::as_str) else {
            continue;
        };
        if !is_valid_tag(tag) {
            continue;
        }
        let Ok(ver) = parse_semver(tag) else {
            continue;
        };
        let is_newer = match &best {
            None => true,
            Some((best_ver, _)) => ver > *best_ver,
        };
        if is_newer {
            best = Some((ver, tag.to_string()));
        }
    }
    Ok(best.map(|(_, tag)| tag))
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
    if !is_valid_tag(tag) {
        return Err(format!("invalid release tag '{tag}'"));
    }
    if !is_stable_tag(tag) {
        return Err("latest release is a pre-release; stable channel only".to_string());
    }
    Ok(tag.to_string())
}

enum RejectionReason {
    Draft,
    StableChannelOnly,
}

enum ApiAsset {
    Found(SetupAsset),
    /// The API positively identified the matching release as disallowed for
    /// this channel (draft on any channel, or pre-release on stable); do not
    /// bypass this policy via the HTML fallback.
    RejectedRelease(RejectionReason),
    /// The API returned valid metadata for this matching release, but it
    /// contained no usable x64 setup asset; try the HTML fallback in case
    /// metadata is incomplete, while still knowing the release itself exists.
    NoUsableAsset,
    /// The API 200 response was malformed or described a different tag; fall
    /// back to HTML without letting this unusable response mask a subsequent
    /// HTML transport, HTTP, or rate-limit failure.
    InvalidResponse,
}

/// Fetch the installer metadata for one stable tag. The API is tried first;
/// when it is rate-limited or unavailable, the expanded-assets HTML page is
/// parsed.
#[cfg(test)]
pub fn resolve_release_asset(http: &dyn ReleaseHttp, tag: &str) -> AssetResolution {
    resolve_release_asset_for_channel(http, tag, UpdateChannel::Stable)
}

/// Fetch the installer metadata for `tag` under `channel`'s policy. Drafts are
/// rejected on every channel; pre-releases are rejected on `Stable` and allowed
/// on `Prerelease`. The API is tried first, with `expanded_assets` HTML (and
/// its mandatory SHA-256 verification) as the fallback.
pub fn resolve_release_asset_for_channel(
    http: &dyn ReleaseHttp,
    tag: &str,
    channel: UpdateChannel,
) -> AssetResolution {
    if !is_valid_tag(tag) {
        return AssetResolution {
            asset: None,
            limited: None,
            rejected: false,
            error: Some(format!("invalid release tag '{tag}'")),
        };
    }
    if channel == UpdateChannel::Stable && !is_stable_tag(tag) {
        return AssetResolution {
            asset: None,
            limited: None,
            rejected: true,
            error: Some("release is a pre-release; stable channel only".to_string()),
        };
    }
    let mut api_ok = false;
    let mut api_limited: Option<RateLimit> = None;
    let mut api_error: Option<String> = None;
    let api_url = format!("https://api.github.com/repos/{REPO}/releases/tags/{tag}");
    match http.get(&api_url, &json_headers(), Preset::Check) {
        Ok(response) if response.status == 200 => {
            match asset_from_release_json(&response.body, tag, channel) {
                ApiAsset::Found(asset) => {
                    return AssetResolution {
                        asset: Some(asset),
                        limited: None,
                        rejected: false,
                        error: None,
                    };
                }
                ApiAsset::RejectedRelease(reason) => {
                    let message = match reason {
                        RejectionReason::StableChannelOnly => {
                            "release is a pre-release or draft; stable channel only".to_string()
                        }
                        RejectionReason::Draft => "release is a draft".to_string(),
                    };
                    return AssetResolution {
                        asset: None,
                        limited: None,
                        rejected: true,
                        error: Some(message),
                    };
                }
                ApiAsset::NoUsableAsset => {
                    api_ok = true;
                }
                ApiAsset::InvalidResponse => {}
            }
        }
        Ok(response) => {
            api_limited = rate_limit_for(&response);
            if api_limited.is_none() {
                api_error = Some(format!("[http]: status {}", response.status));
            }
        }
        Err(error) => {
            api_error = Some(format!("[{}]: {}", error.tag, error.detail));
        }
    }

    let expanded_url = format!("https://github.com/{REPO}/releases/expanded_assets/{tag}");
    let mut html_ok = false;
    let mut html_limited: Option<RateLimit> = None;
    let mut html_error: Option<String> = None;
    match http.get(&expanded_url, &html_headers(), Preset::Check) {
        Ok(response) if response.status == 200 => {
            html_ok = true;
            let html = String::from_utf8_lossy(&response.body);
            if let Ok(asset) = parse_expanded_assets(&html, tag) {
                return AssetResolution {
                    asset: Some(asset),
                    limited: None,
                    rejected: false,
                    error: None,
                };
            }
        }
        Ok(response) => {
            html_limited = rate_limit_for(&response);
            if html_limited.is_none() {
                html_error = Some(format!("[http]: status {}", response.status));
            }
        }
        Err(error) => {
            html_error = Some(format!("[{}]: {}", error.tag, error.detail));
        }
    }

    if html_ok || api_ok {
        return AssetResolution {
            asset: None,
            limited: None,
            rejected: false,
            error: None,
        };
    }
    let limited = html_limited.or(api_limited);
    let error = if limited.is_some() {
        None
    } else {
        html_error.or(api_error)
    };
    AssetResolution {
        asset: None,
        limited,
        rejected: false,
        error,
    }
}

fn asset_from_release_json(body: &[u8], tag: &str, channel: UpdateChannel) -> ApiAsset {
    let Ok(release) = serde_json::from_slice::<Value>(body) else {
        return ApiAsset::InvalidResponse;
    };
    let Some(release_tag) = release.get("tag_name").and_then(Value::as_str) else {
        return ApiAsset::InvalidResponse;
    };
    if !is_valid_tag(release_tag) || !same_tag(release_tag, tag) {
        return ApiAsset::InvalidResponse;
    }
    let is_draft = release
        .get("draft")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let is_prerelease = release
        .get("prerelease")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    match channel {
        UpdateChannel::Stable => {
            if is_draft || is_prerelease || !is_stable_tag(release_tag) {
                return ApiAsset::RejectedRelease(RejectionReason::StableChannelOnly);
            }
        }
        UpdateChannel::Prerelease => {
            if is_draft {
                return ApiAsset::RejectedRelease(RejectionReason::Draft);
            }
        }
    }
    let Some(assets) = release.get("assets").and_then(Value::as_array) else {
        return ApiAsset::InvalidResponse;
    };
    match select_setup_asset_for_tag(assets, Some(release_tag)) {
        Ok(asset) => ApiAsset::Found(asset),
        Err(_) => ApiAsset::NoUsableAsset,
    }
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
/// The API is trusted, but an exact `/{repo}/releases/download/{tag}/{name}`
/// check keeps a tampered response from pointing the downloader at another
/// origin, another release, or percent-encoded traversal segments.
fn is_github_release_download(url: &str, expected_tag: Option<&str>, expected_name: &str) -> bool {
    let Some(path) = url.strip_prefix("https://github.com") else {
        return false;
    };
    let prefix = format!("/{REPO}/releases/download/");
    let Some(rest) = path.strip_prefix(prefix.as_str()) else {
        return false;
    };
    if rest.contains(['\\', '?', '#', '@', '%']) || rest.contains("..") {
        return false;
    }
    let Some((url_tag, url_name)) = rest.split_once('/') else {
        return false;
    };
    if url_name.contains('/') || url_name != expected_name || !is_valid_tag(url_tag) {
        return false;
    }
    match expected_tag {
        Some(tag) => same_tag(url_tag, tag),
        None => true,
    }
}

/// Select exactly one x64 NSIS setup asset and validate its URL and digest.
#[cfg(test)]
pub fn select_setup_asset(assets: &[Value]) -> Result<SetupAsset, String> {
    select_setup_asset_for_tag(assets, None)
}

/// Select exactly one x64 NSIS setup asset, binding its download URL to
/// `expected_tag` (when provided) and the asset's own validated filename.
pub fn select_setup_asset_for_tag(
    assets: &[Value],
    expected_tag: Option<&str>,
) -> Result<SetupAsset, String> {
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
        .filter(|url| is_github_release_download(url, expected_tag, &name))
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
        .filter(|value| value.len() == 64 && value.chars().all(|c| c.is_ascii_hexdigit()))
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
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
        && !name.contains("..")
}

/// Parse GitHub's expanded-assets HTML. This page is undocumented, so every
/// field is validated exactly like the JSON API shape; a missing or ambiguous
/// digest makes the fallback fail rather than downloading unverified bytes.
pub fn parse_expanded_assets(html: &str, tag: &str) -> Result<SetupAsset, String> {
    if !is_valid_tag(tag) {
        return Err("invalid release tag".to_string());
    }
    let mut tags = vec![tag.to_string()];
    let with_v = format!("v{}", strip_tag_prefix(tag));
    if !tags.contains(&with_v) {
        tags.push(with_v);
    }

    let mut found: Vec<SetupAsset> = Vec::new();
    for raw_chunk in html.split("<li").skip(1) {
        // Match real <li> items only, not prefixes such as <link>.
        if !raw_chunk
            .chars()
            .next()
            .is_some_and(|c| c == '>' || c.is_ascii_whitespace())
        {
            continue;
        }
        // Bound digest lookup to this list item so a trailing digest elsewhere
        // on the page cannot verify a setup entry that lacked its own digest.
        let chunk = raw_chunk.split("</li>").next().unwrap_or(raw_chunk);
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
        // Every matching setup entry must carry an unambiguous digest; fail
        // closed instead of dropping an unverified/conflicting candidate.
        let Some(sha256) = unique_sha256(chunk) else {
            return Err(format!(
                "setup asset '{name}' has no unambiguous sha256 digest"
            ));
        };
        let url = format!("https://github.com/{REPO}/releases/download/{tag_used}/{name}");
        let asset = SetupAsset {
            name: name.to_string(),
            url,
            size: 0,
            sha256,
        };
        if !found
            .iter()
            .any(|existing| existing.name == asset.name && existing.sha256 == asset.sha256)
        {
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
        if candidate.len() == 64 && candidate.chars().all(|c| c.is_ascii_hexdigit()) && boundary_ok
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
        // `start` sits right after ASCII "sha256:", so it is strictly past
        // `offset`, <= chunk.len(), and guaranteed to be a UTF-8 char boundary.
        offset = start;
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
    Ok(SemVer { core: numbers, pre })
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

        pub(crate) fn with_headers(status: u16, body: &str, headers: ResponseHeaders) -> Self {
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
    use serde_json::json;

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
        assert_eq!(
            version_newer_checked("1.0.0", "1.0.0+build.7").unwrap(),
            false
        );
    }

    #[test]
    fn tag_from_location_accepts_absolute_and_relative_paths() {
        assert_eq!(
            tag_from_location("https://github.com/ZouDongj/ZTerm/releases/tag/v1.2.4").as_deref(),
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
        assert_eq!(
            http.calls(),
            vec![(false, RELEASES_LATEST_PAGE.to_string())]
        );
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
        assert_eq!(
            resolve_latest_tag(&http).unwrap().as_deref(),
            Some("v1.3.0")
        );
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
        assert_eq!(
            resolve_latest_tag(&http).unwrap().as_deref(),
            Some("v1.3.1")
        );
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
            FakeReply::with_headers(403, "", headers(None, None, Some("1730000000"), Some("0"))),
        );
        let result = resolve_release_asset(&http, "v1.2.4");
        assert!(result.asset.is_none());
        assert_eq!(result.limited.unwrap().reset_at, Some(1_730_000_000));
    }

    #[test]
    fn asset_lookup_tolerates_a_missing_or_stale_api_tag() {
        let http = FakeHttp::new();
        let sha_stale = "1".repeat(64);
        let sha = "e".repeat(64);
        // The API returns a valid release and asset, but for the wrong tag;
        // same_tag must reject it and fall back to the expanded-assets HTML.
        http.on_get(
            "https://api.github.com/repos/ZouDongj/ZTerm/releases/tags/v1.2.4",
            FakeReply::response(
                200,
                &format!(
                    r#"{{"tag_name":"v9.9.9","prerelease":false,"draft":false,"assets":[{{"name":"ZTerm_9.9.9_x64-setup.exe","size":42,"digest":"sha256:{sha_stale}","browser_download_url":"https://github.com/ZouDongj/ZTerm/releases/download/v9.9.9/ZTerm_9.9.9_x64-setup.exe"}}]}}"#
                ),
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
        let asset = resolve_release_asset(&http, "v1.2.4").asset.unwrap();
        assert_eq!(asset.name, "ZTerm_1.2.4_x64-setup.exe");
        assert_eq!(asset.sha256, sha);
    }

    #[test]
    fn rate_limit_for_ignores_403_with_only_reset_header_or_proxy_abuse_text() {
        let plain_403 = HttpResponse {
            status: 403,
            body: b"Forbidden by upstream".to_vec(),
            headers: headers(None, None, Some("1730000000"), Some("59")),
        };
        assert_eq!(rate_limit_for(&plain_403), None);

        let proxy_403 = HttpResponse {
            status: 403,
            body: b"Blocked by corporate acceptable use / abuse policy".to_vec(),
            headers: headers(None, None, Some("1730000000"), Some("59")),
        };
        assert_eq!(rate_limit_for(&proxy_403), None);

        let gh_abuse_403 = HttpResponse {
            status: 403,
            body: b"You have triggered an abuse detection mechanism".to_vec(),
            headers: headers(None, Some("60"), Some("1730000000"), Some("59")),
        };
        assert_eq!(
            rate_limit_for(&gh_abuse_403),
            Some(RateLimit {
                reset_at: Some(1_730_000_000),
                retry_in: Some(60),
            })
        );
    }

    #[test]
    fn unique_sha256_handles_trailing_prefix_multibyte_utf8_and_conflicting_digests() {
        let sha_a = "a".repeat(64);
        let sha_b = "b".repeat(64);

        // Trailing "sha256:" and multi-byte UTF-8 immediately after the colon
        // must never panic on slice bounds or char boundaries.
        assert_eq!(unique_sha256("<li>sha256:"), None);
        assert_eq!(unique_sha256("<li>sha256:中文字符"), None);
        assert_eq!(
            unique_sha256(&format!("<li>sha256:中文 sha256:sha256:{sha_a}</li>")),
            Some(sha_a.clone())
        );

        // Two distinct valid digests in the same <li> are ambiguous and rejected.
        let conflicting = format!(
            r#"<li><a href="/ZouDongj/ZTerm/releases/download/v1.2.4/ZTerm_1.2.4_x64-setup.exe">x</a>sha256:{sha_a} sha256:{sha_b}</li>"#
        );
        assert!(parse_expanded_assets(&conflicting, "v1.2.4").is_err());
    }

    #[test]
    fn tag_charset_rejects_whitespace_in_location_and_release_json() {
        assert!(!is_valid_tag(" v1.2.4"));
        assert!(!is_valid_tag("v1.2.4 "));
        assert!(
            tag_from_location("https://github.com/ZouDongj/ZTerm/releases/tag/ v1.2.4").is_none()
        );
        let json_body = br#"{"tag_name":" v1.2.4","prerelease":false,"draft":false}"#;
        assert!(stable_tag_from_release_json(json_body).is_err());
    }

    #[test]
    fn select_setup_asset_binds_url_to_tag_and_strict_filename_charset() {
        let sha = format!("sha256:{}", "a".repeat(64));
        let wrong_tag_url = json!({
            "name": "ZTerm_1.2.4_x64-setup.exe",
            "size": 10,
            "digest": sha,
            "browser_download_url": "https://github.com/ZouDongj/ZTerm/releases/download/v1.0.0/ZTerm_1.2.4_x64-setup.exe",
        });
        assert!(select_setup_asset_for_tag(&[wrong_tag_url], Some("v1.2.4")).is_err());

        for bad_url in [
            "https://github.com/ZouDongj/ZTerm/releases/download/v1.2.4/%2e%2e/ZTerm_1.2.4_x64-setup.exe",
            "https://github.com/ZouDongj/ZTerm/releases/download/v1.2.4/sub%2fZTerm_1.2.4_x64-setup.exe",
            "https://github.com/ZouDongj/ZTerm/releases/download/v1.2.4/other_x64-setup.exe",
        ] {
            let asset = json!({
                "name": "ZTerm_1.2.4_x64-setup.exe",
                "size": 10,
                "digest": sha,
                "browser_download_url": bad_url,
            });
            assert!(
                select_setup_asset_for_tag(&[asset], Some("v1.2.4")).is_err(),
                "{bad_url}"
            );
        }

        for bad_name in [
            "ZTerm_1.2.4:ads_x64-setup.exe",
            "ZTerm_1.2.4%20_x64-setup.exe",
            "ZTerm_1.2.4#1_x64-setup.exe",
            "ZTerm_1.2.4 _x64-setup.exe",
        ] {
            let asset = json!({
                "name": bad_name,
                "size": 10,
                "digest": sha,
                "browser_download_url": format!("https://github.com/ZouDongj/ZTerm/releases/download/v1.2.4/{bad_name}"),
            });
            assert!(
                select_setup_asset_for_tag(&[asset], Some("v1.2.4")).is_err(),
                "{bad_name}"
            );
        }
    }

    #[test]
    fn api_prerelease_or_draft_does_not_fall_back_to_expanded_assets_html() {
        let sha = "a".repeat(64);
        // Use a stable-formatted tag so API metadata rejection is exercised
        // independently of the SemVer pre-release tag guard.
        for flag in ["prerelease", "draft"] {
            let http = FakeHttp::new();
            http.on_get(
                "https://api.github.com/repos/ZouDongj/ZTerm/releases/tags/v1.3.0",
                FakeReply::response(
                    200,
                    &format!(
                        r#"{{"tag_name":"v1.3.0","{flag}":true,"assets":[{{"name":"ZTerm_1.3.0_x64-setup.exe","size":42,"digest":"sha256:{sha}","browser_download_url":"https://github.com/ZouDongj/ZTerm/releases/download/v1.3.0/ZTerm_1.3.0_x64-setup.exe"}}]}}"#
                    ),
                ),
            );
            http.on_get(
                "https://github.com/ZouDongj/ZTerm/releases/expanded_assets/v1.3.0",
                FakeReply::response(
                    200,
                    &format!(
                        r#"<li><a href="/ZouDongj/ZTerm/releases/download/v1.3.0/ZTerm_1.3.0_x64-setup.exe">x</a>sha256:{sha}</li>"#
                    ),
                ),
            );
            let res = resolve_release_asset(&http, "v1.3.0");
            assert!(res.asset.is_none(), "{flag} must not return an asset");
            assert!(res.rejected, "{flag} must mark resolution as rejected");
            assert!(
                res.error
                    .as_deref()
                    .unwrap_or("")
                    .contains("stable channel"),
                "{flag}: {:?}",
                res.error
            );
            assert_eq!(
                http.calls().len(),
                1,
                "{flag} rejection must stop before HTML fallback"
            );
        }
    }

    #[test]
    fn prerelease_semver_tags_are_rejected_across_all_stable_channel_paths() {
        assert!(
            tag_from_location("https://github.com/ZouDongj/ZTerm/releases/tag/v1.3.0-rc.1")
                .is_none()
        );

        let http = FakeHttp::new();
        http.on_no_redirect(
            RELEASES_LATEST_PAGE,
            FakeReply::with_headers(
                302,
                "",
                headers(
                    Some("https://github.com/ZouDongj/ZTerm/releases/tag/v1.3.0-rc.1"),
                    None,
                    None,
                    None,
                ),
            ),
        );
        http.on_get(
            RELEASES_LATEST_API,
            FakeReply::response(
                200,
                r#"{"tag_name":"v1.3.0-rc.1","prerelease":false,"draft":false}"#,
            ),
        );
        let err = resolve_latest_tag(&http).unwrap_err();
        assert!(err.contains("pre-release"), "{err}");

        let asset_http = FakeHttp::new();
        let res = resolve_release_asset(&asset_http, "v1.3.0-rc.1");
        assert!(res.asset.is_none());
        assert!(res.rejected);
        assert!(
            asset_http.calls().is_empty(),
            "pre-release tag must fail before API or HTML fallback"
        );
    }

    #[test]
    fn malformed_api_200_does_not_mask_html_fallback_errors() {
        let http = FakeHttp::new();
        http.on_get(
            "https://api.github.com/repos/ZouDongj/ZTerm/releases/tags/v1.2.4",
            FakeReply::response(200, "<html>captive portal</html>"),
        );
        http.on_get(
            "https://github.com/ZouDongj/ZTerm/releases/expanded_assets/v1.2.4",
            FakeReply::response(503, "Service Unavailable"),
        );
        let res = resolve_release_asset(&http, "v1.2.4");
        assert!(res.asset.is_none());
        assert!(
            res.error
                .as_deref()
                .unwrap_or("")
                .contains("[http]: status 503"),
            "{:?}",
            res.error
        );

        let limited_http = FakeHttp::new();
        limited_http.on_get(
            "https://api.github.com/repos/ZouDongj/ZTerm/releases/tags/v1.2.4",
            FakeReply::response(200, r#"{"tag_name":"v1.0.0","assets":[]}"#),
        );
        limited_http.on_get(
            "https://github.com/ZouDongj/ZTerm/releases/expanded_assets/v1.2.4",
            FakeReply::with_headers(429, "", headers(None, Some("90"), None, None)),
        );
        let res = resolve_release_asset(&limited_http, "v1.2.4");
        assert!(res.asset.is_none());
        assert_eq!(
            res.limited,
            Some(RateLimit {
                reset_at: None,
                retry_in: Some(90)
            })
        );
    }

    #[test]
    fn expanded_assets_html_bounds_items_at_li_close_and_fails_closed_on_unverified_sibling() {
        let sha = "a".repeat(64);
        // Digest sitting outside </li> must not be attached to the setup item.
        let outside = format!(
            r#"<li><a href="/ZouDongj/ZTerm/releases/download/v1.2.4/ZTerm_1.2.4_x64-setup.exe">x</a></li><div>sha256:{sha}</div>"#
        );
        assert!(parse_expanded_assets(&outside, "v1.2.4").is_err());

        // <link> must not be matched by the <li split.
        let link_tag = format!(
            r#"<link href="/ZouDongj/ZTerm/releases/download/v1.2.4/ZTerm_1.2.4_x64-setup.exe">sha256:{sha}"#
        );
        assert!(parse_expanded_assets(&link_tag, "v1.2.4").is_err());

        // One verified setup entry plus one unverified setup entry must fail
        // closed rather than silently dropping the unverified one.
        let mixed = format!(
            r#"<li><a href="/ZouDongj/ZTerm/releases/download/v1.2.4/ZTerm_1.2.4_x64-setup.exe">x</a>sha256:{sha}</li><li><a href="/ZouDongj/ZTerm/releases/download/v1.2.4/ZTerm_1.2.4b_x64-setup.exe">x</a></li>"#
        );
        assert!(parse_expanded_assets(&mixed, "v1.2.4").is_err());
    }

    #[test]
    fn asset_lookup_preserves_transport_and_http_errors_when_both_sources_fail() {
        let http = FakeHttp::new();
        http.on_get(
            "https://api.github.com/repos/ZouDongj/ZTerm/releases/tags/v1.2.4",
            FakeReply::fail("connect", "WinHttpSendRequest: 0x80072EFD"),
        );
        http.on_get(
            "https://github.com/ZouDongj/ZTerm/releases/expanded_assets/v1.2.4",
            FakeReply::fail("connect", "WinHttpSendRequest: 0x80072EFD"),
        );
        let res = resolve_release_asset(&http, "v1.2.4");
        assert!(res.asset.is_none());
        assert!(res.limited.is_none());
        assert!(
            res.error.as_deref().unwrap_or("").contains("[connect]"),
            "{:?}",
            res.error
        );

        let http_503 = FakeHttp::new();
        http_503.on_get(
            "https://api.github.com/repos/ZouDongj/ZTerm/releases/tags/v1.2.4",
            FakeReply::response(503, "Service Unavailable"),
        );
        http_503.on_get(
            "https://github.com/ZouDongj/ZTerm/releases/expanded_assets/v1.2.4",
            FakeReply::response(503, "Service Unavailable"),
        );
        let res = resolve_release_asset(&http_503, "v1.2.4");
        assert!(
            res.error
                .as_deref()
                .unwrap_or("")
                .contains("[http]: status 503"),
            "{:?}",
            res.error
        );
    }

    fn atom_feed_with_entries(entries: &[&str]) -> String {
        let mut out = String::from(
            r#"<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:media="http://search.yahoo.com/mrss/" xml:lang="en-US">
  <id>tag:github.com,2008:https://github.com/ZouDongj/ZTerm/releases</id>
  <link type="text/html" rel="alternate" href="https://github.com/ZouDongj/ZTerm/releases"/>
  <link type="application/atom+xml" rel="self" href="https://github.com/ZouDongj/ZTerm/releases.atom"/>
  <title>Release notes from ZTerm</title>
  <updated>2026-11-22T15:39:27Z</updated>
"#,
        );
        for entry in entries {
            out.push_str(entry);
            out.push('\n');
        }
        out.push_str("</feed>");
        out
    }

    fn atom_entry(tag: &str, content: &str) -> String {
        format!(
            r#"  <entry>
    <id>tag:github.com,2008:Repository/1313590895/{tag}</id>
    <updated>2026-11-22T15:39:27Z</updated>
    <link rel="alternate" type="text/html" href="https://github.com/ZouDongj/ZTerm/releases/tag/{tag}"/>
    <title>ZTerm {tag}</title>
    <content type="html">{content}</content>
    <author><name>ZouDongj</name></author>
    <media:thumbnail height="30" width="30" url="https://avatars.githubusercontent.com/u/1?v=4"/>
  </entry>"#
        )
    }

    #[test]
    fn update_channel_for_version_derives_channel_from_semver_prerelease() {
        for stable in ["1.2.4", "1.2.5", "v1.2.5", "1.2.5+build.7"] {
            assert_eq!(
                UpdateChannel::for_version(stable),
                UpdateChannel::Stable,
                "{stable}"
            );
        }
        for pre in ["1.2.5-dev.3", "v1.2.5-dev.1", "1.2.6-rc.1+sha.abc"] {
            assert_eq!(
                UpdateChannel::for_version(pre),
                UpdateChannel::Prerelease,
                "{pre}"
            );
        }
        for malformed in ["", "not-a-version", "1.2.5-", "1.2.5-dev.04"] {
            assert_eq!(
                UpdateChannel::for_version(malformed),
                UpdateChannel::Stable,
                "malformed version '{malformed}' must fail safe to Stable"
            );
        }
    }

    #[test]
    fn atom_feed_picks_semver_maximum_and_ignores_content_and_malformed_tags() {
        let e1 = atom_entry(
            "v1.2.5-dev.3",
            r#"&lt;p&gt;中文发布说明 &lt;link rel="alternate" href="https://github.com/ZouDongj/ZTerm/releases/tag/v9.9.9"/&gt;&lt;/p&gt;"#,
        );
        // Unescaped markup and CDATA inside <content> must never spoof an entry link.
        let e2 = atom_entry(
            "v1.2.5-dev.4",
            r#"<p>See <br> <link rel="alternate" href="https://github.com/ZouDongj/ZTerm/releases/tag/v9.9.8"/></p><![CDATA[</content><link rel="alternate" href="https://github.com/ZouDongj/ZTerm/releases/tag/v9.9.7"/>]]>"#,
        );
        let e3 = atom_entry("v1.2.4", "stable release");
        let e4 = atom_entry("v1.2.5-dev.2", "older dev release");
        let e_bad_zero = atom_entry("v1.2.5-dev.04", "malformed leading zero");
        let e_bad_empty = atom_entry("v1.2.5-", "malformed empty prerelease");
        let e_non_semver = atom_entry("nightly", "non-semver tag");
        let e_non_alt = r#"  <entry>
    <link rel="related" href="https://github.com/ZouDongj/ZTerm/releases/tag/v9.9.6"/>
    <summary><link rel="alternate" href="https://github.com/ZouDongj/ZTerm/releases/tag/v9.9.5"/></summary>
  </entry>"#;
        let comment_spoof = r#"  <!-- <entry><link rel="alternate" href="https://github.com/ZouDongj/ZTerm/releases/tag/v9.9.4"/></entry> -->"#;

        let xml = atom_feed_with_entries(&[
            &e1,
            &e2,
            &e3,
            &e4,
            &e_bad_zero,
            &e_bad_empty,
            &e_non_semver,
            e_non_alt,
            comment_spoof,
        ]);
        assert_eq!(
            parse_releases_atom_latest_tag(&xml).unwrap().as_deref(),
            Some("v1.2.5-dev.4")
        );
    }

    #[test]
    fn atom_feed_handles_attribute_variations_and_rejects_malformed_docs() {
        // Reversed attributes, single quotes, omitted rel (defaults to alternate),
        // explicit closing </link>, '>' inside another attribute, and UTF-8 BOM.
        let xml = "\u{FEFF}<?xml version='1.0' encoding='UTF-8'?>\
<feed xmlns='http://www.w3.org/2005/Atom'>\
  <entry>\
    <link title='a > b' href='https://github.com/ZouDongj/ZTerm/releases/tag/v1.2.5' rel='alternate'></link>\
  </entry>\
  <entry>\
    <link type=\"text/html\" href=\"https://github.com/ZouDongj/ZTerm/releases/tag/v1.2.6-dev.1\"/>\
  </entry>\
  <entry>\
    <link rel=\"alternate\" href=\"https://github.com/Other/ZTerm/releases/tag/v9.9.9\"/>\
    <link rel=\"alternate\" href=\"https://evil.example/ZouDongj/ZTerm/releases/tag/v9.9.8\"/>\
    <link rel=\"alternate\" href=\"https://github.com/ZouDongj/ZTerm/releases/tag/v9.9.7?q=1\"/>\
    <link rel=\"alternate\" href=\"https://github.com/ZouDongj/ZTerm/releases/tag/v9.9.%36\"/>\
  </entry>\
</feed>";
        assert_eq!(
            parse_releases_atom_latest_tag(xml).unwrap().as_deref(),
            Some("v1.2.6-dev.1")
        );

        // Conflicting alternate release links inside one entry are treated as ambiguous.
        let ambiguous = atom_feed_with_entries(&[r#"  <entry>
    <link rel="alternate" href="https://github.com/ZouDongj/ZTerm/releases/tag/v1.2.5-dev.4"/>
    <link rel="alternate" href="https://github.com/ZouDongj/ZTerm/releases/tag/v9.9.9"/>
  </entry>"#]);
        assert_eq!(parse_releases_atom_latest_tag(&ambiguous).unwrap(), None);

        // Valid empty feed or feed with only malformed tags yields Ok(None).
        assert_eq!(
            parse_releases_atom_latest_tag("<feed xmlns=\"http://www.w3.org/2005/Atom\"></feed>")
                .unwrap(),
            None
        );
        assert_eq!(
            parse_releases_atom_latest_tag("<feed xmlns=\"http://www.w3.org/2005/Atom\"/>")
                .unwrap(),
            None
        );
        let only_bad =
            atom_feed_with_entries(&[&atom_entry("v1.2.5-dev.04", ""), &atom_entry("v1.2.5-", "")]);
        assert_eq!(parse_releases_atom_latest_tag(&only_bad).unwrap(), None);

        // Non-Atom or truncated XML returns Err so callers fall back to the JSON API.
        for bad in [
            "",
            "<html><body>captive portal</body></html>",
            "<!DOCTYPE html><html><head></head><body>login</body></html>",
            "<feed><entry><link href=\"https://github.com/ZouDongj/ZTerm/releases/tag/v1.2.5\"/>",
            "<feed><entry><content>unclosed</entry></feed>",
            "<feed><!-- unclosed comment</feed>",
            "<feed><![CDATA[unclosed</feed>",
            "<feed></wrong>",
        ] {
            assert!(
                parse_releases_atom_latest_tag(bad).is_err(),
                "expected Err for malformed feed: {bad}"
            );
        }
    }

    #[test]
    fn prerelease_channel_uses_atom_without_api_and_selects_semver_maximum() {
        let http = FakeHttp::new();
        let xml = atom_feed_with_entries(&[
            &atom_entry("v1.2.5", "stable"),
            &atom_entry("v1.2.6-dev.1", "next dev"),
            &atom_entry("v1.2.5-dev.3", "current dev"),
        ]);
        http.on_get(RELEASES_ATOM_FEED, FakeReply::response(200, &xml));
        assert_eq!(
            resolve_latest_tag_for_channel(&http, UpdateChannel::Prerelease)
                .unwrap()
                .as_deref(),
            Some("v1.2.6-dev.1")
        );
        assert_eq!(http.calls(), vec![(true, RELEASES_ATOM_FEED.to_string())]);
    }

    #[test]
    fn prerelease_channel_falls_back_to_releases_list_api_and_skips_drafts_and_malformed() {
        let http = FakeHttp::new();
        http.on_get(
            RELEASES_ATOM_FEED,
            FakeReply::response(200, "<html>captive portal</html>"),
        );
        let list_json = json!([
            { "tag_name": "v9.9.9", "draft": true, "prerelease": false },
            { "tag_name": "v1.2.5-dev.04", "draft": false, "prerelease": true },
            { "tag_name": "v1.2.5-", "draft": false, "prerelease": true },
            { "tag_name": "v1.2.5", "draft": false, "prerelease": false },
            { "tag_name": "v1.2.6-dev.1", "draft": false, "prerelease": true },
            { "tag_name": "v1.2.4", "draft": false, "prerelease": false }
        ]);
        http.on_get(
            RELEASES_LIST_API,
            FakeReply::response(200, &list_json.to_string()),
        );
        assert_eq!(
            resolve_latest_tag_for_channel(&http, UpdateChannel::Prerelease)
                .unwrap()
                .as_deref(),
            Some("v1.2.6-dev.1")
        );
        assert_eq!(
            http.calls(),
            vec![
                (true, RELEASES_ATOM_FEED.to_string()),
                (true, RELEASES_LIST_API.to_string()),
            ]
        );

        // API list containing only drafts reports no release.
        let drafts_only = FakeHttp::new();
        drafts_only.on_get(RELEASES_ATOM_FEED, FakeReply::response(503, ""));
        drafts_only.on_get(
            RELEASES_LIST_API,
            FakeReply::response(
                200,
                r#"[{"tag_name":"v1.2.5-dev.4","draft":true,"prerelease":true}]"#,
            ),
        );
        assert_eq!(
            resolve_latest_tag_for_channel(&drafts_only, UpdateChannel::Prerelease).unwrap(),
            None
        );

        // API 404 reports no release.
        let not_found = FakeHttp::new();
        not_found.on_get(RELEASES_ATOM_FEED, FakeReply::response(404, ""));
        not_found.on_get(RELEASES_LIST_API, FakeReply::response(404, ""));
        assert_eq!(
            resolve_latest_tag_for_channel(&not_found, UpdateChannel::Prerelease).unwrap(),
            None
        );
    }

    #[test]
    fn prerelease_channel_preserves_connect_and_rate_limit_errors() {
        // Dead proxy: both Atom and API fail with [connect].
        let dead_proxy = FakeHttp::new();
        dead_proxy.on_get(
            RELEASES_ATOM_FEED,
            FakeReply::fail("connect", "WinHttpSendRequest: 0x80072EFD"),
        );
        dead_proxy.on_get(
            RELEASES_LIST_API,
            FakeReply::fail("connect", "WinHttpSendRequest: 0x80072EFD"),
        );
        let err =
            resolve_latest_tag_for_channel(&dead_proxy, UpdateChannel::Prerelease).unwrap_err();
        assert!(err.contains("[connect]"), "{err}");

        // Atom 502 followed by API [connect] keeps [connect] as the only bracketed tag.
        let mixed = FakeHttp::new();
        mixed.on_get(RELEASES_ATOM_FEED, FakeReply::response(502, "bad gateway"));
        mixed.on_get(
            RELEASES_LIST_API,
            FakeReply::fail("connect", "connection refused"),
        );
        let err = resolve_latest_tag_for_channel(&mixed, UpdateChannel::Prerelease).unwrap_err();
        assert!(err.contains("[connect]"), "{err}");
        assert!(!err.contains("[http]"), "{err}");

        // Atom transport error + API rate limit surfaces rate-limit detail.
        let api_limited = FakeHttp::new();
        api_limited.on_get(RELEASES_ATOM_FEED, FakeReply::fail("timeout", "timed out"));
        api_limited.on_get(
            RELEASES_LIST_API,
            FakeReply::with_headers(
                403,
                r#"{"message":"API rate limit exceeded"}"#,
                headers(None, None, Some("1730000000"), Some("0")),
            ),
        );
        let err =
            resolve_latest_tag_for_channel(&api_limited, UpdateChannel::Prerelease).unwrap_err();
        assert!(err.contains("rate-limit:"), "{err}");
        assert!(err.contains("reset_at=1730000000"), "{err}");

        // Atom 429 rate limit + API transport failure surfaces feed rate-limit detail.
        let feed_limited = FakeHttp::new();
        feed_limited.on_get(
            RELEASES_ATOM_FEED,
            FakeReply::with_headers(429, "", headers(None, Some("75"), None, None)),
        );
        feed_limited.on_get(
            RELEASES_LIST_API,
            FakeReply::fail("connect", "connection refused"),
        );
        let err =
            resolve_latest_tag_for_channel(&feed_limited, UpdateChannel::Prerelease).unwrap_err();
        assert!(err.contains("rate-limit:"), "{err}");
        assert!(err.contains("retry_in=75"), "{err}");
    }

    #[test]
    fn prerelease_asset_lookup_accepts_prerelease_rejects_draft_and_uses_html_fallback() {
        let sha = "f".repeat(64);
        // Accepts API 200 with prerelease:true and draft:false.
        let ok_http = FakeHttp::new();
        ok_http.on_get(
            "https://api.github.com/repos/ZouDongj/ZTerm/releases/tags/v1.2.5-dev.4",
            FakeReply::response(
                200,
                &format!(
                    r#"{{"tag_name":"v1.2.5-dev.4","prerelease":true,"draft":false,"assets":[{{"name":"ZTerm_1.2.5-dev.4_x64-setup.exe","size":99,"digest":"sha256:{sha}","browser_download_url":"https://github.com/ZouDongj/ZTerm/releases/download/v1.2.5-dev.4/ZTerm_1.2.5-dev.4_x64-setup.exe"}}]}}"#
                ),
            ),
        );
        let res =
            resolve_release_asset_for_channel(&ok_http, "v1.2.5-dev.4", UpdateChannel::Prerelease);
        let asset = res.asset.expect("prerelease asset");
        assert_eq!(asset.name, "ZTerm_1.2.5-dev.4_x64-setup.exe");
        assert_eq!(asset.sha256, sha);
        assert_eq!(ok_http.calls().len(), 1);

        // Rejects draft:true on prerelease channel without falling back to HTML.
        let draft_http = FakeHttp::new();
        draft_http.on_get(
            "https://api.github.com/repos/ZouDongj/ZTerm/releases/tags/v1.2.5-dev.4",
            FakeReply::response(
                200,
                &format!(
                    r#"{{"tag_name":"v1.2.5-dev.4","prerelease":true,"draft":true,"assets":[{{"name":"ZTerm_1.2.5-dev.4_x64-setup.exe","size":99,"digest":"sha256:{sha}","browser_download_url":"https://github.com/ZouDongj/ZTerm/releases/download/v1.2.5-dev.4/ZTerm_1.2.5-dev.4_x64-setup.exe"}}]}}"#
                ),
            ),
        );
        draft_http.on_get(
            "https://github.com/ZouDongj/ZTerm/releases/expanded_assets/v1.2.5-dev.4",
            FakeReply::response(
                200,
                &format!(
                    r#"<li><a href="/ZouDongj/ZTerm/releases/download/v1.2.5-dev.4/ZTerm_1.2.5-dev.4_x64-setup.exe">x</a>sha256:{sha}</li>"#
                ),
            ),
        );
        let res = resolve_release_asset_for_channel(
            &draft_http,
            "v1.2.5-dev.4",
            UpdateChannel::Prerelease,
        );
        assert!(res.asset.is_none());
        assert!(res.rejected);
        assert!(
            res.error.as_deref().unwrap_or("").contains("draft"),
            "{:?}",
            res.error
        );
        assert_eq!(draft_http.calls().len(), 1);

        // Falls back to expanded_assets HTML with mandatory SHA-256 when API is rate-limited.
        let fallback_http = FakeHttp::new();
        fallback_http.on_get(
            "https://api.github.com/repos/ZouDongj/ZTerm/releases/tags/v1.2.5-dev.4",
            FakeReply::with_headers(
                403,
                r#"{"message":"API rate limit exceeded"}"#,
                headers(None, None, Some("1730000000"), Some("0")),
            ),
        );
        fallback_http.on_get(
            "https://github.com/ZouDongj/ZTerm/releases/expanded_assets/v1.2.5-dev.4",
            FakeReply::response(
                200,
                &format!(
                    r#"<li><a href="/ZouDongj/ZTerm/releases/download/v1.2.5-dev.4/ZTerm_1.2.5-dev.4_x64-setup.exe">x</a>sha256:{sha}</li>"#
                ),
            ),
        );
        let res = resolve_release_asset_for_channel(
            &fallback_http,
            "v1.2.5-dev.4",
            UpdateChannel::Prerelease,
        );
        let asset = res.asset.expect("html fallback prerelease asset");
        assert_eq!(asset.name, "ZTerm_1.2.5-dev.4_x64-setup.exe");
        assert_eq!(asset.sha256, sha);
        assert!(res.limited.is_none());

        // Reports rate limit when both API and expanded_assets are rate-limited.
        let both_limited = FakeHttp::new();
        both_limited.on_get(
            "https://api.github.com/repos/ZouDongj/ZTerm/releases/tags/v1.2.5-dev.4",
            FakeReply::with_headers(
                403,
                r#"{"message":"API rate limit exceeded"}"#,
                headers(None, None, Some("1730000000"), Some("0")),
            ),
        );
        both_limited.on_get(
            "https://github.com/ZouDongj/ZTerm/releases/expanded_assets/v1.2.5-dev.4",
            FakeReply::with_headers(429, "", headers(None, Some("90"), None, None)),
        );
        let res = resolve_release_asset_for_channel(
            &both_limited,
            "v1.2.5-dev.4",
            UpdateChannel::Prerelease,
        );
        assert!(res.asset.is_none());
        assert_eq!(
            res.limited,
            Some(RateLimit {
                reset_at: None,
                retry_in: Some(90),
            })
        );

        // Malformed tag fails before any network call.
        let invalid_http = FakeHttp::new();
        let res = resolve_release_asset_for_channel(
            &invalid_http,
            "v1.2.5-dev.04",
            UpdateChannel::Prerelease,
        );
        assert!(res.asset.is_none());
        assert!(res
            .error
            .as_deref()
            .unwrap_or("")
            .contains("invalid release tag"));
        assert!(invalid_http.calls().is_empty());
    }
}
