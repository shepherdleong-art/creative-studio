import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { dataRoot } from '../data-root.ts';
import { probeDurationSec } from '../ffmpeg.ts';
import { createOpenAiAlignmentAdapter } from '../final-edit/adapters/alignment.ts';
import {
  getFinalEditTtsAdapter,
  type TtsAdapterInput,
} from '../final-edit/adapters/tts-registry.ts';
import { assertNoStorageSymlink } from '../final-edit/storage-path.ts';
import { computeFingerprintFromFile } from './fingerprint.ts';
import {
  buildBatchNarrationSegments,
  createLocalNarrationSnapshot,
} from './narration.ts';
import type { BatchTaskExecutor } from './executors.ts';

export const BATCH_NARRATION_ADAPTER_VERSION = 'batch-narration-v1';

interface TtsProviderRow {
  baseUrl: string;
  apiKey: string;
  keyEnv: string;
  model: string;
  enabled: number;
}

export interface BatchNarrationSynthesisResult {
  relativePath: string;
  absolutePath: string;
  durationUs: number;
  segmentTimings: Array<{ segmentId: string; startUs: number; endUs: number }>;
}

export interface BatchNarrationExecutorOptions {
  storageRoot?: string;
  /** 测试用:替换真实 TTS 适配器调用。 */
  synthesize?: (providerId: string, input: TtsAdapterInput) => Promise<BatchNarrationSynthesisResult>;
}

function parseNarrationConfig(raw: string | null | undefined): { providerId?: string; voice?: string; speed?: number } {
  if (!raw) return {};
  try {
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    const record = value as Record<string, unknown>;
    return {
      providerId: typeof record.providerId === 'string' ? record.providerId : undefined,
      voice: typeof record.voice === 'string' ? record.voice : undefined,
      speed: typeof record.speed === 'number' && Number.isFinite(record.speed) ? record.speed : undefined,
    };
  } catch {
    return {};
  }
}

function resolveProviderApiKey(provider: Pick<TtsProviderRow, 'apiKey' | 'keyEnv'>): string {
  return provider.apiKey.trim() || (provider.keyEnv ? (process.env[provider.keyEnv] || '').trim() : '');
}

/**
 * 解析一份脚本快照的配音配置。未显式设置时取第一个已启用 TTS 供应商的
 * 默认音色与 1.0 语速——保证任意脚本都有确定性的默认口播配置。
 */
function resolveBatchNarrationConfig(
  db: Database.Database,
  configJson: string,
): { providerId: string; voice: string; speed: number; row: TtsProviderRow } {
  const config = parseNarrationConfig(configJson);
  let providerId = config.providerId ?? '';
  if (!providerId) {
    const first = db.prepare(`
      SELECT id FROM final_edit_tts_providers WHERE enabled = 1 ORDER BY isBuiltin DESC, name, id LIMIT 1
    `).get() as { id: string } | undefined;
    providerId = first?.id ?? '';
  }
  if (!providerId) throw new Error('尚未启用任何口播配音供应商，请在设置中配置');
  const row = db.prepare(`
    SELECT baseUrl, apiKey, keyEnv, model, enabled FROM final_edit_tts_providers WHERE id = ?
  `).get(providerId) as TtsProviderRow | undefined;
  if (!row || row.enabled !== 1) throw new Error('口播配音供应商已停用');
  if (!resolveProviderApiKey(row)) throw new Error('口播配音供应商 API Key 未配置');
  const adapter = getFinalEditTtsAdapter(providerId);
  const voice = config.voice ?? adapter.defaultVoice;
  const speed = Math.max(0.5, Math.min(2, config.speed ?? 1));
  return { providerId, voice, speed, row };
}

/** 同一脚本快照的复用键:正文 + 服务商 + 音色 + 语速 四者一致才共用一条配音。 */
function narrationReuseKey(input: {
  scriptSnapshotId: string;
  bodyText: string;
  providerId: string;
  voice: string;
  speed: number;
}): string {
  return createHash('sha256')
    .update(JSON.stringify({
      scriptSnapshotId: input.scriptSnapshotId,
      bodyText: input.bodyText,
      providerId: input.providerId,
      voice: input.voice,
      speed: input.speed,
      adapterVersion: BATCH_NARRATION_ADAPTER_VERSION,
    }))
    .digest('hex')
    .slice(0, 32);
}

/** 复用既有音频时按脚本句段顺序分配等长时间,保证对齐身份合法。 */
function proportionalTimings(
  segments: Array<{ segmentId: string }>,
  durationUs: number,
): Array<{ segmentId: string; startUs: number; endUs: number }> {
  if (durationUs <= 0) throw new Error('口播音频时长无效');
  const perSegmentUs = Math.floor(durationUs / segments.length);
  return segments.map((segment, index) => {
    const startUs = index * perSegmentUs;
    const endUs = index === segments.length - 1 ? durationUs : startUs + perSegmentUs;
    return { segmentId: segment.segmentId, startUs, endUs };
  });
}

/**
 * 口播执行器(narration):目标是一份冻结的脚本快照,同脚本的 N 条成片
 * 共用同一条配音。产物写入 batch_script_narrations 权威表,并把当前
 * 成片版本的 arrangement.narration 就地升级为 productionReady 快照,
 * 渲染与导出闸门随之打开。复用键范围内音频已存在时直接复用,不重复调用 TTS。
 */
export function createBatchNarrationExecutor(options: BatchNarrationExecutorOptions = {}): BatchTaskExecutor {
  const storageRoot = path.resolve(options.storageRoot ?? path.join(dataRoot(), 'storage'));
  const synthesize = options.synthesize ?? (async (providerId: string, input: TtsAdapterInput) => (
    getFinalEditTtsAdapter(providerId).synthesize(input)
  ));
  return {
    workTypes: ['narration'],
    async execute(context) {
      const { db, claim, signal } = context;
      if (claim.task.targetKind !== 'script_snapshot') throw new Error('口播任务的目标必须是脚本快照');
      const snapshot = db.prepare(`
        SELECT s.id, s.batchVersionId, s.bodyText, s.narrationConfigJson
        FROM batch_script_snapshots s
        JOIN batch_production_versions v ON v.id = s.batchVersionId
        WHERE s.id = ? AND v.batchId = ?
      `).get(claim.task.targetId, claim.task.batchId) as {
        id: string;
        batchVersionId: string;
        bodyText: string;
        narrationConfigJson: string;
      } | undefined;
      if (!snapshot) throw new Error('口播任务的目标脚本快照不存在');
      if (signal.aborted) throw new Error('任务已中止');
      context.reportProgress({ phase: 'locating', description: '读取冻结脚本与配音配置', percent: null });
      const { providerId, voice, speed, row } = resolveBatchNarrationConfig(db, snapshot.narrationConfigJson);
      const segments = buildBatchNarrationSegments(snapshot.id, snapshot.bodyText);
      const reuseKey = narrationReuseKey({
        scriptSnapshotId: snapshot.id,
        bodyText: snapshot.bodyText,
        providerId,
        voice,
        speed,
      });
      const relativeOutputPath = path.join('batch-narration', reuseKey, 'narration.wav');
      const outputDir = path.join(storageRoot, 'batch-narration', reuseKey);
      const absolutePath = path.join(outputDir, 'narration.wav');
      assertNoStorageSymlink(storageRoot, relativeOutputPath);
      let audioFingerprint: string;
      let durationUs: number;
      let segmentTimings: Array<{ segmentId: string; startUs: number; endUs: number }>;
      if (fs.existsSync(absolutePath)) {
        const stat = fs.lstatSync(absolutePath);
        if (stat.isSymbolicLink() || !stat.isFile() || stat.size <= 0) throw new Error('口播缓存文件无效，请重试');
        context.reportProgress({ phase: 'running', description: '复用既有口播音频', percent: null });
        audioFingerprint = await computeFingerprintFromFile(absolutePath);
        durationUs = Math.round((await probeDurationSec(absolutePath)) * 1_000_000);
        segmentTimings = proportionalTimings(segments, durationUs);
      } else {
        context.reportProgress({
          phase: 'content_analyzing',
          description: `生成口播（${segments.length} 句 · ${voice}）`,
          percent: null,
        });
        const adapter = getFinalEditTtsAdapter(providerId);
        const alignment = createOpenAiAlignmentAdapter(
          process.env,
          adapter.alignmentModel
            ? { baseUrl: row.baseUrl, apiKey: resolveProviderApiKey(row), model: adapter.alignmentModel }
            : undefined,
        );
        const synthesized = await synthesize(providerId, {
          provider: { baseUrl: row.baseUrl, apiKey: resolveProviderApiKey(row), model: row.model },
          voice,
          speed,
          segments,
          outputDir,
          relativeOutputPath,
          alignment,
        });
        if (signal.aborted) throw new Error('任务已中止');
        if (!fs.existsSync(synthesized.absolutePath)) throw new Error('口播合成没有产出音频文件');
        const stat = fs.lstatSync(synthesized.absolutePath);
        if (stat.isSymbolicLink() || !stat.isFile() || stat.size <= 0) throw new Error('口播音频文件无效');
        audioFingerprint = await computeFingerprintFromFile(synthesized.absolutePath);
        durationUs = synthesized.durationUs;
        segmentTimings = synthesized.segmentTimings;
      }
      const narrationSnapshot = createLocalNarrationSnapshot({
        scriptSnapshotId: snapshot.id,
        bodyText: snapshot.bodyText,
        artifact: {
          audioRelativePath: relativeOutputPath,
          audioFingerprint,
          durationUs,
          segmentTimings: segmentTimings.map((timing) => ({
            sourceSegmentId: timing.segmentId,
            startUs: timing.startUs,
            endUs: timing.endUs,
          })),
        },
      });
      const snapshotJson = JSON.stringify(narrationSnapshot);
      context.reportProgress({ phase: 'verified', description: '口播核验完成，正在发布', percent: null });
      return {
        resultJson: {
          scriptSnapshotId: snapshot.id,
          audioRelativePath: narrationSnapshot.audioRelativePath,
          audioFingerprint: narrationSnapshot.audioFingerprint,
          durationUs: narrationSnapshot.durationUs,
          segmentCount: narrationSnapshot.segments.length,
        },
        commit: () => {
          if (signal.aborted) throw new Error('任务已中止');
          const now = new Date().toISOString();
          // 权威表:新分配的候选版本与重试渲染都能回落到这条已核验配音。
          db.prepare(`
            INSERT INTO batch_script_narrations
              (scriptSnapshotId, batchVersionId, narrationJson, audioRelativePath, audioFingerprint, createdAt, updatedAt)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(scriptSnapshotId) DO UPDATE SET
              narrationJson = excluded.narrationJson,
              audioRelativePath = excluded.audioRelativePath,
              audioFingerprint = excluded.audioFingerprint,
              updatedAt = excluded.updatedAt
          `).run(
            snapshot.id,
            snapshot.batchVersionId,
            snapshotJson,
            narrationSnapshot.audioRelativePath,
            narrationSnapshot.audioFingerprint,
            now,
            now,
          );
          // 当前成片版本的 arrangement 就地升级,渲染与工作区聚合直接读到真实口播。
          db.prepare(`
            UPDATE batch_output_versions
            SET arrangementJson = json_set(arrangementJson, '$.narration', json(?))
            WHERE id IN (
              SELECT o.id
              FROM batch_output_versions o
              JOIN batch_output_plans p ON p.id = o.planId
              WHERE p.scriptSnapshotId = ? AND p.batchVersionId = ?
            )
          `).run(snapshotJson, snapshot.id, snapshot.batchVersionId);
          return {
            resultJson: {
              scriptSnapshotId: snapshot.id,
              audioRelativePath: narrationSnapshot.audioRelativePath,
              audioFingerprint: narrationSnapshot.audioFingerprint,
              durationUs: narrationSnapshot.durationUs,
              segmentCount: narrationSnapshot.segments.length,
            },
            progress: {
              phase: 'ready',
              description: `口播就绪（${narrationSnapshot.segments.length} 句 · ${voice}）`,
              percent: 1,
            },
          };
        },
      };
    },
  };
}

export const batchNarrationExecutor = createBatchNarrationExecutor();
