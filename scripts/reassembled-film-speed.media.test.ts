// Local moving-picture check: projected rate must change which source frames appear.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runFfmpeg } from '../lib/ffmpeg.ts';
import { prepareShot } from '../lib/film-render/media.ts';
import { changeFilmPlaybackRate, filmTimeline, projectFilmTimeline } from '../lib/final-edit/reassembled/timeline.ts';
import type { RenderSpec } from '../lib/film-render/types.ts';
import type { RegisteredCandidate } from '../lib/final-edit/reassembled/types.ts';

const parent = path.resolve('outputs/2026-10-19-film-editing'); fs.mkdirSync(parent, { recursive: true });
const root = fs.mkdtempSync(path.join(parent, 'speed-motion-'));
const ff = async (args: string[]) => runFfmpeg(['-nostdin', '-hide_banner', '-n', ...args], { timeoutMs: 180000 });
const spec = JSON.parse(fs.readFileSync('outputs/2026-10-19-p1-matrix/synthetic-fixed/variants/01/renders/overlay-poster-first/spec.json', 'utf8')) as RenderSpec;
const manifest = JSON.parse(fs.readFileSync('outputs/2026-10-19-p1-matrix/synthetic-fixed/variants/01/renders/overlay-poster-first/render-manifest.json', 'utf8'));
for (const file of Object.keys(manifest.inputs)) {
  assert.ok(!path.isAbsolute(file) && !file.split(/[\\/]/).includes('..'));
  const destination = path.join(root, file);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(path.join(spec.project.root, file), destination, fs.constants.COPYFILE_EXCL);
}
spec.project.root = root;
await ff(['-f', 'lavfi', '-i', 'testsrc2=size=540x720:rate=24:duration=12', '-an', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '18', '-threads', '2', path.join(root, 'motion.mp4')]);
spec.shots[0].file = 'motion.mp4';
const candidates: RegisteredCandidate[] = spec.shots.map(s => ({ videoJobId: s.id, clipId: s.id, shotId: s.id, file: s.file, fingerprint: 'a'.repeat(64), durationSec: 12, approvedRangeSec: [0, 12] }));
const size = 108 * 144;
const decode = async (file: string, name: string) => {
  const output = path.join(root, name + '.gray');
  await ff(['-i', file, '-vf', 'scale=108:144', '-pix_fmt', 'gray', '-f', 'rawvideo', output]);
  return fs.readFileSync(output);
};
const source = await decode(path.join(root, 'motion.mp4'), 'source');
const difference = (left: Buffer, frame: number, right: Buffer, other: number) => {
  let sum = 0;
  for (let i = 0; i < size; i++) sum += Math.abs(left[frame * size + i] - right[other * size + i]);
  return sum / size;
};
const results = [];
for (const rate of [.5, 2]) {
  const timeline = filmTimeline(spec, candidates);
  changeFilmPlaybackRate(timeline, timeline.clips[0].id, rate);
  const projected = projectFilmTimeline(spec, timeline, candidates);
  const output = path.join(root, `prepared-${rate}.mp4`);
  await prepareShot(projected, projected.shots[0], output, 0);
  const decoded = await decode(output, `prepared-${rate}`);
  assert.equal(decoded.length / size, 120);
  for (const frame of [24, 48, 72]) {
    const expected = Math.round(frame * rate);
    const choices = [expected - 1, expected, expected + 1].map(index => ({ index, difference: difference(decoded, frame, source, index) }));
    const match = choices.sort((a, b) => a.difference - b.difference)[0];
    const wrongSpeed = difference(decoded, frame, source, frame);
    assert.ok(match.difference < 3 && match.difference * 2 < wrongSpeed, JSON.stringify({ rate, frame, match, wrongSpeed }));
    results.push({ rate, frame, expectedSourceFrame: expected, matchedSourceFrame: match.index, meanAbsoluteDifference: match.difference, unchangedSpeedDifference: wrongSpeed });
  }
}
fs.writeFileSync(path.join(root, 'result.json'), JSON.stringify({ ok: true, paidCalls: 0, results }, null, 2));
console.log('PASS projected 0.5x/2x motion matches source frames, fixed 120-frame output', root);
