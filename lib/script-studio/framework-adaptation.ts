/**
 * 框架结构适配（方案 §4.3 / A7）：
 * 知识库框架描述里的固定秒数（如「场景进入（3s）」合计 20 秒）不能与用户选择的
 * 目标时长（如 15 秒）同时作为冲突的硬要求。进入 prompt / 任务阶段快照 / 脚本内容
 * 快照 / RecommendationBlock 之前，先把框架转成与目标时长一致的相对节奏；
 * 原目录结构保留在任务冻结的知识上下文快照中供溯源，不重读当前目录。
 */

export interface AdaptedFrameworkStructure {
  /** 适配后的有效结构（不携带与目标时长冲突的固定秒数）。 */
  structure: string[];
  /** 框架末段的 CTA 结尾意图（如「理想生活 / CTA」→「理想生活」），无 CTA 段时为 null。 */
  ctaEndingScene: string | null;
  /** 适配是否改变了原结构（原样保留时为 false）。 */
  adjusted: boolean;
}

const BEAT_SECONDS_PATTERN = /[（(]\s*(\d+(?:\.\d+)?)\s*s\s*[）)]\s*$/i;

interface ParsedBeat {
  name: string;
  seconds: number | null;
}

function parseBeat(beat: string): ParsedBeat {
  const trimmed = beat.trim();
  const match = BEAT_SECONDS_PATTERN.exec(trimmed);
  if (!match) return { name: trimmed, seconds: null };
  const seconds = Number.parseFloat(match[1]!);
  return {
    name: trimmed.slice(0, match.index).trim(),
    seconds: Number.isFinite(seconds) ? seconds : null,
  };
}

/** 与目标时长一致的容差（秒）：框架秒数合计落在目标 ±1 秒内视为不冲突。 */
const DURATION_CONFLICT_TOLERANCE_SEC = 1;

export function adaptFrameworkStructureToDuration(
  structure: string[],
  targetDurationSec: number,
): AdaptedFrameworkStructure {
  const beats = structure.map((beat) => parseBeat(beat));
  const withSeconds = beats.filter((beat) => beat.seconds !== null);
  const totalSeconds = withSeconds.reduce((sum, beat) => sum + (beat.seconds ?? 0), 0);
  const conflicting = withSeconds.length > 0
    && Math.abs(totalSeconds - targetDurationSec) > DURATION_CONFLICT_TOLERANCE_SEC;
  // 末段 CTA 意图按名称识别（如「理想生活 / CTA」），秒数冲突与否不影响提取。
  const lastNamed = [...beats].reverse().find((beat) => beat.name);
  const ctaEndingScene = lastNamed && /cta/i.test(lastNamed.name)
    ? lastNamed.name.replace(/\/?\s*cta\s*$/i, '').trim() || null
    : null;
  if (!conflicting) {
    return { structure, ctaEndingScene, adjusted: false };
  }
  // 冲突时转为相对节奏：去掉每段固定秒数，末段标注结尾意图，由目标时长统一组织篇幅。
  const adapted = beats.map((beat, index) => {
    const isLast = index === beats.length - 1;
    if (isLast && ctaEndingScene) return `${beat.name}（按目标时长收尾，结尾为行动引导）`;
    return beat.name;
  }).filter(Boolean);
  return { structure: adapted, ctaEndingScene, adjusted: true };
}

/** 把方案上的知识推荐替换为适配后的有效结构；无框架或无冲突时原样返回。 */
export function adaptPlanRecommendation<P extends {
  recommendation?: {
    framework?: { id: string; stableKey: string; name: string; structure: string[]; rationale: string } | null;
    copyHook?: unknown;
    visualHook?: unknown;
  };
}>(plan: P, targetDurationSec: number): P {
  const framework = plan.recommendation?.framework;
  if (!framework || !framework.structure?.length) return plan;
  const adapted = adaptFrameworkStructureToDuration(framework.structure, targetDurationSec);
  if (!adapted.adjusted) return plan;
  return {
    ...plan,
    recommendation: {
      ...plan.recommendation!,
      framework: { ...framework, structure: adapted.structure },
    },
  };
}
