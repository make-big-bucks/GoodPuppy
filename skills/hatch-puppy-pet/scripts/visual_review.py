#!/usr/bin/env python3
"""Record an actual visual review against the exact generated GIFs and run request."""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
from datetime import datetime, timezone


def artifact_hashes(run_dir: Path) -> dict[str, str]:
    request_path = run_dir / 'pet_request.json'
    request = json.loads(request_path.read_text(encoding='utf-8'))
    paths = [request_path] + [run_dir / 'gifs' / f"{row['state']}.gif" for row in request['states']]
    return {str(path.relative_to(run_dir)): hashlib.sha256(path.read_bytes()).hexdigest() for path in paths}


def accepted_review(run_dir: Path) -> bool:
    path = run_dir / 'qa' / 'visual-review.json'
    if not path.is_file():
        return False
    review = json.loads(path.read_text(encoding='utf-8'))
    return review.get('verdict') == 'pass' and review.get('artifacts') == artifact_hashes(run_dir)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--run-dir', required=True)
    parser.add_argument('--verdict', choices=['pass', 'fail'], required=True)
    parser.add_argument('--reviewer', required=True)
    parser.add_argument('--note', required=True, help='Actual observations of identity, motion, transitions and readability')
    args = parser.parse_args()
    if not args.note.strip() or not args.reviewer.strip():
        raise SystemExit('reviewer and observations are required')
    run_dir = Path(args.run_dir).resolve()
    result = dict(verdict=args.verdict, reviewer=args.reviewer, note=args.note,
                  reviewed_at=datetime.now(timezone.utc).isoformat(), artifacts=artifact_hashes(run_dir))
    path = run_dir / 'qa' / 'visual-review.json'
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(result, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')
    print(path)


if __name__ == '__main__':
    main()
