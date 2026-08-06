import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { getFinalEditTtsAdapter } from '@/lib/final-edit/adapters/tts-registry';
import { filterManagedProviders, loadManagedProviderAllowlist } from '@/lib/managed-provider-policy';
import type { ManagedProviderIdentity } from '@/lib/managed-provider-policy';
import { isManagedDeployment } from '@/lib/managed-deployment';

type TtsProviderRow = ManagedProviderIdentity & {
  name: string;
  keyEnv: string;
  model: string;
  enabled: number;
  isBuiltin: number;
  apiKey: string;
  costPerThousandCharacters: number;
};

export async function GET() {
  const rows = getDb().prepare(`SELECT id, name, type, baseUrl, keyEnv, model, enabled, isBuiltin, apiKey, costPerThousandCharacters FROM final_edit_tts_providers ORDER BY name`).all() as TtsProviderRow[];
  const allowlist = isManagedDeployment() ? loadManagedProviderAllowlist() : null;
  const visible = filterManagedProviders('tts', rows, allowlist);
  const providers = visible.map(({ apiKey, ...row }) => {
    const adapter = getFinalEditTtsAdapter(String(row.id));
    const hasApiKey = Boolean(String(apiKey || '').trim() || (row.keyEnv && process.env[String(row.keyEnv)]));
    return {
      ...row,
      id: String(row.id),
      name: String(row.name),
      enabled: Number(row.enabled),
      hasApiKey,
      configured: Boolean(row.enabled && hasApiKey),
      voices: adapter.voices,
      description: adapter.description,
    };
  });
  providers.sort((left, right) => {
    if (left.configured !== right.configured) return left.configured ? -1 : 1;
    const leftPreferred = left.id === 'doubao-seed-tts-2';
    const rightPreferred = right.id === 'doubao-seed-tts-2';
    if (leftPreferred !== rightPreferred) return leftPreferred ? -1 : 1;
    if (Boolean(left.enabled) !== Boolean(right.enabled)) return left.enabled ? -1 : 1;
    return String(left.name).localeCompare(String(right.name), 'zh-CN');
  });
  return NextResponse.json(providers);
}
