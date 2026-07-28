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

export interface ScriptStrategyAnalysisV3 {
  version: 3;
  rankings: Array<{
    sellingPointId: string;
    rank: number;
    title: string;
    priority: 'highest' | 'high' | 'medium' | 'low';
    reason: string;
    factors: {
      audienceFit: number;
      platformFit: number;
      sellingPointStrength: number;
    };
  }>;
  audienceInsight: string;
  platformAdvice: string;
  recommendedTemplate: {
    id: string;
    name: string;
    reason: string;
  };
  recommendationSource: 'model' | 'system_fallback';
}

// ── Script Generation ──

export interface SelectedSellingPoint {
  sellingPointId?: string;
  title: string;
  priority: string;
  reason: string;
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

export interface ScriptSegmentV3 {
  id: string;
  narration: string;
  subtitle: string;
  sellingPointIdRefs?: string[];
  sellingPointRefs: string[];
  visualIntent: string;
  visualKeywords: string[];
}

export interface ScriptSellingPointUsageV3 {
  sellingPointId: string;
  title: string;
  status: 'used' | 'omitted_no_visual_support';
  reason: string;
}

export interface ScriptOutputV3 {
  version: 3;
  title: string;
  coverTitleParts: {
    primary: string;
    secondary: string;
    source: 'model' | 'system_split';
  };
  platform: string;
  tone: string;
  templateId: string;
  template: string;
  shotSetId: string;
  targetDurationSec: number;
  targetNarrationDurationSec: number;
  contentCharacterCount: number;
  estimatedNarrationDurationSec: number;
  durationStatus: 'qualified';
  durationPolicyVersion: 'zh-tts-budget-v1';
  /** New V3 drafts include one entry per selected selling point; historical V3 drafts may omit it. */
  sellingPointUsage?: ScriptSellingPointUsageV3[];
  segments: ScriptSegmentV3[];
  fullScript: string;
  fullSubtitle: string;
}

export type StoredScriptOutput = ScriptOutput | ScriptOutputV3;

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
