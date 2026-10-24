import { createOpenAiTranscriptionAdapter, type SpeechTranscriptionAdapter } from '../../media-core/adapters/alignment.ts';
import { createVolcFlashAsrAdapter } from '../../media-core/adapters/volc-asr.ts';
import { BatchDomainError } from '../errors.ts';

export interface FormulaSpeechService {
  configured: boolean;
  identity: SpeechTranscriptionAdapter['identity'];
}

/** 配了火山就用火山，否则沿用 OpenAI 兼容接口（FINAL_EDIT_ALIGNMENT_*）。 */
function currentSpeechAdapter(): SpeechTranscriptionAdapter {
  const volc = createVolcFlashAsrAdapter();
  return volc.configured ? volc : createOpenAiTranscriptionAdapter();
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
