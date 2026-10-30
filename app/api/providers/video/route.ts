import { NextResponse } from 'next/server';
import { parseVideoDuration, videoDurationError } from '@/lib/video-duration';
import { getDb } from '@/lib/db';
import type { VideoProviderEnvConfig } from '@/lib/video-auth';
import { describeVideoProvider } from '@/lib/video-model-capabilities';
import { getVideoProviderGatewayReadiness } from '@/lib/video-provider-schema-runtime';
import { v4 as uuidv4 } from 'uuid';
import { isVisibleVideoProvider } from '@/lib/provider-list-visibility';

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
    return NextResponse.json(providers.filter(isVisibleVideoProvider).map(describeVideoProvider));
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const id = uuidv4();
    const type = body.type || 'jimeng';
    const durationSec = parseVideoDuration(body.defaultDurationSec);
    const durationError = videoDurationError(type, body.defaultModel || '', durationSec);
    if (durationError) return NextResponse.json({ error: durationError }, { status: 400 });
    if (type === 'openai-video') {
      const readiness = await getVideoProviderGatewayReadiness();
      if (!readiness.available) {
        return NextResponse.json({
          error: 'video_provider_schema_unavailable',
          message: readiness.message,
        }, { status: 503 });
      }
    }
    const db = getDb();

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
      durationSec,
      body.baseUrl || '',
      type === 'kling' ? '' : (body.apiKey || ''),
      type === 'kling' ? (body.accessKey || '') : '',
      type === 'kling' ? (body.secretKey || '') : ''
    );

    const provider = db.prepare(`SELECT * FROM video_providers WHERE id = ?`).get(id) as VideoProviderEnvConfig;
    return NextResponse.json(describeVideoProvider(provider));
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
