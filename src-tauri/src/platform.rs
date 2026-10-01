//! 原生平台窗口原语（macOS AppKit / Windows）。
//!
//! 所有 objc2 / windows-sys FFI 与 `#[cfg(target_os = ...)]` 平台分支集中在此，
//! 对外暴露跨平台的薄封装函数；其余模块只调用这些函数，不直接接触系统 API。
//! 见 `docs/adr/0004-前端-webview-承担业务逻辑.md`（Rust 主进程保持薄层）。

use tauri::{Runtime, WebviewWindow};

#[cfg(target_os = "macos")]
use objc2::{define_class, ClassType};
#[cfg(target_os = "macos")]
use objc2_app_kit::{
    NSPanel, NSWindow, NSWindowAnimationBehavior, NSWindowOrderingMode, NSWindowStyleMask,
};

// A borderless (decorationless) window returns NO from -canBecomeKeyWindow by
// default, so makeKeyAndOrderFront cannot make it key and its HTML text inputs
// never receive keystrokes. Subclass NSPanel and force -canBecomeKeyWindow to
// YES; promoting to a non-activating panel lets the window take key focus for the
// compose textarea WITHOUT activating the whole app. The subclass adds no ivars,
// so swapping an existing NSWindow instance to it via object_setClass keeps the
// instance layout identical. Only the never-destroyed `bubble-self` window is
// promoted (see configure_self_panel) — `main`, remote pets and remote bubbles
// stay plain so they can be destroyed safely (and so `main` gets first-mouse).
#[cfg(target_os = "macos")]
define_class!(
    #[unsafe(super(NSPanel))]
    #[name = "GoodPuppyPanel"]
    struct GoodPuppyPanel;

    impl GoodPuppyPanel {
        #[unsafe(method(canBecomeKeyWindow))]
        fn can_become_key_window(&self) -> bool {
            true
        }
    }
);

// NSPopUpMenuWindowLevel (101) — the same level Electron uses for always-on-top panel windows.
// A high but non-accessibility level: using 1500 (CGAssistiveTechHighWindowLevel) made the window
// manager treat the window as an accessibility overlay, breaking Space membership on some macOS
// versions. Floats above ordinary windows; it does not (and is not meant to) overlay fullscreen apps.
#[cfg(target_os = "macos")]
const NS_POPUP_MENU_WINDOW_LEVEL: objc2_app_kit::NSWindowLevel = 101;

/// Run an AppKit closure, catching any Objective-C exception it raises.
///
/// Window-teardown races (leave-room destroys overlay windows while the cursor
/// monitor / layout still touch them) can make an AppKit call raise an
/// NSException. A foreign exception unwinding through Rust aborts the whole
/// process (`fatal runtime error: Rust cannot catch foreign exceptions`). Catch
/// it at the FFI boundary so the race degrades to a logged no-op instead.
#[cfg(target_os = "macos")]
pub(crate) fn guard_appkit<R>(op: &str, f: impl FnOnce() -> R) -> Option<R> {
    use std::panic::AssertUnwindSafe;
    match objc2::exception::catch(AssertUnwindSafe(f)) {
        Ok(value) => Some(value),
        Err(exception) => {
            log::warn!("AppKit exception caught during {op}: {exception:?}");
            None
        }
    }
}

/// Apply the floating desktop-pet overlay traits to a plain window:
/// - float above ordinary windows (a high but non-accessibility level),
/// - stay visible when another app is focused (`hidesOnDeactivate` off),
/// - never get hidden by Hide Others (`canHide` off),
/// - no Space-switch animation.
///
/// Deliberately NOT a panel and NOT joining all Spaces / fullscreen: GoodPuppy is
/// a desktop pet that does not overlay fullscreen apps. This keeps the window a
/// vanilla Tauri NSWindow, so dynamically spawned pet windows can be destroyed via
/// the standard path without the NSPanel-teardown crash (see `close_pet_window`).
#[cfg(target_os = "macos")]
pub(crate) fn configure_floating_overlay<R: Runtime>(window: &WebviewWindow<R>) {
    let Ok(ns_window_ptr) = window.ns_window() else {
        return;
    };
    let ns_window: &NSWindow = unsafe { &*ns_window_ptr.cast() };
    ns_window.setLevel(NS_POPUP_MENU_WINDOW_LEVEL);
    ns_window.setHidesOnDeactivate(false);
    ns_window.setCanHide(false);
    ns_window.setAnimationBehavior(NSWindowAnimationBehavior::None);
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn configure_floating_overlay<R: Runtime>(_window: &WebviewWindow<R>) {}

/// Configure the self bubble window (`bubble-self`), which hosts the compose
/// textarea. A borderless NSWindow returns NO from -canBecomeKeyWindow, so its
/// text input never receives keystrokes; promote it to a non-activating NSPanel
/// (`GoodPuppyPanel` overrides -canBecomeKeyWindow → YES) so typing works without
/// activating the whole app (Spotlight style).
///
/// Only `bubble-self` is promoted, and like `main` it lives for the entire session
/// (hidden, never destroyed) so it never hits the panel-teardown abort. Every other
/// overlay (`main`, remote pets, remote bubbles) stays a plain floating window via
/// `configure_floating_overlay` — destroyable safely, and `main` plain also restores
/// first-mouse dragging.
#[cfg(target_os = "macos")]
pub(crate) fn configure_self_panel<R: Runtime>(window: &WebviewWindow<R>) {
    let Ok(ns_window_ptr) = window.ns_window() else {
        return;
    };
    let ns_window: &NSWindow = unsafe { &*ns_window_ptr.cast() };

    // objc2::ffi::object_setClass swaps the isa pointer. NSPanel has no extra ivars
    // versus NSWindow, so the instance layouts are identical (objc2 asserts size
    // equality in debug builds). Same technique Electron's ElectronNSPanel uses.
    unsafe {
        let panel_class = GoodPuppyPanel::class();
        objc2::ffi::object_setClass(
            ns_window as *const NSWindow as *mut objc2::runtime::AnyObject,
            panel_class,
        );
    }

    let ns_panel: &NSPanel = unsafe { &*ns_window_ptr.cast() };
    ns_panel.setFloatingPanel(true);
    ns_panel.setBecomesKeyOnlyIfNeeded(true);
    ns_window.setStyleMask(ns_window.styleMask() | NSWindowStyleMask::NonactivatingPanel);

    configure_floating_overlay(window);
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn configure_self_panel<R: Runtime>(_window: &WebviewWindow<R>) {}

/// Make `child` a native macOS child window of `parent`, ordered above it. This
/// keeps the bubble z-ordered above its pet and stacked together across Spaces /
/// window-server reordering, and moves it in lockstep during programmatic
/// `setFrame:`. It does NOT, however, move the child during a native drag's
/// `performWindowDragWithEvent:` modal loop (AppKit keeps the child attached but
/// skips repositioning it until drag-end) — that live positioning is supplied by
/// `ensure_parent_follow_listener` reacting to the parent's `Moved` events.
#[cfg(target_os = "macos")]
pub(crate) fn add_child_window<R: Runtime>(
    parent: &WebviewWindow<R>,
    child: &WebviewWindow<R>,
) -> Result<(), String> {
    let (Ok(parent_ptr), Ok(child_ptr)) = (parent.ns_window(), child.ns_window()) else {
        return Err("parent or child native window is unavailable".into());
    };
    guard_appkit("add_child_window", || {
        let parent_ns: &NSWindow = unsafe { &*parent_ptr.cast() };
        let child_ns: &NSWindow = unsafe { &*child_ptr.cast() };
        unsafe { parent_ns.addChildWindow_ordered(child_ns, NSWindowOrderingMode::Above) };
    })
    .ok_or_else(|| "failed to attach child window".to_string())
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn add_child_window<R: Runtime>(
    _parent: &WebviewWindow<R>,
    _child: &WebviewWindow<R>,
) -> Result<(), String> {
}

/// Switches the macOS Dock icon on or off at runtime.
///
/// Policy 0 = NSApplicationActivationPolicyRegular (Dock icon shown).
/// Policy 1 = NSApplicationActivationPolicyAccessory (Dock icon hidden).
#[cfg(target_os = "macos")]
pub(crate) fn set_dock_visible(visible: bool) {
    let policy: isize = if visible { 0 } else { 1 };
    unsafe {
        let app: *mut objc2::runtime::AnyObject =
            objc2::msg_send![objc2::class!(NSApplication), sharedApplication];
        let _: () = objc2::msg_send![app, setActivationPolicy: policy];
    }
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn set_dock_visible(_visible: bool) {}

#[cfg(target_os = "macos")]
pub(crate) fn configure_macos_app_activation_policy(app: &mut tauri::App) {
    app.set_activation_policy(tauri::ActivationPolicy::Accessory);
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn configure_macos_app_activation_policy(_app: &mut tauri::App) {}

/// Resize and reposition a window atomically (single IPC round-trip → single
/// runloop tick → one paint). Setting size and position via two separate JS
/// calls lets the compositor paint an intermediate frame with mismatched
/// geometry, which shows as the window flashing/jumping when the bubble stack
/// or compose stick grows the pet window upward. Size first, then position last
/// pins the final top-left on both macOS and Windows.
/// Apply position + size to an overlay window. MUST be called on the main thread.
///
/// macOS: a single -[NSWindow setFrame:display:] call. Doing set_size +
/// set_position separately flashes when the stack grows the window upward:
/// -setContentSize: keeps the TOP-LEFT fixed (window grows DOWNWARD, moving the
/// bottom-anchored pet down), then -setFrameOrigin: moves it back — the
/// compositor catches that two-step. setFrame: applies the final geometry in one
/// shot with the Cocoa bottom-left origin anchored, so the pet never moves.
///
/// The Cocoa Y flip uses the height of the zero-origin screen (`screens[0]`, the
/// one holding the menu bar), which is the global Cocoa coordinate origin. Tauri
/// logical coordinates share a single global system anchored at the primary
/// screen's top-left, so this conversion is correct for windows on any monitor.
pub(crate) fn position_overlay_window<R: Runtime>(
    window: &WebviewWindow<R>,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        use objc2::MainThreadMarker;
        use objc2_app_kit::NSScreen;
        use objc2_foundation::{NSPoint, NSRect, NSSize};

        let Ok(ns_window_ptr) = window.ns_window() else {
            return Err("native window or main thread is unavailable".into());
        };
        let ns_window: &NSWindow = unsafe { &*ns_window_ptr.cast() };
        let Some(mtm) = MainThreadMarker::new() else {
            return Err("native window or main thread is unavailable".into());
        };
        let primary_height = NSScreen::screens(mtm)
            .firstObject()
            .map(|screen| screen.frame().size.height)
            .unwrap_or(0.0);
        // Tauri logical coords: origin at primary's TOP-left, Y down.
        // Cocoa: origin at primary's BOTTOM-left, Y up.
        let cocoa_y = primary_height - (y + height);
        let frame = NSRect::new(NSPoint::new(x, cocoa_y), NSSize::new(width, height));
        guard_appkit("set_frame", || ns_window.setFrame_display(frame, true))
            .ok_or_else(|| "failed to position native window".to_string())?;
    }

    #[cfg(not(target_os = "macos"))]
    {
        use tauri::{LogicalPosition, LogicalSize};
        window
            .set_size(LogicalSize::new(width, height))
            .map_err(|error| error.to_string())?;
        window
            .set_position(LogicalPosition::new(x, y))
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

/// 桌面坐标协议：Windows 位置使用全局物理像素，内容尺寸仍为逻辑像素。
pub(crate) fn position_desktop_overlay_window<R: Runtime>(
    window: &WebviewWindow<R>,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let monitor = window
            .available_monitors()
            .map_err(|error| error.to_string())?
            .into_iter()
            .min_by(|a, b| {
                let distance = |monitor: &tauri::Monitor| {
                    let origin = monitor.position();
                    let size = monitor.size();
                    let dx = (origin.x as f64 - x)
                        .max(0.0)
                        .max(x - (origin.x as f64 + size.width as f64));
                    let dy = (origin.y as f64 - y)
                        .max(0.0)
                        .max(y - (origin.y as f64 + size.height as f64));
                    dx * dx + dy * dy
                };
                distance(a).total_cmp(&distance(b))
            })
            .ok_or("target display is unavailable")?;
        let scale = monitor.scale_factor();
        window
            .set_position(tauri::PhysicalPosition::new(
                x.round() as i32,
                y.round() as i32,
            ))
            .map_err(|error| error.to_string())?;
        window
            .set_size(tauri::PhysicalSize::new(
                (width * scale).round() as u32,
                (height * scale).round() as u32,
            ))
            .map_err(|error| error.to_string())?;
        Ok(())
    }
    #[cfg(not(target_os = "windows"))]
    position_overlay_window(window, x, y, width, height)
}
