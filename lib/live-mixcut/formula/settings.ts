/** 浏览器与服务端共用的生成设置；保存设置不会启动制作。 */
import { parseFormulaProductionSettings, type FormulaProductionSettings } from './production-settings.ts';
import { parseFormulaTimingSettings, type FormulaTimingSettings } from './timing-settings.ts';
export const FORMULA_MAX_OUTPUTS = 1_000;
export type FormulaBgmMode = 'none' | 'auto' | 'manual';
export interface FormulaSettings {
  selections: Array<{ key: string; copies: number }>;
  bgm: { mode: FormulaBgmMode; trackIds: string[] };
  production: FormulaProductionSettings;
  timing?: FormulaTimingSettings;
}
export const FORMULA_DEFAULT_BGM: FormulaSettings['bgm'] = { mode: 'none', trackIds: [] };

export function parseFormulaSettings(value: unknown, scriptKeys: readonly string[]): FormulaSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('生成设置格式不正确');
  const settings = value as Record<string, unknown>;
  if (Object.keys(settings).some(key => !['selections', 'bgm', 'production', 'timing'].includes(key))) throw new Error('包含不支持的生成设置');
  if (!Array.isArray(settings.selections) || !settings.selections.length) throw new Error('请至少选择一条脚本');
  if (settings.selections.length > FORMULA_MAX_OUTPUTS) throw new Error('每批最多制作 1,000 条成片，请拆批');
  const keys = new Set(scriptKeys);
  const counts = new Map<string, number>();
  let total = 0;
  for (const entry of settings.selections) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) || Object.keys(entry).some(key => !['key', 'copies'].includes(key))
      || typeof entry.key !== 'string' || !keys.has(entry.key)) throw new Error('所选脚本不属于当前已确认资料，请重新选择');
    if (counts.has(entry.key)) throw new Error('同一脚本不能重复选择');
    if (!Number.isSafeInteger(entry.copies) || entry.copies < 1) throw new Error('每条脚本的份数须为正整数');
    total += entry.copies;
    if (total > FORMULA_MAX_OUTPUTS) throw new Error('每批最多制作 1,000 条成片，请减少份数或拆批');
    counts.set(entry.key, entry.copies);
  }
  const music = settings.bgm as Record<string, unknown> | undefined;
  if (!music || typeof music !== 'object' || Array.isArray(music) || Object.keys(music).some(key => !['mode', 'trackIds'].includes(key))
    || !['none', 'auto', 'manual'].includes(String(music.mode)) || !Array.isArray(music.trackIds)
    || music.trackIds.some(id => typeof id !== 'string' || !id || id.length > 200) || music.trackIds.length > 1_000) throw new Error('请选择有效的背景音乐方式');
  const trackIds = [...new Set(music.trackIds as string[])].sort();
  if (music.mode !== 'manual' && trackIds.length) throw new Error('仅手动选音乐时可以指定曲目');
  if (music.mode === 'manual' && !trackIds.length) throw new Error('请至少选择一首音乐，或改为不加音乐');
  return { selections: scriptKeys.filter(key => counts.has(key)).map(key => ({ key, copies: counts.get(key)! })),
    bgm: { mode: music.mode as FormulaBgmMode, trackIds }, production: parseFormulaProductionSettings(settings.production),
    timing: parseFormulaTimingSettings(settings.timing) };
}
