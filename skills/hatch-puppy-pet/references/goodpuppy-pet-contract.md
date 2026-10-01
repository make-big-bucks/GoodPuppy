# GoodPuppy resource and integration contract

The runtime uses `src/shared/pet/animationCatalog.ts` and `src/windows/pet/petState.ts`, with images
under `public/pets/<id>/<state>.gif`. It does not use a Codex sprite atlas or numbered
`state_images` files. Package metadata:

```json
{
  "id": "shy-ghost",
  "displayName": "小幽灵",
  "description": "A timid curious ghost.",
  "cell": {"width": 240, "height": 240},
  "states": [
    {"state": "idle", "file": "idle.gif", "frames": 6,
     "durationsMs": [280, 110, 110, 140, 140, 320], "loop": true}
  ]
}
```

Include every required state, not just the illustrative idle above. The runtime builds
`<state>.gif` paths, so `file` must match that convention. GIF transparency is binary.
Looping states repeat forever; one-shots omit the GIF loop extension. `cuddle` is a
looping resource played as a transient interaction for the runtime hold period.
The manifest supplies timing; the runtime controls state transitions and mirrors
cuddle to face the partner. No partner is painted into the GIF.

Required names and production timings are in `scripts/puppy_states.py`. Additional
`idle-[a-z][a-z-]*` variants are read from the manifest; the runtime has no fixed list
of animal flourishes. Generation freezes the actual selection in `pet_request.json`.
Do not silently change required semantics or timing presets while repairing a row.

## Package versus installation

A package defaults to `output/pets/<id>/`; it is not automatically installed.
When the user asks for integration into GoodPuppy:

1. Complete the visual review and package first. Inspect existing destination files;
   preserve unrelated pets and do not silently replace a same-ID character.
2. Copy the reviewed package to `public/pets/<id>/`.
3. Registration is automatic: the build reads `public/pets/*/pet.json` through
   `tools/petRegistry.mjs`. Keep the manifest ID equal to the directory and provide
   every listed state/skin file. `default` is reserved for shiba. Do not change the
   default or account selection unless requested; copying files does not select it.
4. Run `check_project_pet.py --project-root <repo> --pet-id <id>`, frontend tests and
   build when changing registration. This checks the actual registry, manifest and
   decoded GIFs; it does not replace a running-app review.
5. Verify the loaded image path, idle variants, state transitions and partner-facing
   cuddle in the app. Report any unverified desktop behavior separately.

No account/database update is part of packaging. Follow repository rules for any
separately requested persistent account selection changes.
