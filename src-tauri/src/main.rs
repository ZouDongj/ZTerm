// ZTerm — Tauri main process

// GUI subsystem: avoid starting as a console app, which would open in the system default terminal (Windows Terminal)
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod zterm;

use serde_json::json;
use std::sync::Arc;
use tauri::Emitter;

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
            zterm::encrypt_password,
            zterm::register_credential,
            zterm::revoke_credential,
            zterm::quit_ready,
            zterm::clipboard_write_text,
            zterm::clipboard_read_text,
            zterm::renderer_ready,
        ])
        .setup(|app| {
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
            .decorations(false)
            // Stay hidden until the window state is restored — otherwise the window
            // flashes at the default size, then jumps from windowed to maximized
            .visible(false)
            // Disable WebView2 form autofill (the white suggestion popup shown while typing);
            // a terminal has no use for browser-style autofill
            .general_autofill_enabled(false)
            // Match the window/WebView background to the theme (#21252b): during
            // resize drags, edges not yet covered by WebView content would flash default white
            .background_color(tauri::window::Color(33, 37, 43, 255))
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

            #[cfg(windows)]
            disable_browser_accelerator_keys(&window);

            // Window-state restore + show live in the renderer_ready command: the
            // renderer asks the main process to show the window only after it has
            // loaded and registered its window-shown listener — an earlier emit would strand the splash screen
            #[cfg(debug_assertions)]
            {
                window.open_devtools();
            }
            // On close, notify the renderer to save state; also save the window state (position/size/maximized)
            let handle = app.handle().clone();
            let win_for_state = window.clone();
            window.on_window_event(move |event| {
                if let tauri::WindowEvent::CloseRequested { .. } = event {
                    if let (Ok(pos), Ok(size)) =
                        (win_for_state.outer_position(), win_for_state.outer_size())
                    {
                        zterm::save_window_state(&zterm::WindowState {
                            x: pos.x,
                            y: pos.y,
                            width: size.width,
                            height: size.height,
                            maximized: win_for_state.is_maximized().unwrap_or(false),
                        });
                    }
                    let _ = handle.emit("app-before-quit", json!({}));
                }
            });
            // Fallback: if renderer init fails or crashes, renderer-ready never fires and the
            // window stays hidden forever — if still invisible after 5s, force-show and re-emit
            // window-shown (normally is_visible is already true here, so this skips; no double fade-in)
            let win_fallback = window.clone();
            let app_fallback = app.handle().clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_secs(5));
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
