// 执行清单卡 11 的固定改动：接火山识别、非口播镜头取中间、默认 3:4、配音和核对时忽略表情符号。
// 只跑一次；原文对不上就整体停下。用法：node scripts/live-mixcut-port/card11-edits.mjs
import fs from 'node:fs';

const SUGGESTED_RANGE = `// 非口播镜头的默认取用范围：素材开头、结尾一般是无效片段，默认去掉开头 3 秒、结尾 2 秒，
// 不够用时开头最少也去 2 秒；还不够就按比例少去一些，id 标成 suggested-reduced，审片时提示。
// 口播镜头保留整段，由原声区间决定取哪里（见 duration.ts）。
const DEFAULT_HEAD_US = 3_000_000, MIN_HEAD_US = 2_000_000, DEFAULT_TAIL_US = 2_000_000;
function suggestedRange(slot: { slotId: string; mediaDurationUs: number }, preferredUs: number, hasSpeech: boolean) {
  const durationUs = slot.mediaDurationUs;
  const base = { protected: null, confirmed: false };
  if (hasSpeech) return { ...base, id: \`suggested:\${slot.slotId}\`, inUs: 0, outUs: durationUs };
  for (const headUs of [DEFAULT_HEAD_US, MIN_HEAD_US]) {
    if (durationUs - headUs - DEFAULT_TAIL_US >= preferredUs) {
      return { ...base, id: \`suggested:\${slot.slotId}\`, inUs: headUs, outUs: durationUs - DEFAULT_TAIL_US };
    }
  }
  const spareUs = Math.max(0, durationUs - preferredUs);
  const headUs = Math.round(spareUs * MIN_HEAD_US / (MIN_HEAD_US + DEFAULT_TAIL_US));
  return { ...base, id: \`suggested-reduced:\${slot.slotId}\`, inUs: headUs, outUs: durationUs - (spareUs - headUs) };
}

`;

const plans = [
  ['lib/media-core/adapters/alignment.ts', [
    ['/** 忽略句读、空白与字母大小写；保留数字的小数点、正负号、百分号等含义。 */\nexport function speechContent(text: string): string {\n  return text.normalize(\'NFKC\').replace(',
      "/** 表情符号不朗读：配音前去掉，核对台词时也不算。 */\nexport const SPEECH_EMOJI = /[\\p{Extended_Pictographic}\\u{FE0F}\\u{200D}\\u{20E3}]/gu;\n\n/** 忽略句读、空白、表情符号与字母大小写；保留数字的小数点、正负号、百分号等含义。 */\nexport function speechContent(text: string): string {\n  return text.normalize('NFKC').replace(SPEECH_EMOJI, '').replace("],
  ]],
  ['lib/live-mixcut/formula/narration.ts', [
    ["import { createOpenAiAlignmentAdapter, createOpenAiTranscriptionAdapter, speechContent, type AlignmentWordTiming } from '../../media-core/adapters/alignment.ts';",
      "import { createOpenAiAlignmentAdapter, createOpenAiTranscriptionAdapter, SPEECH_EMOJI, speechContent, type AlignmentWordTiming } from '../../media-core/adapters/alignment.ts';"],
    ["segments: [{ segmentId: 'narration', narration: input.text }]", "segments: [{ segmentId: 'narration', narration: input.text.replace(SPEECH_EMOJI, '') }]"],
  ]],
  ['lib/live-mixcut/formula/speech-provider.ts', [
    ["import { createOpenAiTranscriptionAdapter, type SpeechTranscriptionAdapter } from '../../media-core/adapters/alignment.ts';\n",
      "import { createOpenAiTranscriptionAdapter, type SpeechTranscriptionAdapter } from '../../media-core/adapters/alignment.ts';\nimport { createVolcFlashAsrAdapter } from '../../media-core/adapters/volc-asr.ts';\n"],
    ['export function captureFormulaSpeechService(): FormulaSpeechService {\n  const adapter = createOpenAiTranscriptionAdapter();',
      '/** 配了火山就用火山，否则沿用 OpenAI 兼容接口（FINAL_EDIT_ALIGNMENT_*）。 */\nfunction currentSpeechAdapter(): SpeechTranscriptionAdapter {\n  const volc = createVolcFlashAsrAdapter();\n  return volc.configured ? volc : createOpenAiTranscriptionAdapter();\n}\n\nexport function captureFormulaSpeechService(): FormulaSpeechService {\n  const adapter = currentSpeechAdapter();'],
    ['  const current = createOpenAiTranscriptionAdapter();', '  const current = currentSpeechAdapter();'],
  ]],
  ['lib/live-mixcut/formula/production-settings.ts', [
    ["return { outputPreset: '9x16', audio:", "return { outputPreset: '3x4', audio:"],
  ]],
  ['lib/live-mixcut/formula/timeline.ts', [
    [`  const candidates: FormulaDurationSlot[][] = input.slots.map(slot => {
    const ranges = slot.ranges.length ? slot.ranges.map(range => ({ ...range, confirmed: true }))
      : [{ id: \`suggested:\${slot.slotId}\`, inUs: 0, outUs: slot.mediaDurationUs, protected: null, confirmed: false }];
    return ranges.map(range => ({ ...slot, preferredDurationUs: Math.max(1, Math.round(input.target.durationUs / Math.max(1, input.slots.length))), range }));
  });`, `  const speechSlotIds = new Set(mapping.sources.map(source => source.slotId));
  const candidates: FormulaDurationSlot[][] = input.slots.map(slot => {
    const preferredDurationUs = Math.max(1, Math.round(input.target.durationUs / Math.max(1, input.slots.length)));
    const ranges = slot.ranges.length ? slot.ranges.map(range => ({ ...range, confirmed: true }))
      : [suggestedRange(slot, preferredDurationUs, speechSlotIds.has(slot.slotId))];
    return ranges.map(range => ({ ...slot, preferredDurationUs, range }));
  });`],
  ], { prependBefore: 'export function', text: SUGGESTED_RANGE }],
  ['lib/live-mixcut/formula/duration.ts', [
    ['    const sourceStart = item.fixedStart ?? Math.max(item.start, (item.protectedEnd ?? item.start) - durations[index]);',
      `    // 没有人工区间、没有原声、没有保护动作的镜头，从默认取用范围的正中间取。
    const centered = !item.slot.range.confirmed && !item.source && item.protectedStart === undefined
      ? item.start + Math.floor((item.end - item.start - durations[index]) / 2) : undefined;
    const sourceStart = item.fixedStart ?? centered ?? Math.max(item.start, (item.protectedEnd ?? item.start) - durations[index]);`],
    ["  if (unconfirmed.length) issues.push({ code: 'range_unconfirmed', slotIds: unconfirmed, message: '这些裁切区间仍需审片确认' });",
      `  if (unconfirmed.length) issues.push({ code: 'range_unconfirmed', slotIds: unconfirmed, message: '这些裁切区间仍需审片确认' });
  const reduced = slots.filter(slot => slot.range.id.startsWith('suggested-reduced:')).map(slot => slot.slotId);
  if (reduced.length) issues.push({ code: 'range_unconfirmed', slotIds: reduced, message: '这些镜头的素材较短，开头结尾少去了一些，请审片确认' });`],
  ]],
];

const results = plans.map(([file, pairs, extra]) => {
  let text = fs.readFileSync(file, 'utf8');
  for (const [from, to] of pairs) {
    const count = text.split(from).length - 1;
    if (count !== 1) throw new Error(`${file}：要替换的原文出现 ${count} 次：${from.slice(0, 80)}`);
    text = text.replace(from, to);
  }
  if (extra) {
    // 把辅助函数插在第一个顶层 export function 之前。
    const at = text.indexOf(`\n${extra.prependBefore}`);
    if (at < 0) throw new Error(`${file}：找不到插入位置`);
    text = text.slice(0, at + 1) + extra.text + text.slice(at + 1);
  }
  return [file, text];
});
for (const [file, text] of results) {
  fs.writeFileSync(file, text, 'utf8');
  console.log(`写入 ${file}`);
}
