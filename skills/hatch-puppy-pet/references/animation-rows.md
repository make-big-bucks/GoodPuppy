# Animation States

GoodPuppy renders one transparent animated GIF per state, sized 240x240, swapped
into the pet `<img>` by `src/renderer.js`. The authoritative manifest lives in
`scripts/puppy_states.py`; this table mirrors it for review.

States come from `docs/桌宠动画清单.md` and ADR-0009 (分层动画的双角色互动与 idle
变体). `loop` GIFs repeat forever; `once` GIFs play through and hold the last
frame (the app re-triggers them).

## Required states (every pet ships all 14)

| State | Source | Frames | Loop | Durations (ms) | Purpose |
| --- | --- | ---: | --- | --- | --- |
| `idle` | A001 | 6 | loop | 280, 110, 110, 140, 140, 320 | breathing + blinking; first frame is the reduced-motion still |
| `drag-lift` | B001 | 6 | loop | 110×5, 180 | held aloft by an invisible grip, limbs dangling; direction-neutral |
| `message` | C001 | 6 | once | 140, 140, 150, 150, 160, 260 | pick up a pixel paper plane and toss it away |
| `cuddle` | C002 | 6 | loop | 180, 150, 150, 180, 180, 240 | press against the RIGHT slot edge; app mirrors the other side |
| `cast` | C002 | 6 | once | 140, 130, 130, 150, 160, 260 | actor animation for feed/kick: wave a pixel magic wand |
| `feed` | C002 | 8 | once | 160, 140, 140, 140, 140, 150, 160, 260 | food pack appears in front, pet eats it up, looks satisfied |
| `kicked` | C002 | 6 | once | 120, 90, 90, 110, 140, 260 | comedic launch after being kicked |
| `enter` | C003 | 8 | once | 150, 130, 120, 120, 120, 130, 150, 260 | door appears, pet steps out of it, door vanishes |
| `greet` | C003 | 4 | once | 150, 140, 140, 260 | greeting gesture when a friend enters |
| `leave` | C003 | 8 | once | 150, 130, 120, 120, 120, 130, 150, 280 | pet walks into a door and disappears; final frame is door only |
| `happy` | D001 | 6 | loop | 150, 130, 130, 150, 150, 220 | cheerful bounce |
| `sad` | D001 | 5 | loop | 260, 180, 180, 200, 320 | downcast slump |
| `busy` | D002 | 6 | loop | 140, 130, 130, 140, 150, 220 | do-not-disturb focus at a tiny pixel desk/laptop |
| `bored` | D002 | 5 | loop | 280, 180, 180, 200, 340 | listless bored idle |

## Idle variant pool (per-pet flavor, default 2 selected)

The old fixed `wander` / `sit-stand` pair is replaced by per-pet idle variants.
The app plays any `idle-*` state declared in `pet.json` on a random timer while
idle, so different pets can ship different flourishes. The pool below has fixed
specs for stable generation; `SELECTED_IDLE_VARIANTS` in `puppy_states.py`
chooses which entries a run generates (default: `idle-stretch`, `idle-shake`).

| State | Frames | Loop | Durations (ms) | Purpose |
| --- | ---: | --- | --- | --- |
| `idle-stretch` | 6 | once | 160, 140, 140, 160, 180, 260 | long satisfying stretch |
| `idle-shake` | 6 | once | 120, 110, 110, 120, 140, 220 | quick full-body shake |
| `idle-sniff` | 6 | once | 150, 140, 140, 150, 160, 240 | curious ground sniffing |
| `idle-tail-chase` | 6 | once | 120, 110, 110, 110, 130, 200 | one playful tail-chase spin |
| `idle-scratch` | 6 | once | 140, 130, 130, 140, 160, 240 | scratch behind one ear |

## Single-character rule and allowed props

Every GIF still shows only the single pet performing its own action — never a
second pet, friend, or hand. Interaction pairing, timing, and mirroring are the
GoodPuppy app's job: feed/kick actors play `cast`, targets play `feed`/`kicked`;
`cuddle` plays on both sides and the app mirrors whichever pet's partner sits to
its left in the local layout.

Some states explicitly allow one inanimate prop (see `STATE_REQUIREMENTS` in
`scripts/prepare_pet_run.py`): the door (`enter`/`leave`, may be the only thing
in a frame), the food pack (`feed`, may be separate from the pet early on), the
paper plane (`message`, may detach in the final frames), the magic wand
(`cast`, always held), and the tiny desk/laptop (`busy`, always touching).
Props must be opaque, hard-edged, pixel-style, and stay inside their frame slot.

## Generation layout

Each state is generated as one horizontal sprite strip of N equal 240x240 slots
(N = frame count), keyed off a flat chroma background, then extracted into frames
and assembled into the transparent GIF with the durations and loop flag above.
Prop-heavy states (`enter`, `leave`, `feed`, `message`) are extracted with fixed
equal slots instead of connected-component grouping; keep every pose and prop
centered in its slot.
