import type { AlignmentAdapter } from './alignment.ts';
import { speechUrl, synthesizeVapiNarration, synthesizeVapiPreview, VAPI_PREVIEW_TEXT, VAPI_VOICES } from './vapi-qwen-tts.ts';

export interface TtsAdapterInput {
  provider: { baseUrl: string; apiKey: string; model: string };
  voice: string;
  speed: number;
  segments: Array<{ segmentId: string; narration: string }>;
  outputDir: string;
  relativeOutputPath: string;
  alignment: AlignmentAdapter;
  onSegmentComplete?: (completed: number, total: number) => void;
}

export interface FinalEditTtsAdapter {
  id: string;
  type: string;
  alignmentModel?: string;
  voices: ReadonlyArray<{ id: string; label: string }>;
  defaultVoice: string;
  previewText: string;
  validateBaseUrl(value: string): string;
  synthesizePreview(input: { provider: { baseUrl: string; apiKey: string; model: string }; voice: string; speed: number; text: string; outputPath: string }): Promise<void>;
  synthesize(input: TtsAdapterInput): Promise<{ relativePath: string; absolutePath: string; durationUs: number; segmentTimings: Array<{ segmentId: string; startUs: number; endUs: number }>; wordTimings: Array<{ text: string; startUs: number; endUs: number }>; alignmentDegradedSegmentIds?: string[] }>;
  estimateCost(input: { text: string; costPerThousandCharacters: number }): number;
}

const adapters: FinalEditTtsAdapter[] = [{
  id: 'vapi-qwen3-tts',
  type: 'vapi-qwen-json-url',
  alignmentModel: 'whisper-1',
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
  estimateCost: ({ text, costPerThousandCharacters }) => Number((Array.from(text).length / 1000 * Math.max(0, costPerThousandCharacters)).toFixed(6)),
}];

export function getFinalEditTtsAdapter(id: string): FinalEditTtsAdapter {
  const adapter = adapters.find((item) => item.id === id);
  if (!adapter) throw new Error(`不支持的口播配音供应商：${id}`);
  return adapter;
}

export function listFinalEditTtsAdapters(): readonly FinalEditTtsAdapter[] {
  return adapters;
}
