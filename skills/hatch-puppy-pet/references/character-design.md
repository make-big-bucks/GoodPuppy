# Character design and run profile

Use a compact JSON profile; omit fields that add no useful direction. It is saved in
`pet_request.json`, so repairs do not depend on conversational memory. Example:

```json
{
  "identity": "A violet bean-shaped ghost with two amber eyes and one crooked cap",
  "anatomy": "No hands, feet, ears or tail; flexible body tip can hold a prop against the body",
  "personality": "Timid but curious; tries to appear composed after surprises",
  "motion": "Small hesitant anticipation, elastic reaction, slow embarrassed recovery; floating rest center",
  "props": "Permanent crooked cap; enter and leave share a small rounded wooden door",
  "style_preset": "clay",
  "pilot_state": "cast",
  "actions": {
    "greet": "Lean out cautiously, make one small body-tip salute, then retreat with a shy smile",
    "cast": "Cradle the wand against the flexible body tip; gather courage before the flourish"
  },
  "idle_variants": [
    {
      "state": "idle-peek",
      "frames": 6,
      "durations_ms": [160, 140, 140, 160, 180, 260],
      "loop": false,
      "purpose": "Shrink shyly, peek out, realize nobody is watching, stretch back into the floating idle pose"
    }
  ]
}
```

`actions` supplements state semantics; it cannot replace required props, endpoints or
interaction direction. Custom variants need a legal `idle-[a-z][a-z-]*` name, 2–8
frames, matching `durations_ms` (20–5000ms, multiples of 10), `loop: false` and purpose.
An empty `idle_variants` array selects none. Without a selection, stretch/shake are
compatible defaults; for actual creative runs deliberately choose or write appropriate
variants. `--idle-variants` overrides the profile with comma-separated pool names.

Style presets: `auto`, `pixel`, `sticker`, `flat-vector`, `clay`, `3d-toy`, `plush`,
`painterly`. `--style-preset` overrides the profile; `--style-notes` adds direction.
Auto respects the requested/reference style, otherwise uses a simple flat cartoon.
A preset describes visual intent, not a guarantee that every material survives GIF.

Good briefs choose a few memorable invariants, not dozens of tiny details. Design for
240px and inspect smaller previews too. Use one dominant silhouette and clear face,
then give personality a visible timing habit. Adapt greeting, sadness and lifting to
existing anatomy. Keep the required wand, plane, food, laptop and door semantics while
varying their design consistently with the character. Do not turn a soft body into a
rigid still merely to preserve its outline.

For animation, specify meaningful key poses and where the emphasis occurs. Preserve
quiet but visible idle variation. Distinguish happy from idle, and bored from sad.
Loops include the last-to-first transition; most one-shots return near idle, while
leave intentionally ends with the door. Across rows, keep a compatible rest pose,
camera scale and standing baseline or floating center. A right-side cuddle contact
anchor overrides ordinary center placement, with a small transparent clearance.

Reference hierarchy: original art informs base design; selected base governs every
row. Attach only canonical base and layout guide by default, avoiding duplicate copies
and competing original references. If extra visual context is genuinely needed, state
its limited role. Once rows exist, redesigning the base requires a new run.
