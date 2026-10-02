// 半自由模式下远程 pet 的自动排布（纯函数）。
//
// 沿自己 pet 右侧「一字排开」：所有远程 pet 窗口底边与自己 pet 窗口底边对齐
// （无气泡时窗口底边即 pet 视觉底边），依次向右排列。复杂避让属 YAGNI（见 Phase B 设计）。
import { desktopScaleAtPoint, desktopSizeAtPoint } from "../../shared/monitorGeometry.js";
import { isWindowPositionVisible } from "../../shared/pet/petLayout.js";
import type { WindowPoint, WindowSize } from "../../types";

export const PET_ROW_GAP = 12;

export function computeSemiFreeLayout(opts: {
  /** 自己 pet 窗口左上角（桌面单位）。 */
  selfPos: WindowPoint;
  /** 自己 pet 窗口尺寸（桌面单位）。 */
  selfSize: WindowSize;
  /** 已排序的在线远程成员 userId 列表。 */
  remoteIds: string[];
  /** 单只远程 pet 窗口尺寸（逻辑像素，无气泡时的基础尺寸）。 */
  petWindowWidth: number;
  petWindowHeight: number;
  gap?: number;
  scaleAt?: (point: WindowPoint) => number;
}): Map<string, WindowPoint> {
  const gap = opts.gap ?? PET_ROW_GAP;
  const bottom = opts.selfPos.y + opts.selfSize.height;
  let edge = opts.selfPos.x + opts.selfSize.width;
  const result = new Map<string, WindowPoint>();
  let previousScale = opts.scaleAt?.(opts.selfPos) ?? 1;
  for (const userId of opts.remoteIds) {
    // 间距归前一个窗口；先固定最终横向位置，再选目标屏比例，避免跨界后用错探测点。
    const x = Math.round(edge + gap * previousScale);
    const scale = opts.scaleAt?.({ x, y: bottom - opts.petWindowHeight * previousScale }) ?? 1;
    result.set(userId, { x: Math.round(x), y: Math.round(bottom - opts.petWindowHeight * scale) });
    edge = x + opts.petWindowWidth * scale;
    previousScale = scale;
  }
  return result;
}

/** 位置选择不改写存档；调用者确认几何快照仍有效后再清理不可见存档。 */
export function resolveRemoteLayout(opts: {
  selfPos: WindowPoint; selfSize: WindowSize; remoteIds: string[]; petSize: WindowSize;
  monitors: Array<WindowPoint & WindowSize & { desktopScale?: number }>;
  free: boolean; stored: Map<string, WindowPoint>;
}) {
  const layout = computeSemiFreeLayout({ selfPos: opts.selfPos, selfSize: opts.selfSize, remoteIds: opts.remoteIds,
    petWindowWidth: opts.petSize.width, petWindowHeight: opts.petSize.height,
    scaleAt: point => desktopScaleAtPoint(opts.monitors, point) });
  const invalidStored: string[] = [];
  if (opts.free) for (const userId of opts.remoteIds) {
    const stored = opts.stored.get(userId);
    if (!stored) continue;
    if (isWindowPositionVisible(stored, desktopSizeAtPoint(opts.monitors, stored, opts.petSize), opts.monitors)) layout.set(userId, stored);
    else invalidStored.push(userId);
  }
  return { layout, invalidStored };
}
