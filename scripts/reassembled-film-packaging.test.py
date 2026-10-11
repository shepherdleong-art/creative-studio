"""Annotation timing/geometry gates and packaging CLI compatibility."""
import copy
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

SCRIPTS = Path(__file__).parent/'reassembled-film'
sys.path.insert(0, str(SCRIPTS))
from callouts import render_callouts, validate_callouts
from contract import validate


def fixture(root):
    (root/'variants/01').mkdir(parents=True)
    (root/'review').mkdir()
    (root/'tools').mkdir()
    (root/'assets/assets/fonts').mkdir(parents=True)
    (root/'assets/assets/scripts').mkdir(parents=True)
    (root/'assets/assets/fonts/SourceHanSansCN-VF.ttf').write_bytes(b'fixture-font')
    (root/'assets/assets/scripts/gsap.min.js').write_text('/* fixture */')
    for name in ('opening.mp4', 'detail.mp4', 'outro.mp4', 'cover.png'):
        (root/'variants/01'/name).write_bytes(b'fixture')
    timeline = dict(variant='01', width=1080, height=1440, fps=24, introFrames=20,
                    frames=480, duration=20, openingEffectId='carton-explosion',
                    title=['舒适', '看得见'], endtitle=['好好', '休息'], tag='测试包装',
                    theme='fixture', coverImage='cover.png', subtitles=[],
                    shots=[dict(id='O01', file='opening.mp4', startFrame=20, endFrame=96, inSec=0, rate=1),
                           dict(id='S02', file='detail.mp4', startFrame=96, endFrame=408, inSec=0, rate=1),
                           dict(id='E03', file='outro.mp4', startFrame=408, endFrame=480, inSec=0, rate=1)])
    callout = dict(id='back', shot='S02', startFrame=120, endFrame=192,
                   title='双层高靠包', sub='头颈 都被托住', dot=[430, 600], pill=[80, 220],
                   dotKeyframes=[dict(frame=120, dot=[430, 600]), dict(frame=191, dot=[480, 650])])
    timeline['callouts'] = [callout]
    (root/'review/opening-effects.json').write_text(json.dumps(dict(variants=[dict(
        variant='01', effectId='carton-explosion', shot='O01', sourceFile='opening.mp4',
        status='visual_approved', sha256=hashlib.sha256(b'fixture').hexdigest())])))
    (root/'packaging.json').write_text(json.dumps(dict(productName='验证样例', brand='TEST', model='DEMO',
        variants={'01': dict(coverNote='fixture', labels={'S02': ['DETAIL', '旧大字', '', '']})})))
    (root/'DESIGN.md').write_text('本地包装验证，非产品成片。')
    (root/'tools/style.css').write_text('body{margin:0}.clip{position:absolute;inset:0}')
    (root/'variants/01/timeline.json').write_text(json.dumps(timeline))
    return timeline


class PackagingTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='film-packaging-test-')
        self.root = Path(self.temp.name)
        self.timeline = fixture(self.root)

    def tearDown(self):
        self.temp.cleanup()

    def save(self):
        (self.root/'variants/01/timeline.json').write_text(json.dumps(self.timeline))

    def test_valid_tracking_and_legacy_timeline(self):
        self.assertEqual(len(validate(self.root, '01')['timeline']['callouts']), 1)
        self.timeline.pop('callouts'); self.save()
        validate(self.root, '01')
        self.assertEqual(render_callouts(self.timeline), ('', [], ''))

    def test_cross_cut_and_cover_annotation_rejected(self):
        c = self.timeline['callouts'][0]
        for start, end in [(80, 140), (120, 481), (0, 72), (120, 130)]:
            with self.subTest(start=start, end=end):
                c['startFrame'], c['endFrame'] = start, end
                self.save()
                with self.assertRaisesRegex(ValueError, 'inside its shot'): validate(self.root, '01')

    def test_bad_coordinates_and_tracking_rejected(self):
        original = copy.deepcopy(self.timeline['callouts'][0])
        changes = [dict(dot=[float('nan'), 600]), dict(pill=[1000, 220]), dict(box=[-1, 100]),
                   dict(dotKeyframes=[]), dict(dotKeyframes=[dict(frame=121, dot=[430, 600]), dict(frame=191, dot=[480, 650])]),
                   dict(dotKeyframes=[dict(frame=120, dot=[440, 600]), dict(frame=191, dot=[480, 650])]),
                   dict(dotKeyframes=[dict(frame=120, dot=[430, 600]), dict(frame=192, dot=[480, 650])])]
        for change in changes:
            with self.subTest(change=change):
                self.timeline['callouts'] = [dict(original, **change)]
                with self.assertRaises(ValueError): validate_callouts(self.timeline)

    def test_tracking_cannot_cross_card_between_valid_endpoints(self):
        c = self.timeline['callouts'][0]
        c.update(dot=[40, 290], dotKeyframes=[dict(frame=120, dot=[40, 290]), dict(frame=191, dot=[500, 290])])
        with self.assertRaisesRegex(ValueError, 'crosses its card'): validate_callouts(self.timeline)

    def test_duplicate_ids_and_unknown_shots_rejected(self):
        self.timeline['callouts'].append(copy.deepcopy(self.timeline['callouts'][0]))
        with self.assertRaisesRegex(ValueError, 'duplicate'): validate_callouts(self.timeline)
        self.timeline['callouts'].pop()
        self.timeline['callouts'][0]['shot'] = 'unknown'
        with self.assertRaisesRegex(ValueError, 'inside its shot'): validate_callouts(self.timeline)

    def test_cli_escapes_text_and_preserves_static_cover(self):
        self.timeline['callouts'][0]['sub'] = '<script>alert(1)</script>'
        self.save()
        output = self.root/'hf-new'
        subprocess.run([sys.executable, str(SCRIPTS/'packaging.py'), str(self.root), '01',
                        '--assets', str(self.root/'assets'), '--output', str(output)], check=True, capture_output=True)
        doc = (output/'index.html').read_text()
        self.assertIn('&lt;script&gt;alert(1)&lt;/script&gt;', doc)
        self.assertNotIn('<script>alert(1)</script>', doc)
        self.assertNotIn('旧大字', doc)
        self.assertNotIn('tl.from("#cover', doc)
        self.assertNotIn('tl.fromTo("#cover', doc)
        self.assertIn('data-duration="0.8333333333333334"', doc)
        # The generated CLI fails before creating a directory for an invalid annotation.
        self.timeline['callouts'][0]['endFrame'] = 481; self.save()
        failed = self.root/'hf-invalid'
        result = subprocess.run([sys.executable, str(SCRIPTS/'packaging.py'), str(self.root), '01',
                                 '--assets', str(self.root/'assets'), '--output', str(failed)], capture_output=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(failed.exists())


if __name__ == '__main__':
    unittest.main()
