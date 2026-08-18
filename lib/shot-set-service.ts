import type Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import {
  FREE_SHOT_SET_NAME,
  isShotSetKind,
  normalizeShotImageIds,
  type ShotSetKind,
} from './shot-set-domain.ts';

export type ShotSetServiceFailure = { ok: false; status: 400 | 404 | 409; error: string };

function asText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** 校验一批图片全部属于该项目。这是唯一挡住跨项目图片的关卡。 */
function allImagesBelongToProject(
  db: Database.Database,
  projectId: string,
  imageIds: string[],
): boolean {
  if (imageIds.length === 0) return true;
  const placeholders = imageIds.map(() => '?').join(',');
  const row = db.prepare(
    `SELECT COUNT(*) as cnt FROM image_assets WHERE id IN (${placeholders}) AND projectId = ?`,
  ).get(...imageIds, projectId) as { cnt: number };
  return row.cnt === imageIds.length;
}

function insertShots(db: Database.Database, shotSetId: string, imageIds: string[], startIndex: number): void {
  const insert = db.prepare(`
    INSERT INTO shots (id, shotSetId, indexNum, sourceImageId) VALUES (?, ?, ?, ?)
  `);
  imageIds.forEach((imageId, offset) => {
    insert.run(uuidv4(), shotSetId, startIndex + offset, imageId);
  });
}

/* ────────────────────────── 建组 ────────────────────────── */

export type CreateShotSetResult =
  | { ok: true; id: string; name: string; kind: ShotSetKind }
  | ShotSetServiceFailure;

export interface CreateShotSetInput {
  projectId: string;
  name: unknown;
  shotImageIds: unknown;
  kind?: unknown;
  productCode?: unknown;
  category?: unknown;
}

export function createShotSet(
  db: Database.Database,
  input: CreateShotSetInput,
): CreateShotSetResult {
  // 非法 kind 必须显式报错,不能静默降级成 storyboard —— 静默降级会让调用方
  // 以为建了自由工位,实际建出一个会出现在第 2 步的普通组。
  let kind: ShotSetKind = 'storyboard';
  if (input.kind !== undefined && input.kind !== null) {
    if (!isShotSetKind(input.kind)) {
      return { ok: false, status: 400, error: `非法的 kind 值：${String(input.kind)}` };
    }
    kind = input.kind;
  }

  const name = asText(input.name).trim() || (kind === 'free' ? FREE_SHOT_SET_NAME : '');
  if (!name) return { ok: false, status: 400, error: '名称不能为空' };

  const normalized = normalizeShotImageIds(input.shotImageIds, {
    // 自由工位可以先建空的,之后一张张追加(D15);普通组必须至少 1 张。
    allowEmpty: kind === 'free',
    max: kind === 'free' ? null : undefined,
  });
  if (!normalized.ok) return { ok: false, status: 400, error: normalized.error };
  const shotImageIds = normalized.ids;

  if (!allImagesBelongToProject(db, input.projectId, shotImageIds)) {
    return { ok: false, status: 400, error: '部分图片不存在或不属于当前项目' };
  }

  const setId = uuidv4();
  const inserted = db.transaction(() => {
    // D15 的单例约束必须落在服务层，而不能只靠 get-or-create 先查一次。
    // immediate 让不同进程同时建自由工位时串行经过这次检查；普通组不受限。
    if (kind === 'free') {
      const existingFreeSet = db.prepare(
        `SELECT id FROM shot_sets WHERE projectId = ? AND kind = 'free' LIMIT 1`,
      ).get(input.projectId);
      if (existingFreeSet) return false;
    }
    db.prepare(`
      INSERT INTO shot_sets (id, projectId, name, productCode, category, kind, status)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      setId, input.projectId, name,
      asText(input.productCode), asText(input.category), kind,
      // 自由工位没有场景图生成过程,直接落 approved 表示可用;
      // 普通分镜组保持既有的 draft。
      kind === 'free' ? 'approved' : 'draft',
    );
    insertShots(db, setId, shotImageIds, 1);
    return true;
  }).immediate();

  if (!inserted) {
    return { ok: false, status: 409, error: '一个项目只能有一个自由素材工位' };
  }

  return { ok: true, id: setId, name, kind };
}

/* ──────────────── 自由工位:一个项目一个,取不到就建 ──────────────── */

export type FreeShotSetResult = { ok: true; id: string; created: boolean } | ShotSetServiceFailure;

/**
 * D15:一个项目只有一个自由素材工位。前端在下拉里选中它时调用本函数,
 * 第一次会建一个空的,之后每次都返回同一个。
 */
export function getOrCreateFreeShotSet(db: Database.Database, projectId: string): FreeShotSetResult {
  const project = db.prepare(`SELECT id FROM projects WHERE id = ?`).get(projectId);
  if (!project) return { ok: false, status: 404, error: '项目不存在' };

  const existing = db.prepare(`
    SELECT id FROM shot_sets WHERE projectId = ? AND kind = 'free' ORDER BY createdAt LIMIT 1
  `).get(projectId) as { id: string } | undefined;
  if (existing) return { ok: true, id: existing.id, created: false };

  const created = createShotSet(db, {
    projectId,
    name: FREE_SHOT_SET_NAME,
    shotImageIds: [],
    kind: 'free',
  });
  if (!created.ok) {
    // 另一个本机进程可能在上面的查询之后先完成了创建。服务层的
    // IMMEDIATE 单例检查会让本次得到 409；回读胜出的那一行即可保持
    // get-or-create 的幂等合同，而不是把正常竞态暴露给前端。
    if (created.status === 409) {
      const winner = db.prepare(`
        SELECT id FROM shot_sets WHERE projectId = ? AND kind = 'free' ORDER BY createdAt LIMIT 1
      `).get(projectId) as { id: string } | undefined;
      if (winner) return { ok: true, id: winner.id, created: false };
    }
    return created;
  }
  return { ok: true, id: created.id, created: true };
}

/* ────────────────────── 往自由工位追加一张图 ────────────────────── */

export type AppendShotResult =
  | { ok: true; shotId: string; indexNum: number }
  | ShotSetServiceFailure;

/**
 * 自由工位的「再加一张图」。只允许 kind='free' —— 普通分镜组的分镜由
 * 第 2 步的场景生成流程产生,不能从这里塞。
 */
export function appendShotToFreeSet(
  db: Database.Database,
  shotSetId: string,
  imageId: unknown,
): AppendShotResult {
  const set = db.prepare(`SELECT id, projectId, kind FROM shot_sets WHERE id = ?`).get(shotSetId) as
    | { id: string; projectId: string; kind: string }
    | undefined;
  if (!set) return { ok: false, status: 404, error: '分镜组不存在' };
  if (set.kind !== 'free') {
    return { ok: false, status: 400, error: '只有自由素材工位可以直接追加图片' };
  }

  const id = asText(imageId).trim();
  if (!id) return { ok: false, status: 400, error: '缺少图片 id' };
  if (!allImagesBelongToProject(db, set.projectId, [id])) {
    return { ok: false, status: 400, error: '图片不存在或不属于当前项目' };
  }

  const shotId = uuidv4();
  let indexNum = 1;
  db.transaction(() => {
    const maxRow = db.prepare(
      `SELECT COALESCE(MAX(indexNum), 0) AS maxIndex FROM shots WHERE shotSetId = ?`,
    ).get(shotSetId) as { maxIndex: number };
    indexNum = Number(maxRow.maxIndex) + 1;
    db.prepare(`
      INSERT INTO shots (id, shotSetId, indexNum, sourceImageId) VALUES (?, ?, ?, ?)
    `).run(shotId, shotSetId, indexNum, id);
  })();

  return { ok: true, shotId, indexNum };
}

/* ─────────────────── 删掉自由工位里的某一张图 ─────────────────── */

/**
 * 「没留下任何东西」的视频任务状态。只有这两种不算数(D21)。
 *
 * 注意这个集合比 TERMINAL_VIDEO_JOB_STATUSES 少一个 succeeded ——
 * 删整个工位时 succeeded 是可以放行的(视频文件留着,只是脱离工位);
 * 删单张图时 succeeded 必须挡住,否则结果列里会留下一条找不到来源的视频。
 */
export const DISCARDABLE_VIDEO_JOB_STATUSES = ['failed', 'canceled'] as const;

export type DeleteShotResult =
  | { ok: true; sourceImageId: string }
  | ShotSetServiceFailure;

/**
 * D21:自由工位的「删掉这张图」。只允许在还没生成之前删。
 *
 * 返回被删 shot 的 sourceImageId,调用方(路由/前端)据此再 best-effort 删
 * 图片资源 —— 图片本身能不能删由 /api/images/[id] 自己的引用检查决定,
 * 这里不重复判断。
 */
export function deleteShotFromFreeSet(
  db: Database.Database,
  shotSetId: string,
  shotId: string,
): DeleteShotResult {
  const set = db.prepare(`SELECT id, kind FROM shot_sets WHERE id = ?`).get(shotSetId) as
    | { id: string; kind: string }
    | undefined;
  if (!set) return { ok: false, status: 404, error: '分镜组不存在' };
  if (set.kind !== 'free') {
    return { ok: false, status: 400, error: '只有自由素材工位可以删除单张图片' };
  }

  const shot = db.prepare(`SELECT id, sourceImageId FROM shots WHERE id = ? AND shotSetId = ?`)
    .get(shotId, shotSetId) as { id: string; sourceImageId: string } | undefined;
  if (!shot) return { ok: false, status: 404, error: '这张图不在该工位里' };

  // D21:只有 failed / canceled 不算数,其余(succeeded 以及所有非终态)都挡住。
  const placeholders = DISCARDABLE_VIDEO_JOB_STATUSES.map(() => '?').join(',');
  const blocking = db.prepare(
    `SELECT COUNT(*) AS count FROM video_jobs
     WHERE shotId = ? AND status NOT IN (${placeholders})`,
  ).get(shotId, ...DISCARDABLE_VIDEO_JOB_STATUSES) as { count: number };
  if (blocking.count > 0) {
    return {
      ok: false,
      status: 409,
      error: '这张图已经生成过视频了，不能删除。如果不想要，删掉对应的视频任务即可。',
    };
  }

  // indexNum 故意不重排:重排会让「图 3」在用户眼前变成「图 2」,而且
  // 已存在的 video_jobs 也没有 indexNum 可跟。tab 顺序按 indexNum 排,
  // 中间空一个号不影响任何东西。
  db.prepare(`DELETE FROM shots WHERE id = ?`).run(shotId);
  return { ok: true, sourceImageId: shot.sourceImageId };
}

/* ────────────────────────── 删组 ────────────────────────── */

/**
 * 视频任务的终态。终态之外的一切(pending / running / needs_check / paused,
 * 以及将来新增的任何状态)都算「进行中」—— 白名单式判定让新状态默认落在
 * 安全的一边。
 */
export const TERMINAL_VIDEO_JOB_STATUSES = ['succeeded', 'failed', 'canceled'] as const;

export type DeleteShotSetResult = { ok: true } | ShotSetServiceFailure;

export function deleteShotSet(db: Database.Database, shotSetId: string): DeleteShotSetResult {
  const existing = db.prepare(`SELECT id FROM shot_sets WHERE id = ?`).get(shotSetId);
  if (!existing) return { ok: false, status: 404, error: '分镜组不存在' };

  // 删组会把 video_jobs.shotSetId / shotId 置空(ON DELETE SET NULL),但视频
  // 队列是按 projectId 领任务的(lib/video-queue.ts claimNextVideoJob),完全
  // 不看 shotSet。所以进行中的任务在删组后会继续向供应商提交、继续计费,
  // 产出却再也回不到任何界面。必须先挡住。
  const placeholders = TERMINAL_VIDEO_JOB_STATUSES.map(() => '?').join(',');
  const active = db.prepare(
    `SELECT COUNT(*) AS count FROM video_jobs
     WHERE shotSetId = ? AND status NOT IN (${placeholders})`,
  ).get(shotSetId, ...TERMINAL_VIDEO_JOB_STATUSES) as { count: number };
  if (active.count > 0) {
    return {
      ok: false,
      status: 409,
      error: `还有 ${active.count} 个视频任务没有结束，请先取消或等它们跑完再删除分镜组。`,
    };
  }

  db.prepare(`DELETE FROM shot_sets WHERE id = ?`).run(shotSetId);
  return { ok: true };
}
