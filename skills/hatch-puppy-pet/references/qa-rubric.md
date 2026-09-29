# Review criteria

## Machine checks

Require valid 240×240 GIFs, expected frames, durations and loop flags. Inspect every
decoded frame for visible content and actual background transparency, not just a GIF
metadata flag. Entirely identical sequences fail. Door-only enter/leave endpoints are
valid. Run states must agree across request, jobs, frames and package.

Default extraction preserves full slot coordinates. Edge pixels, relative area changes
and near-key pixels need interpretation: a large door, squash or airborne pose can be
intentional. Do not normalize away motion to improve a numerical score. Legacy
component/slot recentering needs explicit review and is not the production default.

## Visual checks

Inspect `qa/contact-sheet.png` for identity and composition, then `qa/preview.html`
for actual GIF motion, not just the first frame of an image attachment.

- Same character, anatomy, palette, material and permanent accessories across states;
  expressions and poses may change, no new limbs to perform animal-style gestures.
- Clear actions with meaningful anticipation, emphasis and recovery. Idle is subtle
  but visibly alive, emotion/work states distinct, personality recognizable.
- Stable intended scale and rest anchor across states; intentional flight and rightward
  cuddle survive extraction. No unexpected recentering, scale jumps or baseline pops.
- Smooth loop seams and `idle → action → idle` handoffs; leave intentionally ends with
  the door. Matching door design across enter/leave. No unexpected prop-side changes.
- Complete poses within slots, no neighboring fragments, copied guides, rectangular
  backgrounds, chroma halos or erased character colors. Check light AND dark backgrounds.
- Readable at 240px and smaller preview sizes; no distracting noise, tiny illegible
  detail or constantly exaggerated idle. Mirrored cuddle faces the partner correctly.

Record concrete observations through `visual_review.py`. A JSON pass documents a review,
it does not perform one. If actual motion cannot be inspected, leave acceptance pending.

## Repair and regression

Classify source generation versus extraction versus export failure before regenerating.
Repair one failed row; preserve the original and bounded attempt history. Replace the
previous repair note, do not accumulate contradictory instructions. Base redesign
requires a new run. Default budget: two row repairs, then reconsider the approach.

For workflow changes, run the bundled unittest suite with synthetic fixtures explicitly
marked as tests. These validate geometry, configuration, export and review gates, not
art quality. For visual effectiveness, periodically evaluate real generated characters
covering quadruped, biped robot, limbless soft body, winged, long body and asymmetric
accessory designs. Record first-pass success, retries, generation calls, identity drift,
action recognizability and actual integration results. Do not claim those benchmarks
were run when only deterministic fixtures were tested.
