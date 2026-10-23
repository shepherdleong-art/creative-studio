import { dataRoot } from '../../data-root';
import { getDb } from '../../db';
import { cacheSuccessfulReadiness, schemaUpgradeRuntimePaths } from '../../schema-upgrade/runtime';
import { getBatchProductionReadiness } from '../runtime-readiness';
import { BatchApiUnavailableError } from '../errors';
import { checkFormulaReadiness } from './readiness';

const check = cacheSuccessfulReadiness(() => checkFormulaReadiness({
  db: getDb(), ...schemaUpgradeRuntimePaths(dataRoot()),
}));

export async function getFormulaCapability(): Promise<{ available: boolean; message: string; code?: string }> {
  // 分阶段开发期间仅在隔离验收环境显式启用；关闭时不运行公式迁移。
  if (process.env.CREATIVE_STUDIO_FORMULA_MIXCUT !== '1') {
    return { available: false, code: 'formula_disabled', message: '实拍公式混剪尚未启用' };
  }
  const base = await getBatchProductionReadiness();
  if (!base.available) return { available: false, code: base.code, message: base.message };
  try {
    const result = await check();
    return result.available ? { available: true, message: result.message }
      : { available: false, code: result.code, message: result.message };
  } catch {
    return { available: false, code: 'formula_check_failed', message: '实拍公式混剪自检失败，请稍后重试' };
  }
}

export async function assertFormulaApiReady(): Promise<void> {
  const result = await getFormulaCapability();
  if (!result.available) throw new BatchApiUnavailableError(result.code ?? 'formula_unavailable', result.message);
}
