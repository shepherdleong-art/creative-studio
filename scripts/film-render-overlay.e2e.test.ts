// FILM_E2E=1 node scripts/film-render-overlay.e2e.test.ts; local media only. Retains evidence.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { fixtureProject, repo } from './film-render-test-fixture.ts';
import { isClassicSpec, type OverlayRenderSpec } from '../lib/film-render/types.ts';
import { PACKAGING_TEMPLATE_IDS } from '../lib/media-core/packaging-vars.ts';

if (process.env.FILM_E2E !== '1') console.log('SKIP: set FILM_E2E=1 for four actual templates, each rendered twice');
else {
  process.env.CREATIVE_STUDIO_PACKAGING_DIR = path.join(repo, 'packaging');
  const root = process.env.FILM_OVERLAY_ROOT ? path.resolve(process.env.FILM_OVERLAY_ROOT) : fs.mkdtempSync(path.join(os.tmpdir(), 'film-overlay-中文 空格-'));
  if (process.env.FILM_OVERLAY_ROOT) fs.mkdirSync(root);
  process.env.CREATIVE_STUDIO_DATA_ROOT = root;
  const { renderFilm } = await import('../lib/film-render/render.ts');
  const { runFfmpeg } = await import('../lib/ffmpeg.ts');
  const { renderSpecFromProject } = await import('../lib/film-render/from-project.ts');
  const { compareFilms } = await import('../lib/film-render/compare.ts');
  console.log(`Evidence: ${root}`);
  fixtureProject(root);
  const ff = (args: string[]) => runFfmpeg(['-nostdin', '-hide_banner', '-n', ...args], { timeoutMs: 120_000 });
  const source = path.join(root, 'source.mp4');
  await ff(['-f', 'lavfi', '-i', 'testsrc2=size=540x720:rate=24:duration=8', '-an', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '18', '-threads', '2', source]);
  for (const name of ['opening', 'detail', 'outro']) fs.copyFileSync(source, path.join(root, `variants/01/${name}.mp4`));
  await sharp({ create: { width: 1080, height: 1440, channels: 3, background: '#cabbaa' } }).png().toFile(path.join(root, 'variants/01/cover.png'));
  await ff(['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=4', '-ac', '1', '-c:a', 'pcm_s16le', path.join(root, 'narration-source.wav')]);
  await ff(['-f', 'lavfi', '-i', 'sine=frequency=220:sample_rate=48000:duration=3', '-ac', '2', '-c:a', 'pcm_s16le', path.join(root, 'music-source.wav')]);
  const classic = renderSpecFromProject(root, '01');
  assert.ok(isClassicSpec(classic));
  const { classic: config, ...common } = classic;
  const results = [];
  for (const template of PACKAGING_TEMPLATE_IDS.filter(id => !process.env.FILM_OVERLAY_TEMPLATE || id === process.env.FILM_OVERLAY_TEMPLATE)) {
    const spec: OverlayRenderSpec = { ...structuredClone(common), template: { id: template, version: '1' }, cover: { image: config.cover.image },
      packaging: { enabled: true, template, varsOverrides: { title: '实拍好物', subtitle: '把日常过得更舒服', point1: '细节看得见', point2: '轻松好用', point3: '日常好搭档' },
        pointCues: [{ id: 'detail', text: '靠近看细节', startSec: 2, endSec: 4 }, { id: 'life', text: '自在每一天', startSec: 7, endSec: 10 }], pointCuesMode: 'timed', layouts: {} } };
    spec.canvas.frames = 380;
    spec.project.baseName = 'packaged'; // Must not collide with shared packager temporary names.
    spec.shots.forEach((shot, i) => { shot.startFrame = 20 + i * 120; shot.endFrame = 140 + i * 120; shot.inSec = 0; shot.rate = 1; });
    spec.subtitles = [{ text: '实拍素材，细节清晰可见', startFrame: 24, endFrame: 120 }, { text: '让每一天都轻松一点', startFrame: 160, endFrame: 250 }];
    spec.audio.voices = [24, 144, 264].map(atFrame => ({ file: 'narration-source.wav', trimStart: .1, trimEnd: 3.1, atFrame }));
    spec.audio.music.file = 'music-source.wav'; spec.audio.music.inSec = .5;
    const runs = [];
    for (const run of ['first', 'second']) {
      const result = await renderFilm({ spec, runDir: path.join(root, 'variants/01/renders', `${template}-${run}`), onStage: event => console.log(JSON.stringify({ template, run, ...event })) });
      assert.ok(result.checks.ok); assert.equal(result.outputs.frames, 380); runs.push(result);
    }
    const comparison = await compareFilms({ spec, video: runs[1].outputs.video, reference: runs[0].outputs.video,
      workDir: path.join(root, 'variants/01/renders', `${template}-compare`), threshold: .99 });
    assert.ok(comparison.ok, JSON.stringify(comparison));
    results.push({ template, runs: runs.map(r => r.manifestPath), minSsim: comparison.minSsim, comparison: comparison.report });
    fs.writeFileSync(path.join(root, 'results.json'), JSON.stringify(results, null, 2));
    console.log(`PASS ${template}: 380 frames, full 20-frame static cover, 12 technical checks, repeat SSIM ${comparison.minSsim}`);
  }
}
