import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fixtureProject, goldenRoot, repo, treeHash } from './film-render-test-fixture.ts';
import { encodePcmWav } from '../lib/film-render/wav.ts';
import type { RenderSpec } from '../lib/film-render/types.ts';

process.env.CREATIVE_STUDIO_PACKAGING_DIR = path.join(repo, 'packaging');
const { renderSpecFromProject } = await import('../lib/film-render/from-project.ts');
const { parseRenderSpec, serializeRenderSpec } = await import('../lib/film-render/spec.ts');
const { buildClassic } = await import('../lib/film-render/templates/classic-v1.ts');
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'film-spec-')));
const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'film-spec-outside-')));
try {
  for (const name of ['legacy', 'static', 'tracking', 'fractional', 'float-coordinates']) {
    const project = path.join(root, name);
    fixtureProject(project, name);
    const before = treeHash(project);
    const spec = renderSpecFromProject(project, '01');
    const reparsed = parseRenderSpec(serializeRenderSpec(spec));
    assert.equal(treeHash(project), before, 'spec conversion must be read-only');
    const output = path.join(project, 'hf');
    buildClassic(reparsed, output);
    for (const file of ['index.html', 'meta.json', 'hyperframes.json']) {
      assert.deepEqual(fs.readFileSync(path.join(output, file)), fs.readFileSync(path.join(goldenRoot, name, file)), `${name}/${file}`);
    }
  }
  const project = path.join(root, 'negative');
  fixtureProject(project);
  const base = renderSpecFromProject(project, '01');
  let count = 0;
  const reject = (edit: (s: RenderSpec) => void, code: string) => {
    const spec = structuredClone(base);
    edit(spec);
    assert.throws(() => parseRenderSpec(spec), (e: unknown) => e instanceof Error && 'code' in e && e.code === code, code);
    count++;
  };
  reject(s => { Reflect.deleteProperty(s, 'classic'); }, 'INVALID_FIELD');
  reject(s => { s.schemaVersion = 2 as 1; }, 'SCHEMA_UNSUPPORTED');
  reject(s => { s.shots[0].file = '../outside.mp4'; }, 'PATH_OUTSIDE_PROJECT');
  fs.writeFileSync(path.join(outside, 'clip.mp4'), 'outside');
  reject(s => { s.shots[0].file = path.join(outside, 'clip.mp4'); }, 'PATH_OUTSIDE_PROJECT');
  try {
    fs.symlinkSync(path.join(outside, 'clip.mp4'), path.join(project, 'linked.mp4'));
    reject(s => { s.shots[0].file = 'linked.mp4'; }, 'PATH_OUTSIDE_PROJECT');
  } catch (e) {
    // Windows 未开开发者模式且非管理员时无法创建 symlink（EPERM），跳过该负例
    if (!(e instanceof Error) || (e as NodeJS.ErrnoException).code !== 'EPERM') throw e;
  }
  reject(s => { s.shots[0].file = 'missing.mp4'; }, 'INPUT_MISSING');
  reject(s => { s.shots[1].startFrame++; }, 'TIMELINE_GAP');
  reject(s => { s.shots[2].endFrame--; }, 'TIMELINE_TAIL');
  reject(s => { s.shots[1].file = s.shots[0].file; }, 'DUPLICATE_CLIP');
  reject(s => { s.shots[1].id = s.shots[0].id; }, 'DUPLICATE_SHOT');
  reject(s => { s.shots[0].rate = 0; }, 'INVALID_FIELD');
  reject(s => { s.shots[0].inSec = NaN; }, 'INVALID_FIELD');
  reject(s => { s.audio.voices.push({ ...s.audio.voices[0] }); }, 'VOICE_OVERLAP');
  reject(s => { s.audio.voices[0].atFrame = s.canvas.frames - 1; }, 'VOICE_OVERFLOW');
  reject(s => { s.audio.voices[0].trimEnd = 2; }, 'VOICE_TRIM');
  reject(s => { Reflect.deleteProperty(s.audio.music, 'gainDb'); }, 'INVALID_FIELD');
  reject(s => { Reflect.deleteProperty(s.audio.music.ducking, 'attackMs'); }, 'INVALID_FIELD');
  reject(s => { s.classic.durationText = '20" onclick="x'; }, 'DURATION_MISMATCH');
  reject(s => { s.classic.callouts[0].endFrame = 481; }, 'INVALID_CALLOUT');
  reject(s => { s.classic.callouts[0].dot = [NaN, 600]; }, 'INVALID_CALLOUT');
  reject(s => { s.classic.callouts[0].dotKeyframes = []; }, 'INVALID_CALLOUT');
  reject(s => { s.classic.callouts.push(s.classic.callouts[0]); }, 'INVALID_CALLOUT');
  reject(s => { s.classic.callouts[0].dot = [40, 290]; s.classic.callouts[0].dotKeyframes = [{ frame: 120, dot: [40, 290] }, { frame: 191, dot: [500, 290] }]; }, 'INVALID_CALLOUT');
  reject(s => { s.project.baseName = '../overwrite'; }, 'INVALID_FIELD');
  reject(s => { s.output.coverFrame = 20; }, 'INVALID_FIELD');
  fs.writeFileSync(path.join(project, 'wrong-rate.wav'), encodePcmWav(Buffer.alloc(48000 * 2), 44100));
  fs.writeFileSync(path.join(project, 'stereo.wav'), encodePcmWav(Buffer.alloc(48000 * 4), 48000, 2));
  reject(s => { s.audio.voices[0].file = 'wrong-rate.wav'; }, 'VOICE_FORMAT');
  reject(s => { s.audio.voices[0].file = 'stereo.wav'; }, 'VOICE_FORMAT');
  // A missing review is irrelevant to technical rendering.
  fs.unlinkSync(path.join(project, 'review/opening-effects.json'));
  renderSpecFromProject(project, '01');
  fs.writeFileSync(path.join(project, 'review/delivery.json'), JSON.stringify({ variants: [{ variant: '01', video: 'final/交付-01.mp4' }] }));
  assert.equal(renderSpecFromProject(project, '01').project.baseName, '交付-01');
  assert.equal(renderSpecFromProject(project, '01', { baseName: '显式名称' }).project.baseName, '显式名称');
  fs.writeFileSync(path.join(project, 'review/delivery.json'), '{}');
  assert.throws(() => renderSpecFromProject(project, '01'), /baseName/);
  const packaging = path.join(root, 'packaging');
  fs.cpSync(path.join(repo, 'packaging/templates/classic'), path.join(packaging, 'templates/classic'), { recursive: true });
  process.env.CREATIVE_STUDIO_PACKAGING_DIR = packaging;
  const font = path.join(packaging, 'templates/classic/1/assets/fonts/SourceHanSansCN-VF.ttf');
  fs.appendFileSync(font, 'changed');
  reject(() => {}, 'ASSET_HASH_MISMATCH');
  fs.unlinkSync(font);
  reject(() => {}, 'ASSET_MISSING');
  console.log(`film-render spec passed: 5 golden roundtrips, read-only hashes, ${count} negative cases`);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
}
