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

States come from docs/桌宠动画清单.md ("待制作" items only), with multi-action
entries split into independent single-character animations and named by action
semantics rather than by clipboard codes (A001, C002, ...).
"""

from __future__ import annotations

# GoodPuppy renders 240x240 transparent GIFs (public/state_images/state_NN.gif),
# so every cell, frame, layout guide, and final GIF is square 240x240.
CELL_WIDTH = 240
CELL_HEIGHT = 240

# (name, frames, durations_ms, loop, purpose)
STATES: list[tuple[str, int, list[int], bool, str]] = [
    # A001 基础状态: 呼吸 + 眨眼
    ("idle", 6, [280, 110, 110, 140, 140, 320], True,
     "neutral breathing and blinking idle loop; first frame is the reduced-motion still"),
    # A002 基础状态 "鲜活": 走来走去
    ("wander", 8, [140, 140, 140, 140, 140, 140, 140, 200], True,
     "calm walk/pace cycle, drifting a little while staying lively"),
    # A002 基础状态 "鲜活": 坐下起立
    ("sit-stand", 6, [160, 140, 140, 160, 200, 260], False,
     "sit down then stand back up, a settle-and-rise one-shot"),
    # B001 用户交互: 拖动 -> 小跑
    ("drag-trot", 6, [110, 110, 110, 110, 110, 180], True,
     "quick four-leg trot loop, the reaction to being dragged"),
    # C001 好友交互: 发消息
    ("message", 5, [160, 140, 140, 160, 280], False,
     "a send-a-message gesture: lean in, paw forward, settle"),
    # C002 好友交互: 贴贴
    ("cuddle", 6, [180, 150, 150, 180, 180, 240], True,
     "happy nuzzle/cuddle motion leaning toward a friend"),
    # C002 好友交互: 喂食
    ("feed", 6, [150, 130, 130, 150, 150, 220], True,
     "eating motion: head dips, chews, looks up satisfied"),
    # C002 好友交互: 踢飞 (被踢的一方)
    ("kicked", 6, [120, 90, 90, 110, 140, 260], False,
     "comedic launch after being kicked: tumble through poses and land dazed"),
    # C003 好友交互: 进入房间 (跑入)
    ("enter-run", 6, [110, 110, 110, 110, 120, 200], False,
     "run into the room then skid to a stop, an entrance one-shot"),
    # C003 好友交互: 别人进入时打招呼
    ("greet", 4, [150, 140, 140, 260], False,
     "a friendly greeting: raise a paw and tilt the head"),
    # C003 好友交互: 离开 (被抛出)
    ("leave-thrown", 6, [120, 100, 100, 120, 150, 260], False,
     "get tossed away on exit: lean back, fling up, shrink off"),
    # D001 状态动画: 开心
    ("happy", 6, [150, 130, 130, 150, 150, 220], True,
     "cheerful bounce/wiggle expressing happiness"),
    # D001 状态动画: 难过
    ("sad", 5, [260, 180, 180, 200, 320], True,
     "downcast slump with drooping ears and a slow sniffle loop"),
    # D002 状态动画: 忙碌
    ("busy", 6, [140, 130, 130, 140, 150, 220], True,
     "focused busy motion, head down working at a steady pace"),
    # D002 状态动画: 无聊
    ("bored", 5, [280, 180, 180, 200, 340], True,
     "listless bored idle: sway, sigh, look around slowly"),
]

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
