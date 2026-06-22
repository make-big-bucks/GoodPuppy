import { INTERACTIONS, STATUS_OPTIONS, DEFAULT_SKIN } from "./animationCatalog.js";
import { Menu, Submenu, CheckMenuItem } from "@tauri-apps/api/menu";
import type { PetManifest, PetStatus } from "../../types";

// 「桌宠大小」「朋友摆放模式」已迁至会客厅设置页统一管理，不再出现在右键菜单。
export type SelfMenuContext = {
  selfSkin: string;
  manifest: PetManifest | null | undefined;
  onWriteMessage: () => void;
  onSetStatus: (status: PetStatus) => void;
  onSetSkin: (skin: string) => void;
};

export type RemoteMenuContext = {
  targetId: string;
  onShowRemoteStatus: (userId: string) => void;
  onInteract: (action: keyof typeof INTERACTIONS, targetId: string) => void;
};

async function buildSkinSubmenu(
  selfSkin: string,
  manifest: PetManifest | null | undefined,
  onSetSkin: (skin: string) => void,
) {
  const skins = manifest?.skins || [];
  if (skins.length === 0) return null;
  const options = [{ id: DEFAULT_SKIN, label: "原色" }, ...skins];
  const items = await Promise.all(
    options.map((opt) =>
      CheckMenuItem.new({
        id: `skin-${opt.id}`,
        text: opt.label,
        checked: selfSkin === opt.id,
        action: () => onSetSkin(opt.id),
      }),
    ),
  );
  return Submenu.new({ text: "换肤", items });
}

export async function showSelfContextMenu(ctx: SelfMenuContext) {
  const skinMenu = await buildSkinSubmenu(ctx.selfSkin, ctx.manifest, ctx.onSetSkin);
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
      ...(skinMenu ? [skinMenu] : []),
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
