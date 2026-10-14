import path from 'node:path';
import type Database from 'better-sqlite3';
import type { CanvasAssetRecord } from './assets.ts';
import { CanvasError } from './errors.ts';

/** Windows/macOS 通用文件名：保留中文，拒绝目录片段、设备名、尾部点与控制字符。 */
export function sanitizeCanvasFilename(input: string, fallback = '未命名', maxLength = 48): string {
  const clean = input.replace(/[<>:"/\\|?*]/g, '_').replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/^\.+/, '').trim();
  const clipped = Array.from(clean || fallback).slice(0, maxLength).join('').replace(/[. ]+$/, '') || fallback;
  return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(clipped) ? `_${clipped}` : clipped;
}

/** 用本机时间方便在资源管理器按生成时间查找；短身份区分同名、同毫秒的多变体。 */
export function canvasNamedFilename(name: string, id: string, extension: string, at: Date): string {
  const pad = (value: number, size = 2) => String(value).padStart(size, '0');
  const stamp = `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}`
    + `-${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}-${pad(at.getMilliseconds(), 3)}`;
  return `${sanitizeCanvasFilename(name)}_${stamp}_${id.replace(/-/g, '').slice(0, 12)}.${extension}`;
}

/** 首次使用可读目录时固定名称；之后重命名画布仍复用该目录，不搬动已有文件。 */
export function canvasNamedDirectory(db: Database.Database, canvasId: string): string {
  const canvas = db.prepare('SELECT name FROM creative_canvases WHERE id = ?').get(canvasId) as { name: string } | undefined;
  if (!canvas) throw new CanvasError('not_found', '画布不存在。');
  const suffix = `__${canvasId.replace(/-/g, '').slice(0, 12)}`;
  const rows = db.prepare(`SELECT relativePath FROM creative_canvas_assets WHERE canvasId = ? ORDER BY createdAt, rowid`)
    .all(canvasId) as Array<{ relativePath: string }>;
  for (const row of rows) {
    const parts = row.relativePath.split('/');
    if (parts[0] === 'canvas' && parts[1]?.endsWith(suffix) && parts.length === 4
        && sanitizeCanvasFilename(parts[1], '', 100) === parts[1]) {
      return path.posix.join('canvas', parts[1]);
    }
  }
  return path.posix.join('canvas', `${sanitizeCanvasFilename(canvas.name, '未命名画布', 36)}${suffix}`);
}

function graphNodes(db: Database.Database, canvasId: string): Array<{ id: string; data: Record<string, unknown> }> {
  const row = db.prepare('SELECT graphJson FROM creative_canvases WHERE id = ?').get(canvasId) as { graphJson: string } | undefined;
  if (!row) return [];
  try { return JSON.parse(row.graphJson).nodes ?? []; } catch { return []; }
}

export function canvasResultName(db: Database.Database, canvasId: string, taskId: string, fallback: string): string {
  const task = db.prepare('SELECT nodeId, parameterSnapshot FROM creative_canvas_tasks WHERE id = ? AND canvasId = ?')
    .get(taskId, canvasId) as { nodeId: string; parameterSnapshot: string } | undefined;
  if (!task) return fallback;
  const title = String(graphNodes(db, canvasId).find((node) => node.id === task.nodeId)?.data.title ?? '').trim();
  if (title && !['图片生成', '视频生成', '生成结果'].includes(title)) return title;
  try {
    const prompt = JSON.parse(task.parameterSnapshot).prompt;
    if (typeof prompt === 'string' && prompt.trim()) return prompt.trim().replace(/\s+/g, ' ');
  } catch { /* 历史快照缺失时按媒体类型兜底。 */ }
  return title || fallback;
}

/** 新文件直接使用落盘名称；历史 UUID 文件只改善下载名，不移动或重写旧资产。 */
export function canvasAssetDownloadFilename(db: Database.Database, asset: CanvasAssetRecord): string {
  const basename = path.posix.basename(asset.relativePath);
  const extension = path.posix.extname(basename).slice(1);
  const stem = path.posix.basename(basename, `.${extension}`);
  if (!/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(stem)) {
    return sanitizeCanvasFilename(stem, '素材', 100) + `.${extension}`;
  }
  const media = asset.mediaKind === 'video' ? '视频' : asset.mediaKind === 'audio' ? '音频' : '图片';
  const name = asset.sourceTaskId
    ? canvasResultName(db, asset.canvasId, asset.sourceTaskId, `生成${media}`)
    : String(graphNodes(db, asset.canvasId).find((node) => node.data.assetId === asset.id)?.data.title ?? `导入${media}`);
  return canvasNamedFilename(asset.sourceTaskId ? name : path.parse(name).name || name,
    asset.id, extension, new Date(asset.createdAt));
}

export function canvasAttachmentHeader(filename: string): string {
  const encoded = encodeURIComponent(filename).replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${encoded}"; filename*=UTF-8''${encoded}`;
}
