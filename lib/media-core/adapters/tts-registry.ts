import type { AlignmentAdapter } from './alignment.ts';
import { DOUBAO_PREVIEW_TEXT, DOUBAO_VOICES, doubaoSpeechUrl, synthesizeDoubaoNarration, synthesizeDoubaoPreview, type DoubaoProviderConfig } from './doubao-tts.ts';
import { speechUrl, synthesizeVapiNarration, synthesizeVapiPreview, VAPI_PREVIEW_TEXT, VAPI_VOICES } from './vapi-qwen-tts.ts';
import type { TtsUsageContext } from '../../usage-tts.ts';

export interface TtsAdapterInput {
  provider: {
    baseUrl: string;
    apiKey: string;
    model: string;
    providerId?: string;
    providerName?: string;
    providerType?: string;
    configuredModel?: string;
    requestModel?: string;
  };
  voice: string;
  speed: number;
  segments: Array<{ segmentId: string; narration: string }>;
  outputDir: string;
  relativeOutputPath: string;
  alignment: AlignmentAdapter;
  onSegmentComplete?: (completed: number, total: number) => void;
  signal?: AbortSignal;
  usageContext?: TtsUsageContext;
}

export interface FinalEditTtsAdapter {
  id: string;
  type: string;
  alignmentModel?: string;
  providesWordTimings?: boolean;
  description: string;
  voices: ReadonlyArray<{ id: string; label: string }>;
  defaultVoice: string;
  previewText: string;
  validateBaseUrl(value: string): string;
  synthesizePreview(input: { provider: TtsAdapterInput['provider']; voice: string; speed: number; text: string; outputPath: string; signal?: AbortSignal; usageContext?: TtsUsageContext }): Promise<void>;
  synthesize(input: TtsAdapterInput): Promise<{ relativePath: string; absolutePath: string; durationUs: number; segmentTimings: Array<{ segmentId: string; startUs: number; endUs: number }>; wordTimings: Array<{ text: string; startUs: number; endUs: number }>; alignmentDegradedSegmentIds?: string[] }>;
  estimateCost(input: { text: string; costPerThousandCharacters: number }): number;
}

const estimateCharacterCost: FinalEditTtsAdapter['estimateCost'] = ({ text, costPerThousandCharacters }) => (
  Number((Array.from(text).length / 1000 * Math.max(0, costPerThousandCharacters)).toFixed(6))
);

function withDoubaoIdentity(
  provider: TtsAdapterInput['provider'],
  usageContext?: TtsUsageContext,
): DoubaoProviderConfig {
  return {
    ...provider,
    providerId: provider.providerId ?? '',
    providerName: provider.providerName ?? '',
    providerType: provider.providerType ?? '',
    configuredModel: provider.configuredModel ?? provider.model,
    requestModel: provider.requestModel ?? provider.model,
    usageContext,
  };
}

const adapters: FinalEditTtsAdapter[] = [
  {
    id: 'vapi-qwen3-tts',
    type: 'vapi-qwen-json-url',
    alignmentModel: 'whisper-1',
    description: 'Qwen3 TTS Flash · JSON 临时音频地址；语速由应用下载后本地处理。',
    voices: VAPI_VOICES,
    defaultVoice: 'Cherry',
    previewText: VAPI_PREVIEW_TEXT,
    validateBaseUrl: (value) => {
      const trimmed = value.trim().replace(/\/+$/, '');
      const parsed = new URL(trimmed);
      if (parsed.protocol !== 'https:' || (parsed.pathname !== '/' && parsed.pathname !== '/v1')) throw new Error('Base URL 必须是 HTTPS origin，可选带 /v1');
      const normalized = `${parsed.origin}${parsed.pathname === '/v1' ? '/v1' : ''}`;
      void speechUrl(normalized);
      return normalized;
    },
    synthesize: synthesizeVapiNarration,
    synthesizePreview: synthesizeVapiPreview,
    estimateCost: estimateCharacterCost,
  },
  {
    id: 'doubao-seed-tts-2',
    type: 'doubao-http-chunked',
    providesWordTimings: true,
    description: '豆包 Seed TTS 2.0 · HTTP Chunked 流式音频；语速由应用下载后本地处理。',
    voices: DOUBAO_VOICES,
    defaultVoice: 'zh_female_vv_uranus_bigtts',
    previewText: DOUBAO_PREVIEW_TEXT,
    validateBaseUrl: (value) => {
      const trimmed = value.trim().replace(/\/+$/, '');
      const parsed = new URL(trimmed);
      const endpointPath = '/api/v3/tts/unidirectional';
      if (parsed.protocol !== 'https:') throw new Error('Base URL 必须使用 HTTPS');
      if (parsed.search || parsed.hash || !['/', endpointPath].includes(parsed.pathname)) {
        throw new Error('Base URL 必须是 HTTPS origin，或完整的 /api/v3/tts/unidirectional 地址');
      }
      const normalized = parsed.pathname === endpointPath ? `${parsed.origin}${endpointPath}` : parsed.origin;
      void doubaoSpeechUrl(normalized);
      return normalized;
    },
    synthesize: (input) => synthesizeDoubaoNarration({
      ...input,
      provider: withDoubaoIdentity(input.provider, input.usageContext),
    }),
    synthesizePreview: (input) => synthesizeDoubaoPreview({
      ...input,
      provider: withDoubaoIdentity(input.provider, input.usageContext),
    }),
    estimateCost: estimateCharacterCost,
  },
];

export function getFinalEditTtsAdapter(id: string): FinalEditTtsAdapter {
  const adapter = adapters.find((item) => item.id === id);
  if (!adapter) throw new Error(`不支持的口播配音供应商：${id}`);
  return adapter;
}

export function listFinalEditTtsAdapters(): readonly FinalEditTtsAdapter[] {
  return adapters;
}
