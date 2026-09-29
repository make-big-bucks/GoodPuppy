---
name: hatch-puppy-pet
description: Create, repair, preview and package varied animated characters for GoodPuppy, from a concept or reference art. Use for GoodPuppy pet assets and project integration; use hatch-pet instead for Codex app pets.
---

# Hatch Puppy Pet

Create a recognizable character with coherent personality, expressive animation and a
validated GoodPuppy resource package. Use `$imagegen` for visual creation and these
scripts for deterministic processing. Never substitute locally drawn or transformed
copies of a still for missing generated animations.

## Read only what the task needs

- Before a new character: [character-design.md](references/character-design.md).
- Before generating or repairing: [workflow.md](references/workflow.md), including commands and worker handoff.
- Before delivery or integration: [goodpuppy-pet-contract.md](references/goodpuppy-pet-contract.md).
- During review: [qa-rubric.md](references/qa-rubric.md).
- For state meanings and timing: [animation-rows.md](references/animation-rows.md).

Resolve scripts relative to this SKILL.md; do not assume a global installation path.
The project entry `.codex/skills/hatch-puppy-pet` is a symlink to `skills/hatch-puppy-pet`.

## Creative decisions

Honor the user's character and style. Infer missing details and name without blocking
a direct request; do not turn every design decision into an approval step. For an
ambiguous concept, offer distinct directions when useful, then select one consistent
design before full production. Do not automatically generate multiple expensive bases.

Save identity, existing anatomy, personality, motion language and permanent props in a
run-level character profile. Distinguish identity invariants from allowed expression,
pose and squash/stretch. Never add limbs or ears merely to satisfy an animal-oriented
action. Pick idle variants that fit the character, including custom `idle-*` actions.

Style defaults to `auto`, respecting references and user direction. Pixel, sticker,
flat cartoon and toy-like styles are supported. Plush and painterly styles must keep
clean opaque contours; GIF cannot preserve soft partial transparency. At small display
sizes, recognizable silhouette and expression matter more than surface detail.

## Production sequence

1. Prepare the profile and run snapshot. Keep a short visible progress update covering design, generation, review and delivery.
2. Generate and record the base. Inspect it at pet size; it becomes the single identity authority.
3. Generate `idle` plus one representative difficult state from `pilot_states`; visually check both and process their frames before committing to the remaining rows. Choose a hard state relevant to the anatomy or props.
4. Generate remaining state rows with canonical base and the exact layout guide attached. Row jobs are technically ready after base; do not skip the pilot review just because they are ready.
5. Finalize to create GIFs, contact sheet and `qa/preview.html`. Review actual motion, cross-state scale, loop seams and transitions on light/dark backgrounds.
6. Repair only the failed scope. Fix extraction problems deterministically before spending on new imagery. Record actual visual observations, then finalize with `--package` to deliver.
7. If asked to make the character usable in this project, follow the integration contract and verify registration and loading. A staged package alone is not an installed character.

Use subagents for independent rows when available and appropriate; sequential execution
is valid. The parent owns recording, repair and package writes. Limit concurrent image
jobs to the environment's capacity; each worker receives one row, its prompt, inputs
and a concrete QA target. There is no required worker model.

## Hard invariants

- Every required GoodPuppy state is present, plus the run's selected idle variants. Each output is a transparent 240×240 GIF; timing and loop flags match the frozen run request.
- Canonical identity stays consistent; permanent accessories and temporary action props are distinct. Each state shows one character, with door-only endpoints explicitly permitted.
- All generated rows attach their listed grounding images. Record actual tool-returned originals, never fabricated provenance. Paths and hashes document lineage, not proof of visual quality.
- One coordinate system and scale across a row. Preserve deliberate travel, contact and deformation; do not normalize each pose to its bounding box. `auto` extraction uses stable slots.
- No scenery, cast shadows, visible guides, text or detached decoration. State-declared opaque props are allowed. Use the chosen chroma key nowhere in the character.
- Machine pass is not visual acceptance. A pass must describe observed identity, motion, transitions and readability, and is bound to current artifact hashes. Changed artifacts need renewed review.
- Default repair budget is two regenerations per state. At exhaustion, explain the failure and propose a revised design or method; do not silently spend on unlimited retries.

## Completion

Report package and preview paths, what was reviewed, remaining limitations and whether
project integration was performed. Never report synthetic tests as generated artwork,
a static contact sheet as motion review, or a package as installed without checking it.
