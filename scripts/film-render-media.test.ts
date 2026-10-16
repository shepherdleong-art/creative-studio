// Real local FFmpeg. No HyperFrames, providers, workbench server or production files.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fixtureProject, repo } from './film-render-test-fixture.ts';
import { encodePcmWav, readPcmWav } from '../lib/film-render/wav.ts';
import { runFfmpeg, resolveFfmpegPath } from '../lib/ffmpeg.ts';
import { runCaptured } from '../lib/film-render/process.ts';
import { prepareShot, probeMedia, muxFilm, extractCover } from '../lib/film-render/media.ts';
import { mixFilmAudio, stitchNarration } from '../lib/film-render/audio.ts';
import { verifyFilm, inspectRightEdge } from '../lib/film-render/verify.ts';
import { isClassicSpec } from '../lib/film-render/types.ts';

process.env.CREATIVE_STUDIO_PACKAGING_DIR = path.join(repo, 'packaging');
const { renderSpecFromProject } = await import('../lib/film-render/from-project.ts');
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'film-media-中文 空格-')));
const command = async (args: string[]) => runFfmpeg(['-nostdin', '-hide_banner', '-n', ...args], { timeoutMs: 120_000 });
try {
  fixtureProject(root);
  const spec = renderSpecFromProject(root, '01');
  assert.ok(isClassicSpec(spec));
  spec.canvas.frames = 360; spec.classic.durationText = '15';
  spec.shots[1].endFrame = 288; spec.shots[2].startFrame = 288; spec.shots[2].endFrame = 360;
  // Generate a moving source for frame-count tests at 0.5x, 1x and 2x speed.
  const source = path.join(root, 'testsrc.mp4');
  await command(['-f', 'lavfi', '-i', 'testsrc2=size=1080x1440:rate=24:duration=3', '-an', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '18', '-threads', '2', source]);
  for (const rate of [.5, 1, 2]) {
    const shot = { id: 'test', file: 'testsrc.mp4', startFrame: 20, endFrame: 44, inSec: .25, rate };
    const probe = await prepareShot(spec, shot, path.join(root, `prepared-${rate}.mp4`), 4);
    assert.equal(Number(probe.streams[0].nb_read_frames), 28);
  }
  await assert.rejects(prepareShot(spec, { ...spec.shots[0], file: 'testsrc.mp4', inSec: 2, rate: 2 }, path.join(root, 'too-short.mp4'), 4), /需源片/);
  console.log('prepared clips: 0.5x / 1x / 2x correct, insufficient source rejected');
  // 48kHz sine-wave voices and BGM, including ffmpeg's LIST metadata chunk.
  const voice = path.join(root, 'sine-voice.wav'), music = path.join(root, 'sine-music.wav');
  await command(['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=4', '-ac', '1', '-c:a', 'pcm_s16le', voice]);
  await command(['-f', 'lavfi', '-i', 'sine=frequency=220:sample_rate=48000:duration=3', '-ac', '2', '-c:a', 'pcm_s16le', music]);
  spec.audio.voices = [
    { file: 'sine-voice.wav', trimStart: .125, trimEnd: 3.125, atFrame: 24 },
    { file: 'sine-voice.wav', trimStart: .25, trimEnd: 3.25, atFrame: 144 },
  ];
  spec.audio.music.file = 'sine-music.wav';
  const invalid = structuredClone(spec);
  invalid.audio.voices[1].atFrame = 24;
  assert.throws(() => stitchNarration(invalid, path.join(root, 'overlap.wav')), /重叠/);
  invalid.audio.voices[1].atFrame = 359;
  assert.throws(() => stitchNarration(invalid, path.join(root, 'overflow.wav')), /片尾/);
  fs.writeFileSync(path.join(root, 'stereo.wav'), encodePcmWav(Buffer.alloc(48000 * 4 * 4), 48000, 2));
  invalid.audio.voices = [{ file: 'stereo.wav', trimStart: 0, trimEnd: 1, atFrame: 24 }];
  assert.throws(() => stitchNarration(invalid, path.join(root, 'stereo-out.wav')), /单声道/);
  fs.writeFileSync(path.join(root, '44100.wav'), encodePcmWav(Buffer.alloc(44100 * 2 * 4), 44100));
  invalid.audio.voices[0].file = '44100.wav';
  assert.throws(() => stitchNarration(invalid, path.join(root, '44100-out.wav')), /48kHz/);
  fs.mkdirSync(path.join(root, 'audio'));
  const mixed = await mixFilmAudio(spec, path.join(root, 'audio'));
  assert.ok(Math.abs(mixed.measured.integratedLufs + 16) <= 1);
  assert.ok(mixed.measured.truePeakDb <= -1);
  for (const duration of Object.values(mixed.durations)) assert.ok(Math.abs(duration - 15) <= .02);
  const narration = readPcmWav(mixed.narration);
  assert.equal(narration.sampleFrames, 15 * 48000);
  assert.ok(narration.pcm.subarray(0, 48000 * 2).every(v => v === 0));
  const original = readPcmWav(voice);
  assert.deepEqual(narration.pcm.subarray(48000 * 2, 4 * 48000 * 2), original.pcm.subarray(.125 * 48000 * 2, 3.125 * 48000 * 2));
  console.log('audio: exact PCM offsets, ducking, two-pass loudnorm and all stage durations passed');
  // Static cover and a different static body; source files use the body's actual edge.
  const picture = path.join(root, 'picture.mp4');
  await command(['-f', 'lavfi', '-i', 'color=c=0x426d86:size=1080x1440:rate=24:duration=15',
    '-vf', "drawbox=x=0:y=0:w=iw:h=ih:color=0xb87649:t=fill:enable='lt(n,20)'", '-an',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '18', '-threads', '2', picture]);
  for (const shot of spec.shots) fs.copyFileSync(picture, path.join(root, shot.file));
  const final = path.join(root, 'film.mp4');
  await muxFilm(spec, picture, mixed.final, final);
  const jpg = path.join(root, 'film-封面.jpg'), png = path.join(root, 'cover.png');
  await extractCover(spec, final, jpg, png);
  const positive = await verifyFilm({ spec, video: final, cover: jpg, workDir: path.join(root, 'positive') });
  assert.ok(positive.ok, JSON.stringify(positive.checks.filter(c => !c.ok), null, 2));
  assert.equal(Number((await probeMedia(final, root, { countFrames: true })).streams.find(s => s.codec_type === 'video')?.nb_read_frames), 360);
  await assert.rejects(muxFilm(spec, picture, mixed.final, final), /已存在/);
  console.log('verify: complete film, static cover, JPG, audio and decoded frame count passed');
  const short = path.join(root, 'short-audio.mp4');
  await command(['-i', picture, '-i', mixed.final, '-filter_complex', '[1:a]atrim=duration=1[a]',
    '-map', '0:v', '-map', '[a]', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', short]);
  const truncated = await verifyFilm({ spec, video: short, cover: jpg, workDir: path.join(root, 'short-check') });
  assert.ok(!truncated.ok && truncated.checks.some(c => c.code === 'AUDIO_COVERAGE' && !c.ok));
  const animated = path.join(root, 'animated.mp4');
  await command(['-i', final, '-vf', "drawbox=x=100:y=100:w=500:h=500:color=white:t=fill:enable='between(n,5,10)'",
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '18', '-threads', '2', '-c:a', 'copy', animated]);
  const motion = await verifyFilm({ spec, video: animated, cover: jpg, workDir: path.join(root, 'animated-check') });
  assert.ok(!motion.ok && motion.checks.some(c => c.code === 'COVER_STATIC' && !c.ok));
  console.log('verify negative cases: truncated audio and animated cover rejected');
  // Black strip detection is separate from correction (step 6); source-black must pass.
  const black = path.join(root, 'black-edge.mp4');
  await command(['-i', picture, '-vf', 'drawbox=x=iw-8:y=0:w=8:h=ih:color=black:t=fill', '-an',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '18', '-threads', '2', black]);
  fs.mkdirSync(path.join(root, 'edge-generated'));
  const generated = await inspectRightEdge(spec, black, path.join(root, 'edge-generated'));
  assert.ok(generated.some(s => s.artificial));
  for (const shot of spec.shots) fs.copyFileSync(black, path.join(root, shot.file));
  fs.mkdirSync(path.join(root, 'edge-source'));
  const natural = await inspectRightEdge(spec, black, path.join(root, 'edge-source'));
  assert.ok(natural.every(s => !s.artificial));
  // An already-aborted request starts no process or output. An active process is killed and awaited.
  const aborted = new AbortController(); aborted.abort();
  await assert.rejects(muxFilm(spec, picture, mixed.final, path.join(root, 'cancelled.mp4'), { signal: aborted.signal }), { name: 'AbortError' });
  assert.equal(fs.existsSync(path.join(root, 'cancelled.mp4')), false);
  const active = new AbortController();
  const pending = runCaptured(resolveFfmpegPath(), ['-nostdin', '-re', '-f', 'lavfi', '-i', 'sine=duration=60', '-f', 'null', '-'], { signal: active.signal });
  const timer = setTimeout(() => active.abort(), 150);
  try { await assert.rejects(pending, { name: 'AbortError' }); } finally { clearTimeout(timer); }
  console.log('film-render media passed: source edge preserved, output protection and cancellation');
} finally {
  if (process.env.FILM_KEEP_TEST_OUTPUT === '1') console.log('Retained synthetic test output:', root);
  else fs.rmSync(root, { recursive: true, force: true });
}
