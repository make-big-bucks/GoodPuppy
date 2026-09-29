#!/usr/bin/env python3
"""Create a labeled contact sheet from extracted GoodPuppy pet frames."""

from __future__ import annotations

from puppy_states import load_run_states

import argparse
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

from puppy_states import CELL_HEIGHT, CELL_WIDTH, FRAME_COUNTS, STATES

LABEL_HEIGHT = 22
IMAGE_SUFFIXES = {".png", ".webp"}
MAX_COLUMNS = max(FRAME_COUNTS.values())


def checker(size: tuple[int, int], square: int = 16) -> Image.Image:
    image = Image.new("RGB", size, "#ffffff")
    draw = ImageDraw.Draw(image)
    for y in range(0, size[1], square):
        for x in range(0, size[0], square):
            if (x // square + y // square) % 2:
                draw.rectangle((x, y, x + square - 1, y + square - 1), fill="#e8e8e8")
    return image


def frame_files(state_dir: Path) -> list[Path]:
    if not state_dir.is_dir():
        return []
    return sorted(
        path for path in state_dir.iterdir() if path.suffix.lower() in IMAGE_SUFFIXES
    )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("frames_root")
    parser.add_argument("--output", required=True)
    parser.add_argument("--scale", type=float, default=0.5)
    args = parser.parse_args()

    frames_root = Path(args.frames_root).expanduser().resolve()
    load_run_states(frames_root)
    cell_w = max(1, round(CELL_WIDTH * args.scale))
    cell_h = max(1, round(CELL_HEIGHT * args.scale))
    rows = len(STATES)
    width = MAX_COLUMNS * cell_w
    height = rows * (cell_h + LABEL_HEIGHT)
    sheet = Image.new("RGB", (width, height), "#f7f7f7")
    draw = ImageDraw.Draw(sheet)
    font = ImageFont.load_default()

    for row, (state, frame_count, _durations, loop, _purpose) in enumerate(STATES):
        y = row * (cell_h + LABEL_HEIGHT)
        draw.rectangle((0, y, width, y + LABEL_HEIGHT - 1), fill="#111111")
        draw.text((6, y + 5), f"{state}", fill="#ffffff", font=font)
        draw.text(
            (width - 132, y + 5),
            f"{frame_count} frames {'loop' if loop else 'once'}",
            fill="#ffffff",
            font=font,
        )
        files = frame_files(frames_root / state)
        for column in range(MAX_COLUMNS):
            x = column * cell_w
            bg = checker((cell_w, cell_h))
            if column < len(files):
                with Image.open(files[column]) as opened:
                    crop = opened.convert("RGBA").resize(
                        (cell_w, cell_h), Image.Resampling.LANCZOS
                    )
                bg.paste(crop, (0, 0), crop)
            sheet.paste(bg, (x, y + LABEL_HEIGHT))
            outline = "#18a058" if column < frame_count else "#cc3344"
            draw.rectangle(
                (x, y + LABEL_HEIGHT, x + cell_w - 1, y + LABEL_HEIGHT + cell_h - 1),
                outline=outline,
            )
            draw.text((x + 4, y + LABEL_HEIGHT + 4), str(column), fill="#111111", font=font)

    output = Path(args.output).expanduser().resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(output)
    print(f"wrote {output}")


if __name__ == "__main__":
    main()
