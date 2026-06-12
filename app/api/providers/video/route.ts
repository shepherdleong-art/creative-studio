import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { getVideoProviderConfigState } from '@/lib/video-auth';

export async function GET() {
  try {
    const db = getDb();
    const providers = db.prepare(`
      SELECT id, name, type, baseUrlEnv, apiKeyEnv, defaultModel, defaultDurationSec, enabled
      FROM video_providers
      WHERE enabled = 1
    `).all() as Array<{
      id: string;
      name: string;
      type: string;
      baseUrlEnv: string;
      apiKeyEnv: string;
      defaultModel: string;
      defaultDurationSec: number;
      enabled: number;
    }>;
    return NextResponse.json(providers.map((provider) => {
      const config = getVideoProviderConfigState(provider);
      return {
        id: provider.id,
        name: provider.name,
        type: provider.type,
        defaultModel: provider.defaultModel,
        defaultDurationSec: provider.defaultDurationSec,
        enabled: provider.enabled,
        configured: config.configured,
        missing: config.missing,
      };
    }));
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
