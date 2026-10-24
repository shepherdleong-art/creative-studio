import { getBatchProductionReadiness } from '../runtime-readiness';
import { BatchApiUnavailableError } from '../errors';

/** 实拍混剪只有一条迁移流（../schema.ts），公式能力跟着整个模块的就绪状态走。 */
export async function getFormulaCapability(): Promise<{ available: boolean; message: string; code?: string }> {
  const base = await getBatchProductionReadiness();
  return base.available ? { available: true, message: base.message } : { available: false, code: base.code, message: base.message };
}

export async function assertFormulaApiReady(): Promise<void> {
  const result = await getFormulaCapability();
  if (!result.available) throw new BatchApiUnavailableError(result.code ?? 'live_mixcut_unavailable', result.message);
}
