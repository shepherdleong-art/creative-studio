import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fixtureProject } from './film-render-test-fixture.ts';
import { renderSpecFromProject } from '../lib/film-render/from-project.ts';
import type { Callout } from '../lib/film-render/types.ts';
import { isClassicSpec } from '../lib/film-render/types.ts';
import { filmTimeline, projectFilmTimeline } from '../lib/final-edit/reassembled/timeline.ts';
import type { RegisteredCandidate } from '../lib/final-edit/reassembled/types.ts';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reassembled-projection-'));
try {
  fixtureProject(root);
  const spec = renderSpecFromProject(root, '01');
  assert.ok(isClassicSpec(spec));
  const candidates: RegisteredCandidate[] = spec.shots.map(s => ({ videoJobId: s.id, clipId: s.id, shotId: s.id, file: s.file, fingerprint: 'a'.repeat(64), durationSec: 100, approvedRangeSec: [0, 100] }));
  const timeline = filmTimeline(spec, candidates);
  const projected = projectFilmTimeline(spec, timeline, candidates);
  assert.deepEqual(projected.shots.map(s => [s.file, s.inSec, s.startFrame, s.endFrame]), spec.shots.map(s => [s.file, s.inSec, s.startFrame, s.endFrame]), 'unchanged fractional source positions are preserved');
  assert.deepEqual(projected.audio, spec.audio);
  assert.deepEqual(projected.subtitles, spec.subtitles);
  const moved = structuredClone(timeline); let cursor = 0;
  moved.clips.reverse().forEach(c => { const length = c.timelineOutFrame - c.timelineInFrame; c.timelineInFrame = cursor; c.timelineOutFrame = cursor + length; cursor += length; });
  const reordered = projectFilmTimeline(spec, moved, candidates);
  assert.deepEqual(reordered.shots.map(s => s.id), [...spec.shots].reverse().map(s => s.id));
  assert.ok(isClassicSpec(reordered));
  for (const callout of reordered.classic.callouts) {
    const old: Callout = spec.classic.callouts.find(c => c.id === callout.id)!;
    const delta: number = reordered.shots.find(s => s.id === callout.shot)!.startFrame - spec.shots.find(s => s.id === callout.shot)!.startFrame;
    assert.equal(callout.startFrame, old.startFrame + delta);
    assert.equal(callout.endFrame, old.endFrame + delta);
  }
  for (const mutate of [
    (t: typeof timeline) => { t.clips[0].videoJobId = t.clips[1].videoJobId; },
    (t: typeof timeline) => { t.clips[0].sourceFingerprint = 'b'.repeat(64); },
    (t: typeof timeline) => { t.clips[0].framing.scale = 2; },
    (t: typeof timeline) => { t.clips[0].timelineInFrame = 1; },
    (t: typeof timeline) => { t.clips[0].sourceInFrame = -1; },
    (t: typeof timeline) => { t.clips[0].playbackRate = 3; },
    (t: typeof timeline) => { t.clips.pop(); },
    (t: typeof timeline) => { t.bodyFrames += 1; },
    (t: typeof timeline) => { t.clips[0].sourceOutFrame += 10; },
  ]) { const changed = structuredClone(timeline); mutate(changed); assert.throws(() => projectFilmTimeline(spec, changed, candidates), { code: 'film_edit_unsupported' }); }
  const limited = structuredClone(candidates); limited[0].approvedRangeSec[1] = .1;
  assert.throws(() => projectFilmTimeline(spec, timeline, limited), { code: 'film_edit_unsupported' });
  console.log('PASS exact source positions, classic callout relocation, frozen audio/subtitles, foreign candidate, stale fingerprint, trim/gap/rate/range guards');
} finally { fs.rmSync(root, { recursive: true, force: true }); }
