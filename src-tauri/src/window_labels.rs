//! 窗口标签判定：区分宠物覆盖层、气泡覆盖层与普通窗口（lounge/login）。
//! 纯字符串逻辑，无平台依赖，供光标监视、气泡跟随与命令层共用。

/// Pet overlay windows that the drag-end signal serves: the coordinator + self
/// window (`main`) and every dynamically spawned remote pet window
/// (`pet-<userId>`). The lounge / login windows are excluded.
pub(crate) fn is_pet_window_label(label: &str) -> bool {
    label == "main" || label.starts_with("pet-")
}

/// Bubble overlay windows (`bubble-self`, `bubble-<userId>`): one per pet,
/// auto-following its parent pet window. They carry their own pixel hit shape
/// (close button / scroll / textarea) so the cursor monitor must serve them too.
pub(crate) fn is_bubble_window_label(label: &str) -> bool {
    label.starts_with("bubble-")
}

/// Every transparent overlay the native cursor monitor owns passthrough for:
/// pet windows + their bubble windows.
pub(crate) fn is_overlay_window_label(label: &str) -> bool {
    is_pet_window_label(label) || is_bubble_window_label(label)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pet_window_labels_include_main_and_remote_pets_only() {
        assert!(is_pet_window_label("main"));
        assert!(is_pet_window_label("pet-abc-123"));
        assert!(!is_pet_window_label("lounge"));
        assert!(!is_pet_window_label("login"));
        assert!(!is_pet_window_label("petunia")); // must be the "pet-" prefix
    }

    #[test]
    fn bubble_labels_are_recognized_and_served_as_overlays() {
        assert!(is_bubble_window_label("bubble-self"));
        assert!(is_bubble_window_label("bubble-abc-123"));
        assert!(!is_bubble_window_label("pet-abc"));
        assert!(!is_bubble_window_label("main"));

        // The cursor monitor serves pets AND their bubbles, but not lounge/login.
        assert!(is_overlay_window_label("main"));
        assert!(is_overlay_window_label("pet-abc"));
        assert!(is_overlay_window_label("bubble-self"));
        assert!(is_overlay_window_label("bubble-abc"));
        assert!(!is_overlay_window_label("lounge"));
        assert!(!is_overlay_window_label("login"));
    }
}
