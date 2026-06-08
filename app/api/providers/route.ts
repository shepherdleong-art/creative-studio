import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { seedProviders } from '@/lib/seed';

export async function GET() {
  try {
    seedProviders();
    const db = getDb();
    const providers = db.prepare(`SELECT * FROM providers ORDER BY name`).all();

    // Don't expose apiKey or apiKeyEnv; just indicate if configured
    const safe = (providers as Array<Record<string, unknown>>).map((p) => ({
      ...p,
      apiKeyEnv: undefined,
      apiKey: undefined,
      hasApiKey: !!(p.apiKey as string) || !!process.env[p.apiKeyEnv as string],
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
    const { v4: uuidv4 } = require('uuid');

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
      body.type || 'geekai-json',
      body.defaultCostPerImage || null
    );

    const provider = db.prepare(`SELECT * FROM providers WHERE id = ?`).get(id) as Record<string, unknown>;
    const safe = {
      ...provider,
      apiKeyEnv: undefined,
      apiKey: undefined,
      hasApiKey: !!(provider.apiKey as string),
    };

    return NextResponse.json(safe);
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
