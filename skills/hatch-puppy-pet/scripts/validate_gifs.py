#!/usr/bin/env python3
"""Validate the per-state transparent animated GIFs for a GoodPuppy pet."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from PIL import Image

from puppy_states import CELL_HEIGHT, CELL_WIDTH, DURATIONS, FRAME_COUNTS, LOOPS, STATE_NAMES


def gif_frame_count(image: Image.Image) -> int:
    return getattr(image, "n_frames", 1)


def gif_frame_durations(image: Image.Image) -> list[int]:
    durations: list[int] = []
    for index in range(gif_frame_count(image)):
        image.seek(index)
        durations.append(int(image.info.get("duration", 0)))
    return durations


def has_transparency(image: Image.Image) -> bool:
    if "transparency" in image.info:
        return True
    return image.mode in {"RGBA", "LA", "PA"}


def validate_gif(gif_dir: Path, state: str, min_used_pixels: int) -> dict[str, object]:
    errors: list[str] = []
    warnings: list[str] = []
    path = gif_dir / f"{state}.gif"
    expected_frames = FRAME_COUNTS[state]

    if not path.is_file():
        return {
            "state": state,
            "file": path.name,
            "ok": False,
            "errors": [f"missing GIF: {path}"],
            "warnings": [],
        }

    try:
        with Image.open(path) as opened:
            source_format = opened.format
            size = opened.size
            frames = gif_frame_count(opened)
            transparent = has_transparency(opened)
            # In a GIF, loop=0 means loop forever; no loop extension means play once.
            loop_info = opened.info.get("loop")
            first = opened.convert("RGBA")
            durations = gif_frame_durations(opened)
    except Exception as exc:  # noqa: BLE001
        return {
            "state": state,
            "file": path.name,
            "ok": False,
            "errors": [f"could not open GIF: {exc}"],
            "warnings": [],
        }

    if source_format != "GIF":
        errors.append(f"{state}: expected GIF, got {source_format}")
    if size != (CELL_WIDTH, CELL_HEIGHT):
        errors.append(f"{state}: expected {CELL_WIDTH}x{CELL_HEIGHT}, got {size[0]}x{size[1]}")
    if frames != expected_frames:
        errors.append(f"{state}: expected {expected_frames} frames, got {frames}")
    if not transparent:
        errors.append(f"{state}: GIF has no transparency index")

    expected_loop = LOOPS[state]
    if expected_loop and loop_info != 0:
        errors.append(f"{state}: expected an infinite loop (loop=0), got {loop_info!r}")
    if not expected_loop and loop_info is not None:
        errors.append(f"{state}: expected a play-once GIF (no loop extension), got loop={loop_info!r}")

    expected_durations = DURATIONS[state]
    if frames == expected_frames and durations != expected_durations:
        errors.append(
            f"{state}: per-frame durations {durations} do not match expected {expected_durations}"
        )

    visible = sum(first.getchannel("A").histogram()[1:])
    if visible < min_used_pixels:
        errors.append(f"{state}: first frame is empty or too sparse ({visible} visible pixels)")

    return {
        "state": state,
        "file": path.name,
        "format": source_format,
        "width": size[0],
        "height": size[1],
        "frames": frames,
        "expected_frames": expected_frames,
        "loop": LOOPS[state],
        "loop_info": loop_info,
        "durations_ms": durations,
        "transparent": transparent,
        "ok": not errors,
        "errors": errors,
        "warnings": warnings,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("gif_dir")
    parser.add_argument("--json-out")
    parser.add_argument("--min-used-pixels", type=int, default=50)
    args = parser.parse_args()

    gif_dir = Path(args.gif_dir).expanduser().resolve()
    states = [validate_gif(gif_dir, state, args.min_used_pixels) for state in STATE_NAMES]
    errors = [error for state in states for error in state["errors"]]
    warnings = [warning for state in states for warning in state["warnings"]]
    result = {
        "ok": not errors,
        "gif_dir": str(gif_dir),
        "errors": errors,
        "warnings": warnings,
        "states": states,
    }

    if args.json_out:
        Path(args.json_out).expanduser().resolve().write_text(
            json.dumps(result, indent=2) + "\n", encoding="utf-8"
        )

    print(json.dumps({k: v for k, v in result.items() if k != "states"}, indent=2))
    raise SystemExit(0 if result["ok"] else 1)


if __name__ == "__main__":
    main()
