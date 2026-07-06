// lib/narration-providers/store.ts
import { getDb } from '@/lib/db';
import { seedNarrationProviders } from '@/lib/seed';
import {
  defaultNarrationProviderConfigs,
  resolveNarrationProviderRuntimeConfig,
  toNarrationProviderMeta,
  type NarrationProviderDbRow,
  type NarrationProviderRuntimeConfig,
} from './config';

export function getNarrationProviderRows(): NarrationProviderDbRow[] {
  seedNarrationProviders();
  return getDb()
    .prepare(`SELECT * FROM narration_providers ORDER BY name`)
    .all() as NarrationProviderDbRow[];
}

export function listNarrationProviderMeta() {
  return getNarrationProviderRows().map((row) => {
    const defaults = defaultNarrationProviderConfigs.find((c) => c.id === row.id) ?? {
      id: row.id,
      name: row.name,
      type: row.type,
    };
    return toNarrationProviderMeta(resolveNarrationProviderRuntimeConfig(defaults, row));
  });
}

/**
 * 返回当前启用的第一条已配置的口播供应商；没有则返回 null。
 * 排序：内置优先，同优先级按创建顺序。
 */
export function resolveActiveNarrationProvider(): NarrationProviderRuntimeConfig | null {
  seedNarrationProviders();
  const rows = getDb()
    .prepare(
      `SELECT * FROM narration_providers
       WHERE enabled = 1
       ORDER BY isBuiltin DESC, rowid ASC`
    )
    .all() as NarrationProviderDbRow[];

  for (const row of rows) {
    const defaults = defaultNarrationProviderConfigs.find((c) => c.id === row.id) ?? {
      id: row.id,
      name: row.name,
      type: row.type,
    };
    const runtime = resolveNarrationProviderRuntimeConfig(defaults, row);
    if (runtime.configured) return runtime;
  }

  return null;
}

/**
 * 解析指定 providerId 的口播供应商运行时配置。
 * - 给了 providerId：该行必须存在且 enabled+configured，否则抛错说明具体缺什么。
 * - 不给 providerId：退回 resolveActiveNarrationProvider()（自动挑第一个已配置的）。
 */
export function resolveNarrationProvider(providerId?: string): NarrationProviderRuntimeConfig | null {
  if (!providerId) return resolveActiveNarrationProvider();

  seedNarrationProviders();
  const row = getDb()
    .prepare(`SELECT * FROM narration_providers WHERE id = ?`)
    .get(providerId) as NarrationProviderDbRow | undefined;
  if (!row) throw new Error(`未知的口播供应商：${providerId}`);

  const defaults = defaultNarrationProviderConfigs.find((c) => c.id === row.id) ?? {
    id: row.id,
    name: row.name,
    type: row.type,
  };
  const runtime = resolveNarrationProviderRuntimeConfig(defaults, row);
  if (!runtime.configured) {
    const reason = !runtime.enabled ? '已禁用' : `缺少 ${runtime.missing.join('、') || '必要参数'}`;
    throw new Error(`口播供应商「${runtime.name}」未配置完整（${reason}）：请前往「设置」→「口播配音」配置`);
  }
  return runtime;
}
