"""Shared delivery gate; metadata never substitutes for agent visual inspection."""
import hashlib
import json
from pathlib import Path

OPENINGS = {'carton-explosion', 'bare-shell-renovation', 'giant-hand-place', 'magic-growth'}


def validate(project, variant):
    project = Path(project).resolve(strict=True)
    root = (project/'variants'/variant).resolve(strict=True)
    if not root.is_relative_to(project):
        raise ValueError('Variant outside project')
    timeline = json.loads((root/'timeline.json').read_text(encoding='utf8'))
    if timeline['variant'] != variant or timeline.get('openingEffectId') not in OPENINGS:
        raise ValueError('必须选择四种指定开头效果之一，且型号条目一致')
    if (timeline['width'], timeline['height'], timeline['fps'], timeline['introFrames']) != (1080, 1440, 24, 20):
        raise ValueError('This tested packaging supports only 1080x1440 / 24fps / 20-frame cover')
    if timeline['frames'] < 360 or abs(timeline['duration']-timeline['frames']/24) > 1e-6:
        raise ValueError('Timeline duration mismatch or less than 15 seconds')
    cursor, files = 20, set()
    for shot in timeline['shots']:
        file = (root/shot['file']).resolve(strict=True)
        if not file.is_relative_to(project) or file in files:
            raise ValueError('Repeated clip or path outside project')
        if shot['startFrame'] != cursor or shot['endFrame'] <= cursor or shot['rate'] <= 0 or shot['inSec'] < 0:
            raise ValueError('Invalid shot timing')
        cursor = shot['endFrame']; files.add(file)
    if cursor != timeline['frames']:
        raise ValueError('Timeline tail mismatch')
    first = timeline['shots'][0]
    reviews = json.loads((project/'review/opening-effects.json').read_text(encoding='utf8'))['variants']
    item = next((v for v in reviews if v['variant'] == variant), None)
    if not item or (item.get('effectId'), item.get('shot'), item.get('sourceFile'), item.get('status')) != (timeline['openingEffectId'], first['id'], first['file'], 'visual_approved'):
        raise ValueError('Opening choice, clip and visual approval must match')
    file = (root/first['file']).resolve()
    with file.open('rb') as stream:
        digest = hashlib.file_digest(stream, 'sha256').hexdigest()
    if item.get('sha256') and item['sha256'] != digest:
        raise ValueError('Reviewed opening file changed')
    return dict(variant=variant, openingEffectId=timeline['openingEffectId'], openingSha256=digest,
                legacyReviewWithoutHash=not bool(item.get('sha256')), timeline=timeline)
