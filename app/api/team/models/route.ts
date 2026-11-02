import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { seedProviders } from '@/lib/seed';
import { isPlaceholderValue } from '@/lib/video-auth';
import { isVisibleImageProvider } from '@/lib/provider-list-visibility';
import { isVisibleVideoProvider } from '@/lib/provider-list-visibility';
import { listScriptProviderMeta } from '@/lib/script-providers/store';
import { describeVideoProvider } from '@/lib/video-model-capabilities';
import { getFinalEditTtsAdapter } from '@/lib/final-edit/adapters/tts-registry';
import { withTeamRoute } from '@/lib/team-service/route-wrapper';

function configuredSecret(value: unknown): boolean {
  return Boolean(String(value ?? '').trim()) && !isPlaceholderValue(String(value ?? ''));
}

async function __teamRouteGET(request: Request) {
  const kind = new URL(request.url).searchParams.get('kind') ?? '';
  const db = getDb();
  if (kind === 'image') {
    seedProviders();
    const rows = db.prepare(`SELECT id, name, model, type, enabled, apiKey FROM providers ORDER BY name`).all() as Array<Record<string, unknown> & { id: string; name: string; type: string; baseUrl: string }>;
    return NextResponse.json(rows.filter(isVisibleImageProvider).filter((row) => Number(row.enabled) === 1).map((row) => ({
      id: String(row.id), name: String(row.name), model: String(row.model), type: String(row.type),
      category: 'image', enabled: 1, configured: configuredSecret(row.apiKey), hasApiKey: configuredSecret(row.apiKey), missing: configuredSecret(row.apiKey) ? [] : ['API Key'],
    })));
  }
  if (kind === 'script') {
    return NextResponse.json(listScriptProviderMeta().filter((provider) => provider.enabled && provider.configured).map((provider) => ({
      id: provider.id, name: provider.name, model: provider.model, type: provider.type,
      category: 'script', enabled: 1, configured: true, hasApiKey: true,
      apiStyle: provider.apiStyle, supportsVision: provider.supportsVision,
      maxTokens: provider.maxTokens, executionScope: provider.executionScope, missing: [],
    })));
  }
  if (kind === 'video') {
    const rows = db.prepare(`SELECT * FROM video_providers WHERE enabled = 1 ORDER BY name`).all() as Array<import('@/lib/video-auth').VideoProviderEnvConfig & { id: string }>;
    return NextResponse.json(rows.filter(isVisibleVideoProvider).map((row) => {
      const provider = describeVideoProvider(row);
      return {
        id: provider.id, name: provider.name, category: 'video', type: provider.type,
        defaultModel: provider.defaultModel, defaultDurationSec: provider.defaultDurationSec,
        enabled: provider.enabled, configured: provider.configured, hasApiKey: provider.hasApiKey,
        capabilities: provider.capabilities, tailFrameCapability: provider.tailFrameCapability,
        ...(provider.multiShotCapability ? { multiShotCapability: provider.multiShotCapability } : {}),
        missing: provider.missing,
      };
    }));
  }
  if (kind === 'tts') {
    const rows = db.prepare(`SELECT id, name, type, keyEnv, model, enabled, isBuiltin, apiKey FROM final_edit_tts_providers ORDER BY name`).all() as Array<Record<string, unknown>>;
    const providers = rows.map((row) => {
      const hasApiKey = configuredSecret(row.apiKey) || Boolean(row.keyEnv && process.env[String(row.keyEnv)]);
      const adapter = getFinalEditTtsAdapter(String(row.id));
      return {
        id: String(row.id), name: String(row.name), type: String(row.type), model: String(row.model),
        enabled: Number(row.enabled), isBuiltin: Number(row.isBuiltin), hasApiKey,
        configured: Boolean(Number(row.enabled) && hasApiKey), voices: adapter.voices, description: adapter.description,
      };
    }).filter((provider) => provider.configured);
    providers.sort((left, right) => left.id === 'doubao-seed-tts-2' ? -1 : right.id === 'doubao-seed-tts-2' ? 1 : left.name.localeCompare(right.name, 'zh-CN'));
    return NextResponse.json(providers);
  }
  return NextResponse.json({ error: 'invalid_model_kind', message: 'kind 必须是 image、script、video 或 tts' }, { status: 400 });
}

export const GET = withTeamRoute('/api/team/models', 'GET', __teamRouteGET);
