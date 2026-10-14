import { requireInput } from './errors.ts';

export function object(value: unknown, name: string): Record<string, unknown> {
  requireInput(value !== null && typeof value === 'object' && !Array.isArray(value), 'INVALID_FIELD', `${name} 必须为对象`);
  return value as Record<string, unknown>;
}
export function array(value: unknown, name: string): unknown[] {
  requireInput(Array.isArray(value), 'INVALID_FIELD', `${name} 必须为数组`);
  return value;
}
export function string(value: unknown, name: string, allowEmpty = false): string {
  requireInput(typeof value === 'string' && (allowEmpty || value.trim().length > 0), 'INVALID_FIELD', `${name} 必须为${allowEmpty ? '' : '非空'}字符串`);
  return value;
}
export function numeric(value: unknown, name: string, min = -Infinity, max = Infinity): number {
  requireInput(typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max,
    'INVALID_FIELD', `${name} 必须是 ${min} 到 ${max} 之间的有限数值`);
  return value;
}
export function integer(value: unknown, name: string, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  const n = numeric(value, name, min, max);
  requireInput(Number.isSafeInteger(n), 'INVALID_FIELD', `${name} 必须为安全整数`);
  return n;
}
export function identifier(value: unknown, name: string): string {
  const text = string(value, name);
  requireInput(/^[A-Za-z0-9_-]+$/.test(text), 'INVALID_FIELD', `${name} 只能包含字母、数字、下划线或连字符`);
  return text;
}
