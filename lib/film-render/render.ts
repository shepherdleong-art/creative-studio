import fs from 'node:fs';
import path from 'node:path';
import { parseRenderSpec, serializeRenderSpec } from './spec.ts';
import { createOutputDirectory, sha256, isInside } from './files.ts';
import { prepareShots, muxFilm, extractCover, LEGACY_VIDEO_ARGS } from './media.ts';
import { buildClassic } from './templates/classic-v1.ts';
import { renderHyperframes } from './hyperframes.ts';
import { mixFilmAudio } from './audio.ts';
import { inspectRightEdge, verifyFilm } from './verify.ts';
import { doctor } from './runtime-info.ts';
import { inputHashes, templateHashes, writeNewJson } from './manifest.ts';
import { FilmRenderError, requireInput } from './errors.ts';
import { runFfmpeg } from '../ffmpeg.ts';
import { isClassicSpec, type RenderSpec } from './types.ts';
import { renderOverlayBase } from './overlay-base.ts';
import { renderVideoPackaging } from '../media-core/packaging-render.ts';

export interface StageEvent { stage: string; status: 'start' | 'done' | 'failed'; elapsedMs: number }
export async function renderFilm(input: { spec: RenderSpec; runDir: string; signal?: AbortSignal; onStage?: (event: StageEvent) => void }) {
  const { signal, onStage } = input;
  signal?.throwIfAborted();
  const spec = parseRenderSpec(input.spec);
  const runtime = await doctor();
  const expectedParent = path.resolve(spec.project.root, 'variants', spec.project.variant, 'renders');
  requireInput(isInside(expectedParent, path.resolve(input.runDir)) && path.dirname(path.resolve(input.runDir)) === expectedParent,
    'OUTPUT_LOCATION', '输出必须是该片号 renders 下的新目录');
  const hashes = inputHashes(spec);
  const template = templateHashes(spec);
  const runDir = createOutputDirectory(spec.project.root, input.runDir);
  fs.writeFileSync(path.join(runDir, 'spec.json'), serializeRenderSpec(spec), { flag: 'wx' });
  for (const folder of ['prepared-media', 'audio', 'review', 'edge-check']) fs.mkdirSync(path.join(runDir, folder));
  const stages: StageEvent[] = [];
  const stage = async <T>(name: string, work: () => Promise<T> | T): Promise<T> => {
    const start = Date.now(); onStage?.({ stage: name, status: 'start', elapsedMs: 0 });
    try {
      signal?.throwIfAborted(); const result = await work();
      const event: StageEvent = { stage: name, status: 'done', elapsedMs: Date.now() - start }; stages.push(event); onStage?.(event); return result;
    } catch (error) {
      const event: StageEvent = { stage: name, status: 'failed', elapsedMs: Date.now() - start }; onStage?.(event);
      writeNewJson(path.join(runDir, 'failure.json'), { ...event, code: error instanceof FilmRenderError ? error.code : 'RENDER_FAILED', message: String(error) });
      Object.assign(error instanceof Error ? error : {}, { stage: name }); throw error;
    }
  };
  const prepared = await stage('prepare', () => prepareShots(spec, path.join(runDir, 'prepared-media'), { signal }));
  const hf = path.join(runDir, 'hf');
  let rendered: { picture: string }, composition: string;
  let baseCover: string | undefined;
  if (isClassicSpec(spec)) {
    await stage('composition', () => {
      buildClassic(spec, hf);
      prepared.forEach(file => fs.copyFileSync(file, path.join(hf, 'media', path.basename(file)), fs.constants.COPYFILE_EXCL));
    });
    rendered = await stage('hyperframes', () => renderHyperframes(hf, spec.canvas.frames, { signal }));
    composition = path.join(hf, 'index.html');
  } else {
    const base = await stage('composition', () => renderOverlayBase(spec, prepared, runDir, { signal }));
    rendered = base; composition = base.composition; baseCover = base.cover;
  }
  const edges = await stage('edge', () => inspectRightEdge(spec, rendered.picture, path.join(runDir, 'edge-check'), { signal }));
  const correctEdge = edges.some(e => e.artificial);
  const mixed = await stage('audio', () => mixFilmAudio(spec, path.join(runDir, 'audio'), { signal }));
  const video = path.join(runDir, `${spec.project.baseName}.mp4`), cover = path.join(runDir, `${spec.project.baseName}-封面.jpg`);
  // The shared packager owns temporary names in its input directory. Keep the
  // requested delivery name separate (it may itself be "packaged.mp4").
  const muxed = isClassicSpec(spec) ? video : path.join(runDir, 'base/unpackaged.mp4');
  await stage('mux', async () => {
    if (!correctEdge) { await muxFilm(spec, rendered.picture, mixed.final, muxed, { signal }); return; }
    await runFfmpeg(['-nostdin', '-hide_banner', '-n', '-i', rendered.picture, '-i', mixed.final, '-map', '0:v:0', '-map', '1:a:0',
      '-vf', 'crop=1072:1440:0:0,scale=1080:1440,setsar=1', ...LEGACY_VIDEO_ARGS,
      ...(isClassicSpec(spec) ? [] : ['-crf', '12']), '-c:a', 'aac', '-b:a', '192k',
      '-t', String(spec.canvas.frames / 24), '-movflags', '+faststart', muxed], { signal, timeoutMs: 300_000 });
  });
  if (!isClassicSpec(spec)) await stage('packaging', async () => {
    // libvips still uses traditional Windows path limits for filename inputs.
    // Keep this private copy distinct from base/cover.png without a long suffix.
    const packagingCover = path.join(runDir, 'base/p-cover.png');
    fs.copyFileSync(baseCover!, packagingCover, fs.constants.COPYFILE_EXCL);
    await renderVideoPackaging({ videoPath: muxed, coverPath: packagingCover, config: spec.packaging,
      totalSec: spec.canvas.frames / 24, staticCover: true, signal });
    fs.renameSync(muxed, video);
  });
  await stage('cover', () => extractCover(spec, video, cover, path.join(runDir, 'review/cover.png'), { signal }));
  const checked = await stage('verify', async () => {
    const result = await verifyFilm({ spec, video, cover, workDir: path.join(runDir, 'review/technical'), signal });
    writeNewJson(path.join(runDir, 'checks.json'), result);
    if (!result.ok) throw new FilmRenderError('TECHNICAL_CHECK_FAILED', JSON.stringify(result.checks.filter(c => !c.ok)), 4);
    return result;
  });
  return await stage('manifest', () => {
    const manifestStart = Date.now();
    requireInput(JSON.stringify(inputHashes(spec)) === JSON.stringify(hashes), 'INPUT_CHANGED', '渲染期间输入文件发生变化');
    requireInput(JSON.stringify(templateHashes(spec)) === JSON.stringify(template), 'TEMPLATE_CHANGED', '渲染期间模板发生变化');
    const manifestPath = path.join(runDir, 'render-manifest.json');
    const manifest = { ok: true, schemaVersion: 1, manifestPath, specSha256: sha256(path.join(runDir, 'spec.json')),
      template, tools: runtime, inputs: hashes,
      stages: [...stages, { stage: 'manifest', status: 'done', elapsedMs: Date.now() - manifestStart }],
      edgeCorrection: { applied: correctEdge, cropPixels: correctEdge ? 8 : 0, samples: edges },
      compositionSha256: sha256(composition), audio: mixed,
      outputs: { video, cover, videoSha256: sha256(video), coverSha256: sha256(cover), frames: spec.canvas.frames, duration: spec.canvas.frames / 24 },
      checks: { ok: checked.ok, path: path.join(runDir, 'checks.json') } };
    writeNewJson(manifestPath, manifest); return manifest;
  });
}
