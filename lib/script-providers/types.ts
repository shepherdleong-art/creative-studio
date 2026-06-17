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

export interface ShotContext {
  shotId: string;
  shotIndex: number;
  sourceFilename: string;
  description?: string;
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
  duration: string;
  shotSetId: string;
  shots: ShotContext[];
  sceneReference?: string;
  videoTemplates?: string[];
}

export interface ScriptShot {
  shotId: string;
  shotIndex: number;
  duration: string;
  voiceover: string;
  subtitle: string;
  visualIntent: string;
}

export interface SellingPointMapEntry {
  shotId: string;
  shotIndex: number;
  sellingPoint: string;
}

export interface ScriptOutput {
  title: string;
  platform: string;
  tone: string;
  duration: string;
  template: string;
  shotSetId: string;
  sellingPointMap: SellingPointMapEntry[];
  shots: ScriptShot[];
  fullScript: string;
}

export interface ProviderScriptResult {
  script: ScriptOutput;
  provider: string;
  model: string;
}

// ── Provider Metadata ──

export type ApiStyle = 'native-gemini' | 'openai-compatible';

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
  category?: 'script';
  type?: string;
  enabled?: number;
  hasApiKey?: boolean;
  missing?: string[];
  maxTokens?: number;
}

// ── Provider Interface ──

export interface ScriptProvider {
  readonly config: ProviderConfig;
  isConfigured(): boolean;
  getModel(): string;
  analyzeSellingPoints(input: AnalysisInput): Promise<AnalysisResult>;
  generateScript(input: ScriptInput): Promise<ProviderScriptResult>;
}
