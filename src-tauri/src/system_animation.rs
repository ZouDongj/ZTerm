//! Native OS animation preference query and change notification.
//!
//! WebView2 caches page-level `prefers-reduced-motion` when the document is
//! created and does not reliably refresh it after a remote desktop session
//! (RDP / loopback remote tools) returns to the local console or when the user
//! toggles Windows "Animation effects". Querying `SPI_GETCLIENTAREAANIMATION`
//! directly gives the smooth-cursor gate an authoritative live signal without
//! restarting the application.

use serde::Serialize;
use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
#[cfg(windows)]
use tauri::Emitter;
#[cfg(windows)]
use tokio::sync::Notify;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemAnimationPreference {
    pub animations_enabled: Option<bool>,
    pub remote_session: Option<bool>,
}

/// Compact lock-free encoding of the last GUI-thread observed preference so
/// the window subclass procedure never acquires a mutex or calls Tauri emit
/// synchronously on the Win32 GUI thread.
/// `0` means no value has been recorded yet; values `1..=9` encode the pair
/// `(animations_enabled, remote_session)` in base 3.
/// Written exclusively by the GUI thread (`install` and `watcher`).
static LAST_STATE: AtomicU8 = AtomicU8::new(0);

#[cfg(windows)]
static EMIT_NOTIFY: Notify = Notify::const_new();
#[cfg(windows)]
static WTS_REGISTERED: AtomicBool = AtomicBool::new(false);
#[cfg(windows)]
static EMITTER_STARTED: AtomicBool = AtomicBool::new(false);

fn encode_opt_bool(value: Option<bool>) -> u8 {
    match value {
        None => 0,
        Some(false) => 1,
        Some(true) => 2,
    }
}

fn decode_opt_bool(code: u8) -> Option<bool> {
    match code {
        1 => Some(false),
        2 => Some(true),
        _ => None,
    }
}

fn encode_preference(pref: SystemAnimationPreference) -> u8 {
    1 + encode_opt_bool(pref.animations_enabled) * 3 + encode_opt_bool(pref.remote_session)
}

fn decode_preference(code: u8) -> Option<SystemAnimationPreference> {
    if !(1..=9).contains(&code) {
        return None;
    }
    let idx = code - 1;
    Some(SystemAnimationPreference {
        animations_enabled: decode_opt_bool(idx / 3),
        remote_session: decode_opt_bool(idx % 3),
    })
}

fn record_state(slot: &AtomicU8, pref: SystemAnimationPreference) -> bool {
    let next = encode_preference(pref);
    let prev = slot.swap(next, Ordering::AcqRel);
    prev != 0 && prev != next
}

/// Query the live OS client-area animation preference and remote-session state.
pub fn query_system_animation_preference() -> SystemAnimationPreference {
    #[cfg(windows)]
    {
        use windows::Win32::UI::WindowsAndMessaging::{
            GetSystemMetrics, SystemParametersInfoW, SM_REMOTESESSION, SPI_GETCLIENTAREAANIMATION,
            SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS,
        };
        let mut enabled = windows_core::BOOL::default();
        let animations_enabled = unsafe {
            SystemParametersInfoW(
                SPI_GETCLIENTAREAANIMATION,
                0,
                Some((&mut enabled as *mut windows_core::BOOL).cast::<std::ffi::c_void>()),
                SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS(0),
            )
            .ok()
            .map(|()| enabled.as_bool())
        };
        let remote_session = Some(unsafe { GetSystemMetrics(SM_REMOTESESSION) } != 0);
        SystemAnimationPreference {
            animations_enabled,
            remote_session,
        }
    }
    #[cfg(not(windows))]
    {
        SystemAnimationPreference {
            animations_enabled: None,
            remote_session: None,
        }
    }
}

/// Read-only Tauri command returning the live Windows animation preference.
/// Deliberately does not write `LAST_STATE`, keeping `LAST_STATE` single-writer
/// on the GUI thread so command workers cannot race with `watcher`.
#[tauri::command]
pub fn get_system_animation_preference() -> SystemAnimationPreference {
    query_system_animation_preference()
}

/// Win32 message filter for broadcasts that may flip Windows animation policy
/// (Settings toggle, display adapter change on remote reconnect, and WTS
/// session connect/disconnect/unlock notifications registered via
/// `WTSRegisterSessionNotification`).
const MSG_SETTINGCHANGE: u32 = 0x001A;
const MSG_DISPLAYCHANGE: u32 = 0x007E;
const MSG_WTSSESSION_CHANGE: u32 = 0x02B1;
const SPI_SETCLIENTAREAANIMATION_PARAM: usize = 0x1043;

fn should_check_on_message(message: u32, wparam: usize) -> bool {
    if message == MSG_DISPLAYCHANGE || message == MSG_WTSSESSION_CHANGE {
        return true;
    }
    if message == MSG_SETTINGCHANGE {
        return wparam == 0 || wparam == SPI_SETCLIENTAREAANIMATION_PARAM;
    }
    false
}

/// Install a non-invasive window subclass + WTS session notification on the
/// main window so live Windows animation / display / session changes push
/// updated preferences immediately even while ZTerm stays visible and focused.
///
/// The subclass procedure never calls `app.emit(...)` directly (from the GUI
/// thread Tauri emits synchronously through a `Mutex` + `RefCell` + STA COM
/// `ExecuteScript`, which could self-deadlock or abort on re-entrant broadcasts).
/// Instead, `watcher` updates an atomic state slot and signals one background
/// Tokio task that emits asynchronously off the GUI thread.
#[cfg(windows)]
pub fn install(window: &tauri::WebviewWindow, app: &tauri::AppHandle) {
    use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
    use windows::Win32::System::RemoteDesktop::{
        WTSRegisterSessionNotification, WTSUnRegisterSessionNotification, NOTIFY_FOR_THIS_SESSION,
    };
    use windows::Win32::System::Threading::GetCurrentThreadId;
    use windows::Win32::UI::Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass};
    use windows::Win32::UI::WindowsAndMessaging::{
        GetWindowThreadProcessId, WM_DESTROY, WM_NCDESTROY,
    };

    // Distinct from background_e2e's SUBCLASS_ID (0x5a54_4247).
    const SUBCLASS_ID: usize = 0x5a54_414e;

    unsafe extern "system" fn watcher(
        hwnd: HWND,
        message: u32,
        wparam: WPARAM,
        lparam: LPARAM,
        _id: usize,
        _data: usize,
    ) -> LRESULT {
        // Unregister while the window is still fully alive (WM_DESTROY), as the
        // WTS documentation requires; the WM_NCDESTROY path is an idempotent
        // fallback guarded by the same flag.
        if message == WM_DESTROY && WTS_REGISTERED.swap(false, Ordering::AcqRel) {
            let _ = WTSUnRegisterSessionNotification(hwnd);
        }
        if message == WM_NCDESTROY {
            if WTS_REGISTERED.swap(false, Ordering::AcqRel) {
                let _ = WTSUnRegisterSessionNotification(hwnd);
            }
            let _ = RemoveWindowSubclass(hwnd, Some(watcher), SUBCLASS_ID);
            return DefSubclassProc(hwnd, message, wparam, lparam);
        }
        let result = DefSubclassProc(hwnd, message, wparam, lparam);
        if should_check_on_message(message, wparam.0) {
            let pref = query_system_animation_preference();
            if record_state(&LAST_STATE, pref) {
                EMIT_NOTIFY.notify_one();
            }
        }
        result
    }

    LAST_STATE.store(
        encode_preference(query_system_animation_preference()),
        Ordering::Release,
    );

    if !EMITTER_STARTED.swap(true, Ordering::AcqRel) {
        let handle = app.clone();
        tauri::async_runtime::spawn(async move {
            loop {
                EMIT_NOTIFY.notified().await;
                let code = LAST_STATE.load(Ordering::Acquire);
                if let Some(pref) = decode_preference(code) {
                    let _ = handle.emit("system-animation-preference-changed", pref);
                }
            }
        });
    }

    let raw = match window.hwnd() {
        Ok(raw) => raw,
        Err(err) => {
            eprintln!("[system-animation] failed to resolve main HWND: {err}");
            return;
        }
    };
    let hwnd = HWND(raw.0 as *mut std::ffi::c_void);
    let mut pid = 0;
    unsafe {
        let thread = GetWindowThreadProcessId(hwnd, Some(&mut pid));
        if pid != std::process::id() || thread != GetCurrentThreadId() {
            eprintln!("[system-animation] skipped subclass install outside owning GUI thread");
            return;
        }
        if !SetWindowSubclass(hwnd, Some(watcher), SUBCLASS_ID, 0).as_bool() {
            eprintln!("[system-animation] failed to install window subclass");
            return;
        }
        if WTSRegisterSessionNotification(hwnd, NOTIFY_FOR_THIS_SESSION).is_ok() {
            WTS_REGISTERED.store(true, Ordering::Release);
        }
    }
}

#[cfg(not(windows))]
pub fn install(_window: &tauri::WebviewWindow, _app: &tauri::AppHandle) {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn message_filter_matches_animation_display_and_session_broadcasts_only() {
        assert!(should_check_on_message(MSG_SETTINGCHANGE, 0));
        assert!(should_check_on_message(
            MSG_SETTINGCHANGE,
            SPI_SETCLIENTAREAANIMATION_PARAM
        ));
        assert!(!should_check_on_message(MSG_SETTINGCHANGE, 0x0014)); // unrelated SPI_SETDESKWALLPAPER
        assert!(should_check_on_message(MSG_DISPLAYCHANGE, 32));
        assert!(should_check_on_message(MSG_WTSSESSION_CHANGE, 0x1));
        assert!(!should_check_on_message(0x000F, 0)); // WM_PAINT
    }

    #[test]
    fn preference_encoding_roundtrips_and_change_detection_dedupes() {
        let states = [None, Some(false), Some(true)];
        let mut codes = std::collections::HashSet::new();
        for a in states {
            for r in states {
                let pref = SystemAnimationPreference {
                    animations_enabled: a,
                    remote_session: r,
                };
                let code = encode_preference(pref);
                assert!((1..=9).contains(&code));
                assert!(codes.insert(code));
                assert_eq!(decode_preference(code), Some(pref));
            }
        }
        assert_eq!(codes.len(), 9);
        assert_eq!(decode_preference(0), None);
        assert_eq!(decode_preference(10), None);

        let slot = AtomicU8::new(0);
        let p_remote = SystemAnimationPreference {
            animations_enabled: Some(false),
            remote_session: Some(true),
        };
        let p_local = SystemAnimationPreference {
            animations_enabled: Some(true),
            remote_session: Some(false),
        };
        assert!(
            !record_state(&slot, p_remote),
            "first observation seeds state"
        );
        assert!(
            !record_state(&slot, p_remote),
            "unchanged state does not emit"
        );
        assert!(record_state(&slot, p_local), "transition triggers emit");
        assert!(
            !record_state(&slot, p_local),
            "repeated local state does not re-emit"
        );
    }

    #[test]
    fn command_serializes_camel_case_fields() {
        let pref = SystemAnimationPreference {
            animations_enabled: Some(true),
            remote_session: Some(false),
        };
        let json = serde_json::to_value(pref).expect("serialize preference");
        assert_eq!(
            json,
            serde_json::json!({
                "animationsEnabled": true,
                "remoteSession": false
            })
        );
    }

    #[cfg(windows)]
    #[test]
    fn windows_live_query_returns_boolean_preference() {
        let pref = query_system_animation_preference();
        assert!(
            pref.animations_enabled.is_some(),
            "SPI_GETCLIENTAREAANIMATION should succeed on Windows"
        );
        assert!(
            pref.remote_session.is_some(),
            "SM_REMOTESESSION should be reported on Windows"
        );
    }
}
