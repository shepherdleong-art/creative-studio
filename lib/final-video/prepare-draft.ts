// lib/final-video/prepare-draft.ts
/**
 * 草稿准备：generate/reuse 口播节拍 → TTS 合成 → 构建素材池 → 写回草稿。
 * narration 模式产出 stage=narration-ready；bgm-only 只构建素材池，产出 stage=review。
 * 任何远程/文件错误（LLM、TTS、探测视频时长意外失败）→ stage=failed，保留已成功快照，不抛错给路由；
 * 输入/数据库形状问题（草稿不存在、口播模式缺脚本、脚本内容为空、revision 冲突）在任何写入之前
 * 就作为可辨识的 Error 抛出，交由路由映射为 404/400/409。
 */
import { getDb } from '../db.ts';
import { buildClipPool } from './clip-pool.ts';
import { generateNarrationDraftBeats } from './narration-script.ts';
import { synthesizeNarrationBeats } from './tts.ts';
import { getFinalVideoDraft, updateFinalVideoDraft } from './draft-store.ts';
import {
  parseFinalVideoWorkflowConfigJson,
  parseNarrationBeatsJson,
  type FinalVideoDraftRow,
  type NarrationBeat,
  type TimelineIssue,
} from './types.ts';

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
 * sourceText 固定读取所选 script_drafts.outputJson.fullScript；为空时按 shots[].voiceover 顺序拼接
 * （原样保留每段 voiceover，不逐条 trim，与 app/api/projects/[id]/script/route.ts 的 fullScript 兜底逻辑一致）；
 * 两者 trim 后都为空则视为“脚本内容为空”，返回 invalid_input（never 静默吞掉解析失败的 JSON —— outputJson
 * 本身格式错误时让 JSON.parse 直接抛错，交由路由回落到 500，而不是当作空脚本处理）。
 */
function resolveSourceText(scriptDraftId: string): string {
  const row = getDb()
    .prepare(`SELECT outputJson FROM script_drafts WHERE id = ?`)
    .get(scriptDraftId) as ScriptDraftOutputRow | undefined;
  if (!row) throw invalidInputError('脚本内容为空，无法生成口播');

  const parsed = JSON.parse(row.outputJson) as {
    fullScript?: unknown;
    shots?: Array<{ voiceover?: unknown }>;
  };
  const fullScript = typeof parsed.fullScript === 'string' ? parsed.fullScript.trim() : '';
  if (fullScript) return fullScript;

  const shots = Array.isArray(parsed.shots) ? parsed.shots : [];
  const fallback = shots
    .map((shot) => (shot && typeof shot.voiceover === 'string' ? shot.voiceover : ''))
    .filter(Boolean)
    .join('\n');
  if (fallback.trim()) return fallback;

  throw invalidInputError('脚本内容为空，无法生成口播');
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
  let sourceText = '';
  if (packageConfig.mode === 'narration') {
    if (initialRow.scriptDraftId === null) throw invalidInputError('口播模式必须先选择脚本草稿');
    sourceText = resolveSourceText(initialRow.scriptDraftId);
  }

  // First durable write of this request. Reuses the store's own optimistic-lock check
  // (throws the store's stale_revision-coded error on mismatch) and durably marks a
  // prepare attempt as in-flight before any remote call is made.
  const row = updateFinalVideoDraft(input.draftId, input.expectedRevision, { stage: 'preparing' });
  const currentRevision = row.revision;

  try {
    let narrationBeats: NarrationBeat[];
    let durationIssue: TimelineIssue | null = null;

    if (packageConfig.mode === 'narration') {
      const existingBeats = parseNarrationBeatsJson(row.narrationBeatsJson);
      if (existingBeats.length > 0) {
        // Same-state retry: reuse already-synthesized whole-sentence audio instead of paying for TTS again.
        narrationBeats = existingBeats;
      } else {
        const targetContentSec = Math.max(1, packageConfig.targetDurationSec - packageConfig.cover.introDurationSec);
        const draftBeats = await generateNarrationDraftBeats({
          sourceText,
          targetContentSec,
          providerId: workflowConfig.narrationScriptProviderId,
        });
        const narrationConfig = packageConfig.narration;
        narrationBeats = await synthesizeNarrationBeats({
          draftId: input.draftId,
          beats: draftBeats,
          providerId: narrationConfig.providerId,
          voice: narrationConfig.voice,
          speed: narrationConfig.speed,
          maxClipSeconds: packageConfig.maxClipSeconds,
        });
      }

      const actualTotalSec = packageConfig.cover.introDurationSec
        + narrationBeats.reduce((sum, beat) => sum + beat.durationSec, 0);
      const relativeDelta = Math.abs(actualTotalSec - packageConfig.targetDurationSec) / packageConfig.targetDurationSec;
      if (relativeDelta > packageConfig.durationTolerancePct) {
        // Warning only: never truncate audio, never fail the operation over this.
        durationIssue = {
          code: 'target_duration_out_of_tolerance',
          severity: 'warning',
          message: '成片实际时长超出目标容差',
          beatIds: [],
          clipId: null,
        };
      }
    } else {
      // bgm-only mode never reads the script and produces no narration.
      narrationBeats = [];
    }

    // Clip pool is a cheap, deterministic, zero-cost DB+ffprobe read — always rebuild it,
    // including on retries.
    const { clips, issues: clipIssues } = await buildClipPool(row.shotSetId);
    const issues = durationIssue ? [...clipIssues, durationIssue] : clipIssues;

    return updateFinalVideoDraft(input.draftId, currentRevision, {
      stage: packageConfig.mode === 'narration' ? 'narration-ready' : 'review',
      narrationBeatsJson: JSON.stringify(narrationBeats),
      clipPoolJson: JSON.stringify(clips),
      issuesJson: JSON.stringify(issues),
      // A successful (re-)prepare clears any stale failure note from an earlier attempt —
      // mirrors the failed→running recovery convention in render-queue.ts (errorMessage = NULL).
      errorMessage: null,
    });
  } catch (error) {
    // Any remote/file error → failed; re-running the same action can recover, and
    // already-successful snapshots (narrationBeatsJson etc.) are left untouched.
    try {
      return updateFinalVideoDraft(input.draftId, currentRevision, {
        stage: 'failed',
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    } catch {
      // This recovery write itself raced and lost — almost certainly stale_revision because
      // a concurrent writer (another prepare/PATCH call) already moved the draft's revision
      // past currentRevision while we were awaiting the LLM/TTS/clip-pool work above. That
      // writer's state is now the source of truth: we must not clobber it, and we must not
      // crash this request just because we lost the race to also write our own failure note.
      // Best-effort: report whatever the draft currently looks like.
      const current = getFinalVideoDraft(input.draftId);
      if (current) return current;
      throw error;
    }
  }
}
