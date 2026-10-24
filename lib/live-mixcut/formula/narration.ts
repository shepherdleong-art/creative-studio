import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { dataRoot } from '../../data-root.ts';
import { assertNoStorageSymlink } from '../../media-core/storage-path.ts';
import { getFinalEditTtsAdapter } from '../../media-core/adapters/tts-registry.ts';
import { createOpenAiAlignmentAdapter, createOpenAiTranscriptionAdapter, speechContent, type AlignmentWordTiming } from '../../media-core/adapters/alignment.ts';
import { assertTtsSpeed } from '../../media-core/tts-speed.ts';
import { computeFingerprintFromBuffer } from '../fingerprint.ts';
import { BatchDomainError } from '../errors.ts';

type VoiceChoice = { providerId: string; voice: string; speed: number };
type Provider = { id: string; name: string; type: string; baseUrl: string; apiKey: string; keyEnv: string | null; model: string; enabled: number };
export interface FormulaTtsService {
  version: 'formula-tts/1';
  voice: VoiceChoice & { model: string; providerType: string; endpointHash: string };
  alignment: { configured: boolean; model: string; endpointHash: string };
}
export interface FormulaNarrationAudio {
  relativePath: string; fingerprint: string; durationUs: number; words: AlignmentWordTiming[];
  channels?: 1 | 2; timingSource?: 'manual'; externalNarrationId?: string;
}
export type FormulaNarrationResult = { executionReady: false; algorithmVersion: 'formula-narration/1'; text: string } & (
  | { status: 'ready'; audio: FormulaNarrationAudio }
  | { status: 'needs_attention'; reason: 'service_unavailable'; message: string }
  | { status: 'needs_alignment'; audio: FormulaNarrationAudio; message: string }
);

function providerContext(db: Database.Database, choice: VoiceChoice) {
  try {
  const row = db.prepare('SELECT id,name,type,baseUrl,apiKey,keyEnv,model,enabled FROM final_edit_tts_providers WHERE id=?')
    .get(choice.providerId) as Provider | undefined;
  if (!row || !row.enabled) throw new BatchDomainError('conflict', '所选配音供应商不可用，请恢复原配置或重新发起制作');
  const adapter = getFinalEditTtsAdapter(row.id);
  const apiKey = row.apiKey.trim() || (row.keyEnv ? process.env[row.keyEnv]?.trim() : '') || '';
  assertTtsSpeed(choice.speed);
  if (!apiKey || row.type !== adapter.type || !adapter.voices.some(item => item.id === choice.voice)) {
    throw new BatchDomainError('conflict', '所选配音服务或音色不可用，请恢复原配置或重新发起制作');
  }
  const baseUrl = adapter.validateBaseUrl(row.baseUrl);
  const fallback = adapter.alignmentModel ? { baseUrl, apiKey, model: adapter.alignmentModel } : undefined;
  const identity = createOpenAiTranscriptionAdapter(process.env, fallback);
  const service: FormulaTtsService = { version: 'formula-tts/1',
    voice: { ...choice, model: row.model, providerType: row.type, endpointHash: createHash('sha256').update(baseUrl).digest('hex') },
    alignment: { configured: identity.configured, model: identity.identity.model, endpointHash: identity.identity.endpointHash } };
  return { row, adapter, apiKey, baseUrl, service, alignment: createOpenAiAlignmentAdapter(process.env, fallback) };
  } catch (error) {
    if (error instanceof BatchDomainError) throw error;
    throw new BatchDomainError('conflict', '配音服务配置无效，请检查供应商设置后重试');
  }
}

/** 只保存声音身份，不保存密钥；执行时允许换密钥，不允许悄悄换模型、地址或音色。 */
export function captureFormulaTtsService(db: Database.Database, choice: VoiceChoice | null): FormulaTtsService | null {
  return choice ? providerContext(db, choice).service : null;
}

function validWords(words: AlignmentWordTiming[], text: string, durationUs: number): boolean {
  if (!Array.isArray(words) || words.some(word => !word || typeof word.text !== 'string') || !speechContent(text)
    || speechContent(words.map(word => word.text).join('')) !== speechContent(text)) return false;
  let end = 0;
  for (const word of words) {
    if (!Number.isSafeInteger(word.startUs) || !Number.isSafeInteger(word.endUs) || word.startUs < end
      || word.endUs <= word.startUs || word.endUs > durationUs) return false;
    end = word.endUs;
  }
  return true;
}

/** 48kHz PCM16，TTS 为单声道，外部配音保留单/双声道；直接按帧数计算实际时长。 */
export function inspectFormulaNarrationAudio(relativePath: string): { fingerprint: string; durationUs: number; channels: 1 | 2 } {
  const filename = assertNoStorageSymlink(path.join(dataRoot(), 'storage'), relativePath);
  const stat = fs.statSync(filename);
  if (!stat.isFile() || stat.size < 44 || stat.size > 120 * 1024 * 1024) throw new Error('invalid audio size');
  const bytes = fs.readFileSync(filename);
  if (bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') throw new Error('invalid wave');
  let formatOk = false, samples = 0, hasSignal = false, channels = 0;
  for (let cursor = 12; cursor + 8 <= bytes.length;) {
    const kind = bytes.toString('ascii', cursor, cursor + 4), length = bytes.readUInt32LE(cursor + 4), start = cursor + 8;
    if (start + length > bytes.length) throw new Error('truncated wave');
    if (kind === 'fmt ') {
      channels = length >= 16 ? bytes.readUInt16LE(start + 2) : 0;
      formatOk = length >= 16 && bytes.readUInt16LE(start) === 1 && (channels === 1 || channels === 2)
        && bytes.readUInt32LE(start + 4) === 48_000 && bytes.readUInt16LE(start + 12) === channels * 2 && bytes.readUInt16LE(start + 14) === 16;
    }
    if (kind === 'data') {
      if (length % 2) throw new Error('invalid samples');
      samples += length / 2;
      if (!hasSignal) for (let offset = start; offset < start + length; offset += 2) {
        if (bytes.readInt16LE(offset) !== 0) { hasSignal = true; break; }
      }
    }
    cursor = start + length + (length % 2);
  }
  if (!formatOk || !hasSignal || samples <= 0 || samples % channels || samples > 48_000 * channels * 600) throw new Error('invalid or silent audio');
  const after = fs.statSync(filename);
  if (stat.dev !== after.dev || stat.ino !== after.ino || stat.size !== after.size || stat.mtimeMs !== after.mtimeMs) throw new Error('audio changed while reading');
  return { fingerprint: computeFingerprintFromBuffer(bytes), durationUs: Math.round(samples * 1_000_000 / (48_000 * channels)), channels: channels as 1 | 2 };
}

const inspectAudio = inspectFormulaNarrationAudio;

/** 提交和媒体读取共用：记录、项目、声音内容及字幕必须仍对应同一文件。 */
export function assertFormulaNarrationAudio(projectId: string, text: string, audio: FormulaNarrationAudio): string {
  try {
    const prefix = `live-mixcut/narration/${createHash('sha256').update(projectId).digest('hex')}/`;
    if (!audio.relativePath.startsWith(prefix)) throw new Error('wrong project');
    const measured = inspectAudio(audio.relativePath);
    if (measured.fingerprint !== audio.fingerprint || measured.durationUs !== audio.durationUs || measured.channels !== (audio.channels ?? 1)
      || !validWords(audio.words, text, measured.durationUs)) throw new Error('audio changed');
    return assertNoStorageSymlink(path.join(dataRoot(), 'storage'), audio.relativePath);
  } catch { throw new BatchDomainError('conflict', '配音文件缺失、已变化或字幕无效，请重新生成这份配音'); }
}

export function formulaNarrationReuseKey(text: string, service: FormulaTtsService | null): string {
  return createHash('sha256').update(JSON.stringify({ version: service?.version ?? 'unconfigured', text,
    voice: service ? { providerId: service.voice.providerId, providerType: service.voice.providerType,
      model: service.voice.model, endpointHash: service.voice.endpointHash, voice: service.voice.voice, speed: service.voice.speed } : null })).digest('hex');
}

interface CachedAudio { text: string; voiceKey: string; alignment: FormulaTtsService['alignment']; audio: FormulaNarrationAudio }
function readCache(directory: string, text: string, voiceKey: string): CachedAudio | null {
  try {
    const file = assertNoStorageSymlink(path.join(dataRoot(), 'storage'), `${directory}/cache.json`);
    if (fs.statSync(file).size > 4 * 1024 * 1024) return null;
    const cached = JSON.parse(fs.readFileSync(file, 'utf8')) as CachedAudio;
    if (cached.text !== text || cached.voiceKey !== voiceKey || !cached.audio.relativePath.startsWith(`${directory}/`)) return null;
    const measured = inspectAudio(cached.audio.relativePath);
    if (measured.fingerprint !== cached.audio.fingerprint || measured.durationUs !== cached.audio.durationUs) return null;
    return cached;
  } catch { return null; }
}

function saveCache(directory: string, cached: CachedAudio): void {
  const root = path.join(dataRoot(), 'storage');
  const file = assertNoStorageSymlink(root, `${directory}/cache.json`);
  const temporary = assertNoStorageSymlink(root, `${directory}/${randomUUID()}.tmp.json`);
  fs.writeFileSync(temporary, JSON.stringify(cached));
  try { fs.renameSync(temporary, file); } finally { fs.rmSync(temporary, { force: true }); }
}

/** 只合成调用方已经分出的剩余文案；不修改脚本、原声或其他输出。 */
export async function synthesizeFormulaNarration(db: Database.Database, projectId: string,
  input: { text: string; service: FormulaTtsService | null }, signal: AbortSignal): Promise<FormulaNarrationResult> {
  signal.throwIfAborted();
  if (!db.prepare('SELECT 1 FROM projects WHERE id=?').get(projectId)) throw new BatchDomainError('not_found', '配音所属项目不存在');
  if (typeof input.text !== 'string' || !speechContent(input.text) || input.text.length > 20_000) throw new BatchDomainError('invalid_input', '配音文案为空或过长');
  const base = { executionReady: false as const, algorithmVersion: 'formula-narration/1' as const, text: input.text };
  if (!input.service) return { ...base, status: 'needs_attention', reason: 'service_unavailable', message: '本次制作未选择配音音色；请选择后重新发起制作。' };
  const service = input.service;
  const current = providerContext(db, { providerId: service.voice.providerId, voice: service.voice.voice, speed: service.voice.speed });
  if (JSON.stringify(current.service) !== JSON.stringify(service)) throw new BatchDomainError('conflict', '这次制作的配音或对齐配置已变化，请恢复原配置后重试，或重新发起制作');
  const voiceKey = formulaNarrationReuseKey(input.text, service);
  const directory = `live-mixcut/narration/${createHash('sha256').update(projectId).digest('hex')}/${voiceKey}`;
  const cached = readCache(directory, input.text, voiceKey);
  signal.throwIfAborted();
  if (cached && JSON.stringify(cached.alignment) === JSON.stringify(service.alignment)
    && validWords(cached.audio.words, input.text, cached.audio.durationUs)) return { ...base, status: 'ready', audio: cached.audio };
  const relativePath = `${directory}/${randomUUID()}/narration.wav`;
  const absolutePath = assertNoStorageSymlink(path.join(dataRoot(), 'storage'), relativePath);
  const timeout = new AbortController(), timer = setTimeout(() => timeout.abort(), 300_000);
  const taskSignal = AbortSignal.any([signal, timeout.signal]);
  try {
    if (cached) {
      let words: AlignmentWordTiming[] = [];
      if (current.alignment.configured) {
        try {
          const candidate = await current.alignment.align({ audioPath: assertNoStorageSymlink(path.join(dataRoot(), 'storage'), cached.audio.relativePath),
            text: input.text, signal: taskSignal });
          if (validWords(candidate, input.text, cached.audio.durationUs)) words = candidate;
        } catch { taskSignal.throwIfAborted(); }
      }
      taskSignal.throwIfAborted();
      if (inspectAudio(cached.audio.relativePath).fingerprint !== cached.audio.fingerprint) throw new Error('audio changed during alignment');
      const audio = { ...cached.audio, words };
      saveCache(directory, { text: input.text, voiceKey, alignment: service.alignment, audio });
      return words.length ? { ...base, status: 'ready', audio } : { ...base, status: 'needs_alignment', audio,
        message: '配音声音已保存，但未取得可靠字幕时间；重试对齐后才能继续排片。' };
    }
    const result = await current.adapter.synthesize({
      provider: { baseUrl: current.baseUrl, apiKey: current.apiKey, model: service.voice.model, providerId: current.row.id,
        providerName: current.row.name, providerType: current.row.type, configuredModel: service.voice.model, requestModel: service.voice.model },
      voice: service.voice.voice, speed: service.voice.speed, segments: [{ segmentId: 'narration', narration: input.text }],
      outputDir: path.dirname(absolutePath), relativeOutputPath: relativePath, alignment: current.alignment, signal: taskSignal,
      usageContext: { projectId, refType: 'formula-narration', refId: path.basename(path.dirname(absolutePath)) },
    });
    taskSignal.throwIfAborted();
    if (path.resolve(result.absolutePath) !== absolutePath || result.relativePath !== relativePath) throw new Error('invalid output path');
    const measured = inspectAudio(relativePath);
    const aligned = !result.alignmentDegradedSegmentIds?.length && validWords(result.wordTimings, input.text, measured.durationUs);
    const audio = { relativePath, ...measured, words: aligned ? result.wordTimings : [] };
    saveCache(directory, { text: input.text, voiceKey, alignment: service.alignment, audio });
    return aligned ? { ...base, status: 'ready', audio } : { ...base, status: 'needs_alignment', audio,
      message: '配音声音已保存，但未取得可靠字幕时间；重试对齐后才能继续排片。' };
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof BatchDomainError) throw error;
    throw new BatchDomainError('conflict', timeout.signal.aborted ? '配音处理超时，请重试' : '配音处理失败，请检查服务后重试');
  } finally { clearTimeout(timer); }
}
