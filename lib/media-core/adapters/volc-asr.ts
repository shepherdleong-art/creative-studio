import fs from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { speechContent, type SpeechTranscriptionAdapter } from './alignment.ts';
import { SpeechTranscriptionError } from './speech-errors.ts';

export const VOLC_FLASH_ASR_URL = 'https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash';
/**
 * 火山同一个 Key 下可能只授权了部分资源，Resource-Id 必须与实际开通的一致，
 * 否则返回 45000030「requested resource not granted」。
 * 默认用 SeedASR（实测可用）；不同账号可在设置页或环境变量改。
 */
export const VOLC_FLASH_ASR_RESOURCE_ID = 'volc.seedasr.auc';
export const VOLC_FLASH_ASR_RESOURCE_ID_ENV = 'CREATIVE_STUDIO_VOLC_ASR_RESOURCE_ID';
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
  const resourceId = (env[VOLC_FLASH_ASR_RESOURCE_ID_ENV] ?? '').trim() || VOLC_FLASH_ASR_RESOURCE_ID;
  return {
    configured: Boolean(apiKey),
    identity: Object.freeze({ adapterVersion: 'volc-flash-asr/1' as const, model: resourceId,
      endpointHash: createHash('sha256').update(url).digest('hex') }),
    async transcribe({ audioPath, durationUs, signal }) {
      if (!apiKey) throw new Error('火山原声识别未配置：需要 CREATIVE_STUDIO_VOLC_ASR_API_KEY');
      if (!Number.isSafeInteger(durationUs) || durationUs <= 0) throw new Error('转写需要已核验的真实音频长度');
      const timeout = AbortSignal.timeout(TIMEOUT_MS);
      const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
      const body = JSON.stringify({ user: { uid: 'creative-studio' },
        audio: { data: fs.readFileSync(audioPath).toString('base64') }, request: { model_name: 'bigmodel', show_utterances: true } });
      let payload: VolcPayload | undefined;
      for (let attempt = 0; ; attempt += 1) {
        requestSignal.throwIfAborted();
        const response = await fetch(url, { method: 'POST', body, signal: requestSignal, headers: {
          'Content-Type': 'application/json', 'X-Api-Key': apiKey, 'X-Api-Resource-Id': resourceId,
          'X-Api-Request-Id': randomUUID(), 'X-Api-Sequence': '-1' } });
        const status = response.headers.get('X-Api-Status-Code') ?? '';
        if (status === '20000000') { payload = await response.json() as VolcPayload; break; }
        await response.body?.cancel();
        // 官方终态：静音音频 / 未检测到人声。与成功但缺少文本、鉴权失败严格区分。
        if (response.ok && status === '20000003') {
          return { text: '', words: [], noSpeech: { provider: 'volc', statusCode: '20000003' } };
        }
        const busy = status === '55000031' || response.status === 429 || response.status >= 500;
        if (!busy || attempt >= RETRY_DELAYS_MS.length) {
          // 只输出已知类别，不把上游任意响应头（可能含鉴权信息）展示给用户。
          // 45000030 是「这个 Key 没开通该 Resource-Id」，光看状态码会误判成 Key 失效，
          // 用固定提示说明资源未授权，避免误导用户更换有效的 Key。
          const hint = status === '45000030'
            ? `：当前 Key 未开通 Resource-Id「${resourceId}」，请在火山智能语音控制台开通该服务，或改填已授权的 Resource-Id`
            : status === '45000010' ? '：Key 无效，请检查是否填了语音服务（而非方舟）的凭证' : '';
          const code = /^\d{8}$/.test(status ?? '') ? status : `HTTP ${response.status}`;
          throw new SpeechTranscriptionError(`火山原声识别失败（${code}）${hint || (busy ? '：服务繁忙或限流，请稍后重试。' : '：请检查语音服务配置后重试。')}`);
        }
        await delay(RETRY_DELAYS_MS[attempt], undefined, { signal: requestSignal });
      }
      const text = typeof payload?.result?.text === 'string' ? payload.result.text.trim() : '';
      // SeedASR 在中英文之间可能返回 {text:' ',start_time:-1,end_time:-1}。
      // 空白不是发音单元；仅过滤空白，台词及数字的缺失时间仍须拒绝。
      const raw = (payload?.result?.utterances ?? []).flatMap(utterance => utterance.words ?? [])
        .filter(word => typeof word?.text !== 'string' || Boolean(word.text.trim()));
      if (!text || !raw.length) throw new SpeechTranscriptionError('识别服务未返回完整台词及逐字时间，请重试；空结果不能直接认定为没有人声。');
      let previousEnd = 0;
      const words = raw.map(word => {
        if (!word || typeof word.text !== 'string' || !word.text.trim() || typeof word.start_time !== 'number' || typeof word.end_time !== 'number'
          || !Number.isFinite(word.start_time) || !Number.isFinite(word.end_time) || word.start_time < 0 || word.end_time < word.start_time) {
          throw new SpeechTranscriptionError('火山返回的台词时间格式无效，请重试识别。');
        }
        // 相邻字的时间偶尔重叠或为零长度：起点不早于上一个字的终点，终点至少比起点晚 1 毫秒。
        const startUs = Math.max(previousEnd, Math.round(word.start_time * 1_000));
        let endUs = Math.max(startUs + 1_000, Math.round(word.end_time * 1_000));
        if (endUs > durationUs) {
          if (endUs - durationUs > END_TOLERANCE_US || startUs >= durationUs) throw new SpeechTranscriptionError('火山返回的逐字时间超出原片长度，请重试识别。');
          endUs = durationUs;
        }
        previousEnd = endUs;
        return { text: word.text.trim(), startUs, endUs };
      });
      if (speechContent(text) !== speechContent(words.map(word => word.text).join(''))) {
        throw new SpeechTranscriptionError('识别文本与逐字时间对应的台词不一致，请重试识别。');
      }
      return { text, words };
    },
  };
}
