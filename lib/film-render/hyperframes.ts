import fs from 'node:fs';
import path from 'node:path';
import { dataRoot } from '../data-root.ts';
import { resolveFfmpegPath, resolveFfprobePath } from '../ffmpeg.ts';
import { runtimeInfo } from './runtime-info.ts';
import { runCaptured, type ProcessOptions } from './process.ts';
import { FilmRenderError } from './errors.ts';
import { probeMedia } from './media.ts';

function copyGeneratedTree(source: string, destination: string): void {
  // Node 22's native cpSync crashes on this Windows deep-path fixture. Ordinary
  // readdir/copyFile support the same paths and preserve explicit link refusal.
  fs.mkdirSync(destination, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name), to = path.join(destination, entry.name);
    if (entry.isDirectory()) copyGeneratedTree(from, to);
    else if (entry.isFile()) fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
    else throw new FilmRenderError('WORKSPACE_LINK', '临时渲染工程不接受符号链接或特殊文件', 4);
  }
}

export async function renderHyperframes(hf: string, frames: number, options: ProcessOptions = {}) {
  // The bundled renderer creates deeper transaction/chunk directories. Node and
  // Chrome do not consistently support extended-length paths on Windows. Use an
  // owned short-lived workspace, retaining the original frozen HTML and media.
  if (process.platform !== 'win32' || hf.length <= 160) return renderInDirectory(hf, frames, options);
  const runRoot = path.join(dataRoot(), 'storage', 'run');
  fs.mkdirSync(runRoot, { recursive: true });
  const temporaryRoot = fs.realpathSync(runRoot);
  const work = fs.mkdtempSync(path.join(temporaryRoot, 'hf-'));
  let succeeded = false;
  try {
    options.signal?.throwIfAborted();
    copyGeneratedTree(hf, work);
    const result = await renderInDirectory(work, frames, options);
    const picture = path.join(hf, 'p.mp4');
    fs.copyFileSync(result.picture, picture, fs.constants.COPYFILE_EXCL);
    succeeded = true;
    return { ...result, picture };
  } finally {
    // Preserve diagnostics in the immutable run directory. Keep failed work for
    // diagnosis; only remove the exact mkdtemp directory on success.
    if (fs.existsSync(path.join(work, 'renders'))) copyGeneratedTree(path.join(work, 'renders'), path.join(hf, 'renders'));
    fs.writeFileSync(path.join(hf, 'windows-workspace.json'), JSON.stringify({ work, retained: !succeeded }), { flag: 'wx' });
    if (succeeded && path.dirname(work) === temporaryRoot && path.basename(work).startsWith('hf-') && !fs.lstatSync(work).isSymbolicLink()) fs.rmSync(work, { recursive: true });
  }
}

async function renderInDirectory(hf: string, frames: number, options: ProcessOptions) {
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
  // HyperFrames creates a transaction directory beside the output, adding its
  // basename again. On Windows the nested workbench path can exceed MAX_PATH
  // before rendering even starts. Keep the internal output name/path short;
  // the final delivery name and the frozen composition remain unchanged.
  const output = process.platform === 'win32' ? 'p.mp4' : 'renders/picture.mp4';
  const picture = path.join(hf, output);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await command(`render-${attempt + 1}`, ['render', '--output', output, '--quality', 'high', '--fps', '24', '--workers', '2']);
      break;
    } catch (error) {
      if (attempt || options.signal?.aborted || !/ffprobe.*deadline/i.test(String(error))) throw error;
      if (fs.existsSync(picture)) fs.renameSync(picture, path.join(path.dirname(picture), process.platform === 'win32' ? 'p-failed-1.mp4' : 'picture-failed-attempt-1.mp4'));
    }
  }
  const probe = await probeMedia(picture, path.join(hf, 'renders'), { ...options, countFrames: true });
  if (Number(probe.streams.find(s => s.codec_type === 'video')?.nb_read_frames) !== frames) {
    throw new FilmRenderError('HYPERFRAMES_FRAMES', 'HyperFrames 实际帧数与渲染单不一致', 4);
  }
  return { picture, lint, runtime };
}
