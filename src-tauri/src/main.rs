// ZTerm — Tauri 主进程

// GUI subsystem: 避免控制台程序启动时触发系统默认终端 (Windows Terminal)
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
        ])
        .setup(|app| {
            // 注册全局 AppHandle（config-corrupted 等事件 emit 用）
            zterm::init_app_handle(app.handle());
            // 数据目录迁移：默认目录(打包版=安装目录/data)无 config 且锚点有 → 复制
            zterm::migrate_legacy_config();
            // 手动创建主窗口（tauri.conf.json 的 windows 已清空）:
            // enable_clipboard_access 让 wry 注册 WebView2 PermissionRequested handler，
            // 自动允许 CLIPBOARD_READ —— 否则每次 navigator.clipboard.readText()
            // （右键粘贴）都会弹系统原生权限气泡，与 ZTerm 暗色 UI 风格不一致
            let window = tauri::WebviewWindowBuilder::new(
                app,
                "main",
                tauri::WebviewUrl::App("renderer.html".into()),
            )
            .title("ZTerm")
            .inner_size(1100.0, 720.0)
            .min_inner_size(600.0, 400.0)
            .decorations(false)
            // 窗口/WebView 背景色与主题一致（#21252b）：resize 拖拽期间
            // WebView 内容未覆盖到的边缘露出默认白色会形成闪烁
            .background_color(tauri::window::Color(33, 37, 43, 255))
            .enable_clipboard_access()
            .build()?;

            // 恢复上次关闭时的窗口状态（位置/大小/最大化，与 Tabby 一致）
            if let Some(ws) = zterm::load_window_state() {
                if zterm::window_position_visible(ws.x, ws.y, ws.width, ws.height, &window) {
                    let _ = window.set_position(tauri::PhysicalPosition::new(ws.x, ws.y));
                    let _ = window.set_size(tauri::PhysicalSize::new(ws.width, ws.height));
                }
                if ws.maximized {
                    let _ = window.maximize();
                }
            }

            #[cfg(debug_assertions)]
            {
                window.open_devtools();
            }
            // 关闭前通知 renderer 保存状态；同时保存窗口状态（位置/大小/最大化）
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
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
