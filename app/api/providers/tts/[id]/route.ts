import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { getFinalEditTtsAdapter } from '@/lib/final-edit/adapters/tts-registry';

const KEY_PLACEHOLDER = '••••••••';

export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let adapter: ReturnType<typeof getFinalEditTtsAdapter>;
  try { adapter = getFinalEditTtsAdapter(id); } catch { return NextResponse.json({ error: 'provider_not_found' }, { status: 404 }); }
  const body = await request.json() as { enabled?: boolean; baseUrl?: string; apiKey?: string; costPerThousandCharacters?: number };
  const current = getDb().prepare(`SELECT * FROM final_edit_tts_providers WHERE id=?`).get(id) as {
    type: string;
    model: string;
    baseUrl: string;
    apiKey: string;
    enabled: number;
    costPerThousandCharacters: number;
  } | undefined;
  if (!current) return NextResponse.json({ error: 'provider_not_found' }, { status: 404 });
  let baseUrl = typeof body.baseUrl === 'string' ? body.baseUrl : current.baseUrl;
  try {
    baseUrl = adapter.validateBaseUrl(baseUrl);
  } catch (error) { return NextResponse.json({ error: 'invalid_base_url', message: error instanceof Error ? error.message : 'Base URL 不合法' }, { status: 400 }); }
  const apiKey = typeof body.apiKey === 'string' && body.apiKey !== KEY_PLACEHOLDER ? body.apiKey.trim() : current.apiKey;
  let cost = current.costPerThousandCharacters;
  const isFixedDoubaoIdentity = id === 'doubao-seed-tts-2'
    && current.type === 'doubao-http-chunked'
    && current.model === 'seed-tts-2.0';
  if (!isFixedDoubaoIdentity && body.costPerThousandCharacters != null) {
    cost = Number(body.costPerThousandCharacters);
    if (!Number.isFinite(cost) || cost < 0) return NextResponse.json({ error: 'invalid_cost', message: '每千字符成本必须是非负数' }, { status: 400 });
  }
  getDb().prepare(`UPDATE final_edit_tts_providers SET baseUrl=?, apiKey=?, enabled=?, costPerThousandCharacters=?, updatedAt=? WHERE id=?`).run(baseUrl, apiKey, body.enabled == null ? current.enabled : (body.enabled ? 1 : 0), cost, new Date().toISOString(), id);
  return NextResponse.json({ success: true, hasApiKey: Boolean(apiKey) });
}
