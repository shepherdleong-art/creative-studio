import type Database from 'better-sqlite3';
import type { TeamViewer } from './diagnostics.ts';
import { TeamPoolError } from './pools.ts';
import {
  UNIFIED_CHANNEL_FAILURE_THRESHOLD,
  channelHealthReasonLabel,
  channelHealthStateLabel,
  clearUnifiedChannelHealthAvoidance,
  listUnifiedChannelHealthDefinitions,
  readUnifiedChannelHealth,
  type UnifiedChannelHealthState,
} from '../media-core/unified-media/health.ts';

export interface TeamChannelHealthView {
  healthKey: string;
  unifiedModel: string;
  unifiedModelLabel: string;
  channelKey: string;
  channelLabel: string;
  providerName: string;
  manualEnabled: boolean;
  state: UnifiedChannelHealthState;
  stateLabel: string;
  consecutiveFailures: number;
  failureThreshold: number;
  reasonCode: string | null;
  reasonLabel: string | null;
  lastFailureAt: string | null;
  lastSuccessAt: string | null;
  avoidUntil: string | null;
  recoveryDue: boolean;
  version: number;
  canClear: boolean;
}

function assertAdmin(viewer: TeamViewer): void {
  if (viewer.role !== 'admin') {
    throw new TeamPoolError(403, 'channel_health_forbidden', '只有管理员可以查看或恢复渠道健康状态。');
  }
}

function providerInfo(
  db: Database.Database,
  table: 'providers' | 'video_providers',
  providerId: string,
): { name: string; enabled: boolean } {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)) {
    return { name: '未配置', enabled: false };
  }
  const row = db.prepare(`SELECT name, enabled FROM ${table} WHERE id = ?`).get(providerId) as
    | { name: string; enabled: number }
    | undefined;
  return row
    ? { name: row.name || providerId, enabled: Boolean(row.enabled) }
    : { name: '未配置', enabled: false };
}

export function readTeamChannelHealth(
  db: Database.Database,
  viewer: TeamViewer,
  now = new Date(),
): { items: TeamChannelHealthView[]; failureThreshold: number } {
  assertAdmin(viewer);
  const items = listUnifiedChannelHealthDefinitions().map((definition): TeamChannelHealthView => {
    const provider = providerInfo(db, definition.providerTable, definition.providerId);
    const health = readUnifiedChannelHealth(db, definition.unifiedModel, definition.channelKey);
    const state = health?.state ?? 'healthy';
    const avoidUntil = health?.avoidUntil ?? null;
    return {
      healthKey: health?.healthKey ?? `${definition.unifiedModel}:${definition.channelKey}`,
      unifiedModel: definition.unifiedModel,
      unifiedModelLabel: definition.unifiedModelLabel,
      channelKey: definition.channelKey,
      channelLabel: definition.channelLabel,
      providerName: provider.name,
      manualEnabled: provider.enabled,
      state,
      stateLabel: channelHealthStateLabel({ state }),
      consecutiveFailures: health?.consecutiveFailures ?? 0,
      failureThreshold: UNIFIED_CHANNEL_FAILURE_THRESHOLD,
      reasonCode: health?.reasonCode ?? null,
      reasonLabel: channelHealthReasonLabel(health?.reasonCode ?? null),
      lastFailureAt: health?.lastFailureAt ?? null,
      lastSuccessAt: health?.lastSuccessAt ?? null,
      avoidUntil,
      recoveryDue: state !== 'healthy' && (!avoidUntil || Date.parse(avoidUntil) <= now.getTime()),
      version: health?.version ?? 0,
      canClear: state !== 'healthy',
    };
  });
  return { items, failureThreshold: UNIFIED_CHANNEL_FAILURE_THRESHOLD };
}

export function clearTeamChannelHealth(
  db: Database.Database,
  viewer: TeamViewer,
  input: { healthKey: string; expectedVersion: number; now?: Date },
): TeamChannelHealthView {
  assertAdmin(viewer);
  if (!input.healthKey.trim() || !Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0) {
    throw new TeamPoolError(400, 'channel_health_input_invalid', '通道健康状态参数无效。');
  }
  const definitions = listUnifiedChannelHealthDefinitions();
  const definition = definitions.find((item) =>
    `${item.unifiedModel}:${item.channelKey}` === input.healthKey);
  if (!definition) {
    throw new TeamPoolError(404, 'channel_health_not_found', '通道健康记录不存在。');
  }
  try {
    clearUnifiedChannelHealthAvoidance(db, {
      unifiedModel: definition.unifiedModel,
      channelKey: definition.channelKey,
      providerId: definition.providerId,
      actorId: viewer.userId,
      expectedVersion: input.expectedVersion,
      now: input.now,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/版本已变化/.test(message)) {
      throw new TeamPoolError(409, 'channel_health_version_conflict', message);
    }
    throw error;
  }
  return readTeamChannelHealth(db, viewer, input.now).items.find((item) => item.healthKey === input.healthKey)!;
}
