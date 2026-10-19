/**
 * 批量脚本断句的唯一实现:一次切分产出两种形态——
 * - `text`: 去标点,给分配器与语义匹配;
 * - `textWithPunctuation`: 带标点,给 TTS 朗读、脚本预览与句段 id。
 *
 * 两种形态的数量与顺序结构上不可能分叉。句界以「去标点」侧为准:
 * 连续终止标点归到前一句(`"A。。B"` = 2 句,其 textWithPunctuation 为
 * `["A。。", "B"]`),与旧 narration 侧逐句保留标点的行为在常规文本上完全一致。
 */
export function splitBatchScriptSentences(bodyText: string): Array<{
  text: string;
  textWithPunctuation: string;
}> {
  const normalized = bodyText.replace(/\r\n?/g, '\n').trim();
  if (!normalized) return [];
  const sentences: Array<{ text: string; textWithPunctuation: string }> = [];
  // 句界:连续终止标点(。！？!?；;)整体作为一个边界,或换行
  const boundary = /[。！？!?；;]+|\n+/gu;
  let lastBoundaryEnd = 0;
  let match: RegExpExecArray | null;
  while ((match = boundary.exec(normalized)) !== null) {
    const raw = normalized.slice(lastBoundaryEnd, match.index).trim();
    if (raw) {
      sentences.push({
        text: raw,
        textWithPunctuation: normalized.slice(lastBoundaryEnd, match.index + match[0].length).trim(),
      });
    }
    lastBoundaryEnd = match.index + match[0].length;
  }
  const tail = normalized.slice(lastBoundaryEnd).trim();
  if (tail) {
    sentences.push({ text: tail, textWithPunctuation: tail });
  }
  return sentences;
}
