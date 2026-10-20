import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fixtureProject } from './film-render-test-fixture.ts';
import { renderSpecFromProject } from '../lib/film-render/from-project.ts';
import { isClassicSpec } from '../lib/film-render/types.ts';
import { filmContent } from '../lib/final-edit/reassembled/content.ts';
import { changeFilmPlaybackRate, filmTimeline, projectFilmTimeline } from '../lib/final-edit/reassembled/timeline.ts';
import type { RegisteredCandidate } from '../lib/final-edit/reassembled/types.ts';
import { PACKAGING_TEMPLATE_IDS } from '../lib/media-core/packaging-vars.ts';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'film-speed-'));
try {
  fixtureProject(root);
  for (const template of ['classic', ...PACKAGING_TEMPLATE_IDS]) {
    if (template !== 'classic') fs.writeFileSync(path.join(root, 'packaging.json'), JSON.stringify({ variants: { '01': { packaging: {
      template, title: '定长变速', subtitle: '人工修改保留', coverPoints: ['材质'], bodyCues: [],
    } } } }));
    const spec = renderSpecFromProject(root, '01');
    const base = structuredClone(spec);
    const candidates: RegisteredCandidate[] = spec.shots.map(s => ({ videoJobId: s.id, clipId: s.id, shotId: s.id, file: s.file, fingerprint: 'a'.repeat(64), durationSec: 100, approvedRangeSec: [0, 100] }));
    const timeline = filmTimeline(spec, candidates);
    timeline.filmContent = filmContent(spec);
    timeline.filmContent.subtitles[0].text = '人工字幕保留';
    const before = structuredClone(timeline);
    const original = projectFilmTimeline(spec, timeline, candidates);
    for (const rate of [.25, .5, 1.25, 2, 4]) {
      const edited = structuredClone(before);
      changeFilmPlaybackRate(edited, edited.clips[0].id, rate);
      const projected = projectFilmTimeline(spec, edited, candidates);
      assert.equal(projected.shots[0].rate, rate);
      assert.deepEqual(projected.shots.slice(1), original.shots.slice(1));
      assert.deepEqual(projected.canvas, original.canvas);
      assert.deepEqual(projected.subtitles, original.subtitles);
      assert.deepEqual(projected.audio, original.audio);
      if (isClassicSpec(projected) && isClassicSpec(original)) assert.deepEqual(projected.classic, original.classic);
      assert.deepEqual(edited.clips.slice(1), before.clips.slice(1));
      assert.deepEqual(edited.filmContent, before.filmContent);
      assert.equal(edited.clips[0].timelineInFrame, before.clips[0].timelineInFrame);
      assert.equal(edited.clips[0].timelineOutFrame, before.clips[0].timelineOutFrame);
      const sameRate = structuredClone(edited);
      changeFilmPlaybackRate(edited, edited.clips[0].id, rate);
      assert.deepEqual(edited, sameRate, 'same-speed save must not quantize source positions');
      const limited = structuredClone(candidates);
      const shot = projected.shots[0];
      limited[0].approvedRangeSec[1] = shot.inSec + (shot.endFrame - shot.startFrame) / 24 * rate;
      if (isClassicSpec(projected)) assert.throws(() => projectFilmTimeline(spec, edited, limited), /转场余量/);
      limited[0].durationSec = shot.inSec + .01;
      assert.throws(() => projectFilmTimeline(spec, edited, limited), /审核素材范围/);
    }
    for (const invalid of [0, -.5, .249, 4.01, NaN, Infinity]) {
      const edited = structuredClone(before);
      assert.throws(() => changeFilmPlaybackRate(edited, edited.clips[0].id, invalid), { code: 'invalid_video_playback_rate' });
      assert.deepEqual(edited, before);
    }
    assert.throws(() => changeFilmPlaybackRate(timeline, 'foreign', 1), { code: 'clip_not_found' });
    assert.deepEqual(spec, base);
  }
  console.log('PASS five-template speed projection, fixed duration, other-shot/content isolation, source/tail limits and invalid rates');
} finally { fs.rmSync(root, { recursive: true, force: true }); }
