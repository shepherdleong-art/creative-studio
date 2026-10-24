import fs from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { speechContent, type SpeechTranscriptionAdapter } from './alignment.ts';

export const VOLC_FLASH_ASR_URL = 'https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash';
export const VOLC_FLASH_ASR_RESOURCE_ID = 'volc.bigasr.auc_turbo';
/** 只有服务繁忙（55000031）或 HTTP 429/5xx 才重试；其余错误直接交给调用方。 */
const RETRY_DELAYS_MS = [1_000, 3_000, 8_000] as const;
const TIMEOUT_MS = 120_000;
/** 末字时间允许超出音频这么多（取整误差），超出更多就当作结果不可靠。 */
const END_TOLERANCE_US = 50_000;

type Environment = Readonly<Record<string, string | undefined>>;
interface VolcWord { text?: unknown; start_time?: unknown; end_time?: unknown }
interface VolcPayload { result?: { text?: unknown; utterances?: Array<{ words?: VolcWord[] }> } }

/**
 * 火山「大模型录音文件极速版识别」：一次请求返回分句和逐字时间（毫秒）。
 * 音频以 base64 放在请求体里，不需要公网地址或 COS。Key 只从环境变量读，不写进日志和错误信息。
 */
export function createVolcFlashAsrAdapter(env: Environment = process.env): SpeechTranscriptionAdapter {
  const apiKey = (env.CREATIVE_STUDIO_VOLC_ASR_API_KEY ?? '').trim();
  const url = (env.CREATIVE_STUDIO_VOLC_ASR_URL ?? '').trim() || VOLC_FLASH_ASR_URL;
  return {
    configured: Boolean(apiKey),
    identity: Object.freeze({ adapterVersion: 'volc-flash-asr/1' as const, model: VOLC_FLASH_ASR_RESOURCE_ID,
      endpointHash: createHash('sha256').update(url).digest('hex') }),
    async transcribe({ audioPath, durationUs, signal }) {
      if (!apiKey) throw new Error('火山原声识别未配置：需要 CREATIVE_STUDIO_VOLC_ASR_API_KEY');
      if (!Number.isSafeInteger(durationUs) || durationUs <= 0) throw new Error('转写需要已核验的真实音频长度');
      const timeout = AbortSignal.timeout(TIMEOUT_MS);
      const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
      const body = JSON.stringify({ user: { uid: 'creative-studio' },
        audio: { data: fs.readFileSync(audioPath).toString('base64') }, request: { model_name: 'bigmodel' } });
      let payload: VolcPayload | undefined;
      for (let attempt = 0; ; attempt += 1) {
        requestSignal.throwIfAborted();
        const response = await fetch(url, { method: 'POST', body, signal: requestSignal, headers: {
          'Content-Type': 'application/json', 'X-Api-Key': apiKey, 'X-Api-Resource-Id': VOLC_FLASH_ASR_RESOURCE_ID,
          'X-Api-Request-Id': randomUUID(), 'X-Api-Sequence': '-1' } });
        const status = response.headers.get('X-Api-Status-Code') ?? '';
        if (status === '20000000') { payload = await response.json() as VolcPayload; break; }
        await response.body?.cancel();
        const busy = status === '55000031' || response.status === 429 || response.status >= 500;
        if (!busy || attempt >= RETRY_DELAYS_MS.length) {
          const logId = response.headers.get('X-Tt-Logid');
          throw new Error(`火山原声识别失败（${status || `HTTP ${response.status}`}${logId ? `，Log ID ${logId}` : ''}）`);
        }
        await delay(RETRY_DELAYS_MS[attempt], undefined, { signal: requestSignal });
      }
      const text = typeof payload?.result?.text === 'string' ? payload.result.text.trim() : '';
      const raw = (payload?.result?.utterances ?? []).flatMap(utterance => utterance.words ?? []);
      if (!text || !raw.length) throw new Error('未取得完整台词及逐字时间，请重试或人工核对原声');
      let previousEnd = 0;
      const words = raw.map(word => {
        if (typeof word.text !== 'string' || !word.text.trim() || typeof word.start_time !== 'number' || typeof word.end_time !== 'number') {
          throw new Error('火山返回的逐字时间格式无效');
        }
        // 相邻字的时间偶尔重叠或为零长度：起点不早于上一个字的终点，终点至少比起点晚 1 毫秒。
        const startUs = Math.max(previousEnd, Math.round(word.start_time * 1_000));
        let endUs = Math.max(startUs + 1_000, Math.round(word.end_time * 1_000));
        if (endUs > durationUs) {
          if (endUs - durationUs > END_TOLERANCE_US || startUs >= durationUs) throw new Error('火山返回的逐字时间超出原片长度');
          endUs = durationUs;
        }
        previousEnd = endUs;
        return { text: word.text.trim(), startUs, endUs };
      });
      if (speechContent(text) !== speechContent(words.map(word => word.text).join(''))) {
        throw new Error('台词与逐字时间不一致，请核对原声');
      }
      return { text, words };
    },
  };
}
