import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS))
from manifest_lock import locked_manifest


class ManifestLockTests(unittest.TestCase):
    def test_exception_releases_lock_without_committing_partial_changes(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "imagegen-jobs.json"
            path.write_text('{"count":0}', encoding="utf-8")
            with self.assertRaises(RuntimeError):
                with locked_manifest(path) as manifest:
                    manifest["count"] = 99
                    raise RuntimeError("cancelled")
            with locked_manifest(path) as manifest:
                self.assertEqual(manifest["count"], 0)
                manifest["count"] = 1
            self.assertEqual(json.loads(path.read_text(encoding="utf-8"))["count"], 1)

    def test_two_processes_wait_for_the_lock_and_preserve_both_updates(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "imagegen-jobs.json"
            path.write_text('{"count":0}', encoding="utf-8")
            script = """
import sys
from pathlib import Path
sys.path.insert(0, sys.argv[1])
from manifest_lock import locked_manifest
print('starting', flush=True)
with locked_manifest(Path(sys.argv[2])) as manifest:
    manifest['count'] += 1
    print('locked', flush=True)
    if sys.argv[3] == 'hold': sys.stdin.readline()
"""
            def start(mode):
                return subprocess.Popen([sys.executable, "-c", script, str(SCRIPTS), str(path), mode],
                                        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            first = start("hold")
            second = None
            try:
                self.assertEqual(first.stdout.readline().strip(), "starting")
                self.assertEqual(first.stdout.readline().strip(), "locked")
                second = start("write")
                self.assertEqual(second.stdout.readline().strip(), "starting")
                with self.assertRaises(subprocess.TimeoutExpired):
                    second.communicate(timeout=0.2)
                first.stdin.write("release\n")
                first.stdin.flush()
                _, errors = first.communicate(timeout=15)
                self.assertEqual(first.returncode, 0, errors)
                _, errors = second.communicate(timeout=15)
                self.assertEqual(second.returncode, 0, errors)
                self.assertEqual(json.loads(path.read_text(encoding="utf-8"))["count"], 2)
            finally:
                for process in (first, second):
                    if process is not None:
                        if process.poll() is None: process.kill()
                        process.communicate(timeout=5)
