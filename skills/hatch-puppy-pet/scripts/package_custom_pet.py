#!/usr/bin/env python3
"""Package validated per-state GIFs as a local GoodPuppy pet."""

from __future__ import annotations

from puppy_states import load_run_states

import argparse
import json
import re
import shutil
from pathlib import Path

from PIL import Image
from visual_review import accepted_review

from puppy_states import CELL_HEIGHT, CELL_WIDTH, DURATIONS, FRAME_COUNTS, LOOPS, STATE_NAMES


def default_package_dir(pet_id: str) -> Path:
    return Path.cwd() / "output" / "pets" / pet_id


def slugify(value: str) -> str:
    value = value.strip().lower()
    value = re.sub(r"[^a-z0-9]+", "-", value)
    value = re.sub(r"-{2,}", "-", value)
    return value.strip("-")


def validate_gif(path: Path, state: str) -> None:
    if not path.is_file():
        raise SystemExit(f"missing GIF for state {state}: {path}")
    with Image.open(path) as image:
        if image.format != "GIF":
            raise SystemExit(f"{state}: expected GIF, got {image.format}")
        if image.size != (CELL_WIDTH, CELL_HEIGHT):
            raise SystemExit(
                f"{state}: expected {CELL_WIDTH}x{CELL_HEIGHT}, got {image.width}x{image.height}"
            )
        frames = getattr(image, "n_frames", 1)
        if frames != FRAME_COUNTS[state]:
            raise SystemExit(f"{state}: expected {FRAME_COUNTS[state]} frames, got {frames}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pet-name", default="")
    parser.add_argument("--display-name", default="")
    parser.add_argument("--description", required=True)
    parser.add_argument("--gif-dir", required=True)
    parser.add_argument(
        "--output-dir",
        help="Exact pet package directory. Defaults to ./output/pets/<pet-name> under the current working directory.",
    )
    parser.add_argument("--force", action="store_true")
    parser.add_argument("--run-dir", required=True, help="Run whose current GIFs passed visual review")
    args = parser.parse_args()

    run_dir = Path(args.run_dir).expanduser().resolve()
    if not accepted_review(run_dir):
        raise SystemExit("visual review missing, failed or stale")
    jobs = json.loads((run_dir / "imagegen-jobs.json").read_text())["jobs"]
    if any(job.get("synthetic_test_source") for job in jobs):
        raise SystemExit("synthetic test sources cannot be delivered")

    raw_pet_name = (args.pet_name or args.display_name).strip()
    if not raw_pet_name:
        raise SystemExit("pet name is required")
    pet_id = slugify(raw_pet_name)
    if not pet_id:
        raise SystemExit("pet name must contain at least one letter or digit")
    display_name = (args.display_name or raw_pet_name).strip()

    gif_dir = Path(args.gif_dir).expanduser().resolve()
    if gif_dir != run_dir / "gifs":
        raise SystemExit("--gif-dir must be the reviewed run GIF directory")
    load_run_states(gif_dir)
    target_dir = (
        Path(args.output_dir).expanduser().resolve()
        if args.output_dir
        else default_package_dir(pet_id).resolve()
    )

    manifest_path = target_dir / "pet.json"
    if not args.force and manifest_path.exists():
        raise SystemExit(f"{target_dir} already contains pet files; pass --force to overwrite")

    states_manifest = []
    for state in STATE_NAMES:
        source = gif_dir / f"{state}.gif"
        validate_gif(source, state)
        from validate_gifs import validate_gif as validate_export
        result = validate_export(gif_dir, state, 50)
        if not result["ok"]:
            raise SystemExit("; ".join(result["errors"]))
        states_manifest.append(
            {
                "state": state,
                "file": source.name,
                "frames": FRAME_COUNTS[state],
                "durationsMs": DURATIONS[state],
                "loop": LOOPS[state],
            }
        )

    target_dir.mkdir(parents=True, exist_ok=True)
    for state in STATE_NAMES:
        shutil.copy2(gif_dir / f"{state}.gif", target_dir / f"{state}.gif")

    manifest = {
        "id": pet_id,
        "displayName": display_name,
        "description": args.description,
        "cell": {"width": CELL_WIDTH, "height": CELL_HEIGHT},
        "states": states_manifest,
    }
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")

    print(
        json.dumps(
            {"ok": True, "pet_dir": str(target_dir), "manifest": str(manifest_path)}, indent=2
        )
    )


if __name__ == "__main__":
    main()
