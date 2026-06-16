import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { resolveVideoProviderRuntimeConfig } from '@/lib/video-auth';
import { v4 as uuidv4 } from 'uuid';

function safeVideoProvider(provider: {
  id: string;
  name: string;
  type: string;
  baseUrlEnv: string;
  apiKeyEnv: string;
  modelEnv?: string;
  defaultModel: string;
  defaultDurationSec: number;
  enabled: number;
  baseUrl?: string;
  apiKey?: string;
  accessKey?: string;
  secretKey?: string;
}) {
  const runtime = resolveVideoProviderRuntimeConfig(provider);
  return {
    id: provider.id,
    name: provider.name,
    category: 'video',
    type: provider.type,
    baseUrl: runtime.baseUrl,
    defaultModel: runtime.model,
    defaultDurationSec: runtime.durationSec,
    enabled: provider.enabled,
    configured: runtime.configured,
    missing: runtime.missing,
    hasApiKey: runtime.hasApiKey,
  };
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const includeAll = url.searchParams.get('all') === '1';
    const db = getDb();
    const providers = db.prepare(`
      SELECT *
      FROM video_providers
      ${includeAll ? '' : 'WHERE enabled = 1'}
      ORDER BY name
    `).all() as Array<{
      id: string;
      name: string;
      type: string;
      baseUrlEnv: string;
      apiKeyEnv: string;
      modelEnv: string;
      defaultModel: string;
      defaultDurationSec: number;
      enabled: number;
      baseUrl: string;
      apiKey: string;
      accessKey: string;
      secretKey: string;
    }>;
    return NextResponse.json(providers.map(safeVideoProvider));
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const db = getDb();
    const body = await request.json();
    const id = uuidv4();
    const type = body.type || 'jimeng';

    db.prepare(`
      INSERT INTO video_providers
        (id, name, type, baseUrlEnv, apiKeyEnv, modelEnv, defaultModel, enabled, defaultDurationSec, baseUrl, apiKey, accessKey, secretKey)
      VALUES (?, ?, ?, '', '', '', ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      body.name || '新视频供应商',
      type,
      body.defaultModel || '',
      body.enabled === false ? 0 : 1,
      Number(body.defaultDurationSec || 5),
      body.baseUrl || '',
      type === 'kling' ? '' : (body.apiKey || ''),
      type === 'kling' ? (body.accessKey || '') : '',
      type === 'kling' ? (body.secretKey || '') : ''
    );

    const provider = db.prepare(`SELECT * FROM video_providers WHERE id = ?`).get(id) as Parameters<typeof safeVideoProvider>[0];
    return NextResponse.json(safeVideoProvider(provider));
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
