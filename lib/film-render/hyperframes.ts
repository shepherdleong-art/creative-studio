import fs from 'node:fs';
import path from 'node:path';
import { resolveFfmpegPath, resolveFfprobePath } from '../ffmpeg.ts';
import { runtimeInfo } from './runtime-info.ts';
import { runCaptured, type ProcessOptions } from './process.ts';
import { FilmRenderError } from './errors.ts';
import { probeMedia } from './media.ts';

export async function renderHyperframes(hf: string, frames: number, options: ProcessOptions = {}) {
  const runtime = runtimeInfo();
  const env = { ...process.env, HYPERFRAMES_SKIP_SKILLS: '1', HYPERFRAMES_NO_AUTO_INSTALL: '1', HYPERFRAMES_NO_TELEMETRY: '1',
    HYPERFRAMES_BROWSER_PATH: runtime.chrome, HYPERFRAMES_FFMPEG_PATH: resolveFfmpegPath(), HYPERFRAMES_FFPROBE_PATH: resolveFfprobePath(),
    CREATIVE_STUDIO_PACKAGING_WORK_ROOT: path.join(hf, 'renders', 'probe-work') };
  const command = async (name: string, args: string[]) => {
    const file = fs.openSync(path.join(hf, 'renders', `${name}.log`), 'wx');
    try {
      return await runCaptured(runtime.node, ['--require', path.join(runtime.packagingDir, 'win-hide-spawn.cjs'), runtime.cli, ...args],
        { ...options, timeoutMs: options.timeoutMs ?? 600_000, cwd: hf, env, killTree: true, onOutput: text => { fs.writeSync(file, text); } });
    } finally { fs.closeSync(file); }
  };
  const lintText = (await command('lint', ['lint', '--json'])).stdout;
  let lint;
  try { lint = JSON.parse(lintText.slice(lintText.indexOf('{'))); }
  catch { throw new FilmRenderError('HYPERFRAMES_LINT', '无法解析 HyperFrames lint 结果', 4); }
  if (lint.ok !== true || lint.errorCount !== 0) throw new FilmRenderError('HYPERFRAMES_LINT', JSON.stringify(lint), 4);
  const picture = path.join(hf, 'renders', 'picture.mp4');
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await command(`render-${attempt + 1}`, ['render', '--output', 'renders/picture.mp4', '--quality', 'high', '--fps', '24', '--workers', '2']);
      break;
    } catch (error) {
      if (attempt || options.signal?.aborted || !/ffprobe.*deadline/i.test(String(error))) throw error;
      if (fs.existsSync(picture)) fs.renameSync(picture, path.join(hf, 'renders', 'picture-failed-attempt-1.mp4'));
    }
  }
  const probe = await probeMedia(picture, path.join(hf, 'renders'), { ...options, countFrames: true });
  if (Number(probe.streams.find(s => s.codec_type === 'video')?.nb_read_frames) !== frames) {
    throw new FilmRenderError('HYPERFRAMES_FRAMES', 'HyperFrames 实际帧数与渲染单不一致', 4);
  }
  return { picture, lint, runtime };
}
