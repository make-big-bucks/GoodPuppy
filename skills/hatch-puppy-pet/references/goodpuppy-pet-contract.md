# GoodPuppy Pet Contract

## Per-state GIFs

- Format: transparent animated GIF.
- Dimensions: `240x240` per GIF.
- One GIF per animation state (see `animation-rows.md`).
- Frame count and per-frame durations follow `scripts/puppy_states.py`.
- Background: transparent (1-bit GIF transparency via a reserved palette index).
- Looping states loop forever; one-shot states play once and hold the final frame.

GoodPuppy's `src/renderer.js` swaps the pet `<img>` `src` to the matching GIF;
there is no atlas, CSS background-position, gutter, border, grid line, or shadow
outside the sprite.

## Local custom pet package

Place files under the package directory (defaults to
`./output/pets/<pet-name>/` under the current working directory, but any
`--output-dir` works, e.g. a staging folder for `public/state_images/`):

```text
<package-dir>/
├── pet.json
├── idle.gif
├── wander.gif
├── ... (one GIF per state)
└── bored.gif
```

Manifest shape (`pet.json`):

```json
{
  "id": "pet-name",
  "displayName": "Pet Name",
  "description": "One short sentence.",
  "cell": { "width": 240, "height": 240 },
  "states": [
    {
      "state": "idle",
      "file": "idle.gif",
      "frames": 6,
      "durationsMs": [280, 110, 110, 140, 140, 320],
      "loop": true
    }
  ]
}
```

## Wiring into GoodPuppy

GoodPuppy currently loads animations by number: `/state_images/state_NN.gif`
(`stateCount = 24` in `src/petState.js`). Mapping these semantic GIFs onto state
numbers — or switching the renderer to load by semantic name from `pet.json` — is
a separate integration task and is intentionally out of scope for this skill.
