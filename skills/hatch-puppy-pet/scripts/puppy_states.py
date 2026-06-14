#!/usr/bin/env python3
"""Single source of truth for GoodPuppy desktop-pet animation states.

Every other script in this skill imports the animation manifest from here so the
state list, frame counts, per-frame durations, and loop behavior never drift.

Each entry is (name, frames, durations_ms, loop, purpose):
- name:      semantic action name; also the output GIF filename stem.
- frames:    number of distinct poses in the row strip / animated GIF.
- durations: per-frame duration in milliseconds; len(durations) == frames.
- loop:      True  -> GIF loops forever (idle/ambient/emotion states).
             False -> GIF plays once and holds the last frame (one-shot actions).
- purpose:   one-line action description used in row prompts.

The state set has two parts:

- REQUIRED_STATES: every pet must ship all of these. Interaction states follow
  GoodPuppy's dual-role routing (the actor plays `cast` for feed/kick; both
  sides play `cuddle`; the app mirrors one side at runtime so they face each
  other -- generate only the rightward-leaning version).
- IDLE_VARIANT_POOL: optional per-pet "alive" flourishes that replace the old
  fixed wander/sit-stand pair. The app plays any `idle-*` state declared in
  pet.json on a random timer while idle. SELECTED_IDLE_VARIANTS picks which
  pool entries this run generates; change the selection (not the specs) to give
  different pets different flavor while keeping generation stable.
"""

from __future__ import annotations

# GoodPuppy renders 240x240 transparent GIFs (public/pets/<id>/<state>.gif),
# so every cell, frame, layout guide, and final GIF is square 240x240.
CELL_WIDTH = 240
CELL_HEIGHT = 240

# (name, frames, durations_ms, loop, purpose)
REQUIRED_STATES: list[tuple[str, int, list[int], bool, str]] = [
    # A001 基础状态: 呼吸 + 眨眼
    ("idle", 6, [280, 110, 110, 140, 140, 320], True,
     "neutral breathing and blinking idle loop; first frame is the reduced-motion still"),
    # B001 用户交互: 拖动 -> 被无形之手拎起（方向无关）
    ("drag-lift", 6, [110, 110, 110, 110, 110, 180], True,
     "held aloft by an invisible grip: body dangles upright, all four limbs hang and paddle in the air, "
     "head tilts up and wiggles; symmetric front or 3/4 view with no left/right direction"),
    # C001 好友交互: 发消息 (叼起纸飞机掷出)
    ("message", 6, [140, 140, 150, 150, 160, 260], False,
     "send a message: pick up a small pixel paper plane in the mouth, rear the head back, "
     "toss it up and away off the top of the frame, then settle watching it go"),
    # C002 好友交互: 贴贴 (双方都播; 基准朝右, app 负责镜像)
    ("cuddle", 6, [180, 150, 150, 180, 180, 240], True,
     "scoot sideways and press lovingly against the RIGHT edge of the frame slot: body squashed "
     "flat against that edge, cheek squished, happy closed eyes; generate only this rightward lean"),
    # C002 好友交互: 施法 (feed/kick 的发起者动画)
    ("cast", 6, [140, 130, 130, 150, 160, 260], False,
     "wave a small pixel magic wand held in one paw: raise the wand, two quick flourish waves with "
     "a tiny opaque spark touching the wand tip, then lower it"),
    # C002 好友交互: 喂食 (被作用者动画)
    ("feed", 8, [160, 140, 140, 140, 140, 150, 160, 260], False,
     "a small pixel food pack appears on the ground in front of the pet, the pet dips its head in "
     "and eats it bite by bite until the pack is gone, then looks up satisfied"),
    # C002 好友交互: 踢飞 (被作用者动画)
    ("kicked", 6, [120, 90, 90, 110, 140, 260], False,
     "comedic launch after being kicked: tumble through poses and land dazed"),
    # C003 好友交互: 进入房间 (从门中走出)
    ("enter", 8, [150, 130, 120, 120, 120, 130, 150, 260], False,
     "arrive through a door: first frame shows only a closed pixel door, the pet gradually steps "
     "out of the opening door frame by frame, the door shrinks away, and the final frame shows the "
     "pet standing alone in a near-idle pose"),
    # C003 好友交互: 别人进入时打招呼
    ("greet", 4, [150, 140, 140, 260], False,
     "a friendly greeting: raise a paw and tilt the head"),
    # C003 好友交互: 离开 (走入门中消失)
    ("leave", 8, [150, 130, 120, 120, 120, 130, 150, 280], False,
     "depart through a door: a pixel door appears beside the pet, the pet walks into the opening "
     "door and disappears deeper frame by frame, and the final frame shows only the closed door"),
    # D001 状态动画: 开心
    ("happy", 6, [150, 130, 130, 150, 150, 220], True,
     "cheerful bounce/wiggle expressing happiness"),
    # D001 状态动画: 难过
    ("sad", 5, [260, 180, 180, 200, 320], True,
     "downcast slump with drooping ears and a slow sniffle loop"),
    # D002 状态动画: 忙碌 (专注勿扰)
    ("busy", 6, [140, 130, 130, 140, 150, 220], True,
     "deep do-not-disturb focus: hunched over a tiny pixel desk or laptop touching the body, "
     "back half-turned, head down, paws tapping steadily, never looking up"),
    # D002 状态动画: 无聊
    ("bored", 5, [280, 180, 180, 200, 340], True,
     "listless bored idle: sway, sigh, look around slowly"),
]

# idle 变体候选池: per-pet 的「鲜活」花样。每个条目规格固定以保证稳定生成；
# 通过 SELECTED_IDLE_VARIANTS 选择本次生成哪些（默认 2 个）。
IDLE_VARIANT_POOL: list[tuple[str, int, list[int], bool, str]] = [
    ("idle-stretch", 6, [160, 140, 140, 160, 180, 260], False,
     "a long satisfying stretch: front paws slide forward, chest dips, rump up, then rise back"),
    ("idle-shake", 6, [120, 110, 110, 120, 140, 220], False,
     "a quick full-body shake from head to tail, fur/body ruffling, ending composed"),
    ("idle-sniff", 6, [150, 140, 140, 150, 160, 240], False,
     "curious sniffing: lower the nose toward the ground, sniff side to side, then look up"),
    ("idle-tail-chase", 6, [120, 110, 110, 110, 130, 200], False,
     "one playful spin chasing the tail, then stop slightly dizzy and recover"),
    ("idle-scratch", 6, [140, 130, 130, 140, 160, 240], False,
     "sit briefly and scratch behind one ear with a hind leg, then settle back"),
]

# 本次运行生成的 idle 变体。换 pet 想要不同花样时改这份选择即可，
# 规格本身（帧数/时长/提示词）保持不变以维持稳定生成。
SELECTED_IDLE_VARIANTS: list[str] = ["idle-stretch", "idle-shake"]

_POOL_BY_NAME = {name: entry for entry in IDLE_VARIANT_POOL for name in [entry[0]]}
_unknown_variants = sorted(set(SELECTED_IDLE_VARIANTS) - set(_POOL_BY_NAME))
if _unknown_variants:
    raise SystemExit(f"unknown idle variant(s) selected: {', '.join(_unknown_variants)}")

STATES: list[tuple[str, int, list[int], bool, str]] = REQUIRED_STATES + [
    _POOL_BY_NAME[name] for name in SELECTED_IDLE_VARIANTS
]

# 这些状态包含大体量的合法分离道具（门 / 食物包 / 掷出的纸飞机），连通组件
# 提取容易把道具归错组，默认改用等宽槽位切割。
SLOT_EXTRACT_STATES: set[str] = {"enter", "leave", "feed", "message"}

# 每个状态的期望提取方法。inspect_frames.py 用它校验实际提取方法：
# 槽位切割对白名单状态是正确行为而非降级，不应被 --require-components 判错。
EXPECTED_EXTRACTION_METHODS: dict[str, str] = {
    name: ("slots" if name in SLOT_EXTRACT_STATES else "components")
    for name in [entry[0] for entry in REQUIRED_STATES + IDLE_VARIANT_POOL]
}

# 针对可切分性的按状态 repair 追加规则。机器 QA 通过不代表槽位构图可读；
# 这些规则在 queue_pet_repairs.py 追加 repair note 时自动注入，
# 解决通用 repair 模板对道具状态（门 / 食物包 / 纸飞机）约束不足的问题。
SLOT_DISCIPLINE_GUIDANCE: list[str] = [
    "Every frame slot must read cleanly on the final contact sheet: keep a clear "
    "pure-chroma-key margin between the slot contents and both slot edges.",
    "The combined width of the pet plus its prop must never touch or crowd the "
    "slot boundary; shrink the composition before letting it approach an edge.",
]

REPAIR_GUIDANCE: dict[str, list[str]] = {
    "enter": [
        "The door must be ONE compact, fully visible element, centered in its slot, "
        "with the identical door design repeated in every frame.",
        "Frames where the pet and door coexist must keep them close together as one "
        "centered composition, never spread toward opposite slot edges.",
        *SLOT_DISCIPLINE_GUIDANCE,
    ],
    "leave": [
        "The door must be ONE compact, fully visible element, centered in its slot, "
        "with the identical door design repeated in every frame.",
        "Frames where the pet and door coexist must keep them close together as one "
        "centered composition, never spread toward opposite slot edges.",
        *SLOT_DISCIPLINE_GUIDANCE,
    ],
    "feed": [
        "The food pack must sit directly in front of and close to the pet, inside the "
        "same slot's safe area; never place it near a slot edge or floating far away.",
        "Keep the food pack one small compact element that visibly shrinks frame by "
        "frame as it is eaten.",
        *SLOT_DISCIPLINE_GUIDANCE,
    ],
    "message": [
        "The paper plane must stay attached to the pet (mouth or paw) in every frame "
        "except the final 1-2 frames, where it detaches upward but remains inside the "
        "same slot's safe area.",
        *SLOT_DISCIPLINE_GUIDANCE,
    ],
}

STATE_NAMES: list[str] = [name for name, *_ in STATES]
FRAME_COUNTS: dict[str, int] = {name: frames for name, frames, *_ in STATES}
DURATIONS: dict[str, list[int]] = {name: durations for name, _f, durations, *_ in STATES}
LOOPS: dict[str, bool] = {name: loop for name, _f, _d, loop, _p in STATES}
PURPOSES: dict[str, str] = {name: purpose for name, _f, _d, _l, purpose in STATES}


def parse_states(raw: str) -> list[str]:
    """Resolve a --states argument ('all' or a comma list) into known state names."""
    if raw.strip().lower() == "all":
        return list(STATE_NAMES)
    states = [item.strip() for item in raw.split(",") if item.strip()]
    unknown = sorted(set(states) - set(STATE_NAMES))
    if unknown:
        raise SystemExit(f"unknown state(s): {', '.join(unknown)}")
    return states
