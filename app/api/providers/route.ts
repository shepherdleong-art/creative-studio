import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { seedProviders } from '@/lib/seed';
import { isPlaceholderValue } from '@/lib/video-auth';
import { v4 as uuidv4 } from 'uuid';

function isRealKey(value: string | undefined | null): boolean {
  const s = (value || '').trim();
  return !!s && !isPlaceholderValue(s);
}

export async function GET() {
  try {
    seedProviders();
    const db = getDb();
    const providers = db.prepare(`SELECT * FROM providers ORDER BY name`).all();

    // Don't expose apiKey or apiKeyEnv; just indicate if configured
    const safe = (providers as Array<Record<string, unknown>>).map((p) => ({
      ...p,
      category: 'image',
      configured: isRealKey(p.apiKey as string),
      missing: isRealKey(p.apiKey as string) ? [] : ['API Key'],
      apiKeyEnv: undefined,
      apiKey: undefined,
      hasApiKey: isRealKey(p.apiKey as string),
    }));

    return NextResponse.json(safe);
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

export async function POST(request: Request) {
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

    const provider = db.prepare(`SELECT * FROM providers WHERE id = ?`).get(id) as Record<string, unknown>;
    const safe = {
      ...provider,
      category: 'image',
      configured: isRealKey(provider.apiKey as string),
      missing: isRealKey(provider.apiKey as string) ? [] : ['API Key'],
      apiKeyEnv: undefined,
      apiKey: undefined,
      hasApiKey: isRealKey(provider.apiKey as string),
    };

    return NextResponse.json(safe);
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
