import { INTERACTIONS, STATUS_OPTIONS, DEFAULT_SKIN } from "./animationCatalog.js";
import { Menu, Submenu, MenuItem, CheckMenuItem } from "@tauri-apps/api/menu";
import { stepPetScale, DEFAULT_PET_SCALE, MIN_PET_SCALE, MAX_PET_SCALE } from "./petLayout.js";
import type { PetManifest, PetStatus } from "../../types";

export type PetMode = "free" | "semi";

export type SelfMenuContext = {
  selfSkin: string;
  petScale: number;
  manifest: PetManifest | null | undefined;
  hasMessages: boolean;
  petMode: PetMode;
  onShowMessage: () => void;
  onWriteMessage: () => void;
  onSetStatus: (status: PetStatus) => void;
  onSetSkin: (skin: string) => void;
  onSetScale: (scale: number) => void;
  onSetMode: (mode: PetMode) => void;
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

async function buildSizeSubmenu(petScale: number, onSetScale: (scale: number) => void) {
  const items = await Promise.all([
    MenuItem.new({
      id: "size-up",
      text: "放大",
      enabled: petScale < MAX_PET_SCALE,
      action: () => onSetScale(stepPetScale(petScale, 1)),
    }),
    MenuItem.new({
      id: "size-down",
      text: "缩小",
      enabled: petScale > MIN_PET_SCALE,
      action: () => onSetScale(stepPetScale(petScale, -1)),
    }),
    MenuItem.new({
      id: "size-reset",
      text: "恢复默认大小",
      enabled: petScale !== DEFAULT_PET_SCALE,
      action: () => onSetScale(DEFAULT_PET_SCALE),
    }),
  ]);
  return Submenu.new({ text: "大小", items });
}

export async function showSelfContextMenu(ctx: SelfMenuContext) {
  const skinMenu = await buildSkinSubmenu(ctx.selfSkin, ctx.manifest, ctx.onSetSkin);
  const sizeMenu = await buildSizeSubmenu(ctx.petScale, ctx.onSetScale);
  const menu = await Menu.new({
    items: [
      {
        id: "show-message",
        text: "查看对话",
        action: () => {
          if (ctx.hasMessages) ctx.onShowMessage();
          else ctx.onWriteMessage();
        },
      },
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
      sizeMenu,
      await buildModeSubmenu(ctx.petMode, ctx.onSetMode),
    ],
  });
  await menu.popup();
}

async function buildModeSubmenu(petMode: PetMode, onSetMode: (mode: PetMode) => void) {
  const items = await Promise.all([
    CheckMenuItem.new({
      id: "mode-free",
      text: "自由摆放",
      checked: petMode === "free",
      action: () => onSetMode("free"),
    }),
    CheckMenuItem.new({
      id: "mode-semi",
      text: "自动排布",
      checked: petMode === "semi",
      action: () => onSetMode("semi"),
    }),
  ]);
  return Submenu.new({ text: "朋友摆放", items });
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
