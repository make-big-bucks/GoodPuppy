#!/usr/bin/env python3
"""Locked read-modify-write access to a pet run's imagegen-jobs.json.

record_imagegen_result.py and queue_pet_repairs.py both rewrite the whole
manifest. Without an exclusive lock, concurrent invocations lose updates:
the last writer wins and already-recorded jobs flip back to pending. Every
manifest writer must mutate it inside locked_manifest(), which re-reads the
file under an exclusive platform lock and writes it back before releasing it.
"""

from __future__ import annotations

import os

if os.name == "nt":
    import msvcrt
else:
    import fcntl
import json
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator


@contextmanager
def locked_manifest(path: Path) -> Iterator[dict[str, object]]:
    if not path.exists():
        raise SystemExit(f"job manifest not found: {path}")
    # 稳定的旁路锁文件避免对 Windows JSON 读写/截断区域施加字节锁。
    with path.with_name(path.name + ".lock").open("a+b") as lock:
        if os.name == "nt":
            lock.seek(0)
            msvcrt.locking(lock.fileno(), msvcrt.LK_LOCK, 1)
        else:
            fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
        try:
            with path.open("r+", encoding="utf-8") as handle:
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
            if os.name == "nt":
                lock.seek(0)
                msvcrt.locking(lock.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(lock.fileno(), fcntl.LOCK_UN)
