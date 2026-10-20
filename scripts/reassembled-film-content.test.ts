import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fixtureProject } from './film-render-test-fixture.ts';
import { renderSpecFromProject } from '../lib/film-render/from-project.ts';
import { isClassicSpec } from '../lib/film-render/types.ts';
import type { Callout } from '../lib/film-render/types.ts';
import type { FilmContent } from '../lib/final-edit/reassembled/content.ts';
import { filmContent } from '../lib/final-edit/reassembled/content.ts';
import { filmTimeline, projectFilmTimeline } from '../lib/final-edit/reassembled/timeline.ts';
import type { RegisteredCandidate } from '../lib/final-edit/reassembled/types.ts';
import { PACKAGING_TEMPLATE_IDS } from '../lib/media-core/packaging-vars.ts';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'film-content-'));
try {
  fixtureProject(root);
  for (const template of ['classic', ...PACKAGING_TEMPLATE_IDS]) {
    if (template !== 'classic') fs.writeFileSync(path.join(root, 'packaging.json'), JSON.stringify({ variants: { '01': { packaging: {
      template, title: '产品实拍', subtitle: '生活细节', coverPoints: ['材质'], bodyCues: [{ id: 'detail', text: '细节', startFrame: 50, endFrame: 90 }],
    } } } }));
    const spec = renderSpecFromProject(root, '01');
    const before = structuredClone(spec);
    const candidates: RegisteredCandidate[] = spec.shots.map(s => ({ videoJobId: s.id, clipId: s.id, shotId: s.id, file: s.file, fingerprint: 'a'.repeat(64), durationSec: 100, approvedRangeSec: [0, 100] }));
    const timeline = filmTimeline(spec, candidates);
    const unchanged = projectFilmTimeline(spec, timeline, candidates);
    timeline.filmContent = filmContent(spec);
    assert.deepEqual(projectFilmTimeline(spec, timeline, candidates), unchanged, `${template}: explicit unchanged content must not alter rendering`);
    timeline.filmContent.music.gainDb -= 3;
    timeline.filmContent.subtitles[0].text = '人工字幕';
    if (timeline.filmContent.decoration.template === 'classic') {
      timeline.filmContent.decoration.cover.title[0] = '人工标题';
      if (timeline.filmContent.decoration.callouts[0]) timeline.filmContent.decoration.callouts[0].title = '人工标注';
    } else {
      timeline.filmContent.decoration.packaging.varsOverrides.title = '人工标题';
      timeline.filmContent.decoration.packaging.layouts = { [template]: { cover: { title: { x: 45, y: 30, scale: .8 } } } };
    }
    const result = projectFilmTimeline(spec, timeline, candidates);
    assert.deepEqual(result.shots, unchanged.shots, 'content edit cannot change clips');
    assert.deepEqual(result.audio.voices, spec.audio.voices, 'subtitle edit cannot regenerate voice');
    assert.equal(result.audio.music.gainDb, spec.audio.music.gainDb - 3);
    assert.equal(result.subtitles[0].text, '人工字幕');
    if (isClassicSpec(result)) assert.equal(result.classic.cover.title[0], '人工标题');
    else assert.equal(result.packaging.varsOverrides.title, '人工标题');
    assert.deepEqual(spec, before, 'imported spec is immutable');
    for (const mutate of [
      (t: typeof timeline) => { Object.assign(t.filmContent!, { project: { root: 'elsewhere' } }); },
      (t: typeof timeline) => { Object.assign(t.filmContent!.music, { file: 'foreign.wav' }); },
      (t: typeof timeline) => { t.filmContent!.music.gainDb = 100; },
      (t: typeof timeline) => { t.filmContent!.subtitles[0].startFrame = 0; },
      (t: typeof timeline) => { t.filmContent!.subtitles[0].endFrame = spec.canvas.frames + 1; },
      (t: typeof timeline) => { t.filmContent!.subtitles.push({ ...t.filmContent!.subtitles[0] }); },
    ]) { const bad = structuredClone(timeline); mutate(bad); assert.throws(() => projectFilmTimeline(spec, bad, candidates)); }
    // Changes survive candidate/reorder operations; history restoration drops the snapshot entirely.
    let cursor = 0;
    timeline.clips.reverse().forEach(clip => { const length = clip.timelineOutFrame - clip.timelineInFrame; clip.timelineInFrame = cursor; cursor += length; clip.timelineOutFrame = cursor; });
    const reordered = projectFilmTimeline(spec, timeline, candidates);
    assert.equal(reordered.subtitles[0].text, '人工字幕');
    if (isClassicSpec(reordered) && isClassicSpec(spec)) for (const callout of reordered.classic.callouts) {
      const edited: FilmContent['decoration'] = timeline.filmContent.decoration;
      assert.ok(edited.template === 'classic');
      const original: Callout = edited.callouts.find((c: Callout) => c.id === callout.id)!;
      assert.equal(callout.startFrame - original.startFrame, reordered.shots.find(s => s.id === callout.shot)!.startFrame - spec.shots.find(s => s.id === callout.shot)!.startFrame);
    }
    for (const target of PACKAGING_TEMPLATE_IDS) {
      const switched = filmTimeline(spec, candidates);
      switched.filmContent = filmContent(spec);
      switched.filmContent.decoration = { template: target, packaging: { enabled: true, template: target, varsOverrides: { title: '新模板', subtitle: '保留原片' }, pointCues: [], pointCuesMode: 'none', layouts: {} } };
      assert.equal(projectFilmTimeline(spec, switched, candidates).template.id, target);
    }
  }
  console.log('PASS five-template content projection, 20 explicit switches, unchanged compatibility, immutable inputs, local edits, callout relocation and 30 invalid payloads');
} finally { fs.rmSync(root, { recursive: true, force: true }); }
