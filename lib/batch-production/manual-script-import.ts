import { countScriptContentCharacters } from '../script-duration-policy.ts';
import { BatchDomainError } from './errors.ts';
import { splitBatchScriptSentences } from './script-sentences.ts';

/** 手动导入脚本的输入上限；服务端必须独立校验，不能只信前端。 */
export const MANUAL_SCRIPT_TITLE_MAX = 200;
export const MANUAL_SCRIPT_BODY_MAX = 5000;
export const MANUAL_SCRIPT_BATCH_MAX = 50;
export const MANUAL_SCRIPT_PASTE_CHARS_MAX = 100_000;
export const MANUAL_SCRIPT_DURATION_MIN = 1;
export const MANUAL_SCRIPT_DURATION_MAX = 600;

export interface ManualScriptDraftInput {
  title: string;
  bodyText: string;
  targetDurationSec: number;
}

export interface ManualScriptInput {
  title: string;
  bodyText: string;
  targetDurationSec: number;
}

/**
 * 规范化一条手动脚本输入:trim、限长、正文实义校验与时长边界。
 * 正文必须同时通过两条实义校验——只用断句器会漏掉 "，，，" / "……" / "——"
 * 这类无实义字符但整体构成 tail 的输入(断句句界只有 。！？!?；; 与换行)。
 * 校验不通过一律抛 BatchDomainError('invalid_input'),由 HTTP 层映射 400。
 */
export function normalizeManualScriptInput(input: ManualScriptDraftInput): ManualScriptInput {
  const title = input.title.trim();
  if (!title) {
    throw new BatchDomainError('invalid_input', '脚本标题不能为空');
  }
  if (Array.from(title).length > MANUAL_SCRIPT_TITLE_MAX) {
    throw new BatchDomainError('invalid_input', `脚本标题不能超过 ${MANUAL_SCRIPT_TITLE_MAX} 字`);
  }
  const bodyText = input.bodyText.trim();
  if (!bodyText) {
    throw new BatchDomainError('invalid_input', '脚本正文不能为空');
  }
  if (Array.from(bodyText).length > MANUAL_SCRIPT_BODY_MAX) {
    throw new BatchDomainError('invalid_input', `脚本正文不能超过 ${MANUAL_SCRIPT_BODY_MAX} 字`);
  }
  if (countScriptContentCharacters(bodyText) === 0) {
    throw new BatchDomainError('invalid_input', '脚本正文必须包含有效文字内容');
  }
  if (splitBatchScriptSentences(bodyText).length < 1) {
    throw new BatchDomainError('invalid_input', '脚本正文必须能切出至少一个完整句段');
  }
  const duration = input.targetDurationSec;
  if (!Number.isFinite(duration) || !Number.isInteger(duration)
    || duration < MANUAL_SCRIPT_DURATION_MIN || duration > MANUAL_SCRIPT_DURATION_MAX) {
    throw new BatchDomainError(
      'invalid_input',
      `目标时长必须是 ${MANUAL_SCRIPT_DURATION_MIN}–${MANUAL_SCRIPT_DURATION_MAX} 秒的整数`,
    );
  }
  return { title, bodyText, targetDurationSec: duration };
}

/**
 * 规范化一整批手动脚本输入:先校验条数与总字符上限,再逐条规范化。
 * 批量粘贴一次可能创建大量库记录并各自触发语义打分与付费 TTS 任务,必须有边界。
 */
export function normalizeManualScriptBatch(inputs: ManualScriptDraftInput[]): ManualScriptInput[] {
  if (inputs.length === 0) {
    throw new BatchDomainError('invalid_input', '至少需要一条脚本');
  }
  if (inputs.length > MANUAL_SCRIPT_BATCH_MAX) {
    throw new BatchDomainError('invalid_input', `单次最多导入 ${MANUAL_SCRIPT_BATCH_MAX} 条脚本`);
  }
  const totalChars = inputs.reduce((sum, item) => (
    sum + Array.from(item.title).length + Array.from(item.bodyText).length
  ), 0);
  if (totalChars > MANUAL_SCRIPT_PASTE_CHARS_MAX) {
    throw new BatchDomainError('invalid_input', `单次导入的总字符数不能超过 ${MANUAL_SCRIPT_PASTE_CHARS_MAX}`);
  }
  return inputs.map((input) => normalizeManualScriptInput(input));
}

/**
 * 把批量粘贴的大段文本切成多条脚本草稿:按空行切块,每块首行作标题、
 * 其余行作正文;只有一行的块,该行同时作标题与正文;切完为空的块忽略。
 */
export function splitPastedScripts(text: string): Array<{ title: string; bodyText: string }> {
  const results: Array<{ title: string; bodyText: string }> = [];
  for (const block of text.split(/\n\s*\n/)) {
    const lines = block.split('\n').map((line) => line.trim()).filter((line) => line.length > 0);
    if (lines.length === 0) continue;
    const title = lines[0]!;
    const bodyText = lines.length > 1 ? lines.slice(1).join('\n') : title;
    results.push({ title, bodyText });
  }
  return results;
}
