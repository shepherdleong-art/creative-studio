/** 成片来源标记。只接受短编号，不允许任意文本进入文件名。 */
export interface ProductionCodes {
  scriptCode?: string;
  openingCode?: string;
  packagingCode?: string;
}

export const BUILTIN_OPENING_CODES: Readonly<Record<string, string>> = {
  'magic-growth': 'K1',
  'giant-hand-place': 'K2',
  'carton-explosion': 'K3',
  'bare-shell-renovation': 'K4',
};

export function normalizeProductionCode(value: unknown, prefix: 'J' | 'K'): string {
  const text = typeof value === 'string' ? value.normalize('NFKC').trim().toUpperCase() : '';
  return new RegExp(`^${prefix}[1-9][0-9]{0,5}$`).test(text) ? text : '';
}

export function scriptCodeFromContent(value: unknown): string {
  if (!value || typeof value !== 'object') return '';
  const content = value as { scriptCode?: unknown; templateRewrite?: { scriptCode?: unknown } };
  return normalizeProductionCode(content.scriptCode ?? content.templateRewrite?.scriptCode, 'J');
}

export function packagingCode(config: { enabled?: boolean; template?: string } | null | undefined): string {
  if (!config?.enabled) return '';
  return ({ 'overlay-poster': 'A', 'overlay-journal': 'B', 'overlay-minimal': 'C', 'overlay-variety': 'D' } as Record<string, string>)[config.template || 'overlay-poster'] || '';
}

export function productionCodeSuffix(codes?: ProductionCodes): string {
  if (!codes) return '';
  return normalizeProductionCode(codes.scriptCode, 'J')
    + normalizeProductionCode(codes.openingCode, 'K')
    + (/^[ABCD]$/.test(codes.packagingCode || '') ? codes.packagingCode : '');
}

export function withProductionCodes(baseName: string, codes?: ProductionCodes): string {
  const suffix = productionCodeSuffix(codes);
  return suffix ? `${baseName}-${suffix}` : baseName;
}
