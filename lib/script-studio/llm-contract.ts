/**
 * script-studio 与供应商适配层之间的最小 JSON 契约。
 * 这里刻意不引用 script-generation-v3.ts，避免 script-studio 间接依赖 final-edit。
 */
import type { ScriptRequestPurpose } from './request-budget.ts';

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
  /** 图片已按识图预算处理，COS 交付时保持原始字节。 */
  preserveImageBytes?: boolean;
  onTextDelta?: (accumulated: string) => void;
  onReasoningDelta?: (accumulated: string) => void;
  /** server 在统一准入后才占用该次方案预算；local 仍由 generator 直接预留。 */
  executionBudget?: { planIndex: number; purpose: ScriptRequestPurpose };
  executionPhaseBudget?: 'plan_analysis' | 'distill';
  /** 可持久重建的方案/用途步骤；缺省由适配层按调用顺序编号。 */
  executionStep?: string;
}

export type ScriptStudioCompleteJson = (input: ScriptStudioCompleteJsonRequest) => Promise<unknown>;
