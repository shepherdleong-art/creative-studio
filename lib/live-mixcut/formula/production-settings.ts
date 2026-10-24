import { OUTPUT_PRESETS, type OutputPresetId } from '../../media-core/cover-types.ts';
import { assertTtsSpeed } from '../../media-core/tts-speed.ts';

export interface FormulaProductionSettings {
  outputPreset: OutputPresetId;
  audio: { mode: 'mixed' | 'original' | 'narration'; tts: { providerId: string; voice: string; speed: number } | null };
  packaging: { mode: 'none' | 'uniform' | 'random'; templateIds: string[] };
  cover: { mode: 'default' | 'uniform' | 'random'; presetIds: string[] };
}

export interface FormulaProductionOptions {
  voices: Array<{ id: string; name: string; configured: boolean; voices: Array<{ id: string; label: string }> }>;
  templates: Array<{ id: string; name: string }>;
  coverPresets: Array<{ id: string; name: string; available: boolean; reason?: string }>;
}

export function defaultFormulaProductionSettings(): FormulaProductionSettings {
  return { outputPreset: '3x4', audio: { mode: 'mixed', tts: null },
    packaging: { mode: 'uniform', templateIds: ['overlay-poster'] }, cover: { mode: 'default', presetIds: [] } };
}

function object(value: unknown, keys: string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) {
    throw new Error(`${label}格式不正确`);
  }
  return value as Record<string, unknown>;
}

function identifiers(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length > 1_000 || value.some(id => typeof id !== 'string' || !id.trim() || id.length > 200)) {
    throw new Error(`${label}候选无效`);
  }
  return [...new Set(value as string[])].sort();
}

function selectionMode(mode: unknown, ids: string[], offMode: 'none' | 'default', label: string) {
  if (mode !== offMode && mode !== 'uniform' && mode !== 'random') throw new Error(`${label}分配方式无效`);
  if (mode === offMode && ids.length) throw new Error(`${label}未启用时不能保留候选`);
  if (mode !== offMode && !ids.length) throw new Error(`请至少选择一个${label}候选`);
  if (mode === 'uniform' && ids.length !== 1) throw new Error(`${label}统一模式只能选择一个候选`);
  return mode === 'random' && ids.length === 1 ? 'uniform' : mode;
}

/** 严格验证用户设置；旧设置缺此字段时采用明确默认值，不在读取时随机分配。 */
export function parseFormulaProductionSettings(value: unknown): FormulaProductionSettings {
  if (value === undefined) return defaultFormulaProductionSettings();
  const input = object(value, ['outputPreset', 'audio', 'packaging', 'cover'], '声音和包装设置');
  if (typeof input.outputPreset !== 'string' || !Object.hasOwn(OUTPUT_PRESETS, input.outputPreset)) throw new Error('请选择有效的输出画幅');
  const audio = object(input.audio, ['mode', 'tts'], '声音设置');
  if (audio.mode !== 'mixed' && audio.mode !== 'original' && audio.mode !== 'narration') throw new Error('声音方式无效');
  let tts: FormulaProductionSettings['audio']['tts'] = null;
  if (audio.tts !== null) {
    const voice = object(audio.tts, ['providerId', 'voice', 'speed'], '配音设置');
    if (typeof voice.providerId !== 'string' || !voice.providerId.trim() || voice.providerId.length > 200
      || typeof voice.voice !== 'string' || !voice.voice.trim() || voice.voice.length > 200 || typeof voice.speed !== 'number') throw new Error('请选择有效的配音供应商和音色');
    assertTtsSpeed(voice.speed);
    tts = { providerId: voice.providerId, voice: voice.voice, speed: voice.speed };
  }
  if (audio.mode === 'original' && tts) throw new Error('纯原声模式不使用配音设置，请清除配音选择');
  const packaging = object(input.packaging, ['mode', 'templateIds'], '视频包装');
  const templateIds = identifiers(packaging.templateIds, '视频包装');
  const packagingMode = selectionMode(packaging.mode, templateIds, 'none', '视频包装');
  const cover = object(input.cover, ['mode', 'presetIds'], '封面预设');
  const presetIds = identifiers(cover.presetIds, '封面预设');
  const coverMode = selectionMode(cover.mode, presetIds, 'default', '封面预设');
  return { outputPreset: input.outputPreset as OutputPresetId, audio: { mode: audio.mode, tts },
    packaging: { mode: packagingMode as FormulaProductionSettings['packaging']['mode'], templateIds },
    cover: { mode: coverMode as FormulaProductionSettings['cover']['mode'], presetIds } };
}

/** 页面用当前目录提示可修正的问题；提交时服务端仍重新读取真实资源。 */
export function formulaProductionSettingsError(value: FormulaProductionSettings, options: FormulaProductionOptions): string {
  try { parseFormulaProductionSettings(value); }
  catch (error) { return error instanceof Error ? error.message : '声音和包装设置无效'; }
  if (value.packaging.templateIds.some(id => !options.templates.some(item => item.id === id))) return '所选包装模板已不可用，请重新选择。';
  if (value.cover.presetIds.some(id => !options.coverPresets.some(item => item.id === id && item.available))) return '所选封面预设已删除或不可用，请重新选择。';
  const tts = value.audio.tts;
  if (tts && value.audio.mode !== 'original') {
    const provider = options.voices.find(item => item.id === tts.providerId);
    if (!provider?.configured) return '所选配音供应商不可用，请配置后重新读取设置，或暂不选择配音。';
    if (!provider.voices.some(item => item.id === tts.voice)) return '所选配音音色已不可用，请重新选择。';
  }
  return '';
}
