/**
 * 选片：把一条脚本的公式编号对到素材文件。
 *
 * 缺号不再停下等人：缺的是哪些编号记在结果里，交给定声音时替代（见排片计算的规矩 e）。
 * 同号轮换的算法只在 `scheduling/text.ts` 的 `rotationIndex` 里写一次，这里直接调用。
 * 纯函数：不读数据库、不调服务、不碰文件，素材由调用方作为绑定列表给它。
 */
import { isVoiceOver, rotationIndex, slotKind } from '../scheduling/text.ts';
import { parseMaterialFilename } from './parse.ts';

export const FORMULA_SELECTION_VERSION = 'formula-script-selection/1' as const;

export interface FormulaSelectableFile {
  assetId: string;
  contentFingerprint: string;
  fileName: string;
}

/** 素材绑定；和数据库里的绑定一一对应，调用方把不可用的也一起给进来。 */
export interface FormulaSelectionBinding extends FormulaSelectableFile {
  logicalCode: string | null;
  available: boolean;
  excludedReason: string | null;
}

export interface FormulaSelectedCode {
  logicalCode: string;
  /** 编号去掉数字后的部分，如 S、P、VO。 */
  kind: string;
  isVo: boolean;
  /** 口播台词（文件名里 “ ” 中间的字）；不是口播时为 null。 */
  voLine: string | null;
  wide: boolean;
  wideExperience: boolean;
  /** 这个编号全部可用文件，按 assetId 排序；轮换按这个顺序数。 */
  files: FormulaSelectableFile[];
  /** 按轮换选中的文件；缺号时为 null。 */
  file: FormulaSelectableFile | null;
  missing: boolean;
}

export interface FormulaScriptSelection {
  algorithmVersion: typeof FORMULA_SELECTION_VERSION;
  scriptNumber: string;
  /** 份次，从 1 数。 */
  copyIndex: number;
  /** 公式里出现过的编号，去重并按第一次出现的顺序。 */
  codes: FormulaSelectedCode[];
  /** 缺的编号，按公式顺序去重。 */
  missingCodes: string[];
  /** 缺号不停：只要对过一遍就是 selected。 */
  status: 'selected';
}

export function selectFormulaScript(input: {
  scriptNumber: string;
  copyIndex: number;
  codes: readonly string[];
  bindings: readonly FormulaSelectionBinding[];
}): FormulaScriptSelection {
  const filesByCode = new Map<string, FormulaSelectableFile[]>();
  for (const binding of input.bindings) {
    if (!binding.logicalCode || !binding.available || binding.excludedReason) continue;
    const files = filesByCode.get(binding.logicalCode) ?? [];
    if (files.some(file => file.assetId === binding.assetId)) continue;
    files.push({ assetId: binding.assetId, contentFingerprint: binding.contentFingerprint, fileName: binding.fileName });
    filesByCode.set(binding.logicalCode, files);
  }
  // 按 assetId 排序，同一份资料每次选到的文件都一样。
  for (const files of filesByCode.values()) files.sort((a, b) => (a.assetId < b.assetId ? -1 : a.assetId > b.assetId ? 1 : 0));

  const seen = new Set<string>();
  const codes: FormulaSelectedCode[] = [];
  const missingCodes: string[] = [];
  for (const logicalCode of input.codes) {
    if (seen.has(logicalCode)) continue;
    seen.add(logicalCode);
    const files = filesByCode.get(logicalCode) ?? [];
    const file = files.length ? files[rotationIndex(input.scriptNumber, input.copyIndex - 1, files.length)] : null;
    const parsed = parseMaterialFilename(file?.fileName ?? '');
    codes.push({
      logicalCode,
      kind: slotKind(logicalCode),
      isVo: isVoiceOver(logicalCode),
      voLine: parsed.voLine,
      wide: parsed.wide,
      wideExperience: parsed.wideExperience,
      files,
      file,
      missing: file === null,
    });
    if (!file) missingCodes.push(logicalCode);
  }
  return {
    algorithmVersion: FORMULA_SELECTION_VERSION,
    scriptNumber: input.scriptNumber,
    copyIndex: input.copyIndex,
    codes,
    missingCodes,
    status: 'selected',
  };
}
