import type Database from 'better-sqlite3';
import { deriveProjectProgress, type ProjectProgress, type ProjectProgressCounts } from './project-progress.ts';

/**
 * 项目进度的取数（06 号票）。
 *
 * 判断规则在 `project-progress.ts` 的纯函数里；这里只负责把五个「有没有产出」的
 * 数字数出来。老库/本地版可能没有 `project_scripts`、`final_edit_groups` 这些表
 * （它们是独立模块的迁移流），所以先看表在不在，缺表按 0 处理——
 * 不能因为混剪模块没启用就把首页整块打挂。
 */

function tableExists(db: Database.Database, table: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
}

export function readProjectProgressCounts(
  db: Database.Database,
  projectId: string,
): ProjectProgressCounts {
  const sceneCandidateCount = Number(db.prepare(
    `SELECT COUNT(*) FROM image_assets WHERE projectId = ? AND role = 'output' AND usage = 'scene_gen'`,
  ).pluck().get(projectId) ?? 0);
  const shotResultCount = Number(db.prepare(
    `SELECT COUNT(*) FROM shot_result_candidates c JOIN shots s ON s.id = c.shotId
      JOIN shot_sets set_ ON set_.id = s.shotSetId WHERE set_.projectId = ?`,
  ).pluck().get(projectId) ?? 0);
  const approvedShotSetCount = Number(db.prepare(
    `SELECT COUNT(*) FROM shot_sets WHERE projectId = ? AND status IN ('approved', 'video_ready')`,
  ).pluck().get(projectId) ?? 0);
  const scriptCount = tableExists(db, 'project_scripts')
    ? Number(db.prepare('SELECT COUNT(*) FROM project_scripts WHERE projectId = ?').pluck().get(projectId) ?? 0)
    : 0;
  const videoJobCount = Number(db.prepare(
    'SELECT COUNT(*) FROM video_jobs WHERE projectId = ?',
  ).pluck().get(projectId) ?? 0);
  const succeededVideoCount = Number(db.prepare(
    `SELECT COUNT(*) FROM video_jobs WHERE projectId = ? AND status = 'succeeded'`,
  ).pluck().get(projectId) ?? 0);
  const finalGroupCount = tableExists(db, 'final_edit_groups')
    ? Number(db.prepare('SELECT COUNT(*) FROM final_edit_groups WHERE projectId = ?').pluck().get(projectId) ?? 0)
    : 0;
  return {
    sceneCandidateCount,
    shotResultCount,
    approvedShotSetCount,
    scriptCount,
    videoJobCount,
    succeededVideoCount,
    finalGroupCount,
  };
}

/** 批量版本：项目列表一次查完，避免每行一次往返。 */
export function readProjectProgress(
  db: Database.Database,
  projectIds: string[],
): Map<string, ProjectProgress> {
  const result = new Map<string, ProjectProgress>();
  for (const projectId of projectIds) {
    result.set(projectId, deriveProjectProgress(readProjectProgressCounts(db, projectId)));
  }
  return result;
}
