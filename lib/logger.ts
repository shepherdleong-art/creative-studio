import { sanitizeMessage } from './log-sanitize.ts';
import { getDb } from './db.ts';
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs';
import path from 'path';
import { dataRoot } from './data-root.ts';

const LOG_DIR = path.join(dataRoot(), 'storage', 'logs');

export interface WorkbenchLogRetention {
  retentionDays: number;
  maxFileBytes: number;
  maxTotalBytes: number;
  maxFiles: number;
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function workbenchLogRetention(env: Record<string, string | undefined> = process.env): WorkbenchLogRetention {
  const maxFileBytes = positiveInteger(env.CREATIVE_STUDIO_LOG_MAX_FILE_BYTES, 10 * 1024 * 1024);
  return {
    retentionDays: positiveInteger(env.CREATIVE_STUDIO_LOG_RETENTION_DAYS, 30),
    maxFileBytes,
    maxTotalBytes: Math.max(maxFileBytes, positiveInteger(env.CREATIVE_STUDIO_LOG_MAX_TOTAL_BYTES, 100 * 1024 * 1024)),
    maxFiles: positiveInteger(env.CREATIVE_STUDIO_LOG_MAX_FILES, 20),
  };
}

export type LogLevel = 'info' | 'warn' | 'error' | 'debug';

/**
 * Format a Date as local time with timezone offset, e.g. 2026-08-25T09:25:35.203+08:00.
 * Log files are read by humans during troubleshooting, so they use local time;
 * the DB `createdAt` column stays in UTC (the frontend renders it as local).
 */
function formatLocalTimestamp(date: Date): string {
  const pad = (value: number, width = 2) => String(value).padStart(width, '0');
  const offsetMin = -date.getTimezoneOffset();
  const sign = offsetMin >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMin);
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `.${pad(date.getMilliseconds(), 3)}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}

function boundedLogLine(line: string, maxBytes: number): Buffer {
  let value = line.replace(/[\r\n]+$/g, '');
  const contentLimit = Math.max(0, maxBytes - 1);
  while (Buffer.byteLength(value, 'utf8') > contentLimit) value = value.slice(0, -1);
  return Buffer.from(`${value}\n`, 'utf8');
}

export function cleanupBoundedWorkbenchLogs(
  directory: string,
  options: WorkbenchLogRetention,
  now = new Date(),
): void {
  if (!fs.existsSync(directory)) return;
  const cutoff = now.getTime() - options.retentionDays * 24 * 60 * 60 * 1000;
  const files = fs.readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /^workbench-.*\.log$/.test(entry.name))
    .map((entry) => {
      const filePath = path.join(directory, entry.name);
      const stat = fs.statSync(filePath);
      return { filePath, size: stat.size, mtimeMs: stat.mtimeMs };
    });
  for (const file of files) {
    if (file.mtimeMs < cutoff) fs.unlinkSync(file.filePath);
  }
  const remaining = files.filter((file) => file.mtimeMs >= cutoff && fs.existsSync(file.filePath))
    .sort((left, right) => right.mtimeMs - left.mtimeMs || right.filePath.localeCompare(left.filePath));
  let totalBytes = 0;
  let kept = 0;
  for (const file of remaining) {
    if (kept < options.maxFiles && totalBytes + file.size <= options.maxTotalBytes) {
      totalBytes += file.size;
      kept += 1;
    } else {
      fs.unlinkSync(file.filePath);
    }
  }
}

export function appendBoundedWorkbenchLog(
  directory: string,
  line: string,
  options: WorkbenchLogRetention,
  now = new Date(),
): void {
  fs.mkdirSync(directory, { recursive: true });
  const dateStr = formatLocalTimestamp(now).slice(0, 10);
  const activePath = path.join(directory, `workbench-${dateStr}.log`);
  const bytes = boundedLogLine(line, options.maxFileBytes);
  if (fs.existsSync(activePath)) {
    const size = fs.statSync(activePath).size;
    if (size > 0 && size + bytes.length > options.maxFileBytes) {
      const suffix = formatLocalTimestamp(now).replace(/[:.]/g, '-');
      fs.renameSync(activePath, path.join(directory, `workbench-${dateStr}-${suffix}-${uuidv4().slice(0, 8)}.log`));
    }
  }
  fs.appendFileSync(activePath, bytes);
  cleanupBoundedWorkbenchLogs(directory, options, now);
}

export interface JobLogEntry {
  id: string;
  jobId: string;
  projectId: string;
  level: LogLevel;
  message: string;
  attempt: number;
  createdAt: string;
}

/**
 * Write a log entry to both the database and a file.
 * The API key is never logged — the logger explicitly redacts auth-related content.
 */
export function writeLog(params: {
  jobId?: string;
  projectId: string;
  level: LogLevel;
  message: string;
  attempt?: number;
}): void {
  const { jobId = null, projectId, level, message, attempt = 0 } = params;

  // Sanitize: redact any accidental API key exposure
  const sanitized = sanitizeMessage(message);

  // Write to DB (jobId is optional — null for queue-level logs)
  try {
    const db = getDb();
    db.prepare(
      `INSERT INTO job_logs (id, jobId, projectId, level, message, attempt, createdAt)
       VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`
    ).run(uuidv4(), jobId, projectId, level, sanitized, attempt);
  } catch {
    // If DB write fails, still try to write to file
  }

  // Write to file
  try {
    const now = new Date();
    const timestamp = formatLocalTimestamp(now);
    const jobLabel = jobId ? `[job:${jobId.slice(0, 8)}] ` : '';
    const line = `[${timestamp}] [${level.toUpperCase()}] ${jobLabel}[attempt:${attempt}] ${sanitized}`;
    appendBoundedWorkbenchLog(LOG_DIR, line, workbenchLogRetention(), now);
  } catch {
    // Last resort: console
    console.error(`[LOGGER FAILED] ${sanitized}`);
  }
}

/**
 * Get all logs for a project, ordered by time descending.
 */
export function getProjectLogs(projectId: string, limit = 300): JobLogEntry[] {
  const db = getDb();
  // Fetch latest N rows, then return in ASC order (oldest first, newest last)
  return db
    .prepare(
      `SELECT * FROM (
        SELECT rowid, * FROM job_logs
        WHERE projectId = ?
        ORDER BY createdAt DESC, rowid DESC
        LIMIT ?
      ) ORDER BY createdAt ASC, rowid ASC`
    )
    .all(projectId, limit) as JobLogEntry[];
}

/**
 * Get logs for a specific job (ASC order, oldest first).
 */
export function getJobLogs(jobId: string): JobLogEntry[] {
  const db = getDb();
  return db
    .prepare(`SELECT * FROM job_logs WHERE jobId = ? ORDER BY createdAt ASC, rowid ASC`)
    .all(jobId) as JobLogEntry[];
}

/**
 * Clear old logs (keep last N days).
 */
export function cleanupOldLogs(daysToKeep = 30): void {
  try {
    const db = getDb();
    db.prepare(
      `DELETE FROM job_logs WHERE createdAt < datetime('now', ?)`
    ).run(`-${daysToKeep} days`);

    // 只清理普通 workbench 文件；execution journal 与维护回执有独立保留水位。
    cleanupBoundedWorkbenchLogs(LOG_DIR, {
      ...workbenchLogRetention(),
      retentionDays: daysToKeep,
    });
  } catch {
    // Cleanup is best-effort
  }
}
