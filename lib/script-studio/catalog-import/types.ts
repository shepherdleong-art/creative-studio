/**
 * 脚本知识目录导入的类型（方案 §6.1-§6.3）。
 * Excel 单元格只作为待导入、待展示或待归一化的数据，不改变执行方案或代理行为。
 */

export interface ImportIssue {
  code: string;
  message: string;
  row?: number;
  column?: string;
}

export interface ImportReport {
  totalRows: number;
  validRows: number;
  mergedModelCount: number;
  issues: ImportIssue[];
  canActivate: boolean;
  sheet?: string;
  templateCounts?: {
    framework: number;
    copyHook: number;
    visualHook: number;
    valid: number;
    draftInvalid: number;
  };
  /** 无法识别的表头列（含无标题列映射提示）。 */
  unmappedHeaders?: Array<{ column: string; value: string; row: number }>;
}

export interface StrategyEntryInsert {
  modelKey: string;
  normalizedModelKey: string;
  canonicalName: string;
  categoryMindsets: string[];
  primarySellingPoints: string[];
  differentiators: string[];
  searchTerms: string[];
  auxiliary: Record<string, unknown>;
  sourceRows: Array<number | string>;
  status: 'active' | 'conflict';
}

export interface StrategyImportResult {
  entries: StrategyEntryInsert[];
  report: ImportReport;
}

export interface FrameworkTemplateInsert {
  stableKey: string;
  name: string;
  subtype: string;
  structure: string[];
  sellingPointDensity: Record<string, unknown>;
  applicableProducts: string[];
  preferredHookTypes: string[];
  secondaryHookTypes: string[];
  sourceRow: number;
  status: 'active' | 'draft_invalid';
}

export interface CopyHookTemplateInsert {
  stableKey: string;
  hookType: string;
  mechanism: string;
  subtype: string;
  formula: string;
  example: string;
  recommendedFrameworks: string[];
  recommendedSellingPointTags: string[];
  sourceRow: number;
  status: 'active' | 'draft_invalid';
}

export interface VisualHookTemplateInsert {
  stableKey: string;
  playGroup: string;
  playName: string;
  visualFormula: string;
  implementationAdvice: string;
  applicableProducts: string[];
  hookTags: string[];
  referenceLinks: string[];
  notes: string;
  sourceRow: number;
  status: 'active' | 'draft_invalid';
}

export interface TemplateAssetInsert {
  visualHookId: string;
  relativePath: string;
  contentSha256: string;
  sourceAnchor: string;
  width: number | null;
  height: number | null;
}

export interface TemplateImportResult {
  frameworks: FrameworkTemplateInsert[];
  copyHooks: CopyHookTemplateInsert[];
  visualHooks: VisualHookTemplateInsert[];
  assets: TemplateAssetInsert[];
  report: ImportReport;
}

export type ImportKind = 'strategy' | 'template';
