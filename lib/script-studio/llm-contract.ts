/**
 * script-studio 与供应商适配层之间的最小 JSON 契约。
 * 这里刻意不引用 script-generation-v3.ts，避免 script-studio 间接依赖 final-edit。
 */
export interface ScriptStudioCompleteJsonRequest {
  /** 任务快照固定的模型；适配层收到后会固定为实际调用模型。 */
  model?: string;
  systemPrompt: string;
  userPrompt: string;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  images?: Array<{ mimeType: string; imageBase64: string }>;
  onTextDelta?: (accumulated: string) => void;
  onReasoningDelta?: (accumulated: string) => void;
}

export type ScriptStudioCompleteJson = (input: ScriptStudioCompleteJsonRequest) => Promise<unknown>;
