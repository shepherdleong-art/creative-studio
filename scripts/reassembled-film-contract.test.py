"""Negative delivery gates: ordinary movement cannot silently replace an opener."""
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).parent/'reassembled-film'))
from contract import OPENINGS, validate


class ContractTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='film-contract-test-')
        self.root = Path(self.temp.name)
        (self.root/'variants/01').mkdir(parents=True)
        (self.root/'review').mkdir()
        (self.root/'clip.mp4').write_bytes(b'reviewed-video-placeholder')
        self.timeline = dict(variant='01', width=1080, height=1440, fps=24, introFrames=20,
                             frames=480, duration=20, openingEffectId='carton-explosion',
                             shots=[dict(id='O01', file='../../clip.mp4', startFrame=20, endFrame=480, inSec=0, rate=1)])
        self.review = dict(variant='01', effectId='carton-explosion', shot='O01',
                           sourceFile='../../clip.mp4', status='visual_approved',
                           sha256=hashlib.sha256(b'reviewed-video-placeholder').hexdigest())

    def save(self):
        (self.root/'variants/01/timeline.json').write_text(json.dumps(self.timeline), encoding='utf8')
        (self.root/'review/opening-effects.json').write_text(json.dumps({'variants': [self.review]}), encoding='utf8')

    def tearDown(self):
        assert self.root.resolve().parent == Path(tempfile.gettempdir()).resolve()
        assert self.root.name.startswith('film-contract-test-')
        self.temp.cleanup()

    def test_four_choices_and_no_generic_pan(self):
        for effect in OPENINGS:
            self.timeline['openingEffectId'] = self.review['effectId'] = effect
            self.save()
            self.assertEqual(validate(self.root, '01')['openingEffectId'], effect)
        self.timeline['openingEffectId'] = 'pan-left'; self.save()
        with self.assertRaises(ValueError): validate(self.root, '01')

    def test_visual_review_cannot_be_skipped(self):
        self.review['status'] = 'downloaded'; self.save()
        with self.assertRaises(ValueError): validate(self.root, '01')

    def test_replacing_reviewed_clip_invalidates_approval(self):
        self.save(); (self.root/'clip.mp4').write_bytes(b'different-video')
        with self.assertRaisesRegex(ValueError, 'changed'): validate(self.root, '01')

    def test_review_for_different_effect_cannot_pass(self):
        self.review['effectId'] = 'giant-hand-place'; self.save()
        with self.assertRaises(ValueError): validate(self.root, '01')


if __name__ == '__main__':
    unittest.main()
