import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { dataRoot } from '../../data-root.ts';
import { runFfmpeg } from '../../ffmpeg.ts';
import { assertNoStorageSymlink } from '../../media-core/storage-path.ts';
import type { SpeechTranscription, SpeechTranscriptionAdapter } from '../../media-core/adapters/alignment.ts';
import { resolveSourceFilePath } from '../media-catalog.ts';
import { verifyFormulaCandidate, recheckFormulaCandidate, type FormulaCandidateSource } from './candidate-media.ts';
import { parseFormulaManualSpeech, type FormulaSavedManualSpeech } from './manual-speech.ts';

type SourceIdentity = {
  algorithmVersion: 'formula-source-speech/1'; executionReady: false;
  assetId: string; contentFingerprint: string;
  reusedFromStageId?: string;
  manualVerification?: { revisionId: string; verifiedAt: string; timing: 'manual_segments' };
};
export type FormulaSourceSpeech = SourceIdentity & (
  | { status: 'transcribed'; sourceId: string; mediaDurationUs: number; reviewStatus: 'pending'; text: string; words: SpeechTranscription['words'];
      audioStreamIndex: 0; transcriptionIdentity: SpeechTranscriptionAdapter['identity'] | null }
  | { status: 'no_audio_stream'; sourceId: string; mediaDurationUs: number }
  | { status: 'no_speech'; sourceId: string; mediaDurationUs: number }
  | { status: 'needs_attention'; reason: 'source_unavailable' | 'service_unavailable' | 'source_too_long' | 'transcription_failed' | 'manual_invalid'; message: string }
);

/** 后台声音阶段的原片核验入口；返回识别依据，不生成/批准逐输出声音计划。 */
export async function analyzeFormulaSourceSpeech(db: Database.Database, projectId: string, input: {
  assetId: string; contentFingerprint: string; sources: FormulaCandidateSource[]; manualSpeech?: FormulaSavedManualSpeech | null;
}, service: SpeechTranscriptionAdapter | (() => SpeechTranscriptionAdapter), signal: AbortSignal): Promise<FormulaSourceSpeech> {
  signal.throwIfAborted();
  const identity: SourceIdentity = { algorithmVersion: 'formula-source-speech/1', executionReady: false,
    assetId: input.assetId, contentFingerprint: input.contentFingerprint };
  const candidate = await verifyFormulaCandidate(db, projectId, input.assetId, input.contentFingerprint, input.sources, signal);
  if (!candidate) return { ...identity, status: 'needs_attention', reason: 'source_unavailable', message: '原片无法核验，请检查文件是否缺失或已变化。' };
  const mediaDurationUs = candidate.media.durationUs;
  if (input.manualSpeech) {
    const manual = input.manualSpeech;
    try {
      if (manual.formatVersion !== 1 || manual.origin !== 'manual' || manual.assetId !== input.assetId
        || manual.contentFingerprint !== input.contentFingerprint || manual.mediaDurationUs !== mediaDurationUs
        || !manual.id || manual.mode === 'automatic' || (manual.mode === 'speech' && !candidate.media.hasAudio)) throw new Error('manual identity');
      const parsed = parseFormulaManualSpeech(manual.mode, manual.segments, mediaDurationUs);
      const verified = { ...identity, sourceId: candidate.sourceId, mediaDurationUs,
        manualVerification: { revisionId: manual.id, verifiedAt: manual.createdAt, timing: 'manual_segments' as const } };
      if (parsed.mode === 'no_speech') return { ...verified, status: 'no_speech' };
      return { ...verified, status: 'transcribed', reviewStatus: 'pending', audioStreamIndex: 0,
        text: parsed.segments.map(segment => segment.text).join(''), words: parsed.segments, transcriptionIdentity: null };
    } catch {
      return { ...identity, status: 'needs_attention', reason: 'manual_invalid', message: '人工台词或时间与本次原片不一致，请修改输入并重新核对。' };
    }
  }
  if (candidate.media.hasAudio === false) return { ...identity, status: 'no_audio_stream', sourceId: candidate.sourceId, mediaDurationUs };
  const adapter = typeof service === 'function' ? service() : service;
  if (!adapter.configured) return { ...identity, status: 'needs_attention', reason: 'service_unavailable', message: '本次制作未配置原声转写服务，原片台词无法自动核对；请在检查成片时人工核对，或配置识别服务后重新生成。' };
  // 16kHz 单声道 PCM 十分钟约 19.2MB，避免把整段超长视频无界载入转写服务。
  if (mediaDurationUs > 600_000_000) return { ...identity, status: 'needs_attention', reason: 'source_too_long', message: '原片超过十分钟，请拆分素材或人工核对台词和区间。' };
  const storageRoot = path.join(dataRoot(), 'storage');
  const parent = assertNoStorageSymlink(storageRoot, 'live-mixcut/speech-temp');
  fs.mkdirSync(parent, { recursive: true });
  const directory = fs.mkdtempSync(path.join(parent, 'source-'));
  const relative = path.relative(storageRoot, path.join(directory, 'source.wav'));
  const audioPath = assertNoStorageSymlink(storageRoot, relative);
  try {
    // 保留音轨相对视频起点的延迟。补齐仅用于识别坐标，不是成片的静音占位素材。
    await runFfmpeg(['-i', resolveSourceFilePath(candidate.location), '-map', '0:a:0', '-vn',
      '-af', 'aresample=16000:async=1:first_pts=0,apad', '-t', String(mediaDurationUs / 1_000_000),
      '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', '-y', audioPath], { timeoutMs: 90_000, signal });
    signal.throwIfAborted();
    recheckFormulaCandidate(db, projectId, candidate);
    let transcript: SpeechTranscription;
    try { transcript = await adapter.transcribe({ audioPath, durationUs: mediaDurationUs, signal }); }
    catch {
      signal.throwIfAborted();
      return { ...identity, status: 'needs_attention', reason: 'transcription_failed', message: '未取得可靠的台词及时间，请重试；不能据此认定没有人声，请在检查成片时人工核对。' };
    }
    signal.throwIfAborted();
    recheckFormulaCandidate(db, projectId, candidate);
    return { ...identity, status: 'transcribed', sourceId: candidate.sourceId, mediaDurationUs,
      reviewStatus: 'pending', text: transcript.text, words: transcript.words,
      audioStreamIndex: 0, transcriptionIdentity: { ...adapter.identity } };
  } finally {
    // 只删除本次创建的单个临时文件和空目录，不递归清理调用方目录。
    assertNoStorageSymlink(storageRoot, relative);
    fs.rmSync(audioPath, { force: true });
    fs.rmdirSync(directory);
  }
}
