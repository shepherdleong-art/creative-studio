import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { getFinalEditTtsAdapter } from '@/lib/final-edit/adapters/tts-registry';

export async function GET() {
  const rows = getDb().prepare(`SELECT id, name, type, baseUrl, keyEnv, model, enabled, isBuiltin, apiKey, costPerThousandCharacters FROM final_edit_tts_providers ORDER BY name`).all() as Array<Record<string, unknown>>;
  return NextResponse.json(rows.map(({ apiKey, ...row }) => ({ ...row, hasApiKey: Boolean(String(apiKey || '').trim() || (row.keyEnv && process.env[String(row.keyEnv)])), configured: Boolean(row.enabled && (String(apiKey || '').trim() || (row.keyEnv && process.env[String(row.keyEnv)]))), voices: getFinalEditTtsAdapter(String(row.id)).voices })));
}
