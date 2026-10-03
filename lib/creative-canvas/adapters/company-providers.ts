/**
 * 公司供应商路由解析（技术约定 C6／C7）。
 *
 * 画布任务只保存脱敏的供应商身份与精确别名，提交前再从这里取实际 baseUrl／apiKey：
 * - 视频走 `video_providers`（type = openai-video，本机 LiteLLM 别名路由）；
 * - 图片走 `providers`（type = gateway-task-image）。
 *
 * 找不到、被禁用或公司运行环境不可用时抛错 —— 在生成 POST 之前结束。
 */

import type Database from 'better-sqlite3';
import { CanvasAdapterError } from './types.ts';

export interface CanvasProviderRoute {
  providerId: string;
  providerName: string;
  type: string;
  baseUrl: string;
  apiKey: string;
  modelAlias: string;
}

function rowToRoute(
  row: Record<string, unknown>,
  modelAlias: string,
  fallbackId: string,
): CanvasProviderRoute {
  return {
    providerId: String(row.id ?? fallbackId),
    providerName: String(row.name ?? ''),
    type: String(row.type ?? 'openai-video'),
    baseUrl: String(row.baseUrl ?? '').replace(/\/$/, ''),
    apiKey: String(row.apiKey ?? ''),
    modelAlias,
  };
}

/**
 * 解析画布任务要用的供应商路由。**公司路由与外部网关共用这一条路径**：
 * 公司行由 seed 补种（本机 LiteLLM），外部行由用户在设置页配置（自建或第三方网关）。
 */
export function resolveCompanyCanvasRoute(
  db: Database.Database,
  params: { providerIdentity: string; modelAlias: string; mediaKind: 'image' | 'video' },
): CanvasProviderRoute {
  const { providerIdentity, modelAlias, mediaKind } = params;
  const expectedVideoType = providerIdentity === 'jimeng-2-0' ? 'jimeng' : providerIdentity.startsWith('company-') ? 'openai-video' : null;
  // 两张核心表的模型列名不同：视频表是 defaultModel，图片表是 model。
  const query = mediaKind === 'video'
    ? `SELECT id, name, type, baseUrl, apiKey, enabled, defaultModel AS modelColumn FROM video_providers
        WHERE id = ? OR (defaultModel = ? ${expectedVideoType ? `AND type = '${expectedVideoType}'` : ''})
        ORDER BY CASE WHEN id = ? THEN 0 ELSE 1 END
        LIMIT 1`
    : `SELECT id, name, type, baseUrl, apiKey, enabled, model AS modelColumn FROM providers
        WHERE id = ? OR model = ?
        ORDER BY CASE WHEN id = ? THEN 0 ELSE 1 END
        LIMIT 1`;
  const row = db.prepare(query).get(providerIdentity, modelAlias, providerIdentity) as
    | Record<string, unknown>
    | undefined;

  if (!row) {
    throw new CanvasAdapterError(
      'prepare',
      `供应商 ${providerIdentity}（${modelAlias}）未在本机配置，任务未提交。请在设置页确认该供应商已开启。`,
      { code: 'company_provider_missing' },
    );
  }
  if (Number(row.enabled) !== 1) {
    throw new CanvasAdapterError(
      'prepare',
      `供应商 ${providerIdentity} 已停用，任务未提交。`,
      { code: 'company_provider_disabled' },
    );
  }
  const route = rowToRoute(row, modelAlias, providerIdentity);
  if (mediaKind === 'video' && expectedVideoType && route.type !== expectedVideoType) {
    throw new CanvasAdapterError('prepare', '供应商类型与固定渠道不一致，请恢复来源渠道配置', { code: 'provider_channel_mismatch' });
  }

  if (!route.baseUrl) {
    throw new CanvasAdapterError(
      'prepare',
      `供应商 ${providerIdentity} 缺少网关地址（公司渠道需本机 LiteLLM 在跑；外部渠道需填写 baseUrl），任务未提交。`,
      { code: 'company_provider_route_invalid' },
    );
  }
  return route;
}
