"""Explicitly regenerate classic/1 golden fixtures from the untouched Python oracle.
python3.12 scripts/film-render-goldens.py --write
Never regenerate an accepted template version to hide a renderer regression.
"""
import argparse
import copy
import json
import runpy
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

repo = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--write', action='store_true', required=True)
parser.parse_args()
fixture = runpy.run_path(str(repo/'scripts/reassembled-film-packaging.test.py'), run_name='fixture')['fixture']
out = repo/'scripts/fixtures/film-render/classic-v1'
for name in ['legacy', 'static', 'tracking', 'fractional', 'float-coordinates']:
    with tempfile.TemporaryDirectory(prefix='classic-oracle-') as tmp:
        root = Path(tmp)
        t = fixture(root)
        t['subtitles'] = [dict(text='头颈 <托住> & "舒适"\' ☀️', startFrame=24, endFrame=71)]
        config = json.loads((root/'packaging.json').read_text())
        config['brand'] = '品牌 & <HOME>'
        config['variants']['01']['labels']['O01'] = ['OPEN', '第一镜', '辅助文字', 'left']
        if name == 'legacy':
            t.pop('callouts')
        elif name == 'static':
            t['callouts'][0].pop('dotKeyframes')
        elif name == 'fractional':
            t['frames'] = 481
            t['duration'] = 481/24
            t['shots'][0]['endFrame'] = 97
            t['shots'][1]['startFrame'] = 97
            t['shots'][2]['endFrame'] = 481
            t['callouts'][0]['startFrame'] = 121
            t['callouts'][0]['dotKeyframes'][0]['frame'] = 121
        elif name == 'float-coordinates':
            t['duration'] = 20.0
            c = t['callouts'][0]
            c['dot'] = [430.0, 600.0]
            c['pill'] = [80.0, 220.0]
            c['box'] = [320.0, 140.0]
            c['dotKeyframes'][0]['dot'] = copy.copy(c['dot'])
            c['dotKeyframes'][1]['dot'] = [480.0, 650.0]
        (root/'variants/01/timeline.json').write_text(json.dumps(t, ensure_ascii=False), encoding='utf8')
        (root/'packaging.json').write_text(json.dumps(config, ensure_ascii=False), encoding='utf8')
        subprocess.run([sys.executable, str(repo/'scripts/reassembled-film/packaging.py'), str(root), '01',
                        '--assets', str(repo/'packaging/templates/classic/1'), '--output', str(root/'hf')], check=True)
        dest = out/name
        dest.mkdir(parents=True, exist_ok=True)
        for source, target in [('variants/01/timeline.json', 'timeline.json'), ('packaging.json', 'packaging.json'),
                               ('tools/style.css', 'style.css'), ('DESIGN.md', 'DESIGN.md'),
                               ('hf/index.html', 'index.html'), ('hf/meta.json', 'meta.json'), ('hf/hyperframes.json', 'hyperframes.json')]:
            shutil.copyfile(root/source, dest/target)
values = [0.0, -0.0, 4.0, 1e-7, 1e-5, 0.0001, 1e15, 1e16, 1e20, 1e23,
          0.5, 2.5, 3.5, 0.0078125, 1.2345665, 20/24, 4+0.18, 17/24, 481/24]
(out/'numbers.json').write_text(json.dumps([dict(value=v, repr=repr(v), fixed=format(v, '.6f'), rounded=round(v)) for v in values]), encoding='utf8')
