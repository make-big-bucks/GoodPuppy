// 半自由模式下远程 pet 的自动排布（纯函数）。
//
// 沿自己 pet 右侧「一字排开」：所有远程 pet 窗口底边与自己 pet 窗口底边对齐
// （无气泡时窗口底边即 pet 视觉底边），依次向右排列。复杂避让属 YAGNI（见 Phase B 设计）。
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
  for (const userId of opts.remoteIds) {
    const scale = opts.scaleAt?.({ x: edge + gap, y: bottom - opts.petWindowHeight }) ?? 1;
    const x = edge + gap * scale;
    result.set(userId, { x: Math.round(x), y: Math.round(bottom - opts.petWindowHeight * scale) });
    edge = x + opts.petWindowWidth * scale;
  }
  return result;
}
