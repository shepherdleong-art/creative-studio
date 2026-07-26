/**
 * Shared types for script generation providers.
 */

// ── Selling Point Analysis ──

export interface AnalysisInput {
  sellingPoints: string[];
  targetAudience: string;
  platform: string;
}

export interface SellingPointRanking {
  rank: number;
  title: string;
  priority: 'highest' | 'high' | 'medium' | 'low';
  reason: string;
  recommendedTemplateId: string;
  recommendedTemplateName: string;
  targetHook: string;
}

export interface AnalysisResult {
  rankings: SellingPointRanking[];
  audienceInsight: string;
  platformAdvice: string;
}

// ── Script Generation ──

export interface SelectedSellingPoint {
  title: string;
  priority: string;
  reason: string;
}

/** 一张候选分镜图，连同它的真实像素（base64）一起发给多模态模型。 */
export interface ShotContext {
  shotId: string;
  shotIndex: number;
  sourceFilename: string;
  /** 模型实际看到的那张图（= 将来做成视频的那张）。 */
  imageAssetId: string;
  mimeType: string;
  imageBase64: string;
}

export interface ScriptInput {
  projectName: string;
  productName: string;
  productCode: string;
  productCategory: string;
  targetAudience: string;
  tone: string;
  platform: string;
  selectedSellingPoints: SelectedSellingPoint[];
  templateId: string;
  templateName: string;
  /** 取代旧的自由文本 duration。成片目标时长的唯一来源。 */
  targetDurationSec: number;
  shotSetId: string;
  shots: ShotContext[];
  sceneReference?: string;
  videoTemplates?: string[];
}

/** 一句口播 ↔ 一张画面。数组顺序 = 叙事顺序 = 成片画面顺序。 */
export interface ScriptSegment {
  shotId: string;
  /** 写作时看的那张图，用于下游过期检测。 */
  imageAssetId: string;
  narration: string;
  subtitle: string;
  /** 为什么选这张图 / 这张图里有什么。取代旧的 visualIntent（那是凭空编的）。 */
  rationale: string;
}

/** 没被选中的分镜 = 备用池，供成片阶段替补缺失素材。 */
export interface DroppedShot {
  shotId: string;
  reason: string;
}

export interface SellingPointMapEntry {
  shotId: string;
  sellingPoint: string;
}

export interface ScriptOutput {
  version: 2;
  title: string;
  /** 第五步封面使用的两段式标题；旧脚本可以没有，由成片组首次创建时确定性拆分。 */
  coverTitleParts?: { primary: string; secondary: string };
  platform: string;
  tone: string;
  targetDurationSec: number;
  template: string;
  shotSetId: string;
  sellingPointMap: SellingPointMapEntry[];
  segments: ScriptSegment[];
  droppedShots: DroppedShot[];
  /** 各 segment narration 的拼接（派生字段）。 */
  fullScript: string;
}

export interface ProviderScriptResult {
  script: ScriptOutput;
  provider: string;
  model: string;
}

// ── Provider Metadata ──

export type ApiStyle = 'native-gemini' | 'openai-compatible' | 'openai-responses';

export interface ProviderConfig {
  id: string;
  name: string;
  apiStyle: ApiStyle;
  keyEnv: string;
  baseUrlEnv: string;
  modelEnv: string;
  defaultModel: string;
  defaultBaseUrl: string;
  maxTokens: number;
}

export interface ProviderMeta {
  id: string;
  name: string;
  model: string;
  configured: boolean;
  apiStyle: ApiStyle;
  supportsVision: boolean;
  category?: 'script';
  type?: string;
  enabled?: number;
  hasApiKey?: boolean;
  missing?: string[];
  maxTokens?: number;
  visionCostPerRequest?: number;
}

// ── Provider Interface ──

export interface ScriptProvider {
  readonly config: ProviderConfig;
  isConfigured(): boolean;
  getModel(): string;
  analyzeSellingPoints(input: AnalysisInput): Promise<AnalysisResult>;
  generateScript(input: ScriptInput): Promise<ProviderScriptResult>;
}
