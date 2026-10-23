import type Database from 'better-sqlite3';
import { PACKAGING_TEMPLATE_IDS } from '../../media-core/packaging-vars.ts';
import { getFinalEditTtsAdapter } from '../../media-core/adapters/tts-registry.ts';
import { normalizeCoverPreset } from '../../media-core/cover-title-presets.ts';
import type { CoverPresetV2 } from '../../media-core/cover-types.ts';
import { BatchDomainError } from '../errors.ts';
import type { FormulaProductionOptions, FormulaProductionSettings } from './production-settings.ts';

const templateNames: Record<string, string> = {
  'overlay-poster': 'f1 花字种草', 'overlay-journal': 'f2 手账拼贴',
  'overlay-minimal': 'f3 极简高级', 'overlay-variety': 'f4 综艺撕纸',
};

function hasTable(db: Database.Database, name: string): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
}

function voiceOptions(db: Database.Database) {
  if (!hasTable(db, 'final_edit_tts_providers')) return [];
  // 不把密钥读入返回对象；前端只需要是否可用，以及适配器公开的音色。
  const rows = db.prepare(`SELECT id,name,model,enabled,keyEnv,
    CASE WHEN trim(coalesce(apiKey,'')) <> '' THEN 1 ELSE 0 END AS hasStoredKey
    FROM final_edit_tts_providers ORDER BY name,id`).all() as Array<{
      id: string; name: string; model: string; enabled: number; keyEnv: string | null; hasStoredKey: number;
    }>;
  return rows.flatMap(row => {
    try {
      const adapter = getFinalEditTtsAdapter(row.id);
      return [{ id: row.id, name: row.name, model: row.model,
        configured: row.enabled === 1 && !!(row.hasStoredKey || (row.keyEnv && process.env[row.keyEnv]?.trim())),
        voices: adapter.voices.map(voice => ({ id: voice.id, label: voice.label })) }];
    } catch { return []; }
  });
}

function coverOptions(db: Database.Database) {
  if (!hasTable(db, 'final_edit_title_presets')) return [];
  const rows = db.prepare('SELECT id,name,stylesByPresetJson FROM final_edit_title_presets ORDER BY name,id').all() as Array<{
    id: string; name: string; stylesByPresetJson: string;
  }>;
  return rows.map(row => {
    let preset: CoverPresetV2 | null = null;
    try { preset = normalizeCoverPreset(JSON.parse(row.stylesByPresetJson)); } catch { /* 旧的损坏预设仍显示为不可用。 */ }
    return { id: row.id, name: row.name, preset };
  });
}

export function readFormulaProductionOptions(db: Database.Database): FormulaProductionOptions {
  return {
    voices: voiceOptions(db).map(({ id, name, configured, voices }) => ({ id, name, configured, voices })),
    templates: PACKAGING_TEMPLATE_IDS.map(id => ({ id, name: templateNames[id] })),
    coverPresets: coverOptions(db).map(({ id, name, preset }) => ({ id, name, available: !!preset,
      ...(!preset ? { reason: '预设样式不完整，请在封面预设库中修复或重新保存。' } : {}) })),
  };
}

/** 保存及未来输入冻结共用：返回当前选择对应的真实资源，不随机、不生成声音。 */
export function resolveFormulaProductionResources(db: Database.Database, settings: FormulaProductionSettings) {
  for (const id of settings.packaging.templateIds) {
    if (!(PACKAGING_TEMPLATE_IDS as readonly string[]).includes(id)) throw new BatchDomainError('invalid_input', '所选包装模板已不可用，请重新选择');
  }
  const tts = settings.audio.tts;
  let voice: { providerId: string; model: string; voice: string; speed: number } | null = null;
  if (tts && settings.audio.mode !== 'original') {
    const provider = voiceOptions(db).find(item => item.id === tts.providerId);
    if (!provider?.configured) throw new BatchDomainError('invalid_input', '所选配音供应商不可用，请配置后重试或暂不选择配音');
    if (!provider.voices.some(item => item.id === tts.voice)) throw new BatchDomainError('invalid_input', '所选配音音色已不可用，请重新选择');
    voice = { providerId: provider.id, model: provider.model, voice: tts.voice, speed: tts.speed };
  }
  const presets = settings.cover.presetIds.length ? coverOptions(db) : [];
  const covers = settings.cover.presetIds.map(id => {
    const entry = presets.find(item => item.id === id);
    if (!entry?.preset) throw new BatchDomainError('invalid_input', '所选封面预设已删除或样式不可用，请重新选择');
    return { id: entry.id, name: entry.name, preset: entry.preset };
  });
  return { voice, covers };
}
