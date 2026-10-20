import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fixtureProject } from './film-render-test-fixture.ts';
import { renderSpecFromProject } from '../lib/film-render/from-project.ts';
import { isClassicSpec, type Callout } from '../lib/film-render/types.ts';
import { filmContent } from '../lib/final-edit/reassembled/content.ts';
import { changeFilmClipDuration, filmTimeline, projectFilmTimeline } from '../lib/final-edit/reassembled/timeline.ts';
import type { RegisteredCandidate } from '../lib/final-edit/reassembled/types.ts';
import { PACKAGING_TEMPLATE_IDS } from '../lib/media-core/packaging-vars.ts';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'film-duration-'));
try {
  fixtureProject(root);
  for (const template of ['classic', ...PACKAGING_TEMPLATE_IDS]) {
    if (template !== 'classic') fs.writeFileSync(path.join(root, 'packaging.json'), JSON.stringify({ variants: { '01': { packaging: {
      template, title: '时长调整', subtitle: '人工修改保留', coverPoints: ['材质'], bodyCues: [],
    } } } }));
    const spec = renderSpecFromProject(root, '01');
    spec.shots[0].inSec = .12345;
    const base = structuredClone(spec);
    const candidates: RegisteredCandidate[] = spec.shots.map(s => ({ videoJobId: s.id, clipId: s.id, shotId: s.id, file: s.file, fingerprint: 'a'.repeat(64), durationSec: 100, approvedRangeSec: [0, 100] }));
    const timeline = filmTimeline(spec, candidates);
    timeline.filmContent = filmContent(spec);
    timeline.filmContent.subtitles[0].text = '人工字幕保留';
    const before = structuredClone(timeline);
    const original = projectFilmTimeline(spec, before, candidates);
    for (const selectedIndex of [0, 1, 2]) for (const delta of [-24, 24, 1]) {
      const edited = structuredClone(before), selected = edited.clips[selectedIndex];
      changeFilmClipDuration(edited, selected.id, selected.timelineOutFrame - selected.timelineInFrame + delta);
      const projected = projectFilmTimeline(spec, edited, candidates);
      assert.equal(projected.canvas.frames, original.canvas.frames + delta);
      assert.deepEqual(projected.subtitles, original.subtitles);
      assert.deepEqual(projected.audio, original.audio);
      assert.deepEqual(edited.filmContent, before.filmContent);
      for (let i = 0; i < edited.clips.length; i++) {
        const expected = structuredClone(before.clips[i]);
        if (i === selectedIndex) { expected.timelineOutFrame += delta; expected.sourceOutFrame = expected.sourceInFrame + Math.round((expected.timelineOutFrame - expected.timelineInFrame) * (expected.playbackRate ?? 1)); }
        else if (i > selectedIndex) { expected.timelineInFrame += delta; expected.timelineOutFrame += delta; }
        assert.deepEqual(edited.clips[i], expected);
        assert.equal(projected.shots[i].inSec, original.shots[i].inSec, 'duration edits preserve precise source in-points');
      }
      if (isClassicSpec(projected) && isClassicSpec(original)) {
        assert.deepEqual(projected.classic.cover, original.classic.cover);
        assert.deepEqual(projected.classic.labels, original.classic.labels);
        assert.equal(Number(projected.classic.durationText), projected.canvas.frames / 24);
        for (let i = 0; i < projected.classic.callouts.length; i++) {
          const old: Callout = original.classic.callouts[i], moved: Callout = projected.classic.callouts[i];
          const shift: number = original.shots.findIndex(s => s.id === old.shot) > selectedIndex ? delta : 0;
          assert.equal(moved.startFrame, old.startFrame + shift);
          assert.equal(moved.dotKeyframes![0].frame, old.dotKeyframes![0].frame + shift);
        }
      } else if (!isClassicSpec(projected) && !isClassicSpec(original)) assert.deepEqual(projected.packaging, original.packaging);
      const noOp = structuredClone(edited);
      changeFilmClipDuration(edited, selected.id, selected.timelineOutFrame - selected.timelineInFrame);
      assert.deepEqual(edited, noOp);
    }
    for (const value of [0, 11, 12.1, NaN, Infinity, Number.MAX_SAFE_INTEGER]) {
      const edited = structuredClone(before);
      assert.throws(() => changeFilmClipDuration(edited, edited.clips[1].id, value), { code: 'invalid_film_duration' });
      assert.deepEqual(edited, before);
    }
    const tooShort = structuredClone(before);
    assert.throws(() => changeFilmClipDuration(tooShort, tooShort.clips[1].id, 12), /至少 15 秒/);
    assert.throws(() => changeFilmClipDuration(timeline, 'foreign', 24), { code: 'clip_not_found' });
    const shortened = structuredClone(before);
    changeFilmClipDuration(shortened, shortened.clips[2].id, 48);
    for (const dependency of ['subtitle', 'voice', 'music', 'packaging']) {
      const copy = structuredClone(spec), testTimeline = structuredClone(shortened);
      if (dependency === 'subtitle') testTimeline.filmContent!.subtitles.push({ text: '人工片尾字幕', startFrame: 450, endFrame: 479 });
      if (dependency === 'voice') copy.audio.voices.push({ ...copy.audio.voices[0], atFrame: 456 });
      if (dependency === 'music') testTimeline.filmContent!.music.fadeOutSec = 20;
      if (dependency === 'packaging') {
        const d = testTimeline.filmContent!.decoration;
        if (d.template === 'classic') d.callouts.push({ id: 'tail', shot: 'E03', title: '人工尾部标注', startFrame: 420, endFrame: 479, dot: [400, 400], pill: [80, 220] });
        else { d.packaging.pointCues = [{ id: 'tail', text: '人工片尾卖点', startSec: 18, endSec: 20 }]; d.packaging.pointCuesMode = 'timed'; }
      }
      assert.throws(() => projectFilmTimeline(copy, testTimeline, candidates), { code: 'film_duration_dependency' }, dependency);
    }
    const extended = structuredClone(before);
    changeFilmClipDuration(extended, extended.clips[0].id, 100);
    const limited = structuredClone(candidates);
    limited[0].approvedRangeSec[1] = .12345 + 100 / 24;
    if (isClassicSpec(spec)) assert.throws(() => projectFilmTimeline(spec, extended, limited), /转场余量/);
    limited[0].durationSec = 1;
    assert.throws(() => projectFilmTimeline(spec, extended, limited), /审核素材范围/);
    assert.deepEqual(spec, base);
  }
  console.log('PASS five-template ripple duration, precise source starts, manual content, dependency rejection and source/tail gates');
} finally { fs.rmSync(root, { recursive: true, force: true }); }
