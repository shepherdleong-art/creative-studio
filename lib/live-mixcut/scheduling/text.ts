/** 实拍混剪排片用的文字与编号工具；纯函数。 */

/** 去掉标点、空格和表情，只留汉字、字母和数字；用于「逐字写着」的判断。 */
export function normalizeSpeechText(value: unknown): string {
  return String(value ?? '').replace(/[^一-鿿A-Za-z0-9]/g, '');
}

/** 去掉表情符号，保留其余文字；用于字幕和配音。 */
export function stripEmoji(value: unknown): string {
  return String(value ?? '')
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, '')
    .trim();
}

/** 编号去掉末尾数字后的部分：VO12 → VO、S03 → S。 */
export function slotKind(logicalCode: string): string {
  return String(logicalCode).replace(/\d+$/, '');
}

/** 编号是不是口播镜头。 */
export function isVoiceOver(logicalCode: string): boolean {
  return /^VO/i.test(String(logicalCode));
}

/**
 * 同号轮换：一个编号有多份文件时，用第 (原脚本号 + 份次) mod 文件数 份，从 0 数。
 * 脚本号取开头的整数；取不到时按 0 算。
 *
 * 「份次」在这里从 0 数（数据库的 copyIndex 从 1 数，调用方传 copyIndex - 1）：
 * 第一份与原型一致，用「原脚本号」这一档，脚本 18 用第 1 份、脚本 49 用第 2 份。
 */
export function rotationIndex(scriptNumber: string, copyOrdinal: number, fileCount: number): number {
  if (!Number.isSafeInteger(fileCount) || fileCount < 1) throw new Error('轮换需要至少一份文件');
  const matched = /^\d+/.exec(String(scriptNumber).trim());
  const base = matched ? Number(matched[0]) : 0;
  const copy = Number.isSafeInteger(copyOrdinal) ? copyOrdinal : 0;
  return (((base + copy) % fileCount) + fileCount) % fileCount;
}

/** 按台词字数和语速估算朗读时长（毫秒）；只用于没有实际配音时的占位估算。 */
export function estimatedSpeechUs(text: string, charsPerSecond = 4.1): number {
  const length = normalizeSpeechText(text).length;
  return Math.max(600_000, Math.round(length / charsPerSecond * 1_000_000));
}
