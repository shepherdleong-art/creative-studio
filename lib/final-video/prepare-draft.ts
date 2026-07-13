// lib/final-video/prepare-draft.ts
/**
 * 草稿准备：读脚本计划 → 生成/复用口播节拍 → TTS 合成 → 构建素材池 → 按计划编排 → 写回草稿。
 * narration 与 bgm-only 两种模式都止步于 stage=review（不再有 narration-ready/describing/arranging 中间态）。
 * 任何远程/文件错误（TTS、探测视频时长意外失败）→ stage=failed，保留已成功快照，不抛错给路由；
 * 输入/数据库形状问题（草稿不存在、口播模式缺脚本、脚本内容为空、revision 冲突）在任何写入之前
 * 就作为可辨识的 Error 抛出，交由路由映射为 404/400/409。
 */
import { getDb } from '../db.ts';
import { buildClipPool } from './clip-pool.ts';
import { parseScriptPlan } from './script-plan.ts';
import { buildPlanArrangement } from './build-arrangement.ts';
import { synthesizeNarrationBeats } from './tts.ts';
import { getFinalVideoDraft, updateFinalVideoDraft } from './draft-store.ts';
import {
  parseFinalVideoWorkflowConfigJson,
  parseNarrationBeatsJson,
  type FinalVideoDraftRow,
  type NarrationBeat,
  type NarrationDraftBeat,
  type TimelineIssue,
} from './types.ts';
import type { ScriptPlan } from './script-plan.ts';

interface ScriptDraftOutputRow {
  outputJson: string;
}

function notFoundError(): Error & { code: string } {
  return Object.assign(new Error('成片草稿不存在'), { code: 'not_found' });
}

function invalidInputError(message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code: 'invalid_input' });
}

/**
 * 读所选脚本草稿的计划。v2 直接读 segments；旧草稿走形状适配（见 script-plan.ts）。
 * outputJson 本身是坏 JSON 时让 JSON.parse 抛错（路由回落 500），绝不当作空脚本吞掉。
 */
function resolveScriptPlan(scriptDraftId: string): ScriptPlan {
  const row = getDb()
    .prepare(`SELECT outputJson FROM script_drafts WHERE id = ?`)
    .get(scriptDraftId) as ScriptDraftOutputRow | undefined;
  if (!row) throw invalidInputError('脚本内容为空，无法生成口播');
  return parseScriptPlan(row.outputJson);
}

export async function prepareFinalVideoDraft(input: {
  draftId: string;
  expectedRevision: number;
}): Promise<FinalVideoDraftRow> {
  const initialRow = getFinalVideoDraft(input.draftId);
  if (!initialRow) throw notFoundError();

  const workflowConfig = parseFinalVideoWorkflowConfigJson(initialRow.workflowConfigJson);
  const packageConfig = workflowConfig.packageConfig;

  // Input validation happens before any DB write: a bad request must never bump
  // stage/revision, so the draft is left exactly as the client last saw it.
  let scriptPlan: ScriptPlan | null = null;
  if (packageConfig.mode === 'narration') {
    if (initialRow.scriptDraftId === null) throw invalidInputError('口播模式必须先选择脚本草稿');
    scriptPlan = resolveScriptPlan(initialRow.scriptDraftId);
  }

  const row = updateFinalVideoDraft(input.draftId, input.expectedRevision, { stage: 'preparing' });
  const currentRevision = row.revision;

  try {
    let narrationBeats: NarrationBeat[] = [];
    const issues: TimelineIssue[] = [];

    if (packageConfig.mode === 'narration' && scriptPlan) {
      const existingBeats = parseNarrationBeatsJson(row.narrationBeatsJson);
      if (existingBeats.length > 0) {
        // Same-state retry: reuse already-synthesized audio instead of paying for TTS again.
        narrationBeats = existingBeats;
      } else {
        // 一句 = 一个 beat。不再调 LLM 重新切句 —— 脚本已经一句一图分好了。
        const draftBeats: NarrationDraftBeat[] = scriptPlan.segments.map((segment, index) => ({
          beatId: `beat-${index}`,
          index,
          text: segment.narration,
          subtitleText: segment.subtitle,
          shotId: segment.shotId,
          imageAssetId: segment.imageAssetId,
        }));
        const narrationConfig = packageConfig.narration;
        narrationBeats = await synthesizeNarrationBeats({
          draftId: input.draftId,
          beats: draftBeats,
          providerId: narrationConfig.providerId,
          voice: narrationConfig.voice,
          speed: narrationConfig.speed,
        });
      }

      const actualTotalSec = packageConfig.cover.introDurationSec
        + narrationBeats.reduce((sum, beat) => sum + beat.durationSec, 0);
      const relativeDelta = Math.abs(actualTotalSec - packageConfig.targetDurationSec) / packageConfig.targetDurationSec;
      if (relativeDelta > packageConfig.durationTolerancePct) {
        // Warning only: never truncate audio, never fail the operation over this.
        issues.push({
          code: 'target_duration_out_of_tolerance',
          severity: 'warning',
          message: '成片实际时长超出目标容差',
          beatIds: [],
          clipId: null,
        });
      }
    }

    // Clip pool is a cheap, deterministic, zero-cost DB+ffprobe read — always rebuild it.
    const { clips, issues: clipIssues } = await buildClipPool(row.shotSetId);
    issues.push(...clipIssues);

    // 编排是确定性的：脚本已经决定了顺序，这里只做「计划 vs 现实」的对账。
    let arrangementJson = row.arrangementJson;
    if (packageConfig.mode === 'narration' && scriptPlan) {
      const { plan, issues: planIssues } = buildPlanArrangement({
        beats: narrationBeats,
        clips,
        droppedShotIds: scriptPlan.droppedShotIds,
      });
      arrangementJson = JSON.stringify(plan);
      issues.push(...planIssues);
    }

    return updateFinalVideoDraft(input.draftId, currentRevision, {
      // 编排已在此处完成，不再有 narration-ready / describing / arranging 三个中间态。
      stage: 'review',
      narrationBeatsJson: JSON.stringify(narrationBeats),
      clipPoolJson: JSON.stringify(clips),
      arrangementJson,
      issuesJson: JSON.stringify(issues),
      errorMessage: null,
    });
  } catch (error) {
    try {
      return updateFinalVideoDraft(input.draftId, currentRevision, {
        stage: 'failed',
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    } catch {
      // This recovery write itself raced and lost — a concurrent writer already moved the
      // draft's revision past currentRevision. That writer's state is now the source of
      // truth: don't clobber it, and don't crash just because we lost the race.
      const current = getFinalVideoDraft(input.draftId);
      if (current) return current;
      throw error;
    }
  }
}
