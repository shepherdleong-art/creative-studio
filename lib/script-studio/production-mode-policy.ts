import { ScriptStudioError } from './errors.ts';
import type { ScriptProductionMode } from './generation-contract.ts';

/**
 * 团队工作台演示版：AI 写脚本只保留「爆文模板改写」。
 *
 * 规格（2026-11-18 团队工作台四步制作演示版）要求首次生成、换模板、结果页再生成，
 * 以及打开旧项目后发起的新生成，都不能再新开「多方向生成」或「痛点解决型 · 15秒」。
 * 这里放在共享契约之外单独一层，`parseScriptProductionMode` 仍是纯解析函数，
 * 旧客户端传来的 `standard`/`pain_solving_15s` 在路由和 runner 入口被明确拒绝。
 *
 * 需要临时恢复旧模式时设 `CREATIVE_STUDIO_SCRIPT_ALLOW_LEGACY_MODES=1`（仅排障用）。
 */

const LEGACY_OPT_OUT = ['1', 'true', 'on', 'yes'];

export function legacyScriptModesAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return LEGACY_OPT_OUT.includes(env.CREATIVE_STUDIO_SCRIPT_ALLOW_LEGACY_MODES?.trim().toLowerCase() ?? '');
}

/** 演示版唯一可发起的 AI 写作模式。 */
export const DEMO_SCRIPT_PRODUCTION_MODES: ReadonlyArray<ScriptProductionMode> = ['template_rewrite'];

export function assertScriptProductionModeAllowed(
  mode: ScriptProductionMode,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (legacyScriptModesAllowed(env)) return;
  if (mode === 'template_rewrite') return;
  throw new ScriptStudioError(
    'invalid_input',
    '演示版只支持爆文模板改写：请先提取或复用卖点，再挑选爆文模板生成脚本。',
  );
}
