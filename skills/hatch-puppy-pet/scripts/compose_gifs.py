#!/usr/bin/env python3
"""Compose per-state transparent animated GIFs from extracted GoodPuppy frames.

Reads the 240x240 RGBA frame PNGs produced by extract_strip_frames.py (one folder
per state under --frames-root) and assembles one transparent animated GIF per state
using the per-frame durations and loop flag from puppy_states.STATES.

Looping states (idle, ambient, emotions) loop forever; one-shot states (idle variants,
greet, kicked, ...) play once and hold the final frame, which is what the GoodPuppy
renderer wants when it swaps the <img> src.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from PIL import Image

from puppy_states import (
    CELL_HEIGHT,
    CELL_WIDTH,
    DURATIONS,
    FRAME_COUNTS,
    LOOPS,
    parse_states,
)

IMAGE_SUFFIXES = {".png", ".webp"}
# Reserve palette index 255 for full transparency; quantize colors into 0..254.
TRANSPARENT_INDEX = 255
ALPHA_CUTOFF = 128


def frame_files(state_dir: Path) -> list[Path]:
    if not state_dir.is_dir():
        return []
    return sorted(
        path for path in state_dir.iterdir() if path.suffix.lower() in IMAGE_SUFFIXES
    )


def to_transparent_palette(frame: Image.Image) -> Image.Image:
    """Convert an RGBA frame to a P-mode frame with a reserved transparent index."""
    rgba = frame.convert("RGBA")
    if rgba.size != (CELL_WIDTH, CELL_HEIGHT):
        canvas = Image.new("RGBA", (CELL_WIDTH, CELL_HEIGHT), (0, 0, 0, 0))
        left = (CELL_WIDTH - rgba.width) // 2
        top = (CELL_HEIGHT - rgba.height) // 2
        canvas.alpha_composite(rgba, (left, top))
        rgba = canvas

    # Quantize visible colors into indices 0..254 so 255 stays free for transparency.
    paletted = rgba.convert("RGB").quantize(colors=TRANSPARENT_INDEX, method=Image.MEDIANCUT)

    # Mark every pixel whose alpha is below the cutoff as the transparent index.
    alpha = rgba.getchannel("A")
    transparent_mask = alpha.point(lambda value: 255 if value < ALPHA_CUTOFF else 0)
    paletted.paste(TRANSPARENT_INDEX, mask=transparent_mask)
    paletted.info["transparency"] = TRANSPARENT_INDEX
    return paletted


def compose_state_gif(state: str, frames_root: Path, output_dir: Path) -> dict[str, object]:
    expected = FRAME_COUNTS[state]
    files = frame_files(frames_root / state)
    if len(files) < expected:
        raise SystemExit(
            f"{state} needs {expected} frames, found {len(files)} under {frames_root / state}"
        )

    frames = [to_transparent_palette(Image.open(path)) for path in files[:expected]]
    durations = DURATIONS[state]
    loop = LOOPS[state]

    output = output_dir / f"{state}.gif"
    output.parent.mkdir(parents=True, exist_ok=True)
    save_kwargs: dict[str, object] = {
        "save_all": True,
        "append_images": frames[1:],
        "duration": durations,
        "disposal": 2,  # restore to transparent background between frames
        "transparency": TRANSPARENT_INDEX,
        "optimize": False,
    }
    if loop:
        save_kwargs["loop"] = 0  # 0 == loop forever
    # When loop is omitted entirely, viewers play the GIF exactly once.
    frames[0].save(output, **save_kwargs)
    return {
        "state": state,
        "file": output.name,
        "path": str(output),
        "frames": expected,
        "durations_ms": durations,
        "loop": loop,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--frames-root", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--states", default="all")
    args = parser.parse_args()

    frames_root = Path(args.frames_root).expanduser().resolve()
    output_dir = Path(args.output_dir).expanduser().resolve()
    states = parse_states(args.states)

    composed = [compose_state_gif(state, frames_root, output_dir) for state in states]
    manifest = {"ok": True, "output_dir": str(output_dir), "gifs": composed}
    (output_dir / "gifs-manifest.json").write_text(
        json.dumps(manifest, indent=2) + "\n", encoding="utf-8"
    )
    print(json.dumps({"ok": True, "output_dir": str(output_dir), "states": states}, indent=2))


if __name__ == "__main__":
    main()
