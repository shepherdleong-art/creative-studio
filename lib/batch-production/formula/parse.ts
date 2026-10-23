/** 编号解析只读取资料，不执行 Excel 或自然语言中的指令。 */
export function normalizeLogicalCode(value: string): string {
  const code = value.normalize('NFKC').trim().toUpperCase();
  if (!/^[A-Z]+[0-9]+$/.test(code) || code.length > 64) {
    throw new Error('素材编号须为完整的字母加数字，例如 G1、GB9、VO13');
  }
  return code;
}

export function parseMaterialFilename(filename: string): {
  logicalCode: string | null;
  excludedReason: 'preview' | null;
} {
  const name = filename.normalize('NFKC').trim().toUpperCase();
  const match = /^([A-Z]+[0-9]+)(?=[\s_.\-]|$)/.exec(name);
  return {
    logicalCode: match ? normalizeLogicalCode(match[1]) : null,
    excludedReason: /(?:^|[\s_.\-])(?:PREVIEW|PROXY|预览|代理)(?=[\s_.\-]|$)/.test(name) ? 'preview' : null,
  };
}

export function parseFormula(value: string, expectedShots?: number): string[] {
  const text = value.normalize('NFKC').trim();
  if (expectedShots !== undefined && (!Number.isSafeInteger(expectedShots) || expectedShots < 1)) {
    throw new Error('镜头数必须为正整数');
  }
  if (!text || text.length > 65536) throw new Error('公式为空或过长');
  const codes: string[] = [];
  let rest = text;
  while (rest) {
    const token = /^(?:【\s*([A-Za-z]+[0-9]+)\s*】|([A-Za-z]+[0-9]+))/.exec(rest);
    if (!token) throw new Error(`公式第 ${text.length - rest.length + 1} 个字符不是完整素材编号`);
    codes.push(normalizeLogicalCode(token[1] ?? token[2]));
    rest = rest.slice(token[0].length);
    if (!rest) break;
    const spaced = /^\s+/.test(rest);
    rest = rest.trimStart();
    if (!rest) break;
    if (/^[→+,]/.test(rest)) {
      rest = rest.slice(1).trimStart();
      if (!rest) throw new Error('公式分隔符后缺少素材编号');
    } else if (!spaced && !(token[1] && rest.startsWith('【'))) {
      throw new Error(`公式第 ${text.length - rest.length + 1} 个字符不是合法分隔符`);
    }
  }
  if (expectedShots !== undefined && codes.length !== expectedShots) {
    throw new Error(`公式有 ${codes.length} 个镜头，与填写的 ${expectedShots} 个不一致`);
  }
  return codes;
}
