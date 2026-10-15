import fs from 'node:fs';
import path from 'node:path';
import type { RenderSpec, ClassicComposition } from './types.ts';
import { FilmRenderError, requireInput } from './errors.ts';
import { projectFile, verifyClassicAssets } from './files.ts';
import { parsePythonJson, pyJson, roundEven } from './python-format.ts';
import { validateClassicCallouts } from './templates/classic-callouts-v1.ts';
import { readPcmWav } from './wav.ts';
import { array, identifier, integer, numeric, object, string } from './validation.ts';

export function validateClassicComposition(input: unknown): asserts input is ClassicComposition {
  const s = object(input, '渲染单');
  const project = object(s.project, 'project');
  const root = string(project.root, 'project.root');
  requireInput(path.isAbsolute(root) && fs.existsSync(root) && fs.statSync(root).isDirectory(), 'INVALID_PROJECT', 'project.root 必须是已存在的绝对目录');
  identifier(project.variant, 'project.variant');
  const name = string(project.baseName, 'project.baseName');
  requireInput(!/[<>:"/\\|?*\x00-\x1f]/.test(name) && !/[. ]$/.test(name) &&
    !/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(name), 'INVALID_FIELD', 'baseName 必须是跨平台安全文件名');
  const canvas = object(s.canvas, 'canvas');
  requireInput(canvas.width === 1080 && canvas.height === 1440 && canvas.fps === 24 && canvas.introFrames === 20,
    'CANVAS_UNSUPPORTED', 'classic/1 只支持 1080×1440 / 24fps / 20 帧封面');
  const frames = integer(canvas.frames, 'canvas.frames', 360);
  const shots = array(s.shots, 'shots');
  requireInput(shots.length > 0, 'INVALID_TIMELINE', 'shots 不能为空');
  const files = new Set<string>(), ids = new Set<string>();
  let cursor = 20;
  for (const value of shots) {
    const shot = object(value, 'shot');
    const id = identifier(shot.id, 'shot.id');
    requireInput(!ids.has(id), 'DUPLICATE_SHOT', `镜头 ID 重复: ${id}`); ids.add(id);
    const file = projectFile(root, string(shot.file, 'shot.file'));
    requireInput(!files.has(file), 'DUPLICATE_CLIP', `单条内素材重复: ${file}`); files.add(file);
    requireInput(integer(shot.startFrame, 'shot.startFrame') === cursor, 'TIMELINE_GAP', '镜头时间线必须从第 20 帧连续');
    const end = integer(shot.endFrame, 'shot.endFrame', cursor + 1, frames);
    const rate = numeric(shot.rate, 'shot.rate', Number.MIN_VALUE);
    const inSec = numeric(shot.inSec, 'shot.inSec', 0);
    if (shot.approvedSourceRangeSec !== undefined) {
      const range = array(shot.approvedSourceRangeSec, 'approvedSourceRangeSec');
      requireInput(range.length === 2, 'SOURCE_RANGE', '已审核源片区间必须包含起止秒数');
      const low = numeric(range[0], 'approvedSourceRangeSec[0]', 0), high = numeric(range[1], 'approvedSourceRangeSec[1]', low);
      const tail = end === frames ? 0 : 4;
      requireInput(low < high && inSec >= low && inSec + (end - cursor + tail) / 24 * rate <= high,
        'SOURCE_RANGE', `镜头 ${id}（含转场余量）越出已审核源片区间`);
    }
    cursor = end;
  }
  requireInput(cursor === frames, 'TIMELINE_TAIL', '镜头时间线终点与 canvas.frames 不符');
  for (const value of array(s.subtitles, 'subtitles')) {
    const sub = object(value, 'subtitle');
    string(sub.text, 'subtitle.text');
    const start = integer(sub.startFrame, 'subtitle.startFrame', 20, frames - 1);
    integer(sub.endFrame, 'subtitle.endFrame', start + 1, frames);
  }
  const c = object(s.classic, 'classic');
  projectFile(root, string(c.projectCss, 'classic.projectCss'));
  projectFile(root, string(c.designDoc, 'classic.designDoc'));
  string(c.theme, 'classic.theme', true);
  if (c.durationText !== undefined) {
    const text = string(c.durationText, 'classic.durationText');
    requireInput(/^(?:0|[1-9]\d*)(?:\.\d+)?(?:e[+-]?\d+)?$/.test(text) && Number.isFinite(Number(text)) &&
      Math.abs(Number(text) - frames / 24) <= 1e-6, 'DURATION_MISMATCH', 'classic.durationText 必须与总帧数一致');
  }
  const cover = object(c.cover, 'classic.cover');
  projectFile(root, string(cover.image, 'classic.cover.image'));
  for (const field of ['tag', 'note', 'brand', 'model', 'productName']) string(cover[field], `classic.cover.${field}`, true);
  for (const [name, value] of [['cover', cover], ['outro', object(c.outro, 'classic.outro')]] as const) {
    const title = array(value.title, `classic.${name}.title`);
    requireInput(title.length === 2, 'INVALID_FIELD', `${name}.title 必须恰好两行`);
    title.forEach(v => string(v, `${name}.title[]`, true));
  }
  const labels = object(c.labels, 'classic.labels');
  for (const [id, value] of Object.entries(labels)) {
    identifier(id, 'label shot');
    const label = array(value, `labels.${id}`);
    requireInput(label.length === 4, 'INVALID_FIELD', 'labels 每项必须有四个字符串');
    label.forEach(v => string(v, 'label', true));
  }
  validateClassicCallouts(input as ClassicComposition, c.callouts);
}

export function parseRenderSpec(input: unknown): RenderSpec {
  let value = input;
  if (typeof input === 'string') {
    try { value = parsePythonJson(input); }
    catch (error) { throw new FilmRenderError('INVALID_JSON', `渲染单 JSON 不合法: ${String(error)}`); }
  }
  validateClassicComposition(value);
  const s = object(value, '渲染单');
  requireInput(s.schemaVersion === 1, 'SCHEMA_UNSUPPORTED', '仅支持 schemaVersion: 1');
  const template = object(s.template, 'template');
  requireInput(template.id === 'classic' && template.version === '1', 'TEMPLATE_UNSUPPORTED', '本阶段仅支持 classic/1');
  const spec = value as RenderSpec;
  const audio = object(s.audio, 'audio');
  const voices = array(audio.voices, 'audio.voices');
  const totalSamples = spec.canvas.frames * 2000;
  let previousEnd = 0;
  for (const value of voices) {
    const voice = object(value, 'voice');
    const wav = readPcmWav(projectFile(spec.project.root, string(voice.file, 'voice.file')));
    requireInput(wav.sampleRate === 48000 && wav.channels === 1, 'VOICE_FORMAT', '配音必须为 48kHz 单声道 PCM16 WAV');
    const start = roundEven(numeric(voice.trimStart, 'voice.trimStart', 0) * 48000);
    const end = roundEven(numeric(voice.trimEnd, 'voice.trimEnd', 0) * 48000);
    requireInput(start < end && end <= wav.sampleFrames, 'VOICE_TRIM', '配音裁切范围不合法');
    const offset = integer(voice.atFrame, 'voice.atFrame', 0) * 2000;
    requireInput(offset >= previousEnd, 'VOICE_OVERLAP', '配音重叠或顺序不递增');
    previousEnd = offset + end - start;
    requireInput(previousEnd <= totalSamples, 'VOICE_OVERFLOW', '配音超出片尾');
  }
  const music = object(audio.music, 'audio.music');
  projectFile(spec.project.root, string(music.file, 'audio.music.file'));
  numeric(music.inSec, 'music.inSec', 0);
  numeric(music.gainDb, 'music.gainDb', -120, 24);
  numeric(music.fadeInSec, 'music.fadeInSec', 0, spec.canvas.frames / 24);
  numeric(music.fadeOutSec, 'music.fadeOutSec', 0, spec.canvas.frames / 24);
  const duck = object(music.ducking, 'music.ducking');
  numeric(duck.threshold, 'ducking.threshold', .00097563, 1);
  numeric(duck.ratio, 'ducking.ratio', 1, 20);
  numeric(duck.attackMs, 'ducking.attackMs', .01, 2000);
  numeric(duck.releaseMs, 'ducking.releaseMs', .01, 9000);
  const loud = object(audio.loudness, 'audio.loudness');
  numeric(loud.integratedLufs, 'loudness.integratedLufs', -70, -5);
  numeric(loud.truePeakDb, 'loudness.truePeakDb', -9, 0);
  numeric(loud.lra, 'loudness.lra', 1, 50);
  const output = object(s.output, 'output');
  integer(output.coverFrame, 'output.coverFrame', 0, 19);
  verifyClassicAssets();
  return spec;
}

/** Unlike JSON.stringify, retains float tokens from historical Python JSON. */
export function serializeRenderSpec(spec: RenderSpec): string { return pyJson(spec, false) + '\n'; }
