import fs from 'node:fs';
import path from 'node:path';

/** 将展示名限制为单个 Windows/macOS 均可用的 MP4 文件名。 */
export function videoStorageFilename(displayName: string): string {
  let base = displayName.replace(/\\/g, '/').split('/').pop() || '未命名视频';
  base = base.replace(/\.mp4$/i, '').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').trim().replace(/[. ]+$/g, '');
  if (!base) base = '未命名视频';
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(base)) base = `视频-${base}`;
  return `${Array.from(base).slice(0, 116).join('')}.mp4`;
}

/** 排他创建：同名时追加可读序号，不覆盖其他项目/并发任务的成片。 */
export function writeVideoOutputFile(
  directory: string,
  displayName: string,
  buffer: Buffer,
): { filename: string; videoPath: string } {
  const original = videoStorageFilename(displayName);
  const base = original.slice(0, -4);
  for (let index = 1; ; index += 1) {
    const suffix = index === 1 ? '' : ` (${index})`;
    const filename = `${Array.from(base).slice(0, 116 - suffix.length).join('')}${suffix}.mp4`;
    const videoPath = path.join(directory, filename);
    // 避免命中孤立预览衍生物，从而播放到其他视频的旧预览。
    if (fs.existsSync(videoPath.slice(0, -4) + '.preview.mp4')) continue;
    let fd: number;
    try { fd = fs.openSync(videoPath, 'wx'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue;
      throw error;
    }
    try { fs.writeFileSync(fd, buffer); }
    catch (error) {
      fs.closeSync(fd);
      fs.unlinkSync(videoPath);
      throw error;
    }
    fs.closeSync(fd);
    return { filename, videoPath };
  }
}
