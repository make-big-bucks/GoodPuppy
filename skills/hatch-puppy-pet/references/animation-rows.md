# Animation States

GoodPuppy renders one transparent animated GIF per state, sized 240x240, swapped
into the pet `<img>` by `src/renderer.js`. The authoritative manifest lives in
`scripts/puppy_states.py`; this table mirrors it for review.

States come from `docs/桌宠动画清单.md` ("待制作" items only), with multi-action
entries split into independent single-character animations and named by action
semantics. `loop` GIFs repeat forever; `once` GIFs play through and hold the last
frame (the app re-triggers them).

| State | Source | Frames | Loop | Durations (ms) | Purpose |
| --- | --- | ---: | --- | --- | --- |
| `idle` | A001 | 6 | loop | 280, 110, 110, 140, 140, 320 | breathing + blinking; first frame is the reduced-motion still |
| `wander` | A002 | 8 | loop | 140×7, 200 | calm walk/pace cycle with a small drift |
| `sit-stand` | A002 | 6 | once | 160, 140, 140, 160, 200, 260 | sit down then stand back up |
| `drag-trot` | B001 | 6 | loop | 110×5, 180 | quick trot, the reaction to being dragged |
| `message` | C001 | 5 | once | 160, 140, 140, 160, 280 | send-a-message gesture |
| `cuddle` | C002 | 6 | loop | 180, 150, 150, 180, 180, 240 | nuzzle/cuddle toward a friend |
| `feed` | C002 | 6 | loop | 150, 130, 130, 150, 150, 220 | eating motion |
| `kicked` | C002 | 6 | once | 120, 90, 90, 110, 140, 260 | comedic launch after being kicked |
| `enter-run` | C003 | 6 | once | 110×4, 120, 200 | run into the room and skid to a stop |
| `greet` | C003 | 4 | once | 150, 140, 140, 260 | greeting gesture when a friend enters |
| `leave-thrown` | C003 | 6 | once | 120, 100, 100, 120, 150, 260 | tossed away on exit |
| `happy` | D001 | 6 | loop | 150, 130, 130, 150, 150, 220 | cheerful bounce |
| `sad` | D001 | 5 | loop | 260, 180, 180, 200, 320 | downcast slump |
| `busy` | D002 | 6 | loop | 140, 130, 130, 140, 150, 220 | focused busy motion |
| `bored` | D002 | 5 | loop | 280, 180, 180, 200, 340 | listless bored idle |

## Single-character rule

`cuddle`, `feed`, `kicked`, `enter-run`, `greet`, and `leave-thrown` describe
interactions between two pets, but each GIF shows only the single pet performing
its own action (the kicked pet plays `kicked`, not the kicker). Pairing two pets,
positioning, and timing are the GoodPuppy app's job, not the skill's.

## Generation layout

Each state is generated as one horizontal sprite strip of N equal 240x240 slots
(N = frame count), keyed off a flat chroma background, then extracted into frames
and assembled into the transparent GIF with the durations and loop flag above.
