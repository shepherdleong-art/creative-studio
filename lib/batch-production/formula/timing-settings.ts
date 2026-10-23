export interface FormulaTimingSettings {
  mode: 'reference' | 'strict_max' | 'fixed'; scope: 'body' | 'total';
  overrideDurationSec: number | null; speechMarginMs: number;
}

export function defaultFormulaTimingSettings(): FormulaTimingSettings {
  return { mode: 'reference', scope: 'total', overrideDurationSec: null, speechMarginMs: 120 };
}

export function parseFormulaTimingSettings(value: unknown): FormulaTimingSettings {
  if (value === undefined) return defaultFormulaTimingSettings();
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !['mode', 'scope', 'overrideDurationSec', 'speechMarginMs'].includes(key))) throw new Error('时长设置格式无效');
  const input = value as FormulaTimingSettings;
  if (!['reference', 'strict_max', 'fixed'].includes(input.mode) || !['body', 'total'].includes(input.scope)) throw new Error('时长规则或计时范围无效');
  if (input.overrideDurationSec !== null && (typeof input.overrideDurationSec !== 'number' || !Number.isFinite(input.overrideDurationSec)
    || input.overrideDurationSec <= 0 || !Number.isSafeInteger(Math.round(input.overrideDurationSec * 1_000_000))
    || Math.round(input.overrideDurationSec * 1_000_000) < 1)) throw new Error('时长必须是正数，或留空沿用 Excel');
  if (!Number.isSafeInteger(input.speechMarginMs) || input.speechMarginMs < 0 || input.speechMarginMs > 2_000) throw new Error('原声边距须为 0～2000 毫秒的整数');
  return { mode: input.mode, scope: input.scope, overrideDurationSec: input.overrideDurationSec, speechMarginMs: input.speechMarginMs };
}
