import { getDb } from './db';
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs';
import path from 'path';

const LOG_DIR = path.join(process.cwd(), 'storage', 'logs');

function ensureLogDir() {
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }
}

export type LogLevel = 'info' | 'warn' | 'error' | 'debug';

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
    ensureLogDir();
    const dateStr = new Date().toISOString().split('T')[0];
    const logFile = path.join(LOG_DIR, `workbench-${dateStr}.log`);
    const timestamp = new Date().toISOString();
    const jobLabel = jobId ? `[job:${jobId.slice(0, 8)}] ` : '';
    const line = `[${timestamp}] [${level.toUpperCase()}] ${jobLabel}[attempt:${attempt}] ${sanitized}\n`;
    fs.appendFileSync(logFile, line, 'utf-8');
  } catch {
    // Last resort: console
    console.error(`[LOGGER FAILED] ${sanitized}`);
  }
}

/**
 * Remove any text that looks like an API key from log messages.
 * Matches common patterns: sk-..., Bearer tokens, long base64 strings
 */
function sanitizeMessage(message: string): string {
  return (
    message
      // Redact OpenAI-style keys (sk-...)
      .replace(/sk-[a-zA-Z0-9_-]{20,}/g, '[REDACTED_API_KEY]')
      // Redact Bearer tokens in log messages
      .replace(/Bearer\s+[a-zA-Z0-9._\-=+/]{20,}/gi, 'Bearer [REDACTED]')
      // Redact Authorization headers
      .replace(/Authorization:\s*[^\s,]+\s*[^\s,]+/gi, 'Authorization: [REDACTED]')
      // Redact long hex/base64 strings that could be keys (40+ chars)
      .replace(/\b[a-zA-Z0-9+/=]{40,}\b/g, (match) => {
        // Don't redact image base64 (they're much longer and come after "b64_json")
        if (match.length > 200) return match;
        return '[REDACTED_LONG_STRING]';
      })
  );
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

    // Also clean up old log files
    ensureLogDir();
    const files = fs.readdirSync(LOG_DIR);
    const cutoff = Date.now() - daysToKeep * 24 * 60 * 60 * 1000;

    for (const file of files) {
      const filePath = path.join(LOG_DIR, file);
      const stat = fs.statSync(filePath);
      if (stat.mtimeMs < cutoff) {
        fs.unlinkSync(filePath);
      }
    }
  } catch {
    // Cleanup is best-effort
  }
}
