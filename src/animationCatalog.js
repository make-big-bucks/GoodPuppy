// 动画目录：状态的「行为事实」（属于哪一层、一次性还是持续、互动由谁播）。
//
// 这里只描述 app 行为；每个状态的「资源事实」（帧数、时长、loop）来自各 pet
// 目录下的 pet.json（运行时通过 loadPetManifest 加载）。两者刻意分离，新增形象
// 只需放一个 pet 目录，新增动画只需在此加一行 + 一个 GIF。

// ── 三层优先级 ────────────────────────────────────────────────
// 任一时刻只渲染一个状态：瞬时层 > 状态层 > 基础层。
export const LAYER = Object.freeze({
  BASE: 0, // 自主「鲜活」循环（idle + per-pet 的 idle-* 变体）
  STATUS: 1, // 持续状态，单槽互斥（情绪 / 工作）
  TRANSIENT: 2, // 一次性 / 按住型动作
});

// 每个状态的行为元数据。kind:
//   "base"    基础层常驻静息态（idle）
//   "variant" 基础层 idle 变体（per-pet，由 pet.json 声明，定时随机触发）
//   "status"  持续状态（单槽，互斥）
//   "oneshot" 瞬时一次性，播完自动清除
//   "held"    瞬时按住型，外部条件解除前持续（如拖动）
export const STATE_BEHAVIOR = Object.freeze({
  idle: { layer: LAYER.BASE, kind: "base" },

  happy: { layer: LAYER.STATUS, kind: "status" },
  sad: { layer: LAYER.STATUS, kind: "status" },
  busy: { layer: LAYER.STATUS, kind: "status" },
  bored: { layer: LAYER.STATUS, kind: "status" },

  "drag-lift": { layer: LAYER.TRANSIENT, kind: "held" },
  message: { layer: LAYER.TRANSIENT, kind: "oneshot" },
  cuddle: { layer: LAYER.TRANSIENT, kind: "oneshot" },
  cast: { layer: LAYER.TRANSIENT, kind: "oneshot" },
  feed: { layer: LAYER.TRANSIENT, kind: "oneshot" },
  kicked: { layer: LAYER.TRANSIENT, kind: "oneshot" },
  enter: { layer: LAYER.TRANSIENT, kind: "oneshot" },
  greet: { layer: LAYER.TRANSIENT, kind: "oneshot" },
  leave: { layer: LAYER.TRANSIENT, kind: "oneshot" },
});

export const BASE_STATE = "idle";

// idle 变体：基础层不再有固定成员（原 wander / sit-stand 已删除），改为
// per-pet 的「资源事实」——pet.json 里任何 `idle-<verb>` 状态都是合法变体，
// PetAnimator 在 idle 时定时随机触发。catalog 只定义命名约定。
const IDLE_VARIANT_PATTERN = /^idle-[a-z][a-z-]*$/;
const IDLE_VARIANT_BEHAVIOR = Object.freeze({ layer: LAYER.BASE, kind: "variant" });

export function isIdleVariant(stateName) {
  return typeof stateName === "string" && IDLE_VARIANT_PATTERN.test(stateName);
}

// 持续状态选项（右键菜单）。value=null 表示「正常」，清空状态层。
export const STATUS_OPTIONS = Object.freeze([
  { value: "happy", label: "开心", group: "mood" },
  { value: "sad", label: "难过", group: "mood" },
  { value: "busy", label: "忙碌", group: "work" },
  { value: "bored", label: "无聊", group: "work" },
]);

// 跨用户互动 → 双角色路由：发起者播 actorState，被作用者播 targetState。
//   mirror: "facing"  双方面对面（基准 GIF 朝右贴；对方在本端布局左侧时镜像）
//   holdMs            loop 型瞬时动画的持续播放时长（覆盖单循环周期）
export const INTERACTIONS = Object.freeze({
  cuddle: {
    actorState: "cuddle",
    targetState: "cuddle",
    mirror: "facing",
    holdMs: 3000,
    label: "贴贴",
  },
  feed: { actorState: "cast", targetState: "feed", label: "喂食" },
  kick: { actorState: "cast", targetState: "kicked", label: "踢飞" },
});

// petId → 资源目录名。未知 petId 回退到 shiba。新增形象在此注册一行。
const PET_REGISTRY = Object.freeze({
  default: "shiba",
  shiba: "shiba",
});

export const DEFAULT_PET = "shiba";

export function resolvePetDir(petId) {
  return PET_REGISTRY[petId] || DEFAULT_PET;
}

export function getStateImagePath(petId, stateName) {
  return `/pets/${resolvePetDir(petId)}/${stateName}.gif`;
}

export function isStatusState(stateName) {
  return STATE_BEHAVIOR[stateName]?.kind === "status";
}

export function getBehavior(stateName) {
  if (STATE_BEHAVIOR[stateName]) return STATE_BEHAVIOR[stateName];
  if (isIdleVariant(stateName)) return IDLE_VARIANT_BEHAVIOR;
  return null;
}

// 一次性动画的兜底时长（毫秒），用于 manifest 缺失时。
export const DEFAULT_ONESHOT_MS = 900;

// 由 manifest 的 durationsMs 求一次性动画的播放时长。
export function durationFromManifest(manifestState) {
  if (!manifestState || !Array.isArray(manifestState.durationsMs)) {
    return DEFAULT_ONESHOT_MS;
  }
  const total = manifestState.durationsMs.reduce((sum, ms) => sum + (Number(ms) || 0), 0);
  return total > 0 ? total : DEFAULT_ONESHOT_MS;
}

const manifestCache = new Map();

// 加载 pet 资源清单（pet.json）。返回 { states: { name -> manifestState } }。
// 失败时返回空 states，PetAnimator 退回兜底行为。
export async function loadPetManifest(petId, { fetchImpl = fetch } = {}) {
  const dir = resolvePetDir(petId);
  if (manifestCache.has(dir)) return manifestCache.get(dir);

  let manifest = { id: dir, states: {} };
  try {
    const res = await fetchImpl(`/pets/${dir}/pet.json`);
    if (res.ok) {
      const json = await res.json();
      const states = {};
      for (const s of json.states || []) states[s.state] = s;
      manifest = { id: json.id || dir, states };
    }
  } catch {
    // 网络/解析失败：留空 states，使用兜底时长。
  }
  manifestCache.set(dir, manifest);
  return manifest;
}
