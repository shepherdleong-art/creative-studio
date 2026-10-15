// Opt-in: FILM_E2E=1 node scripts/film-render.e2e.test.ts. Real local HyperFrames + FFmpeg; no providers or user data.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { fixtureProject, repo } from './film-render-test-fixture.ts';
import { runFfmpeg } from '../lib/ffmpeg.ts';
import { renderSpecFromProject } from '../lib/film-render/from-project.ts';
import { renderFilm } from '../lib/film-render/render.ts';
import { compareFilms } from '../lib/film-render/compare.ts';

if (process.env.FILM_E2E !== '1') {
  console.log('SKIP: set FILM_E2E=1 to run real HyperFrames twice');
} else {
  process.env.CREATIVE_STUDIO_PACKAGING_DIR = path.join(repo, 'packaging');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'film-e2e-中文 空格-')));
  console.log(`Evidence retained: ${root}`);
  fixtureProject(root);
  const ff = (args: string[]) => runFfmpeg(['-nostdin', '-hide_banner', '-n', ...args], { timeoutMs: 120_000 });
  const source = path.join(root, 'source.mp4');
  await ff(['-f', 'lavfi', '-i', 'testsrc2=size=540x720:rate=24:duration=14', '-an', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '18', '-threads', '2', source]);
  for (const name of ['opening', 'detail', 'outro']) fs.copyFileSync(source, path.join(root, `variants/01/${name}.mp4`));
  await sharp({ create: { width: 1080, height: 1440, channels: 3, background: '#cabbaa' } }).png().toFile(path.join(root, 'variants/01/cover.png'));
  await ff(['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=4', '-ac', '1', '-c:a', 'pcm_s16le', path.join(root, 'narration-source.wav')]);
  await ff(['-f', 'lavfi', '-i', 'sine=frequency=220:sample_rate=48000:duration=3', '-ac', '2', '-c:a', 'pcm_s16le', path.join(root, 'music-source.wav')]);
  fs.writeFileSync(path.join(root, 'tools/style.css'), `
@font-face{font-family:SHS;src:url('assets/fonts/SourceHanSansCN-VF.ttf') format('truetype');font-weight:100 900;font-display:block}
*{box-sizing:border-box}html,body{margin:0;width:1080px;height:1440px;overflow:hidden;background:#cabbaa}
#root{position:relative;width:1080px;height:1440px;overflow:hidden;font-family:SHS;color:#272727}
.clip,.scene,.overlay{position:absolute;inset:0;width:1080px;height:1440px;overflow:hidden}
.scene{object-fit:cover}.scene img{width:100%;height:100%;object-fit:cover}
.scene-content{width:100%;height:100%;padding:64px;display:flex;flex-direction:column;gap:20px;position:relative;z-index:2}
.brandrow{display:flex;justify-content:space-between;font-size:28px}.cover-title,.end-title{font-size:100px;line-height:1.1;margin:60px 0 0}
.cover-title span,.end-title span{display:block}.cover-detail,.end-model{font-size:30px}.cover-note{margin-top:auto;font-size:26px;display:flex;justify-content:space-between}
.cap{position:absolute;bottom:120px;left:60px;width:960px;text-align:center;font-size:42px;color:white}.cap span{background:#333;padding:12px}
.label-content{padding:80px}.headline{font-size:70px}.kicker,.support{font-size:30px}
`);
  const spec = renderSpecFromProject(root, '01');
  spec.canvas.frames = 360; spec.classic.durationText = '15';
  spec.shots[1].endFrame = 288; spec.shots[2].startFrame = 288; spec.shots[2].endFrame = 360;
  spec.audio.voices = [24, 144, 264].map(atFrame => ({ file: 'narration-source.wav', trimStart: .1, trimEnd: 3.1, atFrame }));
  spec.audio.music.file = 'music-source.wav'; spec.audio.music.inSec = .5;
  const events: string[] = [];
  const first = await renderFilm({ spec, runDir: path.join(root, 'variants/01/renders/first'), onStage: e => {
    if (e.status === 'done') events.push(e.stage); console.log(JSON.stringify(e));
  } });
  assert.ok(first.checks.ok); assert.equal(first.outputs.frames, 360);
  assert.deepEqual(events, ['prepare', 'composition', 'hyperframes', 'edge', 'audio', 'mux', 'cover', 'verify', 'manifest']);
  assert.ok(fs.readFileSync(path.join(root, 'variants/01/renders/first/hf/index.html'), 'utf8').includes('rf-callout-pill'));
  await assert.rejects(renderFilm({ spec, runDir: path.join(root, 'variants/01/renders/first') }), /已存在/);
  const second = await renderFilm({ spec, runDir: path.join(root, 'variants/01/renders/second'), onStage: e => console.log(JSON.stringify({ run: 2, ...e })) });
  const compared = await compareFilms({ spec, video: second.outputs.video, reference: first.outputs.video,
    workDir: path.join(root, 'variants/01/renders/compare'), threshold: .99 });
  assert.ok(compared.ok, JSON.stringify({ minSsim: compared.minSsim, sameVideo: compared.sameVideo, sameAudio: compared.sameAudio, html: compared.html }));
  console.log(`PASS: complete film with tracking callout; repeat min SSIM ${compared.minSsim}; ${compared.report}`);
}
