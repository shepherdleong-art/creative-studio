import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { ASR_KEY_ENV, ASR_PROVIDER_ID, readAsrProviderRow, resolveAsrConfig } from '@/lib/live-mixcut/asr-provider';

/** 与图片/脚本供应商一致：读回时用占位符，绝不回显明文 Key。 */
const KEY_PLACEHOLDER = '••••••••';

export async function GET() {
  const row = readAsrProviderRow(getDb());
  if (!row) {
    return NextResponse.json({ available: false, message: '实拍混剪未启用，或数据库尚未升级到 v2。' }, { status: 503 });
  }
  const resolved = resolveAsrConfig(row);
  return NextResponse.json({
    available: true,
    provider: {
      id: row.id,
      name: row.name,
      type: row.type,
      baseUrl: resolved.baseUrl,
      resourceId: resolved.resourceId,
      model: resolved.model,
      enabled: Boolean(row.enabled),
      isBuiltin: Boolean(row.isBuiltin),
      keyEnv: row.keyEnv || ASR_KEY_ENV,
      hasApiKey: Boolean((row.apiKey ?? '').trim()),
      configured: resolved.configured,
      // 让用户看清「现在实际在用的是哪来的 Key」，避免以为填了却没生效。
      keySource: resolved.keySource,
    },
  });
}

export async function PUT(request: Request) {
  const body = await request.json().catch(() => null) as
    | { baseUrl?: string; apiKey?: string; enabled?: boolean; resourceId?: string; model?: string }
    | null;
  if (!body) return NextResponse.json({ error: '请求体不是合法 JSON' }, { status: 400 });

  const db = getDb();
  const current = readAsrProviderRow(db);
  if (!current) {
    return NextResponse.json({ available: false, message: '实拍混剪未启用，或数据库尚未升级到 v2。' }, { status: 503 });
  }

  const baseUrl = typeof body.baseUrl === 'string' ? body.baseUrl.trim() : current.baseUrl;
  if (baseUrl && !/^https?:\/\//i.test(baseUrl)) {
    return NextResponse.json({ error: 'baseUrl 必须以 http:// 或 https:// 开头' }, { status: 400 });
  }
  // 占位符 = 用户没改这一栏，保留原 Key。
  const apiKey = typeof body.apiKey === 'string' && body.apiKey !== KEY_PLACEHOLDER ? body.apiKey.trim() : current.apiKey;
  const resourceId = typeof body.resourceId === 'string' && body.resourceId.trim() ? body.resourceId.trim() : current.resourceId;
  const model = typeof body.model === 'string' && body.model.trim() ? body.model.trim() : current.model;
  const enabled = body.enabled == null ? Boolean(current.enabled) : Boolean(body.enabled);

  db.prepare(
    `UPDATE live_mixcut_asr_providers
        SET baseUrl = ?, apiKey = ?, resourceId = ?, model = ?, enabled = ?, updatedAt = ?
      WHERE id = ?`,
  ).run(baseUrl, apiKey, resourceId, model, enabled ? 1 : 0, new Date().toISOString(), ASR_PROVIDER_ID);

  const resolved = resolveAsrConfig(readAsrProviderRow(db));
  return NextResponse.json({ success: true, configured: resolved.configured, keySource: resolved.keySource });
}
