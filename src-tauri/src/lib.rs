mod bubbles;
mod commands;
mod cursor;
mod hit_test;
#[cfg(debug_assertions)]
mod native_smoke;
mod platform;
mod quit;
mod window_labels;
mod window_tasks;

use std::sync::Arc;

use bubbles::{BubbleRegistry, Bubbles};
use commands::{
    close_bubble_window, close_pet_window, close_toast_window, focus_pet_panel,
    get_managed_window_instance, set_pet_hit_shape, set_self_visible, set_window_bounds,
    spawn_bubble_window, spawn_pet_window, spawn_toast_window,
};
use cursor::spawn_cursor_monitor;
use hit_test::HitShapes;
use platform::{
    configure_floating_overlay, configure_macos_app_activation_policy, set_dock_visible,
};

use tauri::{
    menu::{MenuBuilder, MenuItemBuilder, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Listener, Manager, Runtime,
};

#[derive(Debug, PartialEq, Eq)]
struct LoungeStartupBehavior {
    strip_decorations: bool,
    show: bool,
    focus: bool,
    show_dock_icon: bool,
}

fn lounge_startup_behavior() -> LoungeStartupBehavior {
    LoungeStartupBehavior {
        strip_decorations: cfg!(target_os = "windows"),
        show: true,
        focus: true,
        show_dock_icon: true,
    }
}

/// 显示并聚焦会客厅窗口（托盘左键 / 菜单共用）。
fn open_lounge<R: Runtime>(app: &AppHandle<R>) {
    if let Some(w) = app.get_webview_window("lounge") {
        let _ = w.show();
        let _ = w.set_focus();
        let _ = w.emit("lounge-refresh", ());
        set_dock_visible(true);
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let hit_shapes: HitShapes = Arc::new(std::sync::Mutex::new(hit_test::HitRegistry::default()));
    let monitor_hit_shapes = hit_shapes.clone();
    let bubbles: Bubbles = Arc::new(std::sync::Mutex::new(BubbleRegistry::default()));
    tauri::Builder::default()
        // 开机自启动（会客厅设置页「通用 → 开机自启动」开关控制）。
        // macOS 走 LaunchAgent，Windows 走注册表，由插件按平台封装。
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .manage(hit_shapes)
        .manage(bubbles)
        .manage(window_tasks::WindowInstances::default())
        .manage(quit::QuitState::default())
        .invoke_handler(tauri::generate_handler![
            set_window_bounds,
            set_self_visible,
            get_managed_window_instance,
            focus_pet_panel,
            spawn_pet_window,
            close_pet_window,
            spawn_bubble_window,
            close_bubble_window,
            spawn_toast_window,
            close_toast_window,
            set_pet_hit_shape
        ])
        .setup(move |app| {
            configure_macos_app_activation_policy(app);
            // `main` 不再承载记号棒 textarea（已搬进自己的气泡窗口 bubble-self），
            // 因此无需提升为 key-capable 的 NSPanel：走普通浮动覆盖层即可。这让 `main`
            // 配合 acceptFirstMouse 修复 first-mouse 拖动 bug（失焦后第一次左键直接派发
            // 到 webview，不再被 panel 的 becomesKeyOnlyIfNeeded 语义吞掉）。见 ADR-0014。
            // panel 提升改由 bubble-self 在 spawn 时按 is_self 承担。
            if let Some(window) = app.get_webview_window("main") {
                configure_floating_overlay(&window);
            }
            spawn_cursor_monitor(app, monitor_hit_shapes);

            let lounge_startup = lounge_startup_behavior();

            if lounge_startup.show_dock_icon {
                set_dock_visible(true);
            }

            // On Windows: strip decorations while the window is still hidden. The frontend
            // still resizes for the custom title bar, but Rust owns first display so startup
            // cannot remain hidden if frontend initialization is delayed or fails.
            if let Some(lounge) = app.get_webview_window("lounge") {
                if lounge_startup.strip_decorations {
                    let _ = lounge.set_decorations(false);
                }
                if lounge_startup.show {
                    let _ = lounge.show();
                }
                if lounge_startup.focus {
                    let _ = lounge.set_focus();
                }
            }

            // 登录成功：通知 Pet 窗口初始化（不自动显示，进房间时由前端控制）
            let handle = app.handle().clone();
            app.listen("auth-ready", move |_| {
                let h = handle.clone();
                let inner = h.clone();
                let _ = h.run_on_main_thread(move || {
                    if let Some(w) = inner.get_webview_window("main") {
                        let _ = w.emit("pet-init", ());
                    }
                });
            });

            // 退出登录：隐藏 Pet 窗口，显示会客厅
            let handle2 = app.handle().clone();
            app.listen("auth-cleared", move |_| {
                let h = handle2.clone();
                let inner = h.clone();
                let _ = h.run_on_main_thread(move || {
                    for label in ["bubble-self", "main"] {
                        if let Some(w) = inner.get_webview_window(label) {
                            let _ = w.hide();
                        }
                    }
                    if let Some(w) = inner.get_webview_window("lounge") {
                        let _ = w.show();
                        let _ = w.set_focus();
                        set_dock_visible(true);
                    }
                });
            });

            // 前端进入房间时会隐藏 Lounge 窗口并发出此事件
            let handle3 = app.handle().clone();
            app.listen("lounge-hidden", move |_| {
                let h = handle3.clone();
                let _ = h.run_on_main_thread(move || {
                    set_dock_visible(false);
                });
            });

            // 用户点击 Lounge 窗口的关闭按钮时，隐藏而不是销毁，并收起 Dock 图标
            if let Some(lounge) = app.get_webview_window("lounge") {
                let lounge_clone = lounge.clone();
                lounge.on_window_event(move |event| {
                    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        let _ = lounge_clone.hide();
                        set_dock_visible(false);
                    }
                });
            }

            // 托盘菜单分两区：会客厅 / 房间聊天记录 ── 分隔线 ── 退出。
            let manage = MenuItemBuilder::with_id("open-lounge", "会客厅").build(app)?;
            let room_history =
                MenuItemBuilder::with_id("room-history", "房间聊天记录").build(app)?;
            let separator = PredefinedMenuItem::separator(app)?;
            let quit = MenuItemBuilder::with_id("quit", "退出").build(app)?;
            let menu = MenuBuilder::new(app)
                .items(&[&manage, &room_history, &separator, &quit])
                .build()?;
            let _tray = TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("GoodPuppy")
                .menu(&menu)
                // 左键直接打开会客厅；右键弹出菜单。
                .show_menu_on_left_click(false)
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        open_lounge(tray.app_handle());
                    }
                })
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "open-lounge" => open_lounge(app),
                    "room-history" => {
                        open_lounge(app);
                        if let Some(w) = app.get_webview_window("lounge") {
                            let _ = w.emit("open-room-history", ());
                        }
                    }
                    "quit" => {
                        app.exit(0);
                    }
                    _ => {}
                })
                .build(app)?;
            #[cfg(debug_assertions)]
            if std::env::var("GOODPUPPY_NATIVE_SMOKE").as_deref() == Ok("1")
                && app.config().identifier == "com.goodpuppy.desktop.native-smoke"
            {
                native_smoke::start(app.handle().clone());
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let tauri::RunEvent::ExitRequested { api, code, .. } = event {
                // Tauri 的 restart 不允许 prevent_exit；本项目不调用 restart。
                if code == Some(tauri::RESTART_EXIT_CODE) {
                    return;
                }
                if !app.state::<quit::QuitState>().allowed() {
                    api.prevent_exit();
                    quit::request(app, code.unwrap_or(0));
                }
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn startup_lounge_is_visible_and_focused() {
        let behavior = lounge_startup_behavior();

        assert!(behavior.show);
        assert!(behavior.focus);
        assert!(behavior.show_dock_icon);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn startup_lounge_strips_system_decorations_on_windows() {
        let behavior = lounge_startup_behavior();

        assert!(behavior.strip_decorations);
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn startup_lounge_keeps_system_decorations_off_windows() {
        let behavior = lounge_startup_behavior();

        assert!(!behavior.strip_decorations);
    }
}
