// 半自由模式下远程 pet 的自动排布（纯函数）。
//
// 沿自己 pet 右侧「一字排开」：所有远程 pet 窗口底边与自己 pet 窗口底边对齐
// （无气泡时窗口底边即 pet 视觉底边），依次向右排列。复杂避让属 YAGNI（见 Phase B 设计）。
import type { WindowPoint, WindowSize } from "../../types";

export const PET_ROW_GAP = 12;

export function computeSemiFreeLayout(opts: {
  /** 自己 pet 窗口左上角（逻辑像素）。 */
  selfPos: WindowPoint;
  /** 自己 pet 窗口尺寸（逻辑像素）。 */
  selfSize: WindowSize;
  /** 已排序的在线远程成员 userId 列表。 */
  remoteIds: string[];
  /** 单只远程 pet 窗口尺寸（逻辑像素，无气泡时的基础尺寸）。 */
  petWindowWidth: number;
  petWindowHeight: number;
  gap?: number;
}): Map<string, WindowPoint> {
  const gap = opts.gap ?? PET_ROW_GAP;
  const bottom = opts.selfPos.y + opts.selfSize.height;
  const startX = opts.selfPos.x + opts.selfSize.width + gap;
  const result = new Map<string, WindowPoint>();
  opts.remoteIds.forEach((userId, index) => {
    result.set(userId, {
      x: Math.round(startX + index * (opts.petWindowWidth + gap)),
      y: Math.round(bottom - opts.petWindowHeight),
    });
  });
  return result;
}
