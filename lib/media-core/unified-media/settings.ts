import type Database from 'better-sqlite3';
import { ExecutionError } from '../execution/context.ts';

export const DEFAULT_IMAGE_CONGESTION_THRESHOLD_SEC = 30;
export const MAX_IMAGE_CONGESTION_THRESHOLD_SEC = 3_600;

export interface UnifiedImageCongestionSettings {
  imageCongestionThresholdSec: number;
  version: number;
  updatedAt: string;
}

interface SettingsRow {
  imageCongestionThresholdSec: number;
  version: number;
  updatedAt: string;
}

function validateThreshold(value: unknown): number {
  if (typeof value !== 'number'
    || !Number.isSafeInteger(value)
    || value < 0
    || value > MAX_IMAGE_CONGESTION_THRESHOLD_SEC) {
    throw new ExecutionError(
      'invalid_congestion_threshold',
      `图片拥堵分流阈值必须是 0–${MAX_IMAGE_CONGESTION_THRESHOLD_SEC} 的整数秒。`,
    );
  }
  return value;
}

export function readUnifiedImageCongestionSettings(
  db: Database.Database,
): UnifiedImageCongestionSettings {
  const row = db.prepare(`
    SELECT imageCongestionThresholdSec, version, updatedAt
    FROM execution_media_settings WHERE id = 1
  `).get() as SettingsRow | undefined;
  if (!row) {
    throw new ExecutionError('execution_not_ready', '统一媒体设置尚未就绪。');
  }
  return {
    imageCongestionThresholdSec: validateThreshold(row.imageCongestionThresholdSec),
    version: row.version,
    updatedAt: row.updatedAt,
  };
}

export function updateUnifiedImageCongestionSettings(
  db: Database.Database,
  input: {
    imageCongestionThresholdSec: unknown;
    expectedVersion: unknown;
    now?: Date;
  },
): UnifiedImageCongestionSettings {
  const threshold = validateThreshold(input.imageCongestionThresholdSec);
  if (typeof input.expectedVersion !== 'number'
    || !Number.isSafeInteger(input.expectedVersion)
    || input.expectedVersion < 1) {
    throw new ExecutionError('invalid_settings_version', '设置版本必须是从 1 开始的整数。');
  }
  const now = input.now ?? new Date();
  const update = db.transaction((): UnifiedImageCongestionSettings => {
    const current = readUnifiedImageCongestionSettings(db);
    if (current.version !== input.expectedVersion) {
      throw new ExecutionError(
        'settings_version_conflict',
        `统一媒体设置版本已变化：期望 ${input.expectedVersion}，实际 ${current.version}。`,
      );
    }
    const version = current.version + 1;
    const updatedAt = now.toISOString();
    db.prepare(`
      UPDATE execution_media_settings
      SET imageCongestionThresholdSec = ?, version = ?, updatedAt = ?
      WHERE id = 1 AND version = ?
    `).run(threshold, version, updatedAt, input.expectedVersion);
    return readUnifiedImageCongestionSettings(db);
  });
  return update.immediate();
}

export function imageCongestionDeadline(
  now: Date,
  thresholdSec: number,
): Date {
  return new Date(now.getTime() + validateThreshold(thresholdSec) * 1_000);
}
