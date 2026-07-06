import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { listNarrationProviderMeta } from '@/lib/narration-providers/store';
import { v4 as uuidv4 } from 'uuid';

export async function GET() {
  try {
    return NextResponse.json(listNarrationProviderMeta());
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const db = getDb();
    const body = await request.json();
    const id = uuidv4();

    db.prepare(`
      INSERT INTO narration_providers (id, name, type, apiKey, baseUrl, model, voices, enabled, isBuiltin)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)
    `).run(
      id,
      body.name || '新口播供应商',
      body.type || 'qwen-tts',
      body.apiKey || '',
      body.baseUrl || '',
      body.model || '',
      body.voices || '',
      body.enabled === false ? 0 : 1
    );

    return NextResponse.json(listNarrationProviderMeta().find((p) => p.id === id));
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
