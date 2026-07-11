import { completeJson } from '../script-providers/index';
import { buildFallbackArrangement, validateArrangement } from './arrangement';
import type { ArrangementPlan, ClipPoolItem, NarrationBeat, TimelineIssue } from './types';

type JsonObject = Record<string, unknown>;

function object(value: unknown, field: string): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${field} 必须是对象`);
  return value as JsonObject;
}

function string(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new Error(`${field} 必须是字符串`);
  return value;
}

function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${field} 必须是数组`);
  return value.map((item, index) => string(item, `${field}[${index}]`));
}

/** Discard all model-controlled fields except the arrangement contract itself. */
function parseModelPlan(value: unknown): ArrangementPlan {
  const response = object(value, 'AI 编排响应');
  if (!Array.isArray(response.assignments) || !Array.isArray(response.gaps)) {
    throw new Error('AI 编排响应必须包含 assignments 和 gaps 数组');
  }

  return {
    assignments: response.assignments.map((raw, index) => {
      const assignment = object(raw, `assignments[${index}]`);
      return {
        assignmentId: `llm-${index}`,
        clipId: string(assignment.clipId, `assignments[${index}].clipId`),
        beatIds: stringArray(assignment.beatIds, `assignments[${index}].beatIds`),
      };
    }),
    gaps: response.gaps.map((raw, index) => {
      const gap = object(raw, `gaps[${index}]`);
      return {
        beatId: string(gap.beatId, `gaps[${index}].beatId`),
        reason: string(gap.reason, `gaps[${index}].reason`),
      };
    }),
  };
}

function fallbackIssue(message: string, beats: NarrationBeat[]): TimelineIssue {
  return {
    code: 'arrangement_fallback_used',
    severity: 'warning',
    message,
    beatIds: beats.map(({ beatId }) => beatId),
    clipId: null,
  };
}

function arrangementPrompt(beats: NarrationBeat[], clips: ClipPoolItem[]): string {
  const promptBeats = beats.map(({ beatId, text, durationSec }) => ({ beatId, text, durationSec }));
  const promptClips = clips.map(({ clipId, visualDescription, shotIndex }) => ({ clipId, visualDescription, shotIndex }));
  return `为电商口播编排画面。每个 beat 必须且只能出现在一个 assignment 或一个 gap 中。assignment 内的 beat 必须连续、升序；一个 clip 只能使用一次。没有合适画面时放入 gaps，并给出简短原因。不要输出任何秒数计算或文件路径。\n\n只返回 JSON：\n{ "assignments": [{ "clipId": "...", "beatIds": ["..."] }], "gaps": [{ "beatId": "...", "reason": "..." }] }\n\n口播节拍：\n${JSON.stringify(promptBeats)}\n\n已描述候选画面：\n${JSON.stringify(promptClips)}`;
}

export async function buildArrangement(input: {
  beats: NarrationBeat[];
  clips: ClipPoolItem[];
  maxClipSeconds: number;
  providerId: string;
}): Promise<{ plan: ArrangementPlan; issues: TimelineIssue[] }> {
  const describedClips = input.clips.filter((clip) => typeof clip.visualDescription === 'string' && clip.visualDescription.trim());
  const fallback = (issues: TimelineIssue[], message: string) => ({
    plan: buildFallbackArrangement(input.beats, input.clips, input.maxClipSeconds),
    issues: [...issues, fallbackIssue(message, input.beats)],
  });

  if (describedClips.length === 0) {
    return fallback([], '没有可用于 AI 编排的已描述素材，已使用确定性兜底');
  }

  try {
    const raw = await completeJson<unknown>({
      providerId: input.providerId,
      systemPrompt: 'You arrange visuals for narration. Return valid JSON only, without markdown fences or commentary.',
      userPrompt: arrangementPrompt(input.beats, describedClips),
      temperature: 0.2,
    });
    const candidate = parseModelPlan(raw);
    const validated = validateArrangement(candidate, input.beats, describedClips, input.maxClipSeconds);
    if (validated.ok) return { plan: validated.plan, issues: [] };
    return fallback(validated.issues, 'AI 编排结果无效，已使用确定性兜底');
  } catch {
    return fallback([], 'AI 编排调用失败，已使用确定性兜底');
  }
}
