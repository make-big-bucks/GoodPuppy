//! 每窗口的交互命中形状与判定逻辑。
//!
//! 形状由 webview 在「窗口内容 CSS 逻辑像素」坐标系下发布（与光标监视测量光标的
//! 坐标系一致）。原生光标监视每个 poll tick 依据该形状决定鼠标穿透——无需逐次
//! 移动的 IPC 往返。命中判定 `shape_is_interactive` 为纯函数，可单测。

use std::collections::HashMap;
use std::sync::Arc;

/// Per-window interactive hit shape, published by the webview in window-content
/// CSS-logical pixels (same space the cursor monitor measures the cursor in).
///
/// The native cursor monitor owns mouse passthrough and decides it from this
/// shape every poll tick — no per-move IPC round-trip. That removes the ~30–50ms
/// "become interactive" latency that made the first click after entering the pet
/// fail to grab it. The webview re-publishes the shape only when it changes
/// (animation frame, scale, bubbles/compose, drag), not on every cursor move.
#[derive(Clone, Default, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PetHitShape {
    /// Pet silhouette alpha mask over `mask_rect`, row-major, 1 = opaque pixel.
    mask: Vec<u8>,
    mask_cols: u32,
    mask_rows: u32,
    /// Mask rect [x, y, w, h] in content-logical px.
    mask_rect: [f64; 4],
    /// Always-interactive rects (visible bubbles / compose stick), content px.
    rects: Vec<[f64; 4]>,
    /// While dragging, the whole window stays interactive regardless of shape.
    force_interactive: bool,
}

/// label → latest published hit shape. Shared between the `set_pet_hit_shape`
/// command (writer) and the cursor monitor (reader).
#[derive(Default)]
pub(crate) struct HitRegistry {
    pub(crate) shapes: HashMap<String, PetHitShape>,
    pub(crate) ignore: HashMap<String, bool>,
}
impl HitRegistry {
    pub(crate) fn remove_window(&mut self, label: &str) {
        self.shapes.remove(label);
        self.ignore.remove(label);
    }
}
pub(crate) type HitShapes = Arc<std::sync::Mutex<HitRegistry>>;

fn point_in_rect(x: f64, y: f64, r: [f64; 4]) -> bool {
    x >= r[0] && y >= r[1] && x <= r[0] + r[2] && y <= r[1] + r[3]
}

/// Whether a content-space point (CSS-logical px) is over interactive content:
/// the pet silhouette (mask) or any interactive rect, or unconditionally while
/// a drag forces the window interactive. Pure → unit-tested.
pub(crate) fn shape_is_interactive(shape: &PetHitShape, x: f64, y: f64) -> bool {
    if shape.force_interactive {
        return true;
    }
    if shape.rects.iter().any(|r| point_in_rect(x, y, *r)) {
        return true;
    }
    let [rx, ry, rw, rh] = shape.mask_rect;
    if shape.mask_cols == 0 || shape.mask_rows == 0 || rw <= 0.0 || rh <= 0.0 {
        return false;
    }
    if x < rx || y < ry || x > rx + rw || y > ry + rh {
        return false;
    }
    let col = (((x - rx) / rw) * shape.mask_cols as f64) as i64;
    let row = (((y - ry) / rh) * shape.mask_rows as f64) as i64;
    let col = col.clamp(0, shape.mask_cols as i64 - 1) as usize;
    let row = row.clamp(0, shape.mask_rows as i64 - 1) as usize;
    let idx = row * shape.mask_cols as usize + col;
    shape.mask.get(idx).copied().unwrap_or(0) != 0
}

#[cfg(test)]
mod tests {
    use super::*;

    fn shape_with_mask(mask: Vec<u8>, cols: u32, rows: u32, rect: [f64; 4]) -> PetHitShape {
        PetHitShape {
            mask,
            mask_cols: cols,
            mask_rows: rows,
            mask_rect: rect,
            rects: Vec::new(),
            force_interactive: false,
        }
    }

    #[test]
    fn force_interactive_overrides_everything() {
        let mut shape = PetHitShape::default();
        shape.force_interactive = true;
        // No mask, no rects, but a drag forces the whole window interactive.
        assert!(shape_is_interactive(&shape, 9999.0, 9999.0));
    }

    #[test]
    fn interactive_rects_hit_inside_only() {
        let mut shape = PetHitShape::default();
        shape.rects = vec![[10.0, 20.0, 100.0, 40.0]];
        assert!(shape_is_interactive(&shape, 10.0, 20.0)); // top-left corner
        assert!(shape_is_interactive(&shape, 60.0, 40.0)); // inside
        assert!(shape_is_interactive(&shape, 110.0, 60.0)); // bottom-right corner
        assert!(!shape_is_interactive(&shape, 9.0, 40.0)); // left of rect
        assert!(!shape_is_interactive(&shape, 60.0, 61.0)); // below rect
    }

    #[test]
    fn mask_opaque_cells_are_interactive_transparent_are_not() {
        // 2x2 mask over a 20x20 rect at origin (10,10): only the bottom-right cell opaque.
        let shape = shape_with_mask(vec![0, 0, 0, 1], 2, 2, [10.0, 10.0, 20.0, 20.0]);
        assert!(!shape_is_interactive(&shape, 12.0, 12.0)); // top-left cell, transparent
        assert!(shape_is_interactive(&shape, 25.0, 25.0)); // bottom-right cell, opaque
        assert!(!shape_is_interactive(&shape, 5.0, 5.0)); // outside the mask rect
    }

    #[test]
    fn empty_mask_is_not_interactive() {
        let shape = shape_with_mask(Vec::new(), 0, 0, [0.0, 0.0, 0.0, 0.0]);
        assert!(!shape_is_interactive(&shape, 0.0, 0.0));
    }
}

#[cfg(test)]
mod registry_tests {
    use super::*;
    #[test]
    fn recreated_window_does_not_inherit_hit_shape_or_passthrough_cache() {
        let mut registry = HitRegistry::default();
        registry
            .shapes
            .insert("pet-a".into(), PetHitShape::default());
        registry.ignore.insert("pet-a".into(), true);
        registry.remove_window("pet-a");
        assert!(!registry.shapes.contains_key("pet-a"));
        assert!(!registry.ignore.contains_key("pet-a"));
    }
}
