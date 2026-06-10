#!/usr/bin/env python3
"""Locked read-modify-write access to a pet run's imagegen-jobs.json.

record_imagegen_result.py and queue_pet_repairs.py both rewrite the whole
manifest. Without an exclusive lock, concurrent invocations lose updates:
the last writer wins and already-recorded jobs flip back to pending. Every
manifest writer must mutate it inside locked_manifest(), which re-reads the
file under an exclusive flock and writes it back before releasing the lock.
"""

from __future__ import annotations

import fcntl
import json
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator


@contextmanager
def locked_manifest(path: Path) -> Iterator[dict[str, object]]:
    if not path.exists():
        raise SystemExit(f"job manifest not found: {path}")
    with path.open("r+", encoding="utf-8") as handle:
        fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
        try:
            try:
                manifest = json.load(handle)
            except json.JSONDecodeError as error:
                raise SystemExit(f"invalid job manifest {path}: {error}") from error
            yield manifest
            handle.seek(0)
            handle.truncate()
            handle.write(json.dumps(manifest, indent=2) + "\n")
            handle.flush()
        finally:
            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
