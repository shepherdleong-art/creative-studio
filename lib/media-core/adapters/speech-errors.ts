/** 仅由适配器使用固定、安全文案创建；上层可展示它，不能包装供应商原始异常。 */
export class SpeechTranscriptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SpeechTranscriptionError';
  }
}
