import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { assertNoStorageSymlink } from './storage-path.ts';

export function desktopRevealAvailable(platform: NodeJS.Platform = process.platform): boolean {
  return process.env.CREATIVE_STUDIO_DESKTOP === '1' && (platform === 'darwin' || platform === 'win32');
}

export function resolvePublishedVideoForReveal(storageRoot: string, outputJson: string): string {
  let output: { publishedVideoRelativePath?: unknown };
  try { output = JSON.parse(outputJson) as { publishedVideoRelativePath?: unknown }; }
  catch { throw new Error('渲染任务没有有效的已发布文件记录'); }
  if (typeof output.publishedVideoRelativePath !== 'string' || !output.publishedVideoRelativePath) {
    throw new Error('渲染任务尚未写回已发布成片');
  }
  const absolutePath = assertNoStorageSymlink(storageRoot, output.publishedVideoRelativePath);
  let stat: fs.Stats;
  try { stat = fs.statSync(absolutePath); }
  catch { throw new Error('已发布成片文件不存在'); }
  if (!stat.isFile()) throw new Error('已发布成片路径不是文件');
  return absolutePath;
}

export function revealCommand(platform: NodeJS.Platform, absolutePath: string): { command: string; args: string[] } {
  if (platform === 'darwin') return { command: 'open', args: ['-R', absolutePath] };
  if (platform === 'win32') return { command: 'explorer.exe', args: [`/select,${absolutePath}`] };
  throw new Error('当前平台不支持在文件夹中查看');
}

export function revealPublishedVideo(absolutePath: string, platform: NodeJS.Platform = process.platform): Promise<void> {
  const invocation = revealCommand(platform, absolutePath);
  return new Promise((resolve, reject) => {
    const child = spawn(invocation.command, invocation.args, { detached: true, stdio: 'ignore', shell: false });
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); resolve(); });
  });
}
