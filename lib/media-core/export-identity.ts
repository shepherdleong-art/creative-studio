export function sanitizeExportFilenamePart(value: string): string {
  return value
    .replace(/[\/\\:*?"<>|]/g, '')
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
    .replace(/[. ]+$/g, '');
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
