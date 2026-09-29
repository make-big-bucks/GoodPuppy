"""Behavioral regression tests; fixtures are intentionally synthetic, never deliverable art."""
import argparse
import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from PIL import Image, ImageDraw

SCRIPTS = Path(__file__).resolve().parents[1] / 'scripts'
sys.path.insert(0, str(SCRIPTS))
from extract_strip_frames import extract_stable_frames, remove_chroma_background
from puppy_states import load_run_states, STATE_NAMES, FRAME_COUNTS, REQUIRED_STATES, state_records, configure_states
from character_profile import select_states
from visual_review import artifact_hashes, accepted_review
from queue_pet_repairs import append_repair_note
from record_imagegen_result import check_background_flatness
from validate_gifs import validate_gif


class PipelineTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        load_run_states(self.root)

    def tearDown(self):
        self.temp.cleanup()

    def cli(self, script, *args, success=True):
        result = subprocess.run([sys.executable, str(SCRIPTS / script), *map(str, args)], capture_output=True, text=True)
        if success:
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        else:
            self.assertNotEqual(result.returncode, 0, result.stdout)
        return result

    def prepare(self):
        profile = self.root / 'profile.json'
        profile.write_text(json.dumps(dict(style_preset='clay', anatomy='No limbs or mouth; a flexible body tip',
            personality='Timid', pilot_state='cast', idle_variants=[dict(state='idle-peek', frames=3,
            durations_ms=[100, 200, 300], loop=False, purpose='Peek, shrink, recover')])) )
        run = self.root / 'run'
        self.cli('prepare_pet_run.py', '--pet-name', '小幽灵', '--character-profile', profile, '--output-dir', run)
        return run

    def test_stable_slots_preserve_translation_and_scale(self):
        strip = Image.new('RGBA', (480, 240))
        draw = ImageDraw.Draw(strip)
        draw.rectangle((30, 20, 69, 59), fill='red')
        draw.rectangle((370, 120, 409, 159), fill='red')
        frames = extract_stable_frames(strip, 2)
        self.assertEqual(frames[0].getbbox(), (30, 20, 70, 60))
        self.assertEqual(frames[1].getbbox(), (130, 120, 170, 160))
        # Uniform scaling preserves relative movement even for a non-square source slot.
        bigger = strip.resize((960, 480), Image.Resampling.NEAREST)
        self.assertEqual([im.getbbox() for im in extract_stable_frames(bigger, 2, pixel=True)],
                         [im.getbbox() for im in frames])

    def test_key_removal_has_no_hidden_color(self):
        image = Image.new('RGBA', (2, 2), '#ff00ff')
        self.assertEqual(remove_chroma_background(image, (255, 0, 255), 96).getpixel((0, 0)), (0, 0, 0, 0))

    def test_custom_states_are_run_local_and_resume_is_safe(self):
        run = self.prepare()
        request = json.loads((run / 'pet_request.json').read_text())
        self.assertTrue(request['pet_id'].startswith('pet-'))
        self.assertEqual(request['style_preset'], 'clay')
        load_run_states(run / 'frames')
        self.assertEqual(FRAME_COUNTS['idle-peek'], 3)
        self.assertNotIn('idle-stretch', STATE_NAMES)
        jobs = json.loads((run / 'imagegen-jobs.json').read_text())['jobs']
        self.assertEqual(len(jobs[1]['input_images']), 2)
        self.cli('prepare_pet_run.py', '--pet-name', 'other', '--output-dir', run, '--force', success=False)
        load_run_states(self.root / 'another-run')
        self.assertNotIn('idle-peek', STATE_NAMES)
        self.assertIn('idle-stretch', STATE_NAMES)

    def test_invalid_custom_timing_and_names_rejected(self):
        for name, durations in [('idle-BAD', [100, 100]), ('idle-peek', [101, 100])]:
            with self.assertRaises(SystemExit):
                configure_states(state_records(REQUIRED_STATES) + [dict(state=name, frames=2, durations_ms=durations, loop=False, purpose='peek')])

    def test_export_validation_checks_later_frames(self):
        select_states({'idle_variants': [dict(state='idle-test', frames=3,
            durations_ms=[100, 100, 100], loop=False, purpose='test')]}, None)
        from compose_gifs import to_transparent_palette
        frames = []
        for index in range(3):
            image = Image.new('RGBA', (240, 240))
            if index != 1:
                ImageDraw.Draw(image).rectangle((60+index, 70, 140+index, 160), fill='red')
            frames.append(to_transparent_palette(image))
        frames[0].save(self.root/'idle-test.gif', save_all=True, append_images=frames[1:],
                       duration=[100,100,100], disposal=2, transparency=255, optimize=False)
        result = validate_gif(self.root, 'idle-test', 50)
        self.assertFalse(result['ok'])
        self.assertTrue(any('frame 1 is empty' in error for error in result['errors']))

    def test_full_synthetic_run_review_repair_and_delivery_gate(self):
        run = self.prepare()
        request = json.loads((run / 'pet_request.json').read_text())
        key = request['chroma_key']['hex']
        rows = [('base', 1)] + [(row['state'], row['frames']) for row in request['states']]
        for name, count in rows:
            source = self.root / f'{name}.png'
            image = Image.new('RGB', (240 * count, 240), key)
            draw = ImageDraw.Draw(image)
            for i in range(count):
                draw.rectangle((i*240 + 60 + i*2, 70, i*240 + 140 + i*2, 160), fill='#7744aa')
            image.save(source)
            self.cli('record_imagegen_result.py', '--run-dir', run, '--job-id', name, '--source', source, '--allow-synthetic-test-source')
        self.cli('finalize_pet_run.py', '--run-dir', run, '--allow-synthetic-test-sources')
        summary = json.loads((run / 'qa/run-summary.json').read_text())
        self.assertEqual(summary['status'], 'awaiting_visual_review')
        self.assertFalse(summary['ok'])
        self.assertTrue((run / 'qa/preview.html').is_file())
        with Image.open(run / 'gifs/idle-peek.gif') as image:
            self.assertEqual(image.n_frames, 3)
        # Static installation check must distinguish packaged files from a registered ID.
        project = self.root/'project'
        directory = project/'public/pets'/request['pet_id']
        shutil.copytree(run/'gifs', directory)
        manifest = dict(id=request['pet_id'], cell=request['cell'], states=[
            dict(state=r['state'], file=r['state']+'.gif', frames=r['frames'],
                 durationsMs=r['durations_ms'], loop=r['loop']) for r in request['states']])
        (directory/'pet.json').write_text(json.dumps(manifest))
        catalog = project/'src/windows/pet/animationCatalog.ts'
        catalog.parent.mkdir(parents=True)
        catalog.write_text('const PET_REGISTRY = Object.freeze({shiba: "shiba"});')
        self.cli('check_project_pet.py', '--project-root', project, '--pet-id', request['pet_id'], success=False)
        catalog.write_text('const PET_REGISTRY = Object.freeze({' + json.dumps(request['pet_id']) + ':' + json.dumps(request['pet_id']) + '});')
        self.cli('check_project_pet.py', '--project-root', project, '--pet-id', request['pet_id'])
        # No review cannot package; even a recorded synthetic review cannot deliver fixtures.
        self.cli('package_custom_pet.py', '--run-dir', run, '--pet-name', 'fixture', '--description', 'test', '--gif-dir', run/'gifs', success=False)
        self.cli('visual_review.py', '--run-dir', run, '--verdict', 'pass', '--reviewer', 'test fixture', '--note', 'Synthetic gate test, not actual art review')
        self.assertTrue(accepted_review(run))
        self.cli('finalize_pet_run.py', '--run-dir', run, '--allow-synthetic-test-sources', '--package', success=False)
        self.cli('package_custom_pet.py', '--run-dir', run, '--pet-name', 'fixture', '--description', 'test', '--gif-dir', run/'gifs', success=False)
        with (run / 'gifs/idle-peek.gif').open('ab') as file:
            file.write(b'changed')
        self.assertFalse(accepted_review(run))
        self.cli('queue_pet_repairs.py', '--run-dir', run, '--states', 'idle-peek,idle-peek,idle-peek', '--reason', 'duplicate', success=False)
        for attempt in range(2):
            self.cli('queue_pet_repairs.py', '--run-dir', run, '--states', 'idle-peek', '--reason', f'failure {attempt}')
        prompt = (run / 'prompts/rows/idle-peek.md').read_text()
        self.assertEqual(prompt.count('Repair attempt '), 1)
        self.assertNotIn('failure 0', prompt)
        self.cli('queue_pet_repairs.py', '--run-dir', run, '--states', 'idle-peek', '--reason', 'again', success=False)
        self.assertFalse((run / 'qa/visual-review.json').exists())


if __name__ == '__main__':
    unittest.main()
