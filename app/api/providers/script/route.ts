import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { listScriptProviderMeta } from '@/lib/script-providers/store';
import { v4 as uuidv4 } from 'uuid';

export async function GET() {
  try {
    return NextResponse.json(listScriptProviderMeta());
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
      INSERT INTO script_providers
        (id, name, type, apiStyle, baseUrl, apiKey, model, keyEnv, baseUrlEnv, modelEnv, defaultBaseUrl, defaultModel, maxTokens, enabled, isBuiltin)
      VALUES (?, ?, ?, ?, ?, ?, ?, '', '', '', ?, ?, ?, ?, 0)
    `).run(
      id,
      body.name || '新脚本供应商',
      body.type || 'openai-compatible',
      body.apiStyle || 'openai-compatible',
      body.baseUrl || '',
      body.apiKey || '',
      body.model || '',
      '',
      '',
      Number(body.maxTokens || 8192),
      body.enabled === false ? 0 : 1
    );

    return NextResponse.json(listScriptProviderMeta().find((p) => p.id === id));
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
