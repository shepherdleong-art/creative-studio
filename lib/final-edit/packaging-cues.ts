import { extractSellingPointsWithLLM } from '../media-core/packaging-extraction.ts';
export { extractSellingPointsWithLLM } from '../media-core/packaging-extraction.ts';
import type Database from 'better-sqlite3';
import { FINAL_EDIT_INTRO_DURATION_US } from '../media-core/render-contract.ts';
import { parsePackagingConfig } from './packaging-vars.ts';
import { buildPointCues, parseStoredWordTimings, computePointCuesKey, generatePointCueId, normalizeForMatch, type PointCue, type PointCueDraft, type CueLike } from '../media-core/packaging-cues.ts';
export * from '../media-core/packaging-cues.ts';
// ---- 持久化 / 幂等保证 ----

function safeJsonParse(text: string): unknown {
  try { return JSON.parse(text); } catch { return null; }
}

function loadProjectSellingPoints(db: Database.Database, projectId: string): string[] {
  const row = db.prepare(`SELECT sellingPointsJson FROM projects WHERE id=?`).get(projectId) as { sellingPointsJson: string | null } | undefined;
  if (!row?.sellingPointsJson) return [];
  try {
    const parsed = JSON.parse(row.sellingPointsJson) as Array<{ title?: unknown }>;
    if (!Array.isArray(parsed)) return [];
    return parsed.map((item) => (typeof item?.title === 'string' ? item.title : '')).filter(Boolean);
  } catch { return []; }
}

/** 读取混剪组的口播全文（editedNarrationText 优先，脚本快照兜底）。 */
export function loadGroupNarrationText(db: Database.Database, groupId: string): string {
  const row = db.prepare(`SELECT editedNarrationText, scriptSnapshotJson FROM final_edit_groups WHERE id=?`).get(groupId) as { editedNarrationText: string | null; scriptSnapshotJson: string | null } | undefined;
  if (!row) return '';
  if (row.editedNarrationText?.trim()) return row.editedNarrationText;
  const snapshot = safeJsonParse(row.scriptSnapshotJson || '');
  if (snapshot && typeof snapshot === 'object') {
    const full = (snapshot as { fullScript?: unknown }).fullScript;
    if (typeof full === 'string' && full.trim()) return full;
    const segments = (snapshot as { segments?: unknown }).segments;
    if (Array.isArray(segments)) {
      const joined = segments
        .map((segment) => (segment && typeof segment === 'object' ? (segment as { narration?: unknown }).narration : null))
        .filter((item): item is string => typeof item === 'string')
        .join('');
      if (joined.trim()) return joined;
    }
  }
  return '';
}

export interface EnsurePointCuesResult {
  pointCues: PointCue[];
  mode: 'timed' | 'even' | 'none';
  pointCuesKey: string;
}

/**
 * 幂等保证：pointCuesKey 与当前口播内容哈希一致则复用已存 pointCues（零写入）；
 * 否则重新提取并写入 packagingJson（不动 revision，属派生缓存）。
 * 在包装配置（启用/脚本变更）与导出渲染（冻结前）时调用。
 */
export async function ensurePackagingPointCues(db: Database.Database, groupId: string): Promise<EnsurePointCuesResult> {
  const row = db.prepare(`SELECT projectId, editedNarrationText, scriptSnapshotJson, wordTimingsJson, subtitleStateJson, narrationDurationUs, packagingJson, analysisProviderId, narrationConfigJson FROM final_edit_groups WHERE id=?`).get(groupId) as {
    projectId: string; editedNarrationText: string | null; scriptSnapshotJson: string | null;
    wordTimingsJson: string | null; subtitleStateJson: string | null; narrationDurationUs: number | null;
    packagingJson: string | null; analysisProviderId: string | null; narrationConfigJson: string | null;
  } | undefined;
  if (!row) throw new Error(`混剪组不存在: ${groupId}`);
  const narrationText = row.editedNarrationText?.trim() || loadGroupNarrationText(db, groupId);
  // v2 版本盐：旧裸哈希视为过期，按成片时间轴口径自动重提取一次（§9）
  const key = computePointCuesKey(narrationText);
  const config = parsePackagingConfig(row.packagingJson);
  if (config.pointCues && config.pointCuesKey === key) {
    return { pointCues: config.pointCues, mode: config.pointCuesMode ?? 'timed', pointCuesKey: key };
  }
  // §7 手动编辑保护：pointCuesEdited=true 后口播哈希变化不再自动重提取（需显式「重新提取」复位）
  if (config.pointCues && config.pointCuesEdited === true) {
    return { pointCues: config.pointCues, mode: config.pointCuesMode ?? 'timed', pointCuesKey: config.pointCuesKey ?? key };
  }
  const words = parseStoredWordTimings(row.wordTimingsJson).words;
  const subtitleCues = (safeJsonParse(row.subtitleStateJson || '[]') as CueLike[] | null) || [];
  const narrationDurationUs = Number(row.narrationDurationUs || 0);
  // §9：口播倍速参与换算（与 renderer.ts:81-83 同口径，缺省 1、钳 0.5~2）
  const narrationConfig = safeJsonParse(row.narrationConfigJson || '') as { playbackRate?: unknown } | null;
  const rawRate = Number(narrationConfig?.playbackRate);
  const playbackRate = Number.isFinite(rawRate) ? Math.max(0.5, Math.min(2, rawRate)) : 1;
  const coverSec = FINAL_EDIT_INTRO_DURATION_US / 1e6;
  // §9：totalSec 同为成片时间轴（此前漏除倍速）
  const totalSec = coverSec + narrationDurationUs / 1e6 / playbackRate;
  const built = await buildPointCues({
    narrationText,
    words,
    subtitleCues,
    sellingPoints: loadProjectSellingPoints(db, row.projectId),
    totalSec,
    coverSec,
    narrationPlaybackRate: playbackRate,
    extractPoints: (text) => extractSellingPointsWithLLM(text, row.analysisProviderId || undefined),
  });
  if (computePointCuesKey(loadGroupNarrationText(db, groupId)) !== key) throw new Error('卖点提取期间口播已更新，请重试');
  const latest = db.prepare(`SELECT packagingJson FROM final_edit_groups WHERE id=?`).get(groupId) as { packagingJson: string | null } | undefined;
  if (latest?.packagingJson !== row.packagingJson) {
    const current = parsePackagingConfig(latest?.packagingJson);
    if (current.pointCuesEdited && current.pointCues) {
      return { pointCues: current.pointCues, mode: current.pointCuesMode ?? 'timed', pointCuesKey: current.pointCuesKey ?? key };
    }
  }
  return persistPointCues(db, groupId, built.pointCues, key, built.mode);
}

function persistPointCues(db: Database.Database, groupId: string, drafts: PointCueDraft[], key: string, mode: 'timed' | 'even' | 'none'): EnsurePointCuesResult {
  const row = db.prepare(`SELECT packagingJson FROM final_edit_groups WHERE id=?`).get(groupId) as { packagingJson: string | null } | undefined;
  const config = parsePackagingConfig(row?.packagingJson ?? '');
  // 重提取按「规范化文本」匹配旧 cues 保留旧 id，保住 layouts.*.cues 的布局引用（§7）
  const oldIdByText = new Map<string, string>();
  for (const old of config.pointCues ?? []) {
    const textKey = normalizeForMatch(old.text);
    if (textKey && !oldIdByText.has(textKey)) oldIdByText.set(textKey, old.id);
  }
  const usedIds = new Set<string>();
  const pointCues: PointCue[] = drafts.map((draft) => {
    const matched = oldIdByText.get(normalizeForMatch(draft.text));
    let id = matched && !usedIds.has(matched) ? matched : generatePointCueId();
    while (usedIds.has(id)) id = generatePointCueId();
    usedIds.add(id);
    return { id, text: draft.text, startSec: draft.startSec, endSec: draft.endSec };
  });
  const next = {
    enabled: config.enabled,
    template: config.template,
    varsOverrides: config.varsOverrides,
    ...(config.pointFont ? { pointFont: config.pointFont } : {}),
    ...(config.titleFont ? { titleFont: config.titleFont } : {}),
    ...(config.subtitleFont ? { subtitleFont: config.subtitleFont } : {}),
    pointCues,
    pointCuesKey: key,
    pointCuesMode: mode,
    // §7 新增字段必须随重写保留，不能丢
    ...(config.pointCuesEdited ? { pointCuesEdited: true } : {}),
    ...(config.layouts && Object.keys(config.layouts).length > 0 ? { layouts: config.layouts } : {}),
  };
  db.prepare(`UPDATE final_edit_groups SET packagingJson=? WHERE id=?`).run(JSON.stringify(next), groupId);
  return { pointCues, mode, pointCuesKey: key };
}
