import { createHash } from 'node:crypto';
import { BatchDomainError } from '../errors.ts';
import { normalizeLogicalCode } from './parse.ts';

export interface FormulaReplacementHint { originalCode: string; replacementCode: string; note: string; sourceLine: number | null }
export interface FormulaReplacementHintsFile { filename: string; fingerprint: string; hints: FormulaReplacementHint[] }
export const FORMULA_REPLACEMENT_HINT_BYTES = 256 * 1024;
const fail = (message: string): never => { throw new BatchDomainError('invalid_input', message); };
function code(value: unknown): string {
  if (typeof value !== 'string') return fail('替换建议需使用完整素材编号');
  try { return normalizeLogicalCode(value); } catch { return fail(`替换建议编号无效：${value.slice(0, 60)}`); }
}

/** Existing files are untrusted hints, never confirmed manual replacement rules. */
export function parseFormulaReplacementHints(name: string, bytes: Buffer): FormulaReplacementHintsFile {
  if (typeof name !== 'string' || /[\u0000-\u001f\u007f]/.test(name)) return fail('替换建议文件名无效');
  const filename = name.split(/[/\\]/).at(-1)!.trim();
  if (filename.length > 180 || !/\.(json|txt)$/i.test(filename)) return fail('请选择 JSON 或 TXT 替换建议文件');
  if (!bytes.length || bytes.length > FORMULA_REPLACEMENT_HINT_BYTES) return fail('替换建议文件不能为空，且不能超过 256 KiB');
  let source: string;
  try { source = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { return fail('替换建议须为 UTF-8 编码的 JSON 或 TXT 文件'); }
  const hints: FormulaReplacementHint[] = [];
  if (/\.json$/i.test(filename)) {
    let body: unknown;
    try { body = JSON.parse(source); } catch { return fail('替换建议 JSON 格式不正确'); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return fail('JSON 须按原编号保存每项建议及 sub 替换编号');
    // JSON.parse silently overwrites duplicate keys; scan validated syntax before accepting it.
    const keys: string[] = [], objects: Array<Set<string> | null> = [];
    for (const token of source.matchAll(/"(?:\\.|[^"\\])*"|[{}\[\]]/g)) {
      if (token[0] === '{' || token[0] === '[') objects.push(token[0] === '{' ? new Set() : null);
      else if (token[0] === '}' || token[0] === ']') objects.pop();
      else if (/^\s*:/.test(source.slice(token.index! + token[0].length))) {
        const key = JSON.parse(token[0]) as string, siblings = objects.at(-1);
        if (siblings?.has(key)) return fail('替换建议 JSON 含重复字段');
        siblings?.add(key);
        if (objects.length === 1) keys.push(key);
      }
    }
    if (new Set(keys.map(code)).size !== keys.length) return fail('同一原编号的替换建议重复');
    for (const [original, raw] of Object.entries(body)) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail(`${original} 的建议格式不正确`);
      const item = raw as Record<string, unknown>;
      const allowed = ['kind', 'sub', 'line', 'group', 'line_index', 'orig_group', 'orig_shot', 'sub_group', 'sub_shot', 'reason'];
      if (Object.entries(item).some(([key, value]) => !allowed.includes(key)
        || (typeof value !== 'string' && typeof value !== 'number') || String(value).length > 2000)) return fail(`${original} 含不支持的建议字段或过长说明`);
      const note = JSON.stringify(item);
      if (note.length > 8000) return fail(`${original} 的建议说明过长`);
      hints.push({ originalCode: code(original), replacementCode: code(item.sub), note, sourceLine: null });
    }
  } else {
    let pending: { originalCode: string; replacementCode: string | null; sourceLine: number; lines: string[] } | null = null;
    const finish = () => {
      if (!pending) return;
      if (!pending.replacementCode) return fail(`${pending.originalCode} 的替换建议不完整`);
      const note = pending.lines.join('\n');
      if (note.length > 8000) return fail(`${pending.originalCode} 的建议说明过长`);
      hints.push({ originalCode: pending.originalCode, replacementCode: pending.replacementCode, sourceLine: pending.sourceLine, note });
      pending = null;
    };
    const lines = source.split(/\r?\n/);
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index], normalized = line.normalize('NFKC').trim();
      if (/^-+\s*C[.、]/i.test(normalized)) break; // The legacy section C lists duplicate files, not replacement hints.
      if (!normalized || /^[-=]+/.test(normalized) && !normalized.startsWith('->')) continue;
      const original = /^([A-Z]+\d+)(?=\s|$)/i.exec(normalized);
      if (original) { finish(); pending = { originalCode: code(original[1]), replacementCode: null, sourceLine: index + 1, lines: [] }; }
      if (/^(?:备选|候选)\s+/u.test(normalized)) { pending?.lines.push(line); continue; }
      if (pending) pending.lines.push(line);
      if (/->|→/.test(normalized)) {
        const target = /(?:->|→)\s*(?:替身\s*)?([A-Z]+\d+)(?=$|[\s([（【])/i.exec(normalized);
        if (!pending || !target || pending.replacementCode || (normalized.match(/->|→/g)?.length ?? 0) !== 1) return fail(`第 ${index + 1} 行替换编号或格式不正确`);
        pending.replacementCode = code(target[1]);
      }
    }
    finish();
  }
  if (!hints.length) return fail('文件中没有可读取的替换建议');
  if (hints.length > 1000) return fail('单次最多导入 1000 项替换建议');
  const originals = new Set(hints.map(hint => hint.originalCode));
  if (originals.size !== hints.length) return fail('同一原编号的替换建议重复');
  if (hints.some(hint => hint.originalCode === hint.replacementCode)) return fail('替换建议不能指向原编号自身');
  if (hints.some(hint => originals.has(hint.replacementCode))) return fail('替换建议不能包含多跳或循环，请直接指定最终素材编号');
  return { filename, fingerprint: createHash('sha256').update(bytes).digest('hex'), hints };
}
