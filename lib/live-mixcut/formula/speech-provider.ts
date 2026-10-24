import { createOpenAiTranscriptionAdapter, type SpeechTranscriptionAdapter } from '../../media-core/adapters/alignment.ts';
import { createVolcFlashAsrAdapter } from '../../media-core/adapters/volc-asr.ts';
import { asrEnvFromDatabase } from '../asr-provider.ts';
import { getDb } from '../../db.ts';
import { BatchDomainError } from '../errors.ts';

export interface FormulaSpeechService {
  configured: boolean;
  identity: SpeechTranscriptionAdapter['identity'];
}

/**
 * 配了火山就用火山，否则沿用 OpenAI 兼容接口（FINAL_EDIT_ALIGNMENT_*）。
 *
 * 火山的 Key 可以来自设置页（数据库）或 .env.local（环境变量），由
 * asr-provider.ts 统一合并；这里只关心合并结果是否可用。
 */
function currentSpeechAdapter(): SpeechTranscriptionAdapter {
  const volc = createVolcFlashAsrAdapter(resolveAsrEnv());
  return volc.configured ? volc : createOpenAiTranscriptionAdapter();
}

/**
 * 数据库里存了 ASR 配置就用它，否则原样返回 process.env。
 * 开关关闭或表不存在时 getDb() 可能不可用，任何异常都退回环境变量，
 * 不能让「设置页读不到」把原本能跑的环境变量配置一起废掉。
 */
function resolveAsrEnv(): Readonly<Record<string, string | undefined>> {
  try {
    return asrEnvFromDatabase(getDb());
  } catch {
    return process.env;
  }
}

export function captureFormulaSpeechService(): FormulaSpeechService {
  const adapter = currentSpeechAdapter();
  return { configured: adapter.configured, identity: { ...adapter.identity } };
}

/** 冻结模型/端点身份，不冻结密钥；配置发生变化不能让旧任务偷偷改用另一服务。 */
export function resolveFormulaSpeechService(frozen: FormulaSpeechService | null): SpeechTranscriptionAdapter {
  const current = currentSpeechAdapter();
  if (!frozen?.configured) return { ...current, configured: false };
  if (!current.configured || JSON.stringify(current.identity) !== JSON.stringify(frozen.identity)) {
    throw new BatchDomainError('conflict', '这次制作使用的原声转写配置已变化，请恢复原配置后重试，或创建新的制作请求');
  }
  return current;
}
