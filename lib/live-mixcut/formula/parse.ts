/** 编号解析只读取资料，不执行 Excel 或自然语言中的指令。 */
export function normalizeLogicalCode(value: string): string {
  const code = value.normalize('NFKC').trim().toUpperCase();
  if (!/^[A-Z]+[0-9]+$/.test(code) || code.length > 64) {
    throw new Error('素材编号须为完整的字母加数字，例如 G1、GB9、VO13');
  }
  return code;
}

export interface FormulaMaterialFilename {
  logicalCode: string | null;
  excludedReason: 'preview' | null;
  /** 口播台词：文件名里 “ ” 中间的字；不是口播时也只是原文，由调用方按编号判断。 */
  voLine: string | null;
  /** 全景展示：文件名同时含「整体外观」和「无人出镜」。 */
  wide: boolean;
  /** 全景体验：P 镜头，并且文件名含「全景」。 */
  wideExperience: boolean;
}

/** 从素材文件名直接读出编号、口播台词和两种全景标记；不依赖表格，也不调模型。 */
export function parseMaterialFilename(filename: string): FormulaMaterialFilename {
  const original = filename.trim();
  // 编号和标记不区分全角/半角；口播台词保留原样，标点不能改。
  const name = original.normalize('NFKC').toUpperCase();
  const match = /^([A-Z]+[0-9]+)(?=[\s_.\-]|$)/.exec(name);
  const logicalCode = match ? normalizeLogicalCode(match[1]) : null;
  const quoted = /“([^”]*)”|"([^"]*)"/.exec(original);
  const voLine = quoted ? (quoted[1] ?? quoted[2] ?? '').trim() || null : null;
  return {
    logicalCode,
    excludedReason: /(?:^|[\s_.\-])(?:PREVIEW|PROXY|预览|代理)(?=[\s_.\-]|$)/.test(name) ? 'preview' : null,
    voLine,
    wide: name.includes('整体外观') && name.includes('无人出镜'),
    wideExperience: Boolean(logicalCode?.startsWith('P')) && name.includes('全景'),
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
