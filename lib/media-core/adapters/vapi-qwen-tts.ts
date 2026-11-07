import fs from 'node:fs';
import path from 'node:path';
import { runFfmpeg, probeDurationSec } from '../../ffmpeg.ts';
import { assertTtsSpeed } from '../tts-speed.ts';
import type { AlignmentAdapter, AlignmentWordTiming } from './alignment.ts';
import {
  alignOrProportionallyTime,
  concatWavFiles,
  isReusableNarrationChunk,
  readCachedSegmentAlignment,
  splitTtsInput,
  writeCachedSegmentAlignment,
} from './tts-common.ts';
import {
  executeSyncOperation,
  registerSyncOperationContinuation,
  transmitSyncOperation,
  type SyncOperationContext,
  type SyncOperationTransport,
} from '../execution/sync-operation.ts';
import { getExecutionModuleRuntime } from '../execution/module-runtime.ts';
import { getDb } from '../../db.ts';
import type { TtsUsageContext } from '../../usage-tts.ts';
import { withMediaResource } from '../media-resource-gate.ts';

export { isReusableNarrationChunk, proportionalWordTimings } from './tts-common.ts';

export const VAPI_PREVIEW_TEXT = '你好，我是林视创作台语音助手，这是当前音色和语速的试听效果。';

export const VAPI_VOICES = [
  { id: 'Cherry', label: '芊悦' }, { id: 'Ethan', label: '晨煦' },
  { id: 'Nofish', label: '不吃鱼' }, { id: 'Jennifer', label: '詹妮弗' },
  { id: 'Ryan', label: '甜茶' }, { id: 'Katerina', label: '卡捷琳娜' },
  { id: 'Elias', label: '墨讲师' }, { id: 'Jada', label: '上海-阿珍' },
  { id: 'Dylan', label: '北京-晓东' }, { id: 'Sunny', label: '四川-晴儿' },
  { id: 'li', label: '南京-老李' }, { id: 'Marcus', label: '陕西-秦川' },
  { id: 'Roy', label: '闽南-阿杰' }, { id: 'Peter', label: '天津-李彼得' },
  { id: 'Rocky', label: '粤语-阿强' }, { id: 'Kiki', label: '粤语-阿清' },
  { id: 'Eric', label: '四川-程川' },
] as const;

export function speechUrl(baseUrl: string): string {
  const base = baseUrl.trim().replace(/\/+$/, '');
  return /\/v1$/i.test(base) ? `${base}/audio/speech` : `${base}/v1/audio/speech`;
}

export function validateVapiAudioUrl(raw: string): URL {
  const url = new URL(raw);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('TTS 音频 URL 协议不安全');
  const host = url.hostname.toLowerCase();
  if (!/(^|\.)oss-[a-z0-9-]+\.aliyuncs\.com$/.test(host)) {
    throw new Error('TTS 音频 URL 主机不在允许的阿里云 OSS 范围');
  }
  if (url.protocol === 'http:') url.protocol = 'https:';
  return url;
}

interface VapiProviderConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  providerId?: string;
  providerName?: string;
  providerType?: string;
  configuredModel?: string;
  requestModel?: string;
}

interface SynthesisInput {
  provider: VapiProviderConfig;
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

class VapiResponseError extends Error {}

async function requestVapiGeneration(
  config: VapiProviderConfig,
  voice: string,
  input: string,
  destination: string,
  signal?: AbortSignal,
): Promise<{ audioUrl?: string }> {
  const response = await fetch(speechUrl(config.baseUrl), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
    body: JSON.stringify({ model: config.model, input, voice }),
    signal,
  });
  const raw = await response.text();
  let payload: { output?: { audio?: { data?: string; url?: string } }; error?: { message?: string } } = {};
  try { payload = JSON.parse(raw) as typeof payload; } catch { /* handled below */ }
  if (!response.ok) throw new VapiResponseError(`V-API TTS ${response.status}: ${(payload.error?.message || raw).slice(0, 300)}`);
  const audio = payload.output?.audio;
  if (audio?.data) {
    fs.writeFileSync(destination, Buffer.from(audio.data, 'base64'));
    return {};
  }
  if (!audio?.url) throw new VapiResponseError('V-API TTS 响应缺少 output.audio.url/data');
  return { audioUrl: audio.url };
}

async function downloadVapiAudio(audioUrl: string, destination: string, signal?: AbortSignal): Promise<void> {
  const audioResponse = await fetch(validateVapiAudioUrl(audioUrl), { signal });
  if (!audioResponse.ok) throw new Error(`下载 V-API TTS 音频失败：HTTP ${audioResponse.status}`);
  fs.writeFileSync(destination, Buffer.from(await audioResponse.arrayBuffer()));
}

type VapiOperationSnapshot = {
  provider: Omit<VapiProviderConfig, 'apiKey'>;
  voice: string;
  text: string;
  destination: string;
};

const VAPI_CONTINUATION_KEY = 'media-core.tts.vapi.v1';

function vapiSnapshot(config: VapiProviderConfig, voice: string, text: string, destination: string): VapiOperationSnapshot {
  return {
    provider: {
      providerId: config.providerId,
      providerName: config.providerName,
      providerType: config.providerType,
      configuredModel: config.configuredModel,
      requestModel: config.requestModel,
      baseUrl: config.baseUrl,
      model: config.model,
    },
    voice,
    text,
    destination,
  };
}

function resolveVapiProvider(snapshot: VapiOperationSnapshot): VapiProviderConfig {
  const providerId = snapshot.provider.providerId;
  if (!providerId) throw new Error('V-API 持久操作缺少供应商身份');
  const row = getDb().prepare('SELECT apiKey, keyEnv FROM final_edit_tts_providers WHERE id = ?').get(providerId) as {
    apiKey: string; keyEnv: string;
  } | undefined;
  const apiKey = row?.apiKey.trim() || (row?.keyEnv ? (process.env[row.keyEnv] || '').trim() : '');
  if (!apiKey) throw new Error('V-API 持久操作的供应商凭据不可用');
  return { ...snapshot.provider, apiKey };
}

async function executeVapiOperation(
  transport: SyncOperationTransport,
  snapshot: VapiOperationSnapshot,
  liveConfig?: VapiProviderConfig,
  signal?: AbortSignal,
): Promise<{ audioUrl?: string }> {
  const config = liveConfig ?? resolveVapiProvider(snapshot);
  return transmitSyncOperation(transport, {
    requestSnapshot: snapshot,
    send: async () => {
      try {
        const value = await requestVapiGeneration(config, snapshot.voice, snapshot.text, snapshot.destination, signal);
        return { value, terminalState: 'succeeded' as const, result: value, actualCost: null };
      } catch (error) {
        if (error instanceof VapiResponseError) {
          return { terminalState: 'failed' as const, errorCode: 'vapi_response_failed', actualCost: null };
        }
        throw error;
      }
    },
  });
}

registerSyncOperationContinuation(VAPI_CONTINUATION_KEY, async (transport, rawSnapshot) => {
  await executeVapiOperation(transport, rawSnapshot as VapiOperationSnapshot);
});

export async function requestVapiAudio(
  config: VapiProviderConfig,
  voice: string,
  input: string,
  destination: string,
  signal?: AbortSignal,
  execution?: SyncOperationContext,
): Promise<void> {
  if (!getExecutionModuleRuntime()) {
    const generated = await requestVapiGeneration(config, voice, input, destination, signal);
    if (generated.audioUrl) await downloadVapiAudio(generated.audioUrl, destination, signal);
    return;
  }
  if (!execution) throw new Error('server V-API TTS 调用缺少稳定 segment/chunk 执行上下文');
  const snapshot = vapiSnapshot(config, voice, input, destination);
  const generated = await executeSyncOperation({
    context: { ...execution, module: 'tts', requiredPools: execution.requiredPools ?? ['tts:remote'] },
    inputSnapshot: snapshot,
    continuationKey: VAPI_CONTINUATION_KEY,
    providerSnapshot: snapshot.provider,
    configVersion: `${config.baseUrl}:${config.model}`,
    credentialVersionRef: config.providerId,
    quote: { kind: 'unpriced', pricingSnapshot: null },
    replay: (result) => {
      const value = result as { audioUrl?: string };
      if (!value.audioUrl && (!fs.existsSync(destination) || fs.statSync(destination).size === 0)) {
        throw new Error('V-API 已完成回执对应的音频缺失，请核查产物');
      }
      return value;
    },
    execute: (transport) => executeVapiOperation(transport, snapshot, config, signal),
  });
  if (generated.audioUrl) await downloadVapiAudio(generated.audioUrl, destination, signal);
}

function narrationExecution(input: SynthesisInput, segmentId: string, chunkIndex: number): SyncOperationContext {
  const taskId = input.usageContext?.refId ?? input.relativeOutputPath;
  const rawAttempt = input.usageContext?.detail?.attempt;
  const attemptNumber = typeof rawAttempt === 'number' && Number.isSafeInteger(rawAttempt) && rawAttempt > 0 ? rawAttempt : 1;
  const attemptId = `${taskId}:attempt:${attemptNumber}`;
  return {
    taskId,
    step: `segment:${segmentId}:chunk:${chunkIndex}:request:1`,
    inputRevision: attemptId,
    businessAttempt: { id: attemptId, number: attemptNumber },
    scope: {
      resourceType: input.usageContext?.projectId ? 'project' : 'narration',
      resourceId: input.usageContext?.projectId ?? taskId,
    },
  };
}

export async function synthesizeVapiNarration(input: SynthesisInput) {
  if (!VAPI_VOICES.some((voice) => voice.id === input.voice)) throw new Error('不支持的 V-API 音色');
  assertTtsSpeed(input.speed);
  fs.mkdirSync(input.outputDir, { recursive: true });
  const segmentFiles: string[] = [];
  const segmentTimings: Array<{ segmentId: string; startUs: number; endUs: number }> = [];
  const wordTimings: AlignmentWordTiming[] = [];
  const alignmentDegradedSegmentIds: string[] = [];
  let cursorUs = 0;

  for (let segmentIndex = 0; segmentIndex < input.segments.length; segmentIndex += 1) {
    const segment = input.segments[segmentIndex];
    const chunkFiles: string[] = [];
    const chunks = splitTtsInput(segment.narration);
    for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex += 1) {
      const rawPath = path.join(input.outputDir, `segment-${segmentIndex}-${chunkIndex}-raw.wav`);
      const normalizedPath = path.join(input.outputDir, `segment-${segmentIndex}-${chunkIndex}.wav`);
      const reusableChunk = await isReusableNarrationChunk(normalizedPath);
      if (!reusableChunk) {
        await requestVapiAudio(input.provider, input.voice, chunks[chunkIndex], rawPath, input.signal, narrationExecution(input, segment.segmentId, chunkIndex));
        const filters = input.speed === 1 ? ['aresample=48000'] : [`atempo=${input.speed.toFixed(2)}`, 'aresample=48000'];
        const temporaryPath = `${normalizedPath}.${process.pid}-${Date.now()}.tmp.wav`;
        try {
          await withMediaResource({ taskId: normalizedPath, step: 'tts-normalize', wait: false, signal: input.signal }, () => runFfmpeg(['-i', rawPath, '-vn', '-af', filters.join(','), '-ar', '48000', '-ac', '1', '-c:a', 'pcm_s16le', '-y', temporaryPath], { timeoutMs: 180_000, signal: input.signal }));
          if (!await isReusableNarrationChunk(temporaryPath)) throw new Error('TTS 分段音频标准化后不可读取');
          fs.rmSync(normalizedPath, { force: true });
          fs.renameSync(temporaryPath, normalizedPath);
        } finally {
          fs.rmSync(temporaryPath, { force: true });
        }
      }
      chunkFiles.push(normalizedPath);
    }
    const segmentPath = path.join(input.outputDir, `segment-${segmentIndex}.wav`);
    await concatWavFiles(chunkFiles, segmentPath, input.signal);
    const durationUs = Math.round(await probeDurationSec(segmentPath) * 1_000_000);
    const alignmentCachePath = `${segmentPath}.alignment.json`;
    const cachedAlignment = readCachedSegmentAlignment(alignmentCachePath, durationUs);
    const aligned = cachedAlignment ?? await alignOrProportionallyTime({
      alignment: input.alignment,
      audioPath: segmentPath,
      narration: segment.narration,
      durationUs,
      segmentId: segment.segmentId,
      signal: input.signal,
      execution: {
        ...narrationExecution(input, segment.segmentId, 0),
        step: `segment:${segment.segmentId}:alignment`,
      },
    });
    if (!aligned.degraded && !cachedAlignment) writeCachedSegmentAlignment(alignmentCachePath, { durationUs, words: aligned.words });
    if (aligned.degraded) alignmentDegradedSegmentIds.push(segment.segmentId);
    wordTimings.push(...aligned.words.map((word) => ({ ...word, startUs: word.startUs + cursorUs, endUs: word.endUs + cursorUs })));
    segmentTimings.push({ segmentId: segment.segmentId, startUs: cursorUs, endUs: cursorUs + durationUs });
    cursorUs += durationUs;
    segmentFiles.push(segmentPath);
    input.onSegmentComplete?.(segmentIndex + 1, input.segments.length);
  }

  const outputPath = path.join(input.outputDir, 'narration.wav');
  await concatWavFiles(segmentFiles, outputPath, input.signal);
  return { relativePath: input.relativeOutputPath, absolutePath: outputPath, durationUs: cursorUs, segmentTimings, wordTimings, alignmentDegradedSegmentIds };
}

export async function synthesizeVapiPreview(input: { provider: VapiProviderConfig; voice: string; speed: number; text: string; outputPath: string; signal?: AbortSignal; execution?: SyncOperationContext }): Promise<void> {
  if (!VAPI_VOICES.some((voice) => voice.id === input.voice)) throw new Error('不支持的 V-API 音色');
  assertTtsSpeed(input.speed);
  fs.mkdirSync(path.dirname(input.outputPath), { recursive: true });
  const rawPath = `${input.outputPath}.raw.wav`;
  await requestVapiAudio(input.provider, input.voice, input.text, rawPath, input.signal, input.execution);
  const filters = input.speed === 1 ? ['aresample=48000'] : [`atempo=${input.speed.toFixed(2)}`, 'aresample=48000'];
  await withMediaResource({ taskId: input.outputPath, step: 'tts-preview-normalize', wait: false, signal: input.signal }, () => runFfmpeg(['-i', rawPath, '-vn', '-af', filters.join(','), '-ar', '48000', '-ac', '1', '-c:a', 'pcm_s16le', '-y', input.outputPath], { timeoutMs: 180_000, signal: input.signal }));
  fs.rmSync(rawPath, { force: true });
}
