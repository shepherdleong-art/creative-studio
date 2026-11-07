/**
 * 项目的「做到第几步」（06 号票，员工首页「接着做」用）。
 *
 * 首页要写「第 3 步 脚本」，就必须有可断言的来源。这里把判断抽成纯函数，
 * SQL 只负责数数——页面和测试用同一份规则，不在组件里另编一套。
 *
 * 步骤口径沿用五步工作台：场景图 → 分镜 → 脚本 → 视频 → 混剪。
 * 只看「有没有产出」，不看状态字符串，避免把 `running` 当成已完成。
 */

export interface ProjectProgressCounts {
  /** `role='output' AND usage='scene_gen'` 的场景候选数。 */
  sceneCandidateCount: number;
  /** 分镜结果候选数（`shot_result_candidates`）。 */
  shotResultCount: number;
  /** 已通过/已出视频的分镜组数。 */
  approvedShotSetCount: number;
  /** 项目脚本数（`project_scripts`；老库没有该表时传 0）。 */
  scriptCount: number;
  videoJobCount: number;
  succeededVideoCount: number;
  /** 混剪组数（`final_edit_groups`；表不存在时传 0）。 */
  finalGroupCount: number;
}

export interface ProjectProgress {
  /** 1–5，对应五个步骤。 */
  step: 1 | 2 | 3 | 4 | 5;
  label: string;
  /** 这一步是不是「还没开始」——首页据此写空状态与下一步。 */
  empty: boolean;
}

export const WORKBENCH_STEP_LABELS = ['场景图', '分镜', '脚本', '视频', '混剪'] as const;

export function deriveProjectProgress(counts: ProjectProgressCounts): ProjectProgress {
  const step = pickStep(counts);
  const label = WORKBENCH_STEP_LABELS[step - 1];
  return {
    step,
    label,
    empty: isStepEmpty(step, counts),
  };
}

function pickStep(counts: ProjectProgressCounts): ProjectProgress['step'] {
  if (counts.sceneCandidateCount <= 0) return 1;
  if (counts.shotResultCount <= 0 && counts.approvedShotSetCount <= 0) return 2;
  if (counts.scriptCount <= 0) return 3;
  if (counts.succeededVideoCount <= 0) return 4;
  return 5;
}

function isStepEmpty(step: ProjectProgress['step'], counts: ProjectProgressCounts): boolean {
  switch (step) {
    case 1: return counts.sceneCandidateCount <= 0;
    case 2: return counts.shotResultCount <= 0 && counts.approvedShotSetCount <= 0;
    case 3: return counts.scriptCount <= 0;
    case 4: return counts.succeededVideoCount <= 0;
    case 5: return counts.finalGroupCount <= 0;
  }
}

/** 首页空状态那一句话：告诉用户下一步该做什么，而不是只说「暂无」。 */
export function nextActionForProgress(progress: ProjectProgress): string {
  switch (progress.step) {
    case 1: return '先上传一张原始场景图，生成场景候选。';
    case 2: return '场景图有了，去第 2 步整理原始分镜并批量生成。';
    case 3: return '分镜图有了，去第 3 步生成口播脚本。';
    case 4: return '脚本有了，去第 4 步给分镜生成视频。';
    case 5: return '视频有了，去第 5 步剪成成片并导出。';
  }
}
