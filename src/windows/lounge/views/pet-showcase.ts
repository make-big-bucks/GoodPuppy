import type { SupabaseClient } from "@supabase/supabase-js";
import { getStateImagePath, loadPetManifest, DEFAULT_SKIN } from "../../pet/animationCatalog.js";

type ShowcaseOptions = {
  petId: string;
  skin: string;
  selfAuthId: string;
  supabase: SupabaseClient;
  onSkinChange: (skin: string) => void;
};

const SKIN_STORAGE_KEY = "goodpuppy.skin";

const SKIN_SWATCH_COLORS: Record<string, string> = {
  default: "#cc7a2a",
  pink:    "#d4909f",
  blue:    "#5ca0c8",
  purple:  "#a07ed4",
  mint:    "#78c4a8",
  cream:   "#c8baa0",
};

type StateEntry = { state: string; label: string; icon: string };

// Module-level state
let backdropEl: HTMLElement | null = null;
let previewEl: HTMLImageElement | null = null;
let statesEl: HTMLElement | null = null;
let skinsEl: HTMLElement | null = null;
let saveBtnEl: HTMLButtonElement | null = null;
let activePetId = "default";
// savedSkin = 打开时的皮肤（事实源）；activeSkin = 当前预览选择。点色块只改 activeSkin，
// 点「保存」才把 activeSkin 落库并视为新的 savedSkin。关闭不保存则 activeSkin 被丢弃。
let savedSkin = DEFAULT_SKIN;
let activeSkin = DEFAULT_SKIN;
let activeState = "idle";
let skinChangeCb: ((skin: string) => void) | null = null;
let authId: string | null = null;
let sbClient: SupabaseClient | null = null;

function getBackdrop() {
  return backdropEl ?? (backdropEl = document.querySelector<HTMLElement>(".showcase-backdrop"));
}

export function initShowcase() {
  const backdrop = getBackdrop();
  backdrop?.addEventListener("click", (e) => {
    if (e.target === e.currentTarget) closeShowcase();
  });
  saveBtnEl = backdrop?.querySelector<HTMLButtonElement>(".showcase-save") ?? null;
  saveBtnEl?.addEventListener("click", () => saveSkin());
}

export function openShowcase({ petId, skin, selfAuthId, supabase, onSkinChange }: ShowcaseOptions) {
  const backdrop = getBackdrop();
  if (!backdrop) return;

  activePetId = petId;
  savedSkin = skin || DEFAULT_SKIN;
  activeSkin = savedSkin;
  activeState = "idle";
  skinChangeCb = onSkinChange;
  authId = selfAuthId;
  sbClient = supabase;

  previewEl = backdrop.querySelector<HTMLImageElement>(".showcase-gif");
  statesEl = backdrop.querySelector<HTMLElement>(".showcase-states");
  skinsEl = backdrop.querySelector<HTMLElement>(".showcase-skins");
  saveBtnEl = backdrop.querySelector<HTMLButtonElement>(".showcase-save");

  renderStates();
  updatePreview();
  renderSkins();
  syncSaveButton();

  void loadPetManifest(petId).then((manifest) => {
    if (manifest.skins.length > 0) renderSkins(manifest.skins);
  });

  backdrop.hidden = false;
}

function closeShowcase() {
  const backdrop = getBackdrop();
  if (backdrop) backdrop.hidden = true;
}

function updatePreview() {
  if (previewEl) {
    previewEl.src = getStateImagePath(activePetId, activeState, activeSkin);
  }
}

function renderStates() {
  if (!statesEl) return;
  statesEl.innerHTML = "";
  for (const entry of STATE_ENTRIES) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "showcase-state-btn";
    btn.dataset.state = entry.state;
    btn.dataset.tooltip = entry.label;
    btn.innerHTML = entry.icon;
    if (entry.state === activeState) btn.classList.add("is-active");
    btn.addEventListener("click", () => {
      activeState = entry.state;
      statesEl!.querySelectorAll(".showcase-state-btn").forEach((b) =>
        b.classList.toggle("is-active", (b as HTMLElement).dataset.state === entry.state),
      );
      updatePreview();
    });
    statesEl.appendChild(btn);
  }
}

function renderSkins(manifestSkins?: Array<{ id: string }>) {
  if (!skinsEl) return;
  skinsEl.innerHTML = "";

  const skinIds = manifestSkins
    ? ["default", ...manifestSkins.map((s) => s.id)]
    : Object.keys(SKIN_SWATCH_COLORS);

  for (const skinId of skinIds) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "showcase-skin-btn";
    btn.dataset.skin = skinId;
    btn.style.setProperty("--swatch", SKIN_SWATCH_COLORS[skinId] ?? "#aaa");
    if (skinId === activeSkin) btn.classList.add("is-active");
    btn.addEventListener("click", () => previewSkin(skinId));
    skinsEl.appendChild(btn);
  }
}

// 点色块：只更新预览选择与高亮，不写库、不广播。需点「保存」才生效。
function previewSkin(skinId: string) {
  activeSkin = skinId;

  skinsEl?.querySelectorAll<HTMLElement>(".showcase-skin-btn").forEach((btn) => {
    btn.classList.toggle("is-active", btn.dataset.skin === skinId);
  });

  updatePreview();
  syncSaveButton();
}

// 「保存」启用条件：当前预览选择与已保存皮肤不同。
function syncSaveButton() {
  if (saveBtnEl) saveBtnEl.disabled = activeSkin === savedSkin;
}

// 点「保存」：落库（profiles）+ 缓存（localStorage）+ 通知会客厅/pet 窗口，然后关闭。
function saveSkin() {
  if (activeSkin === savedSkin) {
    closeShowcase();
    return;
  }
  const skinId = activeSkin;
  savedSkin = skinId;

  try { localStorage.setItem(SKIN_STORAGE_KEY, skinId); } catch { /* noop */ }

  if (sbClient && authId) {
    // 注意：PostgrestBuilder 是惰性 thenable，HTTP 请求只在 .then()/await 时才发出。
    // 此前写成 `void sbClient...update(...)` 从不调用 .then()，PATCH 根本没发出，
    // 皮肤未落库，任何 loadPanelData() 重新读到 skin=default 都会把头像换回原色。
    void sbClient
      .from("profiles")
      .update({ skin: skinId })
      .eq("id", authId)
      .then(({ error }) => {
        if (error) console.error("skin update:", error);
      });
  }

  skinChangeCb?.(skinId);
  syncSaveButton();
  closeShowcase();
}

// ── SVG icon helpers ──────────────────────────────────────────────

function s(content: string) {
  return `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${content}</svg>`;
}
function sf(content: string) {
  return `<svg viewBox="0 0 20 20" fill="currentColor" stroke="none" aria-hidden="true">${content}</svg>`;
}

// ── State icon definitions ────────────────────────────────────────

function iconIdle() {
  // Paw print: palm + 3 toes
  return s(`
    <ellipse cx="10" cy="13.5" rx="3.5" ry="2.8"/>
    <circle cx="6.8" cy="9.2" r="1.2"/>
    <circle cx="10" cy="8.2" r="1.2"/>
    <circle cx="13.2" cy="9.2" r="1.2"/>
  `);
}

function iconShake() {
  // Two horizontal sine waves
  return s(`
    <path d="M2.5 9 Q4.5 7 6.5 9 Q8.5 11 10.5 9 Q12.5 7 14.5 9 Q16 10 17.5 9"/>
    <path d="M2.5 13 Q4.5 11 6.5 13 Q8.5 15 10.5 13 Q12.5 11 14.5 13 Q16 14 17.5 13"/>
  `);
}

function iconStretch() {
  // Bidirectional horizontal arrows
  return s(`
    <line x1="4" y1="10" x2="16" y2="10"/>
    <path d="M2 10 l4 -2.5 M2 10 l4 2.5"/>
    <path d="M18 10 l-4 -2.5 M18 10 l-4 2.5"/>
  `);
}

function iconHappy() {
  // Filled heart
  return sf(`<path d="M10 17 C9 16 2 11 2 7 C2 4.8 3.8 3 6 3 C7.5 3 8.8 3.8 10 5 C11.2 3.8 12.5 3 14 3 C16.2 3 18 4.8 18 7 C18 11 11 16 10 17 Z"/>`);
}

function iconSad() {
  // Filled teardrop
  return sf(`<path d="M10 3 C10 3 6 9 6 12.5 A4 4 0 0 0 14 12.5 C14 9 10 3 10 3 Z"/>`);
}

function iconBusy() {
  // Filled lightning bolt
  return sf(`<path d="M12.5 2 L6 11 H10.5 L7.5 18 L14 9 H9.5 Z"/>`);
}

function iconBored() {
  // Three z's going up-right (zZZ)
  return s(`
    <path d="M4 17 H9 L4 13 H9"/>
    <path d="M8 10.5 H12 L8 7.5 H12" stroke-width="1.5"/>
    <path d="M11.5 5 H14.5 L11.5 3 H14.5" stroke-width="1.2"/>
  `);
}

function iconDragLift() {
  // Arrow pointing up + base line (being lifted)
  return s(`
    <line x1="10" y1="15" x2="10" y2="6"/>
    <path d="M7 9 L10 6 L13 9"/>
    <line x1="5.5" y1="15" x2="14.5" y2="15"/>
  `);
}

function iconMessage() {
  // Chat bubble
  return s(`
    <path d="M3 4.5 C3 3.4 3.9 2.5 5 2.5 H15 C16.1 2.5 17 3.4 17 4.5 V11.5 C17 12.6 16.1 13.5 15 13.5 H8 L5 17 V13.5 C3.9 13.5 3 12.6 3 11.5 Z"/>
  `);
}

function iconCuddle() {
  // Two overlapping circles
  return s(`
    <circle cx="7.5" cy="10" r="4"/>
    <circle cx="12.5" cy="10" r="4"/>
  `);
}

function iconCast() {
  // Arm extending forward with motion lines (throwing)
  return s(`
    <path d="M4 16 C6 14 8 13 10 10"/>
    <path d="M10 10 L14 5"/>
    <path d="M12 3 L14 5 L16 3"/>
    <line x1="16" y1="7" x2="18" y2="6.5"/>
    <line x1="16" y1="10" x2="18" y2="10"/>
  `);
}

function iconFeed() {
  // Bone shape: thick center + circle knobs at ends
  return sf(`
    <rect x="6" y="8.5" width="8" height="3" rx="1.5"/>
    <circle cx="5" cy="8" r="2.2"/>
    <circle cx="5" cy="12" r="2.2"/>
    <circle cx="15" cy="8" r="2.2"/>
    <circle cx="15" cy="12" r="2.2"/>
  `);
}

function iconKicked() {
  // Boot kicking + impact star burst
  return s(`
    <path d="M2 17 L5 12 L9 14 L8 17 Z" stroke-linejoin="round"/>
    <path d="M9 14 L13.5 8.5"/>
    <line x1="14.5" y1="5.5" x2="14.5" y2="2.5"/>
    <line x1="12.5" y1="6.5" x2="10.5" y2="5"/>
    <line x1="16.5" y1="6.5" x2="18.5" y2="5"/>
    <line x1="17" y1="8.5" x2="19" y2="8.5"/>
    <line x1="13" y1="4" x2="11.5" y2="2.5"/>
    <line x1="16" y1="4" x2="17.5" y2="2.5"/>
  `);
}

function iconEnter() {
  // Right-pointing arrow entering a door frame
  return s(`
    <path d="M11 4.5 H16 V15.5 H11"/>
    <line x1="3" y1="10" x2="13" y2="10"/>
    <path d="M9.5 7 L13 10 L9.5 13"/>
  `);
}

function iconGreet() {
  // Open hand with fingers raised + wave curve
  return s(`
    <rect x="7" y="11" width="7" height="6" rx="1.5"/>
    <line x1="8.5" y1="11" x2="8.5" y2="6"/>
    <line x1="10.5" y1="11" x2="10.5" y2="5"/>
    <line x1="12.5" y1="11" x2="12.5" y2="6"/>
    <path d="M15 4 Q17.5 5.5 16.5 8"/>
  `);
}

function iconLeave() {
  // Arrow exiting to the right through a door frame on the left
  return s(`
    <path d="M9 4.5 H4 V15.5 H9"/>
    <line x1="7" y1="10" x2="17" y2="10"/>
    <path d="M13 7 L17 10 L13 13"/>
  `);
}

const STATE_ENTRIES: StateEntry[] = [
  { state: "idle",         label: "待机",    icon: iconIdle() },
  { state: "idle-shake",   label: "抖身",    icon: iconShake() },
  { state: "idle-stretch", label: "伸懒腰",  icon: iconStretch() },
  { state: "happy",        label: "开心",    icon: iconHappy() },
  { state: "sad",          label: "难过",    icon: iconSad() },
  { state: "busy",         label: "忙碌",    icon: iconBusy() },
  { state: "bored",        label: "无聊",    icon: iconBored() },
  { state: "message",      label: "收消息",  icon: iconMessage() },
  { state: "cuddle",       label: "贴贴",    icon: iconCuddle() },
  { state: "cast",         label: "发动互动",icon: iconCast() },
  { state: "feed",         label: "被喂食",  icon: iconFeed() },
  { state: "kicked",       label: "被踢飞",  icon: iconKicked() },
  { state: "enter",        label: "进场",    icon: iconEnter() },
  { state: "greet",        label: "打招呼",  icon: iconGreet() },
  { state: "leave",        label: "离场",    icon: iconLeave() },
  { state: "drag-lift",    label: "被拖起",  icon: iconDragLift() },
];
