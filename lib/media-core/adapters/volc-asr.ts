import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import type Database from 'better-sqlite3';
import { getDb } from '../../db.ts';
import { getExecutionModuleRuntime } from '../execution/module-runtime.ts';
import {
  executeSyncOperation, MediaExecutionFailedError, registerSyncOperationContinuation, transmitSyncOperation,
  type SyncOperationOutcome, type SyncOperationTransport,
} from '../execution/sync-operation.ts';
import { speechContent, type SpeechTranscription, type SpeechTranscriptionAdapter } from './alignment.ts';

const URL = 'https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash';
const DEFAULT_RESOURCE = 'volc.seedasr.auc';
const CONTINUATION = 'media:volc-asr:1';
const RETRY_DELAYS_MS = [1_000, 3_000, 8_000] as const;
const END_TOLERANCE_US = 50_000;

type Environment = Readonly<Record<string, string | undefined>>;
type KeySource = 'asr' | 'doubao-voice';
type Failure = { message: string; retryable?: boolean };
type Outcome = SyncOperationOutcome<SpeechTranscription | Failure>;
type Snapshot = {
  audioPath: string;
  audioHash: string;
  durationUs: number;
  resourceId: string;
  keySource: KeySource;
};
type VolcWord = { text?: unknown; start_time?: unknown; end_time?: unknown };
type VolcPayload = { result?: { text?: unknown; utterances?: Array<{ text?: unknown; words?: VolcWord[] }> } };

function keyFor(env: Environment, source: KeySource, db?: Database.Database): string {
  if (source === 'asr') return env.CREATIVE_STUDIO_VOLC_ASR_API_KEY?.trim() ?? '';
  const row = db?.prepare("SELECT apiKey, keyEnv FROM final_edit_tts_providers WHERE id='doubao-seed-tts-2'").get() as {
    apiKey: string; keyEnv: string;
  } | undefined;
  return row?.apiKey.trim() || env[row?.keyEnv || 'DOUBAO_TTS_API_KEY']?.trim() || '';
}

function parseWords(payload: VolcPayload, durationUs: number): SpeechTranscription {
  const text = typeof payload.result?.text === 'string' ? payload.result.text.trim() : '';
  const raw = (payload.result?.utterances ?? []).flatMap((utterance) => {
    const suffix = typeof utterance.text === 'string' ? utterance.text.trim().match(/[。！？.!?]+$/)?.[0] : undefined;
    const words = utterance.words ?? [];
    return words.map((word, index) => {
      if (index !== words.length - 1 || !suffix || typeof word.text !== 'string' || /[。！？.!?]$/.test(word.text.trim())) return word;
      return { ...word, text: word.text.trim() + suffix };
    });
  });
  if (!/[\p{L}\p{N}]/u.test(text) || !raw.length) throw new Error('豆包 ASR 没有返回正文和逐字时间');
  let previousEnd = 0;
  const words = raw.map((word) => {
    if (typeof word.text !== 'string' || !word.text.trim()
      || typeof word.start_time !== 'number' || typeof word.end_time !== 'number'
      || !Number.isFinite(word.start_time) || !Number.isFinite(word.end_time)
      || word.start_time < 0 || word.end_time < word.start_time) {
      throw new Error('豆包 ASR 返回的逐字时间格式无效');
    }
    const startUs = Math.max(previousEnd, Math.round(word.start_time * 1000));
    const endUs = Math.max(startUs + 1000, Math.round(word.end_time * 1000));
    if (startUs >= durationUs || endUs - durationUs > END_TOLERANCE_US) throw new Error('豆包 ASR 返回的逐字时间超出正文长度');
    previousEnd = Math.min(endUs, durationUs);
    return { text: word.text.trim(), startUs, endUs: previousEnd };
  });
  if (speechContent(text) !== speechContent(words.map((word) => word.text).join(''))) {
    throw new Error('豆包 ASR 的正文与逐字时间不一致');
  }
  return { text, words };
}

function completed(value: SpeechTranscription): Outcome {
  return { terminalState: 'succeeded', value, result: value };
}

async function requestAsr(snapshot: Snapshot, audio: Buffer, apiKey: string, signal: AbortSignal): Promise<Outcome> {
  const response = await fetch(URL, {
    method: 'POST',
    redirect: 'error',
    headers: {
      'Content-Type': 'application/json',
      'X-Api-Key': apiKey,
      'X-Api-Resource-Id': snapshot.resourceId,
      'X-Api-Request-Id': randomUUID(),
      'X-Api-Sequence': '-1',
    },
    body: JSON.stringify({
      user: { uid: 'creative-studio' },
      audio: { data: audio.toString('base64') },
      request: { model_name: 'bigmodel', show_utterances: true },
    }),
    signal,
  });
  const status = response.headers.get('X-Api-Status-Code') ?? '';
  if (response.ok && status === '20000000') {
    try {
      return completed(parseWords(await response.json() as VolcPayload, snapshot.durationUs));
    } catch (error) {
      const message = error instanceof SyntaxError ? '豆包 ASR 没有返回有效 JSON' : (error as Error).message;
      return { terminalState: 'failed', value: { message }, errorCode: 'volc_asr_invalid_result' };
    }
  }
  await response.body?.cancel();
  if (status === '20000003') return completed({ text: '', words: [], noSpeech: { provider: 'volc', statusCode: '20000003' } });
  const code = /^\d{8}$/.test(status) ? status : `HTTP ${response.status}`;
  const message = status === '45000030'
    ? `当前豆包语音 Key 未开通 ASR 资源 ${snapshot.resourceId}（${code}）`
    : `豆包 ASR 请求失败（${code}）`;
  return {
    terminalState: 'failed',
    value: { message, retryable: status === '55000031' || response.status === 429 },
    errorCode: 'volc_asr_failed',
  };
}

function hash(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

function transmitAsr(
  transport: SyncOperationTransport, snapshot: Snapshot, audio: Buffer, apiKey: string, signal: AbortSignal,
) {
  return transmitSyncOperation(transport, {
    requestSnapshot: snapshot,
    send: () => requestAsr(snapshot, audio, apiKey, signal),
  });
}

registerSyncOperationContinuation(CONTINUATION, async (transport, input) => {
  const snapshot = input as Snapshot;
  const apiKey = keyFor(process.env, snapshot.keySource, snapshot.keySource === 'doubao-voice' ? getDb() : undefined);
  if (!apiKey) throw new Error('豆包 ASR 的凭据不可用');
  const audio = await fs.readFile(snapshot.audioPath);
  if (hash(audio) !== snapshot.audioHash) throw new Error('转录音频已变化，不能沿用原任务');
  await transmitAsr(transport, snapshot, audio, apiKey, AbortSignal.timeout(120_000));
});

/** 豆包录音文件识别。单独配置的识别 Key 优先，其次复用现有豆包语音 Key。 */
export function createVolcFlashAsrAdapter(env: Environment = process.env, db?: Database.Database): SpeechTranscriptionAdapter {
  const keySource = keyFor(env, 'asr') ? 'asr' : 'doubao-voice';
  const apiKey = keyFor(env, keySource, db);
  const resourceId = env.CREATIVE_STUDIO_VOLC_ASR_RESOURCE_ID?.trim() || DEFAULT_RESOURCE;
  return {
    configured: Boolean(apiKey),
    identity: Object.freeze({ adapterVersion: 'volc-flash-asr/1', model: resourceId, endpointHash: hash(URL) }),
    async transcribe({ audioPath, durationUs, execution, signal }) {
      if (!apiKey) throw new Error('尚未配置豆包语音 Key');
      if (!Number.isSafeInteger(durationUs) || durationUs <= 0) throw new Error('转写需要已核验的真实音频长度');
      const audio = await fs.readFile(audioPath);
      const audioHash = hash(audio);
      const snapshot: Snapshot = { audioPath, audioHash, durationUs, resourceId, keySource };
      const timeout = AbortSignal.timeout(120_000);
      const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
      const runtime = getExecutionModuleRuntime();
      for (let attempt = 0; ; attempt += 1) {
        requestSignal.throwIfAborted();
        let result: SpeechTranscription | Failure;
        if (runtime) {
          try {
            result = await executeSyncOperation<SpeechTranscription | Failure>({
              context: {
                ...execution,
                module: 'alignment',
                taskId: execution?.taskId ?? `volc-asr:${audioHash}`,
                step: `${execution?.step ?? 'transcription'}:volc:${attempt + 1}`,
                scope: execution?.scope ?? { resourceType: 'narration', resourceId: audioHash },
                inputRevision: hash(JSON.stringify([execution?.inputRevision, audioHash, durationUs, resourceId, hash(apiKey)])),
                requiredPools: execution?.requiredPools ?? ['tts:remote'],
              },
              inputSnapshot: snapshot, providerSnapshot: { resourceId, keySource },
              continuationKey: CONTINUATION, configVersion: resourceId,
              quote: { kind: 'unpriced', pricingSnapshot: null },
              replay: (value) => value as SpeechTranscription,
              execute: (transport) => transmitAsr(transport, snapshot, audio, apiKey, requestSignal),
            });
          } catch (error) {
            if (!(error instanceof MediaExecutionFailedError) || !error.details) throw error;
            result = error.details as Failure;
          }
        } else {
          const reply = await requestAsr(snapshot, audio, apiKey, requestSignal);
          result = reply.value!;
        }
        if ('words' in result) return result;
        if (!result.retryable || attempt >= RETRY_DELAYS_MS.length) throw new Error(result.message);
        await delay(RETRY_DELAYS_MS[attempt], undefined, { signal: requestSignal });
      }
    },
  };
}
