import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { dataRoot } from '../data-root.ts';
import { sanitizeMessage } from '../log-sanitize.ts';
import type { CanvasTaskRecord } from './tasks.ts';
import type { CanvasTaskPhase } from './types.ts';

export interface CanvasLogEntry {
  id: string;
  canvasId: string;
  jobId: string | null;
  level: 'info' | 'warn' | 'error' | 'debug';
  message: string;
  attempt: number;
  createdAt: string;
}

const PHASE_LABELS: Record<CanvasTaskPhase, string> = {
  waiting_input: '等待上游输入', queued: '进入队列', preparing: '准备素材',
  submitting: '向供应商提交', polling: '查询生成进度', downloading: '下载保存产物',
  succeeded: '生成完成', failed: '任务失败', blocked: '上游未完成',
  cancelled: '任务已停止', uncertain: '提交状态待核查',
  resume_pending: '等待手动继续', download_failed: '产物下载失败',
};

/** 独立画布日志，不借用旧项目表。诊断写入失败不得打断任务。 */
export function writeCanvasLog(db: Database.Database, entry: {
  canvasId: string; jobId?: string; level: CanvasLogEntry['level']; message: string; createdAt?: string;
}): void {
  const createdAt = entry.createdAt ?? new Date().toISOString();
  const message = sanitizeMessage(entry.message);
  try {
    db.prepare(`INSERT INTO creative_canvas_logs (id, canvasId, jobId, level, message, createdAt)
      VALUES (?, ?, ?, ?, ?, ?)`).run(randomUUID(), entry.canvasId, entry.jobId ?? null, entry.level, message, createdAt);
  } catch { /* 文件日志兜底；不改变任务结果。 */ }
  try {
    const dir = path.join(dataRoot(), 'storage', 'logs');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, `canvas-${createdAt.slice(0, 10)}.log`),
      JSON.stringify({ ...entry, createdAt, message }) + '\n');
  } catch { /* 日志不能阻断调度。 */ }
}

function taskMessage(task: CanvasTaskRecord): string {
  let model = '';
  try {
    const snapshot = JSON.parse(task.providerSnapshot);
    model = String(snapshot.modelAlias ?? snapshot.capabilityKey ?? '');
  } catch { /* 老记录可能没有模型快照。 */ }
  return [`节点 ${task.nodeId}`, model && `模型 ${model}`, PHASE_LABELS[task.phase] ?? task.phase,
    task.providerTaskId && `远端任务 ${task.providerTaskId}`,
    task.errorCode && `错误码 ${task.errorCode}`, task.errorMessage].filter(Boolean).join(' · ');
}

function taskLevel(task: CanvasTaskRecord): CanvasLogEntry['level'] {
  if (['failed', 'download_failed'].includes(task.phase)) return 'error';
  if (['uncertain', 'blocked', 'resume_pending', 'cancelled'].includes(task.phase)) return 'warn';
  if (task.errorCode || task.errorMessage) return 'warn';
  return 'info';
}

/** 只记有诊断价值的变化；轮询计数与租约心跳不刷屏。守卫失败不得调用。 */
export function recordCanvasTaskLog(db: Database.Database, task: CanvasTaskRecord, before?: CanvasTaskRecord): void {
  if (before && task.phase === before.phase && task.errorCode === before.errorCode
      && task.errorMessage === before.errorMessage && task.providerTaskId === before.providerTaskId
      && task.cancelRequestedAt === before.cancelRequestedAt) return;
  // 第一次恢复旧任务前先保存其遗留错误，避免新状态覆盖唯一的历史证据。
  if (before && !db.prepare('SELECT 1 FROM creative_canvas_logs WHERE jobId = ? LIMIT 1').get(task.id)) {
    writeCanvasLog(db, { canvasId: before.canvasId, jobId: before.id, level: taskLevel(before),
      message: `历史任务状态（未记录完整过程） · ${taskMessage(before)}`, createdAt: before.updatedAt });
  }
  const cancelIntent = before && !before.cancelRequestedAt && task.cancelRequestedAt;
  writeCanvasLog(db, { canvasId: task.canvasId, jobId: task.id, level: taskLevel(task),
    message: taskMessage(task) + (cancelIntent ? ' · 已请求停止，等待确认' : ''), createdAt: task.updatedAt });
}

export function getCanvasLogs(db: Database.Database, canvasId: string, options: { jobId?: string; limit?: number } = {}): CanvasLogEntry[] {
  const limit = Number.isFinite(options.limit) ? Math.min(1000, Math.max(1, Math.trunc(options.limit!))) : 300;
  const jobId = options.jobId ?? null;
  const rows = db.prepare(`SELECT * FROM creative_canvas_logs WHERE canvasId = ? AND (? IS NULL OR jobId = ?)
    ORDER BY createdAt DESC, rowid DESC LIMIT ?`).all(canvasId, jobId, jobId, limit) as CanvasLogEntry[];
  // 历史任务没有阶段日志：明确标记为快照，不编造过去的执行过程。
  const historical = db.prepare(`SELECT * FROM creative_canvas_tasks t
    WHERE canvasId = ? AND (? IS NULL OR id = ?)
    AND NOT EXISTS (SELECT 1 FROM creative_canvas_logs l WHERE l.jobId = t.id)
    ORDER BY updatedAt DESC LIMIT ?`).all(canvasId, jobId, jobId, limit) as CanvasTaskRecord[];
  const snapshots = historical.map((task): CanvasLogEntry => ({
    id: `snapshot-${task.id}`, canvasId, jobId: task.id, level: taskLevel(task), attempt: 0,
    message: sanitizeMessage(`历史任务状态（未记录完整过程） · ${taskMessage(task)}`), createdAt: task.updatedAt,
  }));
  // Reverse first so stable sorting preserves insertion order for identical timestamps.
  return [...rows.reverse(), ...snapshots].sort((a, b) => a.createdAt.localeCompare(b.createdAt)).slice(-limit);
}
