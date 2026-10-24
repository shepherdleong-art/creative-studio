/**
 * 原声转写（ASR）供应商配置：数据库优先，环境变量兜底。
 *
 * 为什么要这一层：volc-asr.ts 原本只读 process.env，用户在设置页填的 Key
 * 根本进不去。这里把「数据库里那一行」翻译成适配器要的 env 形状，
 * 让适配器保持纯粹的、可单测的形态，不用反过来依赖数据库。
 *
 * 优先级：数据库 enabled 且 apiKey 非空 → 用数据库；否则回退环境变量。
 * 这样老 .env.local 配置继续有效，新用户可以在界面里填，两条路不打架。
 */
import type Database from 'better-sqlite3';
import { VOLC_FLASH_ASR_RESOURCE_ID, VOLC_FLASH_ASR_RESOURCE_ID_ENV, VOLC_FLASH_ASR_URL } from '../media-core/adapters/volc-asr.ts';

export const ASR_PROVIDER_ID = 'volc-flash-asr';
/** 数据库没配时回退的环境变量名；与 volc-asr.ts 读取的键保持一致。 */
export const ASR_KEY_ENV = 'CREATIVE_STUDIO_VOLC_ASR_API_KEY';
export const ASR_URL_ENV = 'CREATIVE_STUDIO_VOLC_ASR_URL';

export interface AsrProviderRow {
  id: string;
  name: string;
  type: string;
  baseUrl: string;
  apiKey: string;
  keyEnv: string;
  resourceId: string;
  model: string;
  enabled: number;
  isBuiltin: number;
}

/** 读取那一行配置；表不存在（迁移未跑）时返回 null，调用方回退环境变量。 */
export function readAsrProviderRow(db: Database.Database): AsrProviderRow | null {
  try {
    const row = db.prepare(
      `SELECT id, name, type, baseUrl, apiKey, keyEnv, resourceId, model, enabled, isBuiltin
         FROM live_mixcut_asr_providers WHERE id = ?`,
    ).get(ASR_PROVIDER_ID) as AsrProviderRow | undefined;
    return row ?? null;
  } catch {
    // 表还不存在：开关关闭或迁移未完成，都不该让调用方崩掉。
    return null;
  }
}

export interface ResolvedAsrConfig {
  baseUrl: string;
  apiKey: string;
  resourceId: string;
  model: string;
  configured: boolean;
  /** 当前 Key 的来源，用于界面提示；null 表示两处都没配。 */
  keySource: 'database' | 'env' | null;
}

/**
 * 把数据库行 + 环境变量合成适配器能用的配置。
 * 只做取值与优先级判断，不做网络请求，方便单测。
 */
export function resolveAsrConfig(
  row: AsrProviderRow | null,
  env: Readonly<Record<string, string | undefined>> = process.env,
): ResolvedAsrConfig {
  const envKey = (env[ASR_KEY_ENV] ?? '').trim();
  const envUrl = (env[ASR_URL_ENV] ?? '').trim();

  // 停用时整体视为未配置：用户明确关掉它，就不该偷偷走环境变量。
  if (row && !row.enabled) {
    return { baseUrl: row.baseUrl || VOLC_FLASH_ASR_URL, apiKey: '', resourceId: row.resourceId || VOLC_FLASH_ASR_RESOURCE_ID,
      model: row.model || 'bigmodel', configured: false, keySource: null };
  }

  const rowKey = (row?.apiKey ?? '').trim();
  if (rowKey) {
    return { baseUrl: (row?.baseUrl ?? '').trim() || envUrl || VOLC_FLASH_ASR_URL, apiKey: rowKey,
      resourceId: (row?.resourceId ?? '').trim() || VOLC_FLASH_ASR_RESOURCE_ID, model: (row?.model ?? '').trim() || 'bigmodel',
      configured: true, keySource: 'database' };
  }

  if (envKey) {
    return { baseUrl: (row?.baseUrl ?? '').trim() || envUrl || VOLC_FLASH_ASR_URL, apiKey: envKey,
      resourceId: (row?.resourceId ?? '').trim() || VOLC_FLASH_ASR_RESOURCE_ID, model: (row?.model ?? '').trim() || 'bigmodel',
      configured: true, keySource: 'env' };
  }

  return { baseUrl: (row?.baseUrl ?? '').trim() || envUrl || VOLC_FLASH_ASR_URL, apiKey: '',
    resourceId: (row?.resourceId ?? '').trim() || VOLC_FLASH_ASR_RESOURCE_ID, model: (row?.model ?? '').trim() || 'bigmodel',
    configured: false, keySource: null };
}

/** 供适配器使用：把解析结果摊平成 volc-asr.ts 认识的 env 形状。 */
export function asrEnvFromDatabase(
  db: Database.Database,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string | undefined> {
  const resolved = resolveAsrConfig(readAsrProviderRow(db), env);
  return {
    ...env,
    [ASR_URL_ENV]: resolved.baseUrl,
    [ASR_KEY_ENV]: resolved.apiKey,
    [VOLC_FLASH_ASR_RESOURCE_ID_ENV]: resolved.resourceId,
  };
}
