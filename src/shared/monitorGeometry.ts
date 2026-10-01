import type { WindowPoint, WindowSize } from "../types";

type Rect = WindowPoint & WindowSize;
type MonitorGeometry = { position: WindowPoint; size: WindowSize; scaleFactor: number; workArea: { position: WindowPoint; size: WindowSize } };

/** 每屏按自身比例转逻辑单位；Windows 混合 DPI 下不能视作统一全局平面，见坐标验收契约。 */
export function monitorRect(monitor: MonitorGeometry, usable = false): Rect {
  const scale = monitor.scaleFactor > 0 ? monitor.scaleFactor : 1;
  const source = usable ? monitor.workArea : monitor;
  return { x: Math.round(source.position.x / scale), y: Math.round(source.position.y / scale),
    width: Math.round(source.size.width / scale), height: Math.round(source.size.height / scale) };
}

/** 屏幕间隙或刚拔掉外接屏时选最近的一块，避免默认跳到协调窗口所在屏。 */
export function workAreaAtPoint(monitors: MonitorGeometry[], point: WindowPoint): Rect | null {
  let selected: MonitorGeometry | null = null;
  let distance = Infinity;
  for (const monitor of monitors) {
    const bounds = monitorRect(monitor);
    const dx = Math.max(bounds.x - point.x, 0, point.x - bounds.x - bounds.width);
    const dy = Math.max(bounds.y - point.y, 0, point.y - bounds.y - bounds.height);
    const next = dx * dx + dy * dy;
    if (next < distance) { selected = monitor; distance = next; }
  }
  return selected ? monitorRect(selected, true) : null;
}
