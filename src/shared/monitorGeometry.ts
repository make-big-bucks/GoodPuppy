import type { WindowPoint, WindowSize } from "../types";

type Rect = WindowPoint & WindowSize;
type MonitorGeometry = { position: WindowPoint; size: WindowSize; scaleFactor: number; workArea: { position: WindowPoint; size: WindowSize } };

/** 每屏按自身比例转逻辑单位；Windows 混合 DPI 下不能视作统一全局平面，见坐标验收契约。 */
export function monitorRect(monitor: MonitorGeometry, usable = false, physical = false): Rect {
  const scale = physical ? 1 : monitor.scaleFactor > 0 ? monitor.scaleFactor : 1;
  const source = usable ? monitor.workArea : monitor;
  return { x: Math.round(source.position.x / scale), y: Math.round(source.position.y / scale),
    width: Math.round(source.size.width / scale), height: Math.round(source.size.height / scale) };
}

/** 屏幕间隙或刚拔掉外接屏时选最近的一块，避免默认跳到协调窗口所在屏。 */
export function workAreaAtPoint(monitors: MonitorGeometry[], point: WindowPoint, physical = false): Rect | null {
  let selected: MonitorGeometry | null = null;
  let distance = Infinity;
  for (const monitor of monitors) {
    const bounds = monitorRect(monitor, false, physical);
    const dx = Math.max(bounds.x - point.x, 0, point.x >= bounds.x + bounds.width ? point.x - bounds.x - bounds.width + 1 : 0);
    const dy = Math.max(bounds.y - point.y, 0, point.y >= bounds.y + bounds.height ? point.y - bounds.y - bounds.height + 1 : 0);
    const next = dx * dx + dy * dy;
    if (next < distance) { selected = monitor; distance = next; }
  }
  return selected ? monitorRect(selected, true, physical) : null;
}

/** 将内容逻辑尺寸换算到目标屏桌面单位，屏幕矩形本身必须已经处于统一平面。 */
export function desktopScaleAtPoint(monitors: Array<Rect & { desktopScale?: number }>, point: WindowPoint) {
  let scale = 1; let distance = Infinity;
  for (const bounds of monitors) {
    const dx = Math.max(bounds.x - point.x, 0, point.x >= bounds.x + bounds.width ? point.x - bounds.x - bounds.width + 1 : 0);
    const dy = Math.max(bounds.y - point.y, 0, point.y >= bounds.y + bounds.height ? point.y - bounds.y - bounds.height + 1 : 0);
    if (dx * dx + dy * dy < distance) { distance = dx * dx + dy * dy; scale = bounds.desktopScale ?? 1; }
  }
  return scale;
}
export function desktopSizeAtPoint(monitors: Array<Rect & { desktopScale?: number }>, point: WindowPoint, size: WindowSize) {
  const scale = desktopScaleAtPoint(monitors, point);
  return { width: size.width * scale, height: size.height * scale };
}
