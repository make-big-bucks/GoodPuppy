import { INTERACTIONS, STATUS_OPTIONS } from "../../shared/pet/animationCatalog.js";
import { Menu, PredefinedMenuItem } from "@tauri-apps/api/menu";
import type { PetStatus } from "../../types";

// 「桌宠大小」「朋友摆放模式」已迁至会客厅设置页统一管理；「换肤」已迁至会客厅资料卡头像，
// 二者均不再出现在右键菜单。
export type SelfMenuContext = {
  // 是否在房间内：决定是否展示「退出房间」。
  inRoom: boolean;
  onWriteMessage: () => void;
  onSetStatus: (status: PetStatus) => void;
  onLeaveRoom: () => void;
};

export type RemoteMenuContext = {
  targetId: string;
  onShowRemoteStatus: (userId: string) => void;
  onInteract: (action: keyof typeof INTERACTIONS, targetId: string) => void;
};

export async function showSelfContextMenu(ctx: SelfMenuContext) {
  const leaveItems = ctx.inRoom
    ? [
        await PredefinedMenuItem.new({ item: "Separator" }),
        {
          id: "leave-room",
          text: "退出房间",
          action: () => ctx.onLeaveRoom(),
        },
      ]
    : [];
  const menu = await Menu.new({
    items: [
      {
        id: "write-message",
        text: "写消息",
        action: () => ctx.onWriteMessage(),
      },
      ...STATUS_OPTIONS.map((opt) => ({
        id: `status-${opt.value}`,
        text: `${opt.group === "mood" ? "心情" : "状态"}：${opt.label}`,
        action: () => ctx.onSetStatus(opt.value),
      })),
      {
        id: "status-normal",
        text: "恢复正常",
        action: () => ctx.onSetStatus(null),
      },
      ...leaveItems,
    ],
  });
  await menu.popup();
}

export async function showRemoteContextMenu(ctx: RemoteMenuContext) {
  const menu = await Menu.new({
    items: [
      {
        id: "show-status",
        text: "查看状态",
        action: () => ctx.onShowRemoteStatus(ctx.targetId),
      },
      ...Object.entries(INTERACTIONS).map(([action, def]) => ({
        id: `interact-${action}`,
        text: def.label,
        action: () => ctx.onInteract(action as keyof typeof INTERACTIONS, ctx.targetId),
      })),
    ],
  });
  await menu.popup();
}
