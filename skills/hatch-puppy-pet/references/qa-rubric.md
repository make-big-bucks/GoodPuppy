# QA Rubric

Do not accept the pet until all checks pass.

## Geometry

- Every GIF is exactly `240x240`.
- Each GIF has the exact expected frame count from `scripts/puppy_states.py`.
- Every GIF is a transparent GIF (reserved transparent palette index).
- `gifs/validation.json` (from `validate_gifs.py`) has no errors.
- `qa/review.json` (from `inspect_frames.py`) has no errors.
- `frames/frames-manifest.json` records component extraction for production rows,
  unless slot extraction was intentionally accepted after visual inspection.

## Character Consistency

- Same silhouette and proportions across every state.
- Same face and expression language.
- Same material, palette, lighting, and prop design.
- No frame introduces a new unintended character or object beyond the state's
  explicitly allowed prop (see `STATE_REQUIREMENTS` in `scripts/prepare_pet_run.py`).
- No GIF contains a second pet, a friend, or a hand — every state is single-character.

## Sprite Style

- Art reads as a Codex digital pet sprite, not a polished illustration or glossy app icon.
- Silhouette is compact and chunky enough to read inside a `240x240` cell.
- Outlines are dark and simple, with visible stepped/pixel-style edges.
- Palette is limited, with flat cel shading and minimal highlights or shadow steps.
- No painterly texture, realistic fur/material detail, soft gradients, high-detail
  antialiasing, or tiny accessories that disappear at pet size.

## Animation Completeness

- Each state uses the exact expected number of frames.
- Looping states loop without an obvious pop between the last and first frame.
- Directional states (`cuddle`, `kicked`, `enter`, `leave`) read as the intended
  direction/motion; `cuddle` must press against the RIGHT slot edge (the app mirrors
  the other side), and `drag-lift` must read direction-neutral.
- Prop states (`enter`/`leave` door, `feed` food pack, `message` paper plane,
  `cast` wand, `busy` desk/laptop) show exactly the one allowed prop, opaque and
  pixel-style; `enter` first frame and `leave` last frame may be door-only, and
  that is not a missing-sprite failure.
- State-specific actions are recognizable at pet size.
- Poses are generated animation variants, not repeated copies of the same source image.

## App Fitness

- The first `idle` frame works as a static reduced-motion pet.
- No important detail is too small to read.
- No frame is clipped by the cell.
- Emotion/work/interaction states are distinct from ordinary idle.
- Contact sheets must show whole sprite poses inside cells, not cropped tiles from a
  larger reference image.
- Contact sheets must not be accepted if every used frame is just the reference image
  with small geometric transforms.
- Used frames must not have white or opaque rectangular backgrounds unless the pet
  intentionally fills the whole cell and the user accepts that tradeoff.
- The chroma key must be visually absent from the character. If extraction removes
  character regions, choose a different key and regenerate the affected base/rows.
- Contact sheets must not show edge slivers or partial neighboring sprites inside cells.
- Contact sheets must not show darker/lighter versions of the chroma key as shadows,
  dust, smears, glows, landing marks, or motion effects. These are background
  extraction failures and should trigger row repair.
- If `qa/review.json` reports edge pixels, sparse frames, size outliers, or
  slot-extraction fallback, inspect the row visually and repair it when the issue is visible.
- If `qa/review.json` reports chroma-adjacent non-transparent pixels, repair the row
  unless those pixels are an intentional character color and the selected key was
  manually accepted.

## Repair Policy

Repair the smallest failing scope first:

1. Single bad frame.
2. One row/state.
3. Full regeneration only when identity or layout is broadly broken.

The normal production path should queue targeted repair jobs for failing states.
Manual repair should preserve the same run directory and regenerate only the affected
row prompt/image unless the base character is wrong.
