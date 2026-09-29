# Execution and repair

Requires Python 3 with Pillow. Resolve `SKILL_DIR` from the actual loaded skill folder.
Do not install dependencies or assume a global skill path unnecessarily. Commands use
`python3`; on Windows use the available Python launcher and equivalent absolute paths.

## Prepare and generate

```bash
python3 "$SKILL_DIR/scripts/prepare_pet_run.py" --pet-name "小幽灵" \
  --pet-id shy-ghost --pet-notes "A timid violet ghost" \
  --character-profile /absolute/profile.json --output-dir /absolute/run
python3 "$SKILL_DIR/scripts/pet_job_status.py" --run-dir /absolute/run
```

References use repeated `--reference`. A Chinese display name works without a supplied
slug (a stable hashed ID is generated). Preparation never resets an existing manifest;
resume it or choose a new directory. State definitions are frozen in `pet_request.json`
and shared by extraction, QA, composition, repairs and packaging. Do not edit the skill
source to select variants.

Load the installed `$imagegen` skill before actual generation and follow its tool and
fallback rules. Pass the prompt as a concise authoritative visual specification with
listed images and role labels. Do not add generic hero-art or marketing embellishment.
The base may be text-only; every row must attach canonical base and its layout guide.

```bash
python3 "$SKILL_DIR/scripts/record_imagegen_result.py" --run-dir /absolute/run \
  --job-id base --source /actual/tool-returned-image.png --source-tool imagegen
```

Recording validates the image, grounding-file availability and background, then copies
and hashes the original. It does not prove that the tool actually attached the images:
that remains an execution responsibility. File location and prefix are not provenance.
Do not use the hidden synthetic fixture option for real production.

Pilot: after base, generate idle and the profile's `pilot_state` (default enter). Inspect
source rows and optionally run extraction/composition with `--states idle,cast` (replace
cast with the selected pilot). Check identity, anatomy, scale, spacing and motion before
remaining jobs. Default cost is one base plus 14 required rows and two idle rows, before
repairs; custom selection changes the total. Do not generate extra candidates by habit.

Optional worker handoff:

```text
Generate only <state> for <run> using the exact prompt at <path>.
Inputs: <each manifest image path and role>.
Use $imagegen and inspect the selected result for correct frame count, canonical
identity, existing anatomy, state action, clean chroma, spacing and complete poses.
Return selected original output path and concise QA observations.
Do not edit manifests, record results, finalize or package.
```

The parent serializes record calls. Use sequential jobs when delegation is unavailable.
`generate_pet_images.py` is a legacy secondary provider; do not invoke it routinely.
Use it only if the installed imagegen workflow explicitly permits that fallback and
its credentials/cost requirements are satisfied; normal work stays with imagegen.

## Finalize, review, package

```bash
python3 "$SKILL_DIR/scripts/finalize_pet_run.py" --run-dir /absolute/run
```

This prepares `gifs/`, `qa/contact-sheet.png`, machine reports and self-contained
`qa/preview.html`. It reports `awaiting_visual_review`, not a completed pet. Open the
preview in a browser and inspect actual GIF motion, dark/light backgrounds, smaller
sizes, transitions and mirrored cuddle. If motion inspection is unavailable, explicitly
leave visual review pending rather than claiming a pass from the contact sheet.

After actual review:

```bash
python3 "$SKILL_DIR/scripts/visual_review.py" --run-dir /absolute/run \
  --verdict pass --reviewer "agent or human reviewer" \
  --note "Specific observations of identity, motion, loop seams and transitions"
python3 "$SKILL_DIR/scripts/finalize_pet_run.py" --run-dir /absolute/run --package \
  --package-dir /absolute/output/shy-ghost
```

A review is bound to the run request and all GIF hashes; changed output invalidates it.
Packaging refuses to overwrite an existing pet by default. The standalone package tool
also requires the reviewed run; `--force` is an intentional replacement, not a default.
Keep source prompts, decoded rows and reports while repairs may be needed. No automatic
source deletion: decoded hashes allow resuming if the tool's external original expires.

## Repairs

Classify first: generation identity/anatomy/action failure, key/background failure,
layout/clipping failure, extraction artifact, or timing/transition issue. Compare source
strip against extracted frames before regenerating. Stable slots preserve generated
coordinates; do not fix bad spacing by silently recentring all poses.

```bash
python3 "$SKILL_DIR/scripts/queue_pet_repairs.py" --run-dir /absolute/run \
  --states cast --reason "The ghost grew a hand" \
  --note "Keep the wand touching the existing flexible body tip; no new limbs"
```

Without `--states`, the queue reads machine `qa/review.json`. It archives only the failed
row, records attempt history and replaces the prior repair note instead of accumulating
contradictory prompts. Regenerate and record that job, then finalize and review again.
Default `--max-repairs 2` is frozen at preparation; at exhaustion revise the design or
agree a new budget before another run. Do not repeatedly reset a run to evade the cap.
