export function sanitizeExportFilenamePart(value: string): string {
  return value
    .replace(/[\/\\:*?"<>|]/g, '')
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
    .replace(/[. ]+$/g, '');
}

/** 与旧 J/K 编号分开保存；份次来自生成输入，包装来自本次实际渲染。 */
export interface FormulaExportIdentity {
  version: 1;
  scriptNumber: string;
  copyIndex: number;
  packagingCode: 'none' | 'f1' | 'f2' | 'f3' | 'f4';
}

export function formulaExportSuffix(identity: FormulaExportIdentity): string {
  if (identity?.version !== 1 || typeof identity.scriptNumber !== 'string'
    || !/^[1-9][0-9]*$/.test(identity.scriptNumber) || !Number.isSafeInteger(Number(identity.scriptNumber))
    || !Number.isSafeInteger(identity.copyIndex) || identity.copyIndex < 1
    || !['none', 'f1', 'f2', 'f3', 'f4'].includes(identity.packagingCode)) {
    throw new Error('公式导出缺少有效的原脚本号、份次或包装编号');
  }
  return `脚本${identity.scriptNumber}-第${String(identity.copyIndex).padStart(2, '0')}份-${identity.packagingCode === 'none' ? '无包装' : identity.packagingCode}`;
}

export function formatShanghaiTaskDate(createdAt: string): string {
  const trimmed = createdAt.trim();
  const sqliteUtc = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(trimmed)
    ? `${trimmed.replace(' ', 'T')}Z`
    : trimmed;
  const date = new Date(sqliteUtc);
  if (!Number.isFinite(date.getTime())) return '';
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year || ''}${value.month || ''}${value.day || ''}`;
}

export function previewExportBaseName(productCode: string, taskDate: string): string | null {
  const trimmed = productCode.trim();
  if (!trimmed || !/^\d{8}$/.test(taskDate)) return null;
  const sanitized = sanitizeExportFilenamePart(trimmed);
  return sanitized.trim() ? `成片-${sanitized}-${taskDate}` : null;
}
