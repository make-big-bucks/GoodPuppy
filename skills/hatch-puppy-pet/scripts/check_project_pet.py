#!/usr/bin/env python3
"""Verify a staged pet's files and actual automatic registration in the current GoodPuppy project."""
from __future__ import annotations
import argparse
import json
import re
import subprocess
from pathlib import Path
from puppy_states import REQUIRED_STATES, configure_states
from validate_gifs import validate_gif


def check(project: Path, pet_id: str) -> dict:
    if not re.fullmatch(r'[a-z0-9]+(?:-[a-z0-9]+)*', pet_id):
        raise SystemExit('invalid pet id')
    directory = project / 'public' / 'pets' / pet_id
    errors = []
    manifest = json.loads((directory / 'pet.json').read_text(encoding='utf-8'))
    if manifest.get('id') != pet_id:
        errors.append('manifest id differs from directory')
    if manifest.get('cell') != {'width': 240, 'height': 240}:
        errors.append('manifest cell must be 240x240')
    records = []
    for row in manifest.get('states', []):
        if row.get('file') != f"{row.get('state')}.gif":
            errors.append(f"{row.get('state')}: runtime expects <state>.gif filename")
        records.append(dict(state=row.get('state'), frames=row.get('frames'), durations_ms=row.get('durationsMs'),
                            loop=row.get('loop'), purpose='Installed state'))
    configure_states(records)
    for row in records:
        errors.extend(validate_gif(directory, row['state'], 50)['errors'])
    registry_tool = project / 'tools/petRegistry.mjs'
    if not registry_tool.is_file():
        errors.append('project automatic registry tool is missing')
    else:
        result = subprocess.run(['node', str(registry_tool), str(project / 'public/pets'), pet_id],
                                capture_output=True, text=True, timeout=30)
        if result.returncode:
            errors.append('runtime registration failed: ' + result.stderr.strip()[:1000])
    return dict(ok=not errors, pet_id=pet_id, directory=str(directory), errors=errors,
                runtime_preview='not_checked', note='Static integration only; still verify state transitions and interactions in the app')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--project-root', required=True)
    parser.add_argument('--pet-id', required=True)
    args = parser.parse_args()
    result = check(Path(args.project_root).resolve(), args.pet_id)
    print(json.dumps(result, indent=2, ensure_ascii=False))
    raise SystemExit(0 if result['ok'] else 1)


if __name__ == '__main__':
    main()
