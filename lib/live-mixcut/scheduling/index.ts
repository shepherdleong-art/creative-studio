/**
 * 排片计算：实拍混剪「一条脚本怎么排成一条成片」的规矩都在这里。
 * 纯计算，只用 media-core 方向的共享能力（本模块目前不依赖任何模块）。
 */
export * from './types.ts';
export { normalizeSpeechText, stripEmoji, slotKind, isVoiceOver, rotationIndex, estimatedSpeechUs } from './text.ts';
export { assignFormulaVoice, linesToNarrate, missingNarrationLines, relatedAssetIds } from './voice.ts';
export { arrangeFormulaTime, microsecondsToFrames, framesToMicroseconds, voiceUsableRange, voiceFrames } from './arrange-time.ts';
export { validateFormulaShortFilm } from './validate.ts';
