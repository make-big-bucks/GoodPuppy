---
name: hatch-puppy-pet
description: Create, repair, validate, preview, and package GoodPuppy desktop-pet animations from character art, screenshots, generated images, or visual references. Use when a user wants to hatch a GoodPuppy pet, create a custom animated desktop pet, or build pet assets as per-state 240x240 transparent animated GIFs with row-by-row animation prompts, QA contact sheets, and pet.json packaging. This skill composes the installed $imagegen system skill for visual generation and uses bundled scripts for deterministic frame extraction and GIF assembly.
---

# Hatch Puppy Pet

## Overview

Create a GoodPuppy-compatible animated desktop pet from a concept, one or more
reference images, or both. This skill owns pet-specific prompt planning, animation
states, frame extraction, QA, previews, and packaging. It delegates visual
generation to `$imagegen`.

GoodPuppy renders one transparent animated GIF per state (240x240), swapped into the
pet `<img>` by `src/renderer.js`. This skill produces those per-state GIFs plus a
`pet.json` manifest. The 15 animation states come from `docs/桌宠动画清单.md`
("待制作" items), with multi-action entries split into independent single-character
animations and named by action semantics. See `references/animation-rows.md`.

User-facing inputs are optional. If the user omits a pet name, infer one from the
concept or reference filenames; if that is not possible, choose a short appropriate
name. If the user omits a description, infer one from the concept or references. If
the user omits reference images, generate the base pet from text first, then use that
base as the canonical reference for every animation row.

## Generation Delegation

Use `$imagegen` for all normal visual generation.

Before generating base art, row strips, or repair rows, load and follow the installed
image generation skill:

```text
${CODEX_HOME:-$HOME/.codex}/skills/.system/imagegen/SKILL.md
```

Do not call the Image API directly for the normal path. Let `$imagegen` choose its own
built-in-first path and its own CLI fallback rules. If `$imagegen` says a fallback
requires confirmation, ask the user before continuing.

When invoking `$imagegen` from this skill, pass the generated pet prompt as the
authoritative visual spec. Do not wrap it in the generic `$imagegen` shared prompt
schema and do not add extra polish, hero-art, photo, product, or illustration-style
augmentation. Pet prompts should stay terse, sprite-specific, and digital-pet
oriented; only add role labels for input images and any essential user constraint.

Use this skill's scripts for deterministic work only: preparing prompts and manifests,
ingesting selected `$imagegen` outputs, extracting frames, validating rows, composing
the per-state GIFs, creating QA media, and packaging.

Hard boundary: do not create, draw, tile, warp, mirror, or synthesize pet visuals with
local Python/Pillow scripts, SVG, canvas, HTML/CSS, or other code-native art as a
substitute for `$imagegen`. For a normal pet run, expect up to 16 visual generation
jobs: 1 base pet plus 15 row-strip jobs. The deterministic scripts may only process
already-generated visual outputs. If those calls are too expensive, blocked, or
unavailable, stop and explain the blocker instead of fabricating row strips locally.

Do not mark visual jobs complete by editing `imagegen-jobs.json`, copying files into
`decoded/`, or writing helper scripts that populate row outputs. Use
`record_imagegen_result.py` for selected built-in `$imagegen` outputs, or
`generate_pet_images.py` only for the documented secondary fallback.

Only the base job may be prompt-only. Every row-strip job generated through `$imagegen`
must use the input images listed in `imagegen-jobs.json`, including the canonical base
reference created after the base job is recorded. Treat any row generation without
attached grounding images as invalid.

## Codex Digital Pet Style

Default pet art should match the Codex app's built-in digital pets: small pixel-art-
adjacent mascots with compact chibi proportions, chunky readable silhouettes, thick
dark 1-2 px outlines, visible stepped/pixel edges, limited palettes, flat cel shading,
simple expressive faces, and tiny limbs. Even if the reference art is more detailed,
complex or realistic, the generated pet should be simplified into this style.

Do NOT generate polished illustration, painterly rendering, anime key art, 3D
rendering, glossy app-icon treatment, realistic fur or material texture, soft
gradients, high-detail antialiasing, and complex tiny accessories. References that are
more detailed than this should be simplified into the house style before row generation.

## Transparency And Effects

Pet rows are processed into transparent 240x240 cells and assembled into transparent
GIFs, so every generated pixel must either belong to the pet sprite or be cleanly
removable chroma-key background. Prefer pose, expression, and silhouette changes over
decorative effects.

Allowed effects must satisfy all of these conditions:

- The effect is state-relevant and helps explain the animation.
- The effect is physically attached to, touching, or overlapping the pet silhouette,
  not floating nearby.
- The effect is inside the same frame slot as the pet and does not create a separate
  sprite component.
- The effect is opaque, hard-edged, pixel-style, and uses non-chroma-key colors.
- The effect is small enough to remain readable at 240x240 without clutter.

Examples of allowed effects: a tear touching the face, a small smoke puff touching the
pet or prop, or tiny stars overlapping the pet during a dizzy reaction.

Avoid these by default because they usually break transparent-background cleanup or
component extraction:

- wave marks, motion arcs, speed lines, action streaks, afterimages, blur, or smears
- detached stars, loose sparkles, floating punctuation, floating icons, falling tear
  drops, separated smoke clouds, or loose dust
- cast shadows, contact shadows, drop shadows, oval floor shadows, floor patches,
  landing marks, impact bursts, glow, halo, aura, or soft transparent effects
- text, labels, frame numbers, visible grids, guide marks, speech bubbles, thought
  bubbles, UI panels, code snippets, checkerboard transparency, white backgrounds,
  black backgrounds, or scenery
- chroma-key-adjacent colors in the pet, prop, effects, highlights, or shadows
- stray pixels, disconnected outline bits, speckle/noise, cropped body parts,
  overlapping poses, or any pose that crosses into a neighboring frame slot
- a second pet, a friend, or a hand: every state is single-character

State-specific guidance:

- `wander`, `drag-trot`, `enter-run`: show locomotion through body, limb, and prop
  movement only. Do not draw speed lines, dust clouds, floor shadows, or motion trails.
- `sit-stand`: show the sit and rise through body height and leg pose only; no dust,
  shadows, or seating props.
- `greet`: show the greeting through paw and head pose only. Do not draw wave marks,
  motion arcs, lines, sparkles, or symbols around the paw.
- `message`: show it through head lean and a paw-forward gesture only. Do not draw
  speech bubbles, envelopes, hearts, punctuation, or floating UI.
- `cuddle`, `feed`: show through leaning/eating poses only; no hearts, sparkles, or a
  second character. A food morsel for `feed` is allowed only if opaque and touching
  the mouth inside the same frame slot.
- `kicked`, `leave-thrown`: show the launch/toss through body rotation and position
  only. Do not draw speed lines, motion arcs, impact bursts, dust, or another actor.
- `happy`, `sad`, `busy`, `bored`: show emotion/work through posture and face only.
  Tears (`sad`) or tiny dizzy stars (`bored`) are allowed only when attached to the
  pet inside the same frame slot; otherwise no floating symbols, zzz text, or bubbles.

## Pet Naming

Ask the user for a pet name when they have not provided one and only if the
conversation naturally allows it. If asking would slow down a direct execution request,
choose a short appropriate name from the pet concept, reference image, or personality,
then use that name consistently as the display name and as the source for the package
folder slug.

## Visible Progress Plan

For every pet run, keep a visible checklist so the user can see where the work is up to.
Create the checklist before starting, keep one step active at a time, and update it as
each step finishes.

Before creating the checklist, establish the pet name when possible. Use the
user-provided name when available; otherwise infer a short appropriate name from the
concept or references. If the name is too long, not settled, or not appropriate for a
friendly checklist, use `your pet` instead.

Use this checklist for a normal pet run, replacing `<Pet>` with the pet's name or
`your pet`:

1. Getting `<Pet>` ready.
2. Imagining `<Pet>`'s main look.
3. Picturing `<Pet>`'s poses.
4. Hatching `<Pet>`.

What each step means:

- `Getting <Pet> ready.` Choose or confirm the pet name, description, source images,
  and working folder.
- `Imagining <Pet>'s main look.` Generate the pet's main reference image. This is
  required for new pets, even when the user does not provide an image, because it
  becomes the visual source of truth.
- `Picturing <Pet>'s poses.` Create the pose rows, starting with `idle` to confirm the
  pet looks consistent, then the remaining states.
- `Hatching <Pet>.` Turn the approved poses into the final per-state GIFs, review the
  contact sheet and validation results, fix any broken parts, save `pet.json` and the
  GIFs into the package folder, then tell the user where the pet and QA files were saved.

Only mark a step complete when the real file, image, or decision exists. If this is just
a repair run, start from the first relevant step instead of restarting the whole checklist.

## Default Workflow

1. Prepare a pet run folder and imagegen job manifest:

```bash
SKILL_DIR="${CODEX_HOME:-$HOME/.codex}/skills/hatch-puppy-pet"
python "$SKILL_DIR/scripts/prepare_pet_run.py" \
  --pet-name "<Name>" \
  --description "<one sentence>" \
  --reference /absolute/path/to/reference.png \
  --output-dir /absolute/path/to/run \
  --pet-notes "<stable pet description>" \
  --style-notes "<style notes>" \
  --force
```

All arguments above are optional except any flags needed to express user constraints.
For text-only requests, pass the concept through `--pet-notes` and omit `--reference`;
`prepare_pet_run.py` will infer a name, description, chroma key, and output directory as
needed. It also writes 15 row-specific layout guide images under
`references/layout-guides/`, one per animation state. Treat these guides as invisible
construction references: the generated row strip must not include visible boxes,
borders, center marks, labels, guide colors, or the guide background.

2. Inspect the next ready `$imagegen` jobs:

```bash
python "$SKILL_DIR/scripts/pet_job_status.py" --run-dir /absolute/path/to/run
```

3. For each ready job, invoke `$imagegen` with:

- the prompt file listed in `imagegen-jobs.json`
- every input image listed for the job, with its role label
- the default built-in `image_gen` path unless `$imagegen` itself routes otherwise

The base job must complete first. If user references exist, the base job uses them. If
no references exist, the base job may be prompt-only. After recording the base,
`record_imagegen_result.py` writes `decoded/base.png` and
`references/canonical-base.png`; all row jobs use the original references if present
plus those canonical base images, and attach the matching
`references/layout-guides/<state>.png` as a layout-only guide.

When generating row strips, keep the identity lock authoritative: do not redesign the
pet, and preserve the same head shape, face, markings, palette, prop, outline weight,
body proportions, and silhouette. A row that looks like a related but different pet is
failed even if the deterministic geometry QA passes.

For the built-in path, record the selected source image from
`$CODEX_HOME/generated_images/.../ig_*.png`. Do not record files from the run
directory, `tmp/`, hand-made fixtures, deterministic row folders, or post-processed
copies as visual job sources.

4. After selecting a generated output for a job, ingest it:

```bash
python "$SKILL_DIR/scripts/record_imagegen_result.py" \
  --run-dir /absolute/path/to/run \
  --job-id <job-id> \
  --source /absolute/path/to/generated-output.png
```

This copies the image to the exact decoded path expected by the deterministic pipeline
and records source metadata in `imagegen-jobs.json`.

5. When all jobs are complete, finalize:

```bash
python "$SKILL_DIR/scripts/finalize_pet_run.py" \
  --run-dir /absolute/path/to/run
```

Finalize extracts frames, runs frame QA, builds the contact sheet, composes the
per-state transparent GIFs, validates them, and packages the pet. Expected output:

```text
run/
  pet_request.json
  imagegen-jobs.json
  prompts/
  decoded/
  frames/frames-manifest.json
  gifs/<state>.gif          # one transparent 240x240 GIF per state
  gifs/gifs-manifest.json
  gifs/validation.json
  qa/contact-sheet.png
  qa/review.json
  qa/run-summary.json
```

Package output defaults to `./output/pets/<pet-name>/` under the current working
directory. Pass `--package-dir` to stage the GIFs anywhere (for example a folder you
will copy into `public/state_images/`).

```text
<package-dir>/
  pet.json
  <state>.gif × 15
```

Review `qa/contact-sheet.png`, `qa/review.json`, and `gifs/validation.json` before
accepting the pet. Deterministic validation is necessary but not sufficient. Before
calling the pet done, visually inspect the contact sheet for identity consistency. Block
acceptance if any row changes species/body type, face, markings, palette, prop design,
prop side unexpectedly, or overall silhouette.

## Subagent Row Generation

After the base job has been recorded and `references/canonical-base.png` exists,
row-strip visual generation must use subagents unless the user explicitly says not to
use subagents for this session. Before row generation, state that subagents are being
used and which row jobs are being delegated. If subagents cannot be spawned because the
current environment or tool policy blocks them, stop before row-strip generation,
explain the blocker, and ask for explicit user direction before continuing sequentially.

The parent agent must own the manifest and package writes.

Default flow:

1. Parent runs `prepare_pet_run.py`.
2. Parent generates and records `base`.
3. Parent runs `pet_job_status.py`.
4. Parent spawns a subagent for `idle` first as an identity check.
5. Parent records the selected `idle` result.
6. Parent spawns subagents for every remaining row image-generation job (they all
   depend only on `base`, so they parallelize freely).
7. Each subagent receives the row prompt and every listed input image path, invokes
   `$imagegen`, and returns only the selected `$CODEX_HOME/generated_images/.../ig_*.png`
   source path plus a one-sentence QA note.
8. Parent alone runs `record_imagegen_result.py`, repair queueing, finalization, QA, and
   packaging.

Subagent write boundary: do not let subagents edit `imagegen-jobs.json`, copy files into
`decoded/`, run `record_imagegen_result.py`, run `finalize_pet_run.py`, or package the
pet. This avoids manifest races and keeps provenance checks centralized.

Subagent handoff contract:

- Give each subagent exactly one row job unless you are intentionally batching adjacent
  simple rows.
- Include the row id, the absolute prompt file path, the full prompt text or an
  instruction to read that exact prompt file, and every input image path with its role
  label from `imagegen-jobs.json`.
- Explicitly remind the subagent that the prompt's transparency and effects rules are
  mandatory: no detached effects, no wave marks, no speed lines or dust for locomotion
  rows, no second character, and only attached opaque sprite-like tears/smoke/stars when
  allowed by the state prompt.
- Tell the subagent to inspect the generated candidate for frame count, identity
  consistency, clean flat chroma-key background, safe spacing, and forbidden detached
  effects before returning it.
- Tell the subagent to return only the selected original
  `$CODEX_HOME/generated_images/.../ig_*.png` source path plus a one-sentence QA note.
  The parent decides whether to record or repair it.

Use this template for each subagent:

```text
Generate the `<row-id>` row for this hatch-puppy-pet run.

Run dir: <absolute run dir>
Prompt file: <absolute prompt file>
Input images:
- <absolute path> — <role>
- <absolute path> — <role>

Read and follow the row prompt exactly, including the Transparency and artifact rules.
Use `$imagegen` only; do not use local scripts to draw, tile, edit, or synthesize sprites.

Before returning, visually check:
- exact requested frame count
- same pet identity as the canonical base
- clean flat chroma-key background
- complete, separated, unclipped poses
- no second character and no forbidden detached effects or slot-crossing artifacts

Do not edit manifests, copy into decoded, record results, finalize, repair, or package.
Return only:
selected_source=/absolute/path/to/$CODEX_HOME/generated_images/.../ig_*.png
qa_note=<one sentence>
```

No silent sequential fallback: if subagents cannot be used for row-strip visual
generation, stop and ask for explicit user direction before continuing without them.
Only an explicit user instruction such as "do not use subagents" or "run this
sequentially" authorizes a normal sequential row-generation path. The final answer must
report which row jobs were delegated to subagents and which, if any, were repaired by
the parent.

## Repair Workflow

If finalization stops because row QA failed, queue targeted repair jobs:

```bash
python "$SKILL_DIR/scripts/queue_pet_repairs.py" \
  --run-dir /absolute/path/to/run
```

Then repeat the `$imagegen` generation and `record_imagegen_result.py` ingest loop for
each reopened row job. Regenerate the smallest failing scope: the failed state, not all
of them.

For identity repairs, use the canonical base image, original references, contact sheet,
and exact row failure note as grounding context. Repair only the failed row while
preserving the canonical pet identity.

## Secondary Image Generation Fallback

`scripts/generate_pet_images.py` is a secondary fallback for this skill.

Use it only when the installed `$imagegen` system skill is unavailable or cannot be
invoked in the current environment. Normal pet creation should delegate visual
generation to `$imagegen`, because `$imagegen` owns the built-in-first image generation
policy and its own CLI fallback behavior.

Run the secondary fallback only after explaining why `$imagegen` cannot be used:

```bash
python "$SKILL_DIR/scripts/generate_pet_images.py" \
  --run-dir /absolute/path/to/run \
  --model gpt-image-2 \
  --states all
```

The secondary fallback requires `OPENAI_API_KEY`.

## Rules

- Keep `$imagegen` as the primary generation layer.
- Keep reference images attached/visible for `$imagegen` whenever the chosen path
  supports references.
- Attach the row's `references/layout-guides/<state>.png` image to every row-strip job
  as a layout-only guide, and do not accept outputs that copy guide pixels.
- Use subagents for row-strip visual generation after the parent records the base image,
  unless the user explicitly says not to use subagents for this session.
- Generate every normal visual job with `$imagegen`: base plus all 15 row strips.
- Treat only the base job as eligible for prompt-only generation; every row job must
  attach its listed grounding images.
- Every animation is single-character; never generate a second pet, friend, or hand.
- Never substitute locally drawn, tiled, transformed, or code-generated row strips for
  missing `$imagegen` outputs.
- Never manually mutate `imagegen-jobs.json` to claim a visual job completed.
- Do not rely on generated images for exact GIF geometry; use this skill's deterministic
  scripts.
- Use the chroma key stored in `pet_request.json`; do not force a fixed green screen.
- Keep the pet's silhouette, face, materials, palette, and props consistent across all rows.
- Enforce the transparency and effects rules above in every base, row, and repair prompt.
- Treat visual identity drift as a blocker even when `qa/review.json` and
  `gifs/validation.json` have no errors.
- Treat a contact sheet that shows cropped references, repeated tiles, white cell
  backgrounds, or non-sprite fragments as failed.
- Treat forbidden detached effects, chroma-key-adjacent artifacts, shadows, glows,
  smears, dust, landing marks, wave marks, speed lines, or motion trails as failed rows.
- Treat `qa/review.json` errors as blockers. Warnings require visual review.

## Acceptance Criteria

- Each state GIF is a transparent GIF, exactly `240x240`, with the frame count and
  durations from `scripts/puppy_states.py`.
- Looping states loop forever; one-shot states play once and hold the final frame.
- The full state set in `references/animation-rows.md` is produced (15 states).
- Contact sheet has been produced unless explicitly skipped.
- `gifs/validation.json` and `qa/review.json` have no errors.
- Row-by-row review confirms the animation cycles are complete enough for GoodPuppy.
- `<package-dir>/pet.json` and one `<state>.gif` per state are staged together.
