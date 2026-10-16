import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fixtureProject, repo, treeHash } from './film-render-test-fixture.ts';
import { renderSpecFromProject } from '../lib/film-render/from-project.ts';
import { parseRenderSpec, serializeRenderSpec } from '../lib/film-render/spec.ts';
import { isClassicSpec, type OverlayRenderSpec } from '../lib/film-render/types.ts';
import { PACKAGING_TEMPLATE_IDS } from '../lib/media-core/packaging-vars.ts';
import type { CueAdjustment } from '../lib/film-render/overlay-from-project.ts';

process.env.CREATIVE_STUDIO_PACKAGING_DIR = path.join(repo, 'packaging');
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'film-overlay-spec-')));
try {
  fixtureProject(root);
  const file = path.join(root, 'packaging.json');
  for (const template of PACKAGING_TEMPLATE_IDS) {
    fs.writeFileSync(file, JSON.stringify({ variants: { '01': { packaging: {
      template, title: '产品实拍', subtitle: '每日生活的细节', coverPoints: ['实拍材质', '轻巧便携'],
      bodyCues: [{ id: 'first', text: '靠近看看', startFrame: 0, endFrame: 25 }, { id: 'next', text: '第二个卖点', startFrame: 30, endFrame: 40 }],
    } } } }));
    const before = treeHash(root), adjustments: CueAdjustment[] = [];
    const spec = renderSpecFromProject(root, '01', { onAdjustment: change => adjustments.push(change) });
    assert.ok(!isClassicSpec(spec));
    assert.equal(treeHash(root), before);
    assert.equal(spec.template.id, template);
    assert.equal(spec.packaging.pointCues![0].id, 'first');
    assert.equal(spec.packaging.pointCues![1].id, 'next');
    assert.ok(spec.packaging.pointCues![0].startSec >= 20 / 24);
    assert.equal(adjustments.length, 2);
    assert.deepEqual(parseRenderSpec(serializeRenderSpec(spec)), spec);
    // Overlays have hard cuts; an approved interval needs no classic transition handles.
    for (const shot of spec.shots) shot.approvedSourceRangeSec = [shot.inSec, shot.inSec + (shot.endFrame - shot.startFrame) / 24 * shot.rate];
    parseRenderSpec(spec);
    const reject = (edit: (s: OverlayRenderSpec) => void) => { const bad = structuredClone(spec); edit(bad); assert.throws(() => parseRenderSpec(bad)); };
    reject(s => { s.packaging.varsOverrides.title = ''; });
    reject(s => { s.packaging.varsOverrides.subtitle = ' '; });
    reject(s => { s.packaging.varsOverrides.point1 = 'a'.repeat(101); });
    reject(s => { s.packaging.enabled = false; });
    reject(s => { s.packaging.pointCues![0].id = s.packaging.pointCues![1].id; });
    reject(s => { s.packaging.pointCues![0].startSec = 0; });
    reject(s => { s.packaging.pointCues![0].endSec = 200; });
    reject(s => { s.packaging.pointCues![0].text = 'x'.repeat(61); });
    reject(s => { s.packaging.layouts = { [template]: { cover: { title: { x: 101, y: 50, scale: 1 } } } }; });
    reject(s => { s.packaging.layouts = { [template]: { cues: { missing: { x: 10, y: 50, scale: 1 } } } }; });
    reject(s => { Object.assign(s.packaging, { titleFont: { file: 'user.ttf' } }); });
    reject(s => { Object.assign(s, { classic: {} }); });
  }
  console.log('PASS: four overlay specs, read-only adapter, reported cue adjustments, exact hard-cut source ranges and 48 negative checks');
} finally { fs.rmSync(root, { recursive: true, force: true }); }
