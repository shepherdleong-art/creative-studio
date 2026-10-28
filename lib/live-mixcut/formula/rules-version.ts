/**
 * 公式生产规矩的版本。新规矩只接到新建的批次上；10-26 的旧批次保持旧版本，
 * 不迁移、不重排，照旧能打开看。
 *
 * - formula-generation/1：旧的「AI 切分整段文案」声音编排和旧时间轴。
 * - formula-generation/2：选片 → 识别原声 → AI 判断 → 定声音 → 配音 →（任务 09）排时间。
 */
export type FormulaGenerationRulesVersion = 'formula-generation/1' | 'formula-generation/2';

export const LEGACY_FORMULA_RULES_VERSION: FormulaGenerationRulesVersion = 'formula-generation/1';
export const FORMULA_RULES_VERSION: FormulaGenerationRulesVersion = 'formula-generation/2';

export function isFormulaRulesV2(version: string | null | undefined): boolean {
  return version === FORMULA_RULES_VERSION;
}
