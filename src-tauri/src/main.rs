// ZTerm — Tauri main process

// GUI subsystem: avoid starting as a console app, which would open in the system default terminal (Windows Terminal)
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod update_http;
mod execution_trust;
mod zterm;
mod background_e2e;

use serde_json::json;
use std::sync::Arc;
use tauri::Emitter;

/// Last-resort cap on the graceful-quit wait. Shutdown is completion-driven:
/// the renderer answers app-before-quit with quit-ready as soon as its final
/// save lands (see quit_ready, which exits immediately), so this timer only
/// fires when the renderer is hung or already gone. Sized so a slow final
/// save (large scrollback payloads on a busy disk) still finishes; the
/// previous fixed 3s abandoned such saves mid-write.
const QUIT_FORCE_EXIT_SECS: u64 = 15;

#[tokio::main]
async fn main() {
    let session_map: zterm::SessionMap =
        Arc::new(parking_lot::Mutex::new(std::collections::HashMap::new()));
    let cred_store: zterm::CredentialStore =
        Arc::new(parking_lot::Mutex::new(std::collections::HashMap::new()));
    let key_decisions: zterm::KeyDecisionMap =
        Arc::new(parking_lot::Mutex::new(std::collections::HashMap::new()));
    let pending_conns: zterm::PendingMap =
        Arc::new(parking_lot::Mutex::new(std::collections::HashMap::new()));
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(session_map)
        .manage(cred_store)
        .manage(key_decisions)
        .manage(pending_conns)
        .invoke_handler(tauri::generate_handler![
            zterm::get_profiles,
            zterm::prepare_execution,
            zterm::decide_execution,
            zterm::cancel_execution,
            zterm::pty_create,
            zterm::pty_input,
            zterm::pty_diagnostics,
            zterm::pty_resize,
            zterm::pty_destroy,
            zterm::ssh_connect,
            zterm::ssh_disconnect,
            zterm::ssh_hostkey_decision,
            zterm::save_last_tabs,
            zterm::save_appearance,
            zterm::window_minimize,
            zterm::window_maximize,
            zterm::window_close,
            zterm::get_quick_commands,
            zterm::save_quick_commands,
            zterm::get_highlight_rules,
            zterm::save_highlight_rules,
            zterm::save_terminal_settings,
            zterm::save_ssh_profiles,
            zterm::save_shortcuts,
            zterm::get_local_shells,
            zterm::load_settings,
            zterm::get_data_dir_info,
            zterm::set_data_dir,
            zterm::get_about_info,
            zterm::check_update,
            zterm::download_update,
            zterm::update_download_state,
            zterm::apply_update,
            zterm::open_url,
            zterm::get_system_fonts,
            zterm::show_open_dialog,
            zterm::show_save_dialog,
            zterm::sftp_open,
            zterm::sftp_readdir,
            zterm::sftp_mkdir,
            zterm::sftp_download,
            zterm::sftp_upload,
            zterm::sftp_cancel_transfer,
            zterm::open_in_explorer,
            zterm::local_path_stat,
            zterm::encrypt_password,
            zterm::register_credential,
            zterm::revoke_credential,
            zterm::quit_ready,
            zterm::cancel_quit,
            zterm::clipboard_write_text,
            zterm::clipboard_read_text,
            zterm::renderer_ready,
        ])
        .setup(|app| {
            background_e2e::configure().map_err(std::io::Error::other)?;
            // Register the global AppHandle (used to emit events such as config-corrupted)
            zterm::init_app_handle(app.handle());
            // Data dir migration: if the default dir (packaged build = install dir/data) has no config but the anchor location does, copy it
            zterm::migrate_legacy_config();
            // Create the main window manually (tauri.conf.json's windows list is empty):
            // enable_clipboard_access makes wry register a WebView2 PermissionRequested
            // handler that auto-allows CLIPBOARD_READ — otherwise every
            // navigator.clipboard.readText() (right-click paste) pops a native permission bubble that clashes with ZTerm's dark UI
            let window = tauri::WebviewWindowBuilder::new(
                app,
                "main",
                tauri::WebviewUrl::App("renderer.html".into()),
            )
            .title("ZTerm")
            .inner_size(1100.0, 720.0)
            .min_inner_size(600.0, 400.0)
            // ZTerm has a single dark appearance. Pin the window theme so a
            // light Windows app mode cannot make the window chrome light
            // behind the white-on-dark UI.
            .theme(Some(tauri::Theme::Dark))
            .decorations(false)
            // Opaque window: the Ink material is painted by the renderer.
            // No DWM Mica backdrop and no transparent HWND composition is
            // used, so every frame stays on the ordinary opaque present path.
            .transparent(false)
            // Stay hidden until the window state is restored — otherwise the window
            // flashes at the default size, then jumps from windowed to maximized
            .visible(false)
            .focused(!background_e2e::enabled())
            .focusable(!background_e2e::enabled())
            // Disable WebView2 form autofill (the white suggestion popup shown while typing);
            // a terminal has no use for browser-style autofill
            .general_autofill_enabled(false)
            // The opaque window surface matches the Ink material base; the
            // renderer paints the detailed material on top of it.
            .background_color(tauri::window::Color(24, 27, 34, 255))
            .enable_clipboard_access()
            // Disable LCD subpixel text antialiasing so every piece of UI text
            // (tabs, menus, settings, status bar) renders with grayscale AA —
            // matching the terminal canvas, whose glyph atlas is an alpha
            // canvas and therefore already grayscale. Keeps Tauri's default
            // WebView2 feature disables (explicit args replace the defaults).
            .additional_browser_args(
                "--disable-lcd-text --disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection",
            )
            // ZTerm owns every key combo itself: its own Ctrl+F search,
            // Ctrl+P palette and Ctrl+Shift+I sync-input collide with the
            // browser find/print/devtools UI that WebView2 answers before
            // the page. zoom_hotkeys=false pins wry's default off so a tauri
            // upgrade cannot silently re-enable Ctrl+wheel / Ctrl+± UI zoom;
            // devtools stays on in debug builds for open_devtools.
            // The remaining browser accelerators (F5, Ctrl+R, Ctrl+J
            // downloads popup, browser back/forward, F12) are disabled
            // below via ICoreWebView2Settings3 once the webview exists.
            .zoom_hotkeys_enabled(false)
            .devtools(cfg!(debug_assertions))
            .build()?;

            background_e2e::install(&window, app.handle()).map_err(std::io::Error::other)?;

            #[cfg(windows)]
            disable_browser_accelerator_keys(&window);

            // Window-state restore + show live in the renderer_ready command: the
            // renderer asks the main process to show the window only after it has
            // loaded and registered its window-shown listener — an earlier emit would strand the splash screen
            #[cfg(debug_assertions)]
            {
                if !background_e2e::enabled() { window.open_devtools(); }
            }
            // On close, notify the renderer to save state; also save the window state (position/size/maximized)
            let handle = app.handle().clone();
            let win_for_state = window.clone();
            // Quit attempts are generation-based (zterm::begin_quit): later close
            // requests (repeated Alt+F4) only re-prevent while an attempt is
            // active; cancelling a failed save or retrying invalidates older
            // watchdog tokens instead of leaving a latched quit flag.
            window.on_window_event(move |event| {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    let maximized = win_for_state.is_maximized().unwrap_or(false);
                    // A maximized window's outer rect is the monitor-filling
                    // one; persisting it would lose the normal rect, so a
                    // maximize→close→restart cycle could never unmaximize back
                    // to the previous size. Persist the pre-maximize rect
                    // alongside the maximized flag; the restore side sets the
                    // rect first and then maximizes on top of it.
                    let rect = if maximized {
                        normal_window_rect(&win_for_state).or_else(|| outer_rect(&win_for_state))
                    } else {
                        outer_rect(&win_for_state)
                    };
                    if let Some((x, y, width, height)) = rect {
                        // Closing while minimized must keep the last valid state (see minimized_at_close)
                        if !minimized_at_close(
                            win_for_state.is_minimized().unwrap_or(false),
                            x,
                            y,
                        ) {
                            zterm::save_window_state(&zterm::WindowState {
                                x,
                                y,
                                width,
                                height,
                                maximized,
                            });
                        }
                    }
                    // Hold the window open until the renderer's final save hits
                    // disk: without prevent_close, tao destroys the window and
                    // WebView as soon as this handler returns, so the renderer's
                    // async saveConfig could never finish (quit_ready stayed
                    // dead code) and the last <15s of tab state was lost on
                    // Alt+F4/taskbar close. The renderer answers app-before-quit
                    // with quit-ready (which exits the process); if the renderer
                    // is hung or already gone, the timer force-exits so the
                    // window can never become unclosable.
                    api.prevent_close();
                    if let Some(generation) = zterm::begin_quit() {
                        let _ = handle.emit("app-before-quit", json!({}));
                        std::thread::spawn(move || {
                            std::thread::sleep(std::time::Duration::from_secs(
                                QUIT_FORCE_EXIT_SECS,
                            ));
                            // Exit only while this attempt is still active: a
                            // cancelled save or a retry invalidates the token,
                            // so a stale watchdog cannot kill the process.
                            if zterm::quit_force_exit_pending(generation) {
                                std::process::exit(0);
                            }
                        });
                    }
                }
            });
            // Fallback: if renderer init fails or crashes, renderer-ready never fires and the
            // window stays hidden forever — if still invisible after 5s, force-show and re-emit
            // window-shown (normally is_visible is already true here, so this skips; no double fade-in)
            let win_fallback = window.clone();
            let app_fallback = app.handle().clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_secs(5));
                if background_e2e::enabled() { return; }
                match win_fallback.is_visible() {
                    Ok(false) | Err(_) => {
                        let _ = win_fallback.show();
                        let _ = app_fallback.emit("window-shown", json!({}));
                    }
                    Ok(true) => {}
                }
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// Turn off every WebView2 accelerator key that opens browser UI instead of
/// reaching the page (Ctrl+F find, Ctrl+P print, Ctrl+R/F5 reload, Ctrl+J
/// downloads popup, F12, browser back/forward/search keys). With them off,
/// the key events fall through to the page untouched, so ZTerm's own
/// shortcuts always win. Failure is logged and non-fatal: the app still
/// works, it just keeps the browser keys.
#[cfg(windows)]
fn disable_browser_accelerator_keys(window: &tauri::WebviewWindow) {
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Settings3;
    use windows_core::Interface;

    let dispatch = window.with_webview(|webview| unsafe {
        let applied = webview
            .controller()
            .CoreWebView2()
            .and_then(|core| core.Settings())
            .and_then(|settings| settings.cast::<ICoreWebView2Settings3>())
            .and_then(|s3| s3.SetAreBrowserAcceleratorKeysEnabled(false));
        if let Err(e) = applied {
            eprintln!("[zterm] disable browser accelerator keys failed: {e}");
        }
    });
    if let Err(e) = dispatch {
        eprintln!("[zterm] with_webview dispatch failed: {e}");
    }
}

/// Whether the geometry captured at close time must NOT overwrite the saved
/// window state: a minimized window reports Windows' (-32000, -32000) sentinel
/// position and `is_maximized() == false`, so saving it would wipe the last
/// valid position/size/maximized. The sentinel check also covers the case
/// where the is_minimized query itself fails. Pure function for unit tests.
fn minimized_at_close(is_minimized: bool, x: i32, y: i32) -> bool {
    is_minimized || (x <= -32000 && y <= -32000)
}

/// The window's current outer rect as (x, y, width, height); None when either
/// query fails (same tolerance as the previous inline check).
fn outer_rect(window: &tauri::WebviewWindow) -> Option<(i32, i32, u32, u32)> {
    match (window.outer_position(), window.outer_size()) {
        (Ok(pos), Ok(size)) => Some((pos.x, pos.y, size.width, size.height)),
        _ => None,
    }
}

/// Convert WINDOWPLACEMENT's rcNormalPosition (left/top/right/bottom) into
/// the (x, y, width, height) shape save_window_state persists. Extents are
/// clamped to at least 1 so a degenerate rect can never persist a zero-sized
/// window. Pure function for unit tests.
fn normal_rect_from_placement(left: i32, top: i32, right: i32, bottom: i32) -> (i32, i32, u32, u32) {
    (
        left,
        top,
        (right - left).max(1) as u32,
        (bottom - top).max(1) as u32,
    )
}

/// The window's normal (restored) rect even while maximized: Windows keeps it
/// in WINDOWPLACEMENT.rcNormalPosition, while outer_position/outer_size only
/// report the current monitor-filling rect. None when the query fails.
#[cfg(windows)]
fn normal_window_rect(window: &tauri::WebviewWindow) -> Option<(i32, i32, u32, u32)> {
    use winapi::um::winuser::{GetWindowPlacement, WINDOWPLACEMENT};
    let hwnd = window.hwnd().ok()?;
    let mut placement: WINDOWPLACEMENT = unsafe { std::mem::zeroed() };
    placement.length = std::mem::size_of::<WINDOWPLACEMENT>() as u32;
    let ok = unsafe {
        GetWindowPlacement(
            hwnd.0 as winapi::shared::windef::HWND,
            &mut placement,
        )
    };
    if ok == 0 {
        return None;
    }
    let rc = placement.rcNormalPosition;
    Some(normal_rect_from_placement(
        rc.left, rc.top, rc.right, rc.bottom,
    ))
}

/// Non-Windows builds have no normal-rect side channel; the caller falls back
/// to the current outer rect.
#[cfg(not(windows))]
fn normal_window_rect(_window: &tauri::WebviewWindow) -> Option<(i32, i32, u32, u32)> {
    None
}

#[cfg(test)]
mod tests {
    use super::{minimized_at_close, normal_rect_from_placement};

    #[test]
    fn normal_placement_is_saved() {
        // On-screen and multi-monitor negative-axis positions are real placements.
        assert!(!minimized_at_close(false, 100, 100));
        assert!(!minimized_at_close(false, -1919, 0));
        assert!(!minimized_at_close(false, -1919, -1079));
        // One axis alone at the sentinel value is still a valid placement.
        assert!(!minimized_at_close(false, -32000, 100));
        assert!(!minimized_at_close(false, 100, -32000));
    }

    #[test]
    fn minimized_close_keeps_last_valid_state() {
        // IsIconic is true as soon as the window is minimized, even before the
        // OS parks it at the sentinel position.
        assert!(minimized_at_close(true, 100, 100));
        // Windows parks minimized windows at (-32000, -32000).
        assert!(minimized_at_close(false, -32000, -32000));
        assert!(minimized_at_close(false, -40000, -32001));
    }

    #[test]
    fn normal_rect_converts_left_top_right_bottom() {
        assert_eq!(normal_rect_from_placement(100, 50, 1100, 770), (100, 50, 1000, 720));
        // Negative-axis positions (secondary monitors) survive unchanged.
        assert_eq!(
            normal_rect_from_placement(-1919, -1079, -1, -1),
            (-1919, -1079, 1918, 1078)
        );
    }

    #[test]
    fn normal_rect_clamps_degenerate_extents() {
        // A zero/inverted rect must never persist a zero-sized window.
        assert_eq!(normal_rect_from_placement(10, 10, 10, 10), (10, 10, 1, 1));
        assert_eq!(normal_rect_from_placement(10, 10, 5, 5), (10, 10, 1, 1));
    }
}
