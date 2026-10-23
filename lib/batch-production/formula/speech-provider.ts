import { createOpenAiTranscriptionAdapter, type SpeechTranscriptionAdapter } from '../../media-core/adapters/alignment.ts';
import { BatchDomainError } from '../errors.ts';

export interface FormulaSpeechService {
  configured: boolean;
  identity: SpeechTranscriptionAdapter['identity'];
}

export function captureFormulaSpeechService(): FormulaSpeechService {
  const adapter = createOpenAiTranscriptionAdapter();
  return { configured: adapter.configured, identity: { ...adapter.identity } };
}

/** 冻结模型/端点身份，不冻结密钥；配置发生变化不能让旧任务偷偷改用另一服务。 */
export function resolveFormulaSpeechService(frozen: FormulaSpeechService | null): SpeechTranscriptionAdapter {
  const current = createOpenAiTranscriptionAdapter();
  if (!frozen?.configured) return { ...current, configured: false };
  if (!current.configured || JSON.stringify(current.identity) !== JSON.stringify(frozen.identity)) {
    throw new BatchDomainError('conflict', '这次制作使用的原声转写配置已变化，请恢复原配置后重试，或创建新的制作请求');
  }
  return current;
}
