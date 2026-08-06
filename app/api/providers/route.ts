import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { seedProviders } from '@/lib/seed';
import { isPlaceholderValue } from '@/lib/video-auth';
import { filterManagedProviders, loadManagedProviderAllowlist, managedProviderMutationResponse } from '@/lib/managed-provider-policy';
import type { ManagedProviderIdentity } from '@/lib/managed-provider-policy';
import { isManagedDeployment } from '@/lib/managed-deployment';
import { v4 as uuidv4 } from 'uuid';

function isRealKey(value: string | undefined | null): boolean {
  const s = (value || '').trim();
  return !!s && !isPlaceholderValue(s);
}

type ImageProviderRow = ManagedProviderIdentity & {
  name: string;
  apiKey: string;
  model: string;
  enabled: number;
  defaultCostPerImage: number | null;
};

function safeImageProvider(provider: ImageProviderRow) {
  const configured = isRealKey(provider.apiKey as string);
  return {
    ...provider,
    category: 'image',
    configured,
    missing: configured ? [] : ['API Key'],
    apiKeyEnv: undefined,
    apiKey: undefined,
    hasApiKey: configured,
  };
}

export async function GET() {
  try {
    seedProviders();
    const db = getDb();
    const providers = db.prepare(`SELECT * FROM providers ORDER BY name`).all() as ImageProviderRow[];
    const allowlist = isManagedDeployment() ? loadManagedProviderAllowlist() : null;
    const visible = filterManagedProviders('image', providers, allowlist);

    // Don't expose apiKey or apiKeyEnv; just indicate if configured
    const safe = visible.map(safeImageProvider);

    return NextResponse.json(safe);
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const managedError = managedProviderMutationResponse();
  if (managedError) {
    return NextResponse.json(managedError, { status: 403 });
  }
  try {
    const db = getDb();
    const body = await request.json();

    const id = uuidv4();
    db.prepare(
      `INSERT INTO providers (id, name, baseUrl, apiKeyEnv, apiKey, model, type, enabled, defaultCostPerImage)
       VALUES (?, ?, ?, '', ?, ?, ?, 1, ?)`
    ).run(
      id,
      body.name || '新供应商',
      body.baseUrl || '',
      body.apiKey || '',
      body.model || 'gpt-image-2',
      body.type || 'openai-compatible',
      body.defaultCostPerImage || null
    );

    const provider = db.prepare(`SELECT * FROM providers WHERE id = ?`).get(id) as ImageProviderRow;
    const safe = safeImageProvider(provider);

    return NextResponse.json(safe);
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
