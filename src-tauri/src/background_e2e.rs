//! Explicit, fail-closed background mode for the owned E2E executable only.
//! Normal launches do not install a guard or change their window behavior.

use serde::Deserialize;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::{atomic::{AtomicBool, AtomicUsize, Ordering}, OnceLock};
use std::time::{Duration, Instant};
use tauri::{Emitter, Manager};

const STARTUP_LIMIT: Duration = Duration::from_secs(25);
const LEASE_LIMIT: Duration = Duration::from_secs(5);
const RUN_LIMIT: Duration = Duration::from_secs(3600);
const FAILURE_EXIT_LIMIT: Duration = Duration::from_secs(2);
const CLOCK_DOMAIN: &str = "windows-boot-ms";

fn background_now() -> u64 {
    #[cfg(windows)]
    unsafe { windows::Win32::System::SystemInformation::GetTickCount64() }
    #[cfg(not(windows))]
    { 0 }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Policy {
    token: String,
    target_desktop_id: String,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Phase { Hidden, Registered, Placed, Showing, Shown, Failed }

struct Runtime {
    policy: Policy,
    root: PathBuf,
    phase: parking_lot::Mutex<Phase>,
    status_write: parking_lot::Mutex<()>,
    ready: AtomicBool,
    terminating: AtomicBool,
    hwnd: AtomicUsize,
    started: Instant,
}

static RUNTIME: OnceLock<Option<Runtime>> = OnceLock::new();

fn runtime() -> Option<&'static Runtime> { RUNTIME.get().and_then(Option::as_ref) }
pub fn enabled() -> bool { runtime().is_some() }

fn valid_guid(text: &str) -> bool {
    text != "00000000-0000-0000-0000-000000000000" && text.len() == 36 && text.bytes().enumerate().all(|(index, byte)| {
        if [8, 13, 18, 23].contains(&index) { byte == b'-' } else { byte.is_ascii_hexdigit() }
    })
}

pub fn configure() -> Result<(), String> {
    let Some(path) = std::env::var_os("ZTERM_E2E_BACKGROUND_POLICY") else {
        RUNTIME.set(None).map_err(|_| "background policy already initialized")?;
        return Ok(());
    };
    if !cfg!(windows) { return Err("background E2E is supported only on Windows".into()); }
    let path = PathBuf::from(path).canonicalize().map_err(|e| format!("background policy: {e}"))?;
    let exe = std::env::current_exe().map_err(|e| e.to_string())?.canonicalize().map_err(|e| e.to_string())?;
    let root = exe.parent().ok_or("background executable has no parent")?;
    if path.parent() != Some(root) { return Err("background policy must belong to the executable sandbox".into()); }
    let policy: Policy = serde_json::from_str(&std::fs::read_to_string(&path).map_err(|e| e.to_string())?)
        .map_err(|e| format!("invalid background policy: {e}"))?;
    if !valid_guid(&policy.token) || !valid_guid(&policy.target_desktop_id)
        || path.file_name().and_then(|n| n.to_str()) != Some(format!("background-{}.json", policy.token).as_str()) {
        return Err("invalid background policy identity".into());
    }
    RUNTIME.set(Some(Runtime {
        policy, root: root.to_path_buf(), phase: parking_lot::Mutex::new(Phase::Hidden),
        status_write: parking_lot::Mutex::new(()),
        ready: AtomicBool::new(false), terminating: AtomicBool::new(false),
        hwnd: AtomicUsize::new(0), started: Instant::now(),
    })).map_err(|_| "background policy already initialized")?;
    Ok(())
}

fn marker(rt: &Runtime, kind: &str) -> PathBuf {
    rt.root.join(format!("background-{}.{}.json", rt.policy.token, kind))
}

fn read_marker(rt: &Runtime, kind: &str) -> Option<Value> {
    serde_json::from_str(&std::fs::read_to_string(marker(rt, kind)).ok()?).ok()
}

fn identity_matches(value: &Value, token: &str, pid: u32, hwnd: usize) -> bool {
    value.get("token").and_then(Value::as_str) == Some(token)
        && value.get("pid").and_then(Value::as_u64) == Some(pid as u64)
        && value.get("hwnd").and_then(Value::as_str) == Some(format!("0x{hwnd:x}").as_str())
}

fn lease_valid(rt: &Runtime) -> bool {
    read_marker(rt, "lease").is_some_and(|value| {
        lease_proven(&value, &rt.policy.token, std::process::id(), rt.hwnd.load(Ordering::SeqCst), background_now())
    })
}

fn lease_proven(value: &Value, token: &str, pid: u32, hwnd: usize, now: u64) -> bool {
    if value["clockDomain"].as_str() != Some(CLOCK_DOMAIN) || !identity_matches(value, token, pid, hwnd) { return false; }
    value["renewedAt"].as_u64().is_some_and(|renewed| {
        renewed > 0 && renewed <= now && now - renewed < LEASE_LIMIT.as_millis() as u64
    })
}

fn write_status(rt: &Runtime, mut status: Value) -> Result<(), String> {
    let _writer = rt.status_write.lock();
    if rt.terminating.load(Ordering::SeqCst) && status["phase"] != "failed" {
        return Err("background host is terminating".into());
    }
    status["token"] = json!(rt.policy.token);
    status["pid"] = json!(std::process::id());
    status["hwnd"] = json!(format!("0x{:x}", rt.hwnd.load(Ordering::SeqCst)));
    status["targetDesktopId"] = json!(rt.policy.target_desktop_id.to_ascii_lowercase());
    status["clockDomain"] = json!(CLOCK_DOMAIN);
    let path = marker(rt, "status");
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, serde_json::to_vec(&status).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    std::fs::rename(tmp, path).map_err(|e| e.to_string())
}

pub fn renderer_ready() -> bool {
    if let Some(rt) = runtime() { rt.ready.store(true, Ordering::SeqCst); true } else { false }
}

pub fn require_released() -> Result<(), String> {
    if let Some(rt) = runtime() {
        if *rt.phase.lock() != Phase::Shown || !lease_valid(rt) {
            return Err("background window has not been released by the verified harness".into());
        }
    }
    Ok(())
}

pub fn install(window: &tauri::WebviewWindow, app: &tauri::AppHandle) -> Result<(), String> {
    let Some(rt) = runtime() else { return Ok(()) };
    #[cfg(windows)]
    native::install(window, rt)?;
    *rt.phase.lock() = Phase::Registered;
    let app = app.clone();
    std::thread::spawn(move || {
        loop {
            if *rt.phase.lock() == Phase::Failed { break; }
            let dispatch_app = app.clone();
            let (tx, rx) = std::sync::mpsc::sync_channel(1);
            if app.run_on_main_thread(move || { let _ = tx.send(tick(&dispatch_app)); }).is_err() {
                fail(&app, "background GUI dispatcher stopped");
                break;
            }
            match rx.recv_timeout(Duration::from_secs(3)) {
                Ok(true) => {}
                _ => {
                    fail(&app, "background isolation watchdog stopped or timed out");
                    break;
                }
            }
            std::thread::sleep(Duration::from_millis(100));
        }
    });
    Ok(())
}

fn fail(app: &tauri::AppHandle, reason: &str) {
    if let Some(rt) = runtime() {
        // Arm the bound before locks, file I/O, or GUI dispatch can block.
        // This opt-in E2E host must exit even when its GUI loop is hung.
        if !rt.terminating.swap(true, Ordering::SeqCst) {
            std::thread::spawn(|| {
                std::thread::sleep(FAILURE_EXIT_LIMIT);
                std::process::exit(1);
            });
        }
        *rt.phase.lock() = Phase::Failed;
        let _ = write_status(rt, json!({ "phase": "failed", "error": reason }));
        #[cfg(windows)]
        native::hide_owned(rt);
        app.exit(1);
    }
}

fn tick(app: &tauri::AppHandle) -> bool {
    let Some(rt) = runtime() else { return false };
    let phase = *rt.phase.lock();
    if phase == Phase::Failed { return false; }
    let Some(window) = app.get_webview_window("main") else { return false };
    #[cfg(windows)]
    {
        if let Err(error) = native::verify_guard(rt) { fail(app, &error); return false; }
        if rt.started.elapsed() > RUN_LIMIT { fail(app, "background E2E lifetime exceeded"); return false; }
        if phase != Phase::Shown && rt.started.elapsed() > STARTUP_LIMIT {
            fail(app, "background placement/renderer/release barrier timed out"); return false;
        }
        if phase == Phase::Registered {
            match native::place(rt) {
                Ok(()) => {
                    *rt.phase.lock() = Phase::Placed;
                    if native::snapshot(rt, "placed").and_then(|status| write_status(rt, status)).is_err() {
                        fail(app, "could not publish background placement"); return false;
                    }
                }
                Err(_) => return true,
            }
        }
        let phase = *rt.phase.lock();
        if matches!(phase, Phase::Placed | Phase::Showing | Phase::Shown) {
            if let Err(error) = native::verify_desktop(rt) { fail(app, &error); return false; }
        }
        if phase == Phase::Placed && rt.ready.load(Ordering::SeqCst)
            && read_marker(rt, "release").is_some_and(|value| identity_matches(&value, &rt.policy.token, std::process::id(), rt.hwnd.load(Ordering::SeqCst))) {
            if !lease_valid(rt) { fail(app, "background observer lease missing or expired"); return false; }
            *rt.phase.lock() = Phase::Showing;
            let _ = window.unminimize();
            crate::zterm::restore_window_state(&window);
            let _ = window.show();
        }
        let phase = *rt.phase.lock();
        if matches!(phase, Phase::Showing | Phase::Shown) && !lease_valid(rt) {
            fail(app, "background observer lease expired"); return false;
        }
        if phase == Phase::Showing && native::visible_and_restored(rt) {
            *rt.phase.lock() = Phase::Shown;
            if native::snapshot(rt, "shown").and_then(|status| write_status(rt, status)).is_err() {
                fail(app, "could not publish background release"); return false;
            }
            let _ = app.emit("window-shown", json!({}));
        } else if phase == Phase::Placed {
            if native::snapshot(rt, "placed").and_then(|status| write_status(rt, status)).is_err() {
                fail(app, "could not refresh background placement proof"); return false;
            }
        } else if phase == Phase::Shown {
            if native::health_snapshot(rt).and_then(|status| write_status(rt, status)).is_err() {
                fail(app, "could not refresh background native guard proof"); return false;
            }
        }
    }
    true
}

// WS_DISABLED and WS_EX_NOACTIVATE share this bit in their respective style
// words. Retain it after other subclass callbacks, including tao's style rebuild.
fn retained_guard_style(proposed: u32) -> u32 { proposed | 0x0800_0000 }

#[derive(Clone, Copy, PartialEq, Eq)]
enum GuardAction { Disable, RetainStyle, Remove, None }

fn dispatch_guard<T>(action: GuardAction, enforce: impl FnOnce(), delegate: impl FnOnce() -> T) -> T {
    if action == GuardAction::RetainStyle {
        let result = delegate();
        enforce();
        result
    } else {
        enforce();
        delegate()
    }
}

#[cfg(windows)]
mod native {
    use super::*;
    use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
    use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED};
    use windows::Win32::System::Threading::GetCurrentThreadId;
    use windows::Win32::UI::Input::KeyboardAndMouse::{EnableWindow, IsWindowEnabled};
    use windows::Win32::UI::Shell::{DefSubclassProc, IVirtualDesktopManager, RemoveWindowSubclass, SetWindowSubclass, VirtualDesktopManager};
    use windows::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowLongPtrW, GetWindowThreadProcessId, IsIconic, IsWindow, IsWindowVisible, ShowWindow, ShowWindowAsync, GWL_EXSTYLE, GWL_STYLE, STYLESTRUCT, SW_HIDE, SW_SHOWMINNOACTIVE, WM_ENABLE, WM_NCDESTROY, WM_STYLECHANGING, WS_DISABLED, WS_EX_NOACTIVATE};

    const SUBCLASS_ID: usize = 0x5a54_4247;

    fn hwnd(rt: &Runtime) -> HWND { HWND(rt.hwnd.load(Ordering::SeqCst) as *mut std::ffi::c_void) }

    unsafe extern "system" fn guard(hwnd: HWND, message: u32, wparam: WPARAM, lparam: LPARAM, _id: usize, _data: usize) -> LRESULT {
        let action = if message == WM_STYLECHANGING && (wparam.0 as i32 == GWL_STYLE.0 || wparam.0 as i32 == GWL_EXSTYLE.0) && lparam.0 != 0 {
            GuardAction::RetainStyle
        } else if message == WM_ENABLE && wparam.0 != 0 {
            GuardAction::Disable
        } else if message == WM_NCDESTROY {
            GuardAction::Remove
        } else { GuardAction::None };
        dispatch_guard(action, || match action {
            GuardAction::Disable => {
                // Re-disable before any downstream callback observes the HWND.
                let _ = EnableWindow(hwnd, false);
            }
            GuardAction::RetainStyle => {
                let styles = &mut *(lparam.0 as *mut STYLESTRUCT);
                styles.styleNew = retained_guard_style(styles.styleNew);
            }
            GuardAction::Remove => { let _ = RemoveWindowSubclass(hwnd, Some(guard), SUBCLASS_ID); }
            GuardAction::None => {}
        }, || DefSubclassProc(hwnd, message, wparam, lparam))
    }

    pub(super) fn install(window: &tauri::WebviewWindow, rt: &Runtime) -> Result<(), String> {
        let raw = window.hwnd().map_err(|e| e.to_string())?;
        let hwnd = HWND(raw.0 as *mut std::ffi::c_void);
        let mut pid = 0;
        unsafe {
            let thread = GetWindowThreadProcessId(hwnd, Some(&mut pid));
            if pid != std::process::id() || thread != GetCurrentThreadId() { return Err("background guard must be installed on its owning GUI thread".into()); }
            if IsWindowVisible(hwnd).as_bool() { return Err("background host became visible before guard installation".into()); }
            rt.hwnd.store(hwnd.0 as usize, Ordering::SeqCst);
            if !SetWindowSubclass(hwnd, Some(guard), SUBCLASS_ID, 0).as_bool() { return Err("background window subclass installation failed".into()); }
            let _ = EnableWindow(hwnd, false);
            verify_guard(rt)?;
            // The first ShowWindow can honor launcher STARTUPINFO instead.
            // Both attempts are non-activating and the host is already disabled.
            let _ = ShowWindow(hwnd, SW_SHOWMINNOACTIVE);
            if !IsIconic(hwnd).as_bool() { let _ = ShowWindow(hwnd, SW_SHOWMINNOACTIVE); }
            if !IsIconic(hwnd).as_bool() { return Err("background host did not register minimized".into()); }
        }
        Ok(())
    }

    pub(super) fn verify_guard(rt: &Runtime) -> Result<(), String> {
        let hwnd = hwnd(rt);
        let mut pid = 0;
        unsafe {
            GetWindowThreadProcessId(hwnd, Some(&mut pid));
            if !IsWindow(Some(hwnd)).as_bool() || pid != std::process::id() { return Err("background HWND ownership lost".into()); }
            if IsWindowEnabled(hwnd).as_bool() || GetWindowLongPtrW(hwnd, GWL_STYLE) as u32 & WS_DISABLED.0 == 0
                || GetWindowLongPtrW(hwnd, GWL_EXSTYLE) as u32 & WS_EX_NOACTIVATE.0 == 0 {
                return Err("background non-activation guard lost".into());
            }
            if GetForegroundWindow() == hwnd { return Err("background host acquired foreground".into()); }
        }
        Ok(())
    }

    fn manager<T>(operation: impl FnOnce(&IVirtualDesktopManager) -> Result<T, String>) -> Result<T, String> {
        unsafe {
            CoInitializeEx(None, COINIT_APARTMENTTHREADED).ok().map_err(|e| e.to_string())?;
            let result = (|| {
                let manager: IVirtualDesktopManager = CoCreateInstance(&VirtualDesktopManager, None, CLSCTX_INPROC_SERVER).map_err(|e| e.to_string())?;
                operation(&manager)
            })();
            CoUninitialize();
            result
        }
    }

    fn target(rt: &Runtime) -> windows_core::GUID {
        windows_core::GUID::from_u128(u128::from_str_radix(&rt.policy.target_desktop_id.replace('-', ""), 16).expect("validated GUID"))
    }

    pub(super) fn place(rt: &Runtime) -> Result<(), String> {
        manager(|manager| unsafe {
            let own = hwnd(rt);
            let target = target(rt);
            if manager.GetWindowDesktopId(own).map_err(|e| e.to_string())? != target {
                manager.MoveWindowToDesktop(own, &target).map_err(|e| e.to_string())?;
            }
            if manager.GetWindowDesktopId(own).map_err(|e| e.to_string())? != target
                || manager.IsWindowOnCurrentVirtualDesktop(own).map_err(|e| e.to_string())?.as_bool() {
                return Err("background placement is unverified or the target desktop is active".into());
            }
            Ok(())
        })
    }

    pub(super) fn verify_desktop(rt: &Runtime) -> Result<(), String> {
        manager(|manager| unsafe {
            if manager.GetWindowDesktopId(hwnd(rt)).map_err(|e| e.to_string())? != target(rt)
                || manager.IsWindowOnCurrentVirtualDesktop(hwnd(rt)).map_err(|e| e.to_string())?.as_bool() {
                return Err("background desktop isolation was lost".into());
            }
            Ok(())
        })
    }

    pub(super) fn visible_and_restored(rt: &Runtime) -> bool {
        unsafe { IsWindowVisible(hwnd(rt)).as_bool() && !IsIconic(hwnd(rt)).as_bool() }
    }

    fn current_status(rt: &Runtime, phase: &str) -> Result<Value, String> {
        verify_guard(rt)?;
        manager(|manager| unsafe {
            let own = hwnd(rt);
            let status = json!({
                "phase": phase,
                "disabled": !IsWindowEnabled(own).as_bool() && GetWindowLongPtrW(own, GWL_STYLE) as u32 & WS_DISABLED.0 != 0,
                "noActivate": GetWindowLongPtrW(own, GWL_EXSTYLE) as u32 & WS_EX_NOACTIVATE.0 != 0,
                "visible": IsWindowVisible(own).as_bool(),
                "minimized": IsIconic(own).as_bool(),
                "onTargetDesktop": manager.GetWindowDesktopId(own).map_err(|e| e.to_string())? == target(rt),
                "onCurrentDesktop": manager.IsWindowOnCurrentVirtualDesktop(own).map_err(|e| e.to_string())?.as_bool(),
                "checkedAt": background_now()
            });
            if !guard_proven(&status) { return Err("background native guard proof is incomplete".into()); }
            Ok(status)
        })
    }

    pub(super) fn snapshot(rt: &Runtime, phase: &str) -> Result<Value, String> {
        let status = current_status(rt, phase)?;
        if !barrier_proven(&status) { return Err("background native window barrier is incomplete".into()); }
        Ok(status)
    }

    pub(super) fn health_snapshot(rt: &Runtime) -> Result<Value, String> {
        current_status(rt, "shown")
    }

    pub(super) fn hide_owned(rt: &Runtime) {
        let own = hwnd(rt);
        let mut pid = 0;
        unsafe {
            let owner_thread = GetWindowThreadProcessId(own, Some(&mut pid));
            if pid == std::process::id() && IsWindow(Some(own)).as_bool() {
                if owner_thread == GetCurrentThreadId() {
                    let _ = EnableWindow(own, false);
                    let _ = ShowWindow(own, SW_HIDE);
                } else {
                    let _ = ShowWindowAsync(own, SW_HIDE);
                }
            }
        }
    }
}

fn guard_proven(status: &Value) -> bool {
    status["disabled"] == true && status["noActivate"] == true && status["visible"].is_boolean()
        && status["minimized"].is_boolean() && status["onTargetDesktop"] == true
        && status["onCurrentDesktop"] == false
}

fn barrier_proven(status: &Value) -> bool {
    let minimized = match status["phase"].as_str() {
        Some("placed") => true,
        Some("shown") => false,
        _ => return false,
    };
    guard_proven(status) && status["visible"] == true && status["minimized"] == minimized
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn background_guard_preserves_disabled_when_tao_rebuilds_style() {
        let maximized = 0x0100_0000;
        assert_eq!(retained_guard_style(maximized), maximized | 0x0800_0000);
        assert_eq!(retained_guard_style(0x0800_0000), 0x0800_0000);
    }

    #[test]
    fn background_guard_enforces_critical_state_before_downstream_callbacks() {
        use std::cell::Cell;
        let enabled = Cell::new(true);
        let result = dispatch_guard(GuardAction::Disable, || enabled.set(false), || {
            assert!(!enabled.get(), "downstream callbacks must observe a disabled HWND");
            7
        });
        assert_eq!(result, 7);
        let installed = Cell::new(true);
        dispatch_guard(GuardAction::Remove, || installed.set(false), || {
            assert!(!installed.get(), "remove the subclass before forwarding destruction");
        });
        let styles = Cell::new(0);
        dispatch_guard(GuardAction::RetainStyle, || styles.set(retained_guard_style(styles.get())), || {
            styles.set(0x0100_0000);
        });
        assert_eq!(styles.get(), 0x0900_0000, "retain guard bits after downstream style changes");
    }

    #[test]
    fn background_release_identity_cannot_be_reused_for_another_host() {
        let valid = json!({ "token": "fixture", "pid": 10, "hwnd": "0x20" });
        assert!(identity_matches(&valid, "fixture", 10, 32));
        assert!(!identity_matches(&valid, "old", 10, 32));
        assert!(!identity_matches(&valid, "fixture", 11, 32));
        assert!(!identity_matches(&valid, "fixture", 10, 33));
    }

    #[test]
    fn background_lease_uses_matching_boot_clock_and_exact_expiry() {
        let lease = json!({ "clockDomain": CLOCK_DOMAIN, "token": "fixture", "pid": 10,
            "hwnd": "0x20", "renewedAt": 10000 });
        assert!(lease_proven(&lease, "fixture", 10, 32, 10000));
        assert!(lease_proven(&lease, "fixture", 10, 32, 14999));
        assert!(!lease_proven(&lease, "fixture", 10, 32, 15000));
        assert!(!lease_proven(&lease, "fixture", 10, 32, 9999));
        for replacement in [json!({ "clockDomain": "wall-ms" }), json!({ "clockDomain": null }),
            json!({ "renewedAt": null }), json!({ "renewedAt": 0 }), json!({ "renewedAt": "10000" }),
            json!({ "token": "old" }), json!({ "pid": 11 }), json!({ "hwnd": "0x21" })] {
            let mut invalid = lease.clone();
            for (field, value) in replacement.as_object().unwrap() { invalid[field] = value.clone(); }
            assert!(!lease_proven(&invalid, "fixture", 10, 32, 10000));
        }
    }

    #[test]
    fn background_policy_rejects_ambiguous_or_path_like_tokens() {
        assert!(valid_guid("11111111-1111-1111-1111-111111111111"));
        for value in ["", "../release", "11111111111111111111111111111111", "zzzzzzzz-1111-1111-1111-111111111111"] {
            assert!(!valid_guid(value));
        }
    }

    #[test]
    fn background_barrier_requires_native_guard_and_exact_window_state() {
        let placed = json!({ "phase": "placed", "disabled": true, "noActivate": true,
            "visible": true, "minimized": true, "onTargetDesktop": true, "onCurrentDesktop": false });
        assert!(barrier_proven(&placed));
        for field in ["disabled", "noActivate", "visible", "minimized", "onTargetDesktop", "onCurrentDesktop"] {
            let mut missing = placed.clone();
            missing.as_object_mut().unwrap().remove(field);
            assert!(!barrier_proven(&missing), "missing {field}");
            let mut flipped = placed.clone();
            flipped[field] = json!(!placed[field].as_bool().unwrap());
            assert!(!barrier_proven(&flipped), "incorrect {field}");
        }
        let mut shown = placed.clone();
        shown["phase"] = json!("shown");
        assert!(!barrier_proven(&shown));
        shown["minimized"] = json!(false);
        assert!(barrier_proven(&shown));
        shown["phase"] = json!("showing");
        assert!(!barrier_proven(&shown));
    }

    #[test]
    fn background_health_proof_allows_product_minimize_after_release() {
        let mut status = json!({ "phase": "shown", "disabled": true, "noActivate": true,
            "visible": true, "minimized": true, "onTargetDesktop": true, "onCurrentDesktop": false });
        assert!(guard_proven(&status));
        assert!(!barrier_proven(&status));
        status["disabled"] = json!(false);
        assert!(!guard_proven(&status));
        status["disabled"] = json!(true);
        status["minimized"] = Value::Null;
        assert!(!guard_proven(&status));
    }
}
