/** 成片来源标记。只接受短编号，不允许任意文本进入文件名。 */
export interface ProductionCodes {
  scriptCode?: string;
  openingCode?: string;
  packagingCode?: string;
}

export const BUILTIN_OPENING_CODES: Readonly<Record<string, string>> = {
  'magic-growth': 'k1',
  'giant-hand-place': 'k2',
  'carton-explosion': 'k3',
  'bare-shell-renovation': 'k4',
};

export function normalizeProductionCode(value: unknown, prefix: 'J' | 'K'): string {
  const text = typeof value === 'string' ? value.normalize('NFKC').trim().toLowerCase() : '';
  return new RegExp(`^${prefix.toLowerCase()}[1-9][0-9]{0,5}$`).test(text) ? text : '';
}

export function scriptCodeFromContent(value: unknown): string {
  if (!value || typeof value !== 'object') return '';
  const content = value as { scriptCode?: unknown; templateRewrite?: { scriptCode?: unknown } };
  return normalizeProductionCode(content.scriptCode ?? content.templateRewrite?.scriptCode, 'J');
}

export function packagingCode(config: { enabled?: boolean; template?: string } | null | undefined): string {
  if (!config?.enabled) return '';
  return ({ 'overlay-poster': 'f1', 'overlay-journal': 'f2', 'overlay-minimal': 'f3', 'overlay-variety': 'f4' } as Record<string, string>)[config.template || 'overlay-poster'] || '';
}

/** Frozen exports from older versions may still carry the A–D packaging codes. */
export function normalizePackagingCode(value: unknown): string {
  const text = typeof value === 'string' ? value.normalize('NFKC').trim().toLowerCase() : '';
  return ({ a: 'f1', b: 'f2', c: 'f3', d: 'f4' } as Record<string, string>)[text] || (/^f[1-4]$/.test(text) ? text : '');
}

export function productionCodeSuffix(codes?: ProductionCodes): string {
  if (!codes) return '';
  return normalizeProductionCode(codes.scriptCode, 'J')
    + normalizeProductionCode(codes.openingCode, 'K')
    + normalizePackagingCode(codes.packagingCode);
}

export function withProductionCodes(baseName: string, codes?: ProductionCodes): string {
  const suffix = productionCodeSuffix(codes);
  return suffix ? `${baseName}-${suffix}` : baseName;
}
