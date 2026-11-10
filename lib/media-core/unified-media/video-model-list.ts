import type Database from 'better-sqlite3';
import { resolveVideoProviderRuntimeConfig, type VideoProviderEnvConfig } from '../../video-auth.ts';
import { isVisibleVideoProvider } from '../../provider-list-visibility.ts';
import {
  isUnifiedKlingChannelProvider,
  UNIFIED_KLING3_ANCHOR_ID,
  UNIFIED_KLING3_CHANNELS,
  unifiedKlingAnchorProjection,
} from './catalog.ts';

export interface UnifiedKlingChannelAvailability {
  channelKey: string;
  providerId: string;
  model: string;
  configured: boolean;
  identityValid: boolean;
}

function inspectChannel(
  db: Database.Database,
  channel: (typeof UNIFIED_KLING3_CHANNELS)[number],
): UnifiedKlingChannelAvailability {
  const row = db.prepare('SELECT * FROM video_providers WHERE id = ?').get(channel.providerId) as
    | (VideoProviderEnvConfig & { id: string })
    | undefined;
  if (!row || row.type !== 'openai-video' || row.defaultModel !== channel.model) {
    return {
      channelKey: channel.channelKey,
      providerId: channel.providerId,
      model: channel.model,
      configured: false,
      identityValid: false,
    };
  }
  const runtime = resolveVideoProviderRuntimeConfig(row);
  return {
    channelKey: channel.channelKey,
    providerId: channel.providerId,
    model: channel.model,
    configured: Boolean(row.enabled && runtime.enabled && runtime.configured),
    identityValid: true,
  };
}

export function unifiedKlingProviderAvailability(db: Database.Database): UnifiedKlingChannelAvailability[] {
  return UNIFIED_KLING3_CHANNELS.map((channel) => inspectChannel(db, channel));
}

export function projectTeamVideoModels<T extends { id: string; defaultModel?: string; model?: string }>(
  described: T[],
  options: {
    mode: 'local' | 'server';
    unifiedAvailable: boolean;
    unifiedCapabilities: Record<string, unknown>;
  },
): Array<T | ReturnType<typeof unifiedKlingAnchorProjection> & {
  capabilities?: Record<string, unknown>;
}> {
  if (options.mode !== 'server') {
    return described.filter((provider) => provider.id !== UNIFIED_KLING3_ANCHOR_ID);
  }
  return [
    {
      ...unifiedKlingAnchorProjection(options.unifiedAvailable),
      capabilities: options.unifiedCapabilities,
    },
    ...described.filter((provider) =>
      provider.id !== UNIFIED_KLING3_ANCHOR_ID && !isUnifiedKlingChannelProvider(provider)),
  ];
}

export function isVisibleNonUnifiedVideoProvider(provider: {
  id: string; defaultModel?: string; model?: string;
}): boolean {
  return provider.id !== UNIFIED_KLING3_ANCHOR_ID
    && !isUnifiedKlingChannelProvider(provider)
    && isVisibleVideoProvider(provider);
}
