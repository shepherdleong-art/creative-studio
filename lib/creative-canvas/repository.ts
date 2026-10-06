/**
 * 画布定义与运行投影的持久化边界（技术约定 C2／C3）。
 *
 * 三类数据分开管理：
 * - graphJson：客户端可写的编辑定义，带 graphRevision 做乐观并发；
 * - node_states：服务端维护的当前结果与活跃任务（运行投影），客户端不能写；
 * - runs／tasks／asset：执行与产物，P2 起由 planner／runner 写入。
 */

import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { CanvasError } from './errors.ts';
import {
  cloneCanvasGraph,
  emptyCanvasGraph,
  parseCanvasGraph,
  reconcileCanvasGraph,
  serializeCanvasGraph,
} from './graph.ts';
import {
  DEFAULT_CANVAS_VIEWPORT,
  type CanvasGraph,
  type CanvasMediaKind,
  type CanvasNodeKind,
  type CanvasNodeRunProjection,
  type CanvasViewport,
} from './types.ts';

export interface CanvasRecord {
  id: string;
  name: string;
  graphRevision: number;
  graph: CanvasGraph;
  viewport: CanvasViewport;
  createdAt: string;
  updatedAt: string;
}

export interface CanvasSummary {
  id: string;
  name: string;
  graphRevision: number;
  nodeCount: number;
  createdAt: string;
  updatedAt: string;
  /** 列表卡片封面用的轻量布局投影（节点位置/种类/素材 + 连线），不含运行态。 */
  preview: CanvasPreview;
}

export interface CanvasPreviewNode {
  id: string;
  kind: CanvasNodeKind;
  x: number;
  y: number;
  /** 用户调整过的宽度；未调整为 null（前端按种类取默认）。 */
  width: number | null;
  /** 仅素材节点且有已导入素材时非空。 */
  assetId: string | null;
  /** 仅素材节点有意义。 */
  mediaKind: CanvasMediaKind | null;
}

export interface CanvasPreviewEdge {
  source: string;
  target: string;
}

export interface CanvasPreview {
  nodes: CanvasPreviewNode[];
  edges: CanvasPreviewEdge[];
}

export interface CanvasSaveResult {
  graphRevision: number;
  graph: CanvasGraph;
  nodeStates: CanvasNodeRunProjection[];
  updatedAt: string;
}

function parseViewport(value: unknown): CanvasViewport {
  if (!value || typeof value !== 'object') return { ...DEFAULT_CANVAS_VIEWPORT };
  const record = value as Record<string, unknown>;
  const x = typeof record.x === 'number' && Number.isFinite(record.x) ? record.x : 0;
  const y = typeof record.y === 'number' && Number.isFinite(record.y) ? record.y : 0;
  const zoom = typeof record.zoom === 'number' && Number.isFinite(record.zoom) && record.zoom > 0 ? record.zoom : 1;
  return { x, y, zoom };
}

export function parseCanvasViewport(value: unknown): CanvasViewport {
  return parseViewport(value);
}

function readGraph(raw: string): CanvasGraph {
  try {
    return parseCanvasGraph(JSON.parse(raw));
  } catch {
    // 已保存的图损坏时不让整张画布打不开；编辑定义降级为空图，运行投影仍可读。
    return emptyCanvasGraph();
  }
}

function rowToCanvas(row: Record<string, unknown>): CanvasRecord {
  return {
    id: String(row.id),
    name: String(row.name),
    graphRevision: Number(row.graphRevision),
    graph: readGraph(String(row.graphJson)),
    viewport: parseViewport(JSON.parse(String(row.viewportJson))),
    createdAt: String(row.createdAt),
    updatedAt: String(row.updatedAt),
  };
}

export function createCanvas(
  db: Database.Database,
  params: { name: string; now?: () => Date },
): CanvasRecord {
  const name = params.name.trim();
  if (!name) throw new CanvasError('invalid_input', '画布名称不能为空。');
  if (name.length > 120) throw new CanvasError('invalid_input', '画布名称不能超过 120 个字符。');
  const id = randomUUID();
  const at = (params.now ?? (() => new Date()))().toISOString();
  db.prepare(`
    INSERT INTO creative_canvases (id, name, graphRevision, graphJson, viewportJson, createdAt, updatedAt)
    VALUES (?, ?, 0, ?, ?, ?, ?)
  `).run(id, name, serializeCanvasGraph(emptyCanvasGraph()), JSON.stringify(DEFAULT_CANVAS_VIEWPORT), at, at);
  return requireCanvas(db, id);
}

export function listCanvases(db: Database.Database): CanvasSummary[] {
  const rows = db.prepare(
    `SELECT id, name, graphRevision, graphJson, createdAt, updatedAt FROM creative_canvases ORDER BY updatedAt DESC`,
  ).all() as Array<Record<string, unknown>>;
  return rows.map((row) => {
    const graph = readGraph(String(row.graphJson));
    return {
      id: String(row.id),
      name: String(row.name),
      graphRevision: Number(row.graphRevision),
      nodeCount: graph.nodes.length,
      createdAt: String(row.createdAt),
      updatedAt: String(row.updatedAt),
      preview: {
        nodes: graph.nodes.map((node) => ({
          id: node.id,
          kind: node.kind,
          x: node.position.x,
          y: node.position.y,
          width: node.size?.width ?? null,
          assetId: node.kind === 'material' ? node.data.assetId : null,
          mediaKind: node.kind === 'material' ? node.data.mediaKind : null,
        })),
        edges: graph.edges.map((edge) => ({ source: edge.source, target: edge.target })),
      },
    };
  });
}

export function getCanvas(db: Database.Database, canvasId: string): CanvasRecord | null {
  const row = db.prepare(`SELECT * FROM creative_canvases WHERE id = ?`).get(canvasId) as
    | Record<string, unknown>
    | undefined;
  return row ? rowToCanvas(row) : null;
}

export function requireCanvas(db: Database.Database, canvasId: string): CanvasRecord {
  const canvas = getCanvas(db, canvasId);
  if (!canvas) throw new CanvasError('not_found', '画布不存在。');
  return canvas;
}

function rowToNodeState(row: Record<string, unknown>): CanvasNodeRunProjection {
  return {
    nodeId: String(row.nodeId),
    nodeEpoch: Number(row.nodeEpoch),
    deleted: row.deletedAt !== null && row.deletedAt !== undefined,
    activeTaskId: row.activeTaskId === null || row.activeTaskId === undefined ? null : String(row.activeTaskId),
    currentAssetId: row.currentAssetId === null || row.currentAssetId === undefined ? null : String(row.currentAssetId),
    resultTaskId: row.resultTaskId === null || row.resultTaskId === undefined ? null : String(row.resultTaskId),
  };
}

export function listCanvasNodeStates(
  db: Database.Database,
  canvasId: string,
): CanvasNodeRunProjection[] {
  const rows = db.prepare(
    `SELECT * FROM creative_canvas_node_states WHERE canvasId = ? ORDER BY nodeId`,
  ).all(canvasId) as Array<Record<string, unknown>>;
  return rows.map(rowToNodeState);
}

export function getCanvasNodeState(
  db: Database.Database,
  canvasId: string,
  nodeId: string,
): CanvasNodeRunProjection | null {
  const row = db.prepare(
    `SELECT * FROM creative_canvas_node_states WHERE canvasId = ? AND nodeId = ?`,
  ).get(canvasId, nodeId) as Record<string, unknown> | undefined;
  return row ? rowToNodeState(row) : null;
}

/**
 * 让 node_states 与图定义对齐：
 * - 新节点建行（nodeEpoch 从 1 开始）；
 * - 重新出现的节点清除 deletedAt，但不恢复旧运行状态、也不重置 nodeEpoch
 *   （删除时已经递增 epoch，旧任务因此失去发布权）；
 * - 消失的节点只打 tombstone，不删除任务身份。
 */
function syncNodeStates(
  db: Database.Database,
  canvasId: string,
  graph: CanvasGraph,
  at: string,
): void {  const existing = new Map(
    (db.prepare(`SELECT * FROM creative_canvas_node_states WHERE canvasId = ?`).all(canvasId) as Array<Record<string, unknown>>)
      .map((row) => [String(row.nodeId), row]),
  );
  const present = new Set(graph.nodes.map((node) => node.id));

  const insert = db.prepare(`
    INSERT INTO creative_canvas_node_states
      (canvasId, nodeId, nodeEpoch, deletedAt, activeTaskId, currentAssetId, resultTaskId, createdAt, updatedAt)
    VALUES (?, ?, 1, NULL, NULL, NULL, NULL, ?, ?)
  `);
  const restore = db.prepare(
    `UPDATE creative_canvas_node_states SET deletedAt = NULL, updatedAt = ? WHERE canvasId = ? AND nodeId = ?`,
  );
  const tombstone = db.prepare(
    `UPDATE creative_canvas_node_states
       SET deletedAt = ?, nodeEpoch = nodeEpoch + 1, updatedAt = ?
     WHERE canvasId = ? AND nodeId = ? AND deletedAt IS NULL`,
  );

  for (const node of graph.nodes) {
    const row = existing.get(node.id);
    if (!row) {
      insert.run(canvasId, node.id, at, at);
      continue;
    }
    if (row.deletedAt !== null && row.deletedAt !== undefined) {
      restore.run(at, canvasId, node.id);
    }
  }

  for (const nodeId of existing.keys()) {
    if (!present.has(nodeId)) tombstone.run(at, at, canvasId, nodeId);
  }
}

export interface SaveCanvasGraphParams {
  db: Database.Database;
  canvasId: string;
  expectedGraphRevision: number;
  graph: unknown;
  viewport?: unknown;
  now?: () => Date;
}

/**
 * 按期望修订号保存编辑定义。修订号不匹配返回冲突，不静默覆盖——
 * 客户端要保留未保存草稿并提示重试或重新加载。
 */
export function saveCanvasGraph(params: SaveCanvasGraphParams): CanvasSaveResult {
  const { db, canvasId, expectedGraphRevision, graph, viewport } = params;
  const now = params.now ?? (() => new Date());
  requireCanvas(db, canvasId);
  const parsed = reconcileCanvasGraph(parseCanvasGraph(graph));
  if (!Number.isInteger(expectedGraphRevision) || expectedGraphRevision < 0) {
    throw new CanvasError('invalid_input', '缺少有效的图修订号。');
  }
  const nextViewport = viewport === undefined ? null : parseViewport(viewport);
  const graphJson = serializeCanvasGraph(parsed);

  const run = db.transaction((): CanvasSaveResult => {
    const row = db.prepare(`SELECT graphRevision FROM creative_canvases WHERE id = ?`).get(canvasId) as
      | { graphRevision: number }
      | undefined;
    if (!row) throw new CanvasError('not_found', '画布不存在。');
    if (Number(row.graphRevision) !== expectedGraphRevision) {
      throw new CanvasError('conflict', '画布已在别处被修改，请重新加载后再保存。', {
        currentGraphRevision: Number(row.graphRevision),
      });
    }
    const at = now().toISOString();
    const nextRevision = expectedGraphRevision + 1;
    if (nextViewport) {
      db.prepare(
        `UPDATE creative_canvases SET graphRevision = ?, graphJson = ?, viewportJson = ?, updatedAt = ? WHERE id = ?`,
      ).run(nextRevision, graphJson, JSON.stringify(nextViewport), at, canvasId);
    } else {
      db.prepare(
        `UPDATE creative_canvases SET graphRevision = ?, graphJson = ?, updatedAt = ? WHERE id = ?`,
      ).run(nextRevision, graphJson, at, canvasId);
    }
    syncNodeStates(db, canvasId, parsed, at);
    return {
      graphRevision: nextRevision,
      graph: parsed,
      nodeStates: listCanvasNodeStates(db, canvasId),
      updatedAt: at,
    };
  });

  return run.immediate();
}

export function renameCanvas(
  db: Database.Database,
  params: { canvasId: string; name: string; now?: () => Date },
): CanvasRecord {
  const name = params.name.trim();
  if (!name) throw new CanvasError('invalid_input', '画布名称不能为空。');
  if (name.length > 120) throw new CanvasError('invalid_input', '画布名称不能超过 120 个字符。');
  requireCanvas(db, params.canvasId);
  db.prepare(`UPDATE creative_canvases SET name = ?, updatedAt = ? WHERE id = ?`)
    .run(name, (params.now ?? (() => new Date()))().toISOString(), params.canvasId);
  return requireCanvas(db, params.canvasId);
}

export function saveCanvasViewport(
  db: Database.Database,
  params: { canvasId: string; viewport: unknown; now?: () => Date },
): CanvasRecord {
  requireCanvas(db, params.canvasId);
  db.prepare(`UPDATE creative_canvases SET viewportJson = ?, updatedAt = ? WHERE id = ?`)
    .run(JSON.stringify(parseViewport(params.viewport)), (params.now ?? (() => new Date()))().toISOString(), params.canvasId);
  return requireCanvas(db, params.canvasId);
}

/** 服务端专用：绑定节点当前活跃任务（P2 planner 使用）。 */
export function setCanvasNodeActiveTask(
  db: Database.Database,
  params: { canvasId: string; nodeId: string; taskId: string | null; now?: () => Date },
): void {
  const at = (params.now ?? (() => new Date()))().toISOString();
  const info = db.prepare(
    `UPDATE creative_canvas_node_states SET activeTaskId = ?, updatedAt = ? WHERE canvasId = ? AND nodeId = ?`,
  ).run(params.taskId, at, params.canvasId, params.nodeId);
  if (info.changes === 0) {
    db.prepare(`
      INSERT INTO creative_canvas_node_states
        (canvasId, nodeId, nodeEpoch, deletedAt, activeTaskId, currentAssetId, resultTaskId, createdAt, updatedAt)
      VALUES (?, ?, 1, NULL, ?, NULL, NULL, ?, ?)
    `).run(params.canvasId, params.nodeId, params.taskId, at, at);
  }
}

export interface PublishNodeResultParams {
  db: Database.Database;
  canvasId: string;
  nodeId: string;
  taskId: string;
  nodeEpoch: number;
  assetId: string;
  now?: () => Date;
}

export type PublishNodeResultOutcome =
  | { published: true }
  | { published: false; reason: 'node_deleted' | 'epoch_mismatch' | 'node_missing' };

/**
 * 发布任务产物到节点当前结果。发布门禁（v2）：节点存在、未被删除、
 * nodeEpoch 匹配（唯一防迟到发布的红线），且任务确实属于该节点并成功
 * 产出该资产。多变体并存时最后完成者成为 currentAssetId 主结果。
 */
export function publishCanvasNodeResult(params: PublishNodeResultParams): PublishNodeResultOutcome {
  const { db, canvasId, nodeId, taskId, nodeEpoch, assetId } = params;
  const at = (params.now ?? (() => new Date()))().toISOString();
  const row = db.prepare(
    `SELECT * FROM creative_canvas_node_states WHERE canvasId = ? AND nodeId = ?`,
  ).get(canvasId, nodeId) as Record<string, unknown> | undefined;
  if (!row) return { published: false, reason: 'node_missing' };
  if (row.deletedAt !== null && row.deletedAt !== undefined) return { published: false, reason: 'node_deleted' };
  // 并发多变体（v2）：nodeEpoch 是唯一发布门禁——epoch 相等即节点未被删除重建，
  // 该任务对该节点仍合法；多个变体并存时「最后完成者成为主结果」是产品语义。
  if (Number(row.nodeEpoch) !== nodeEpoch) return { published: false, reason: 'epoch_mismatch' };
  // 防御性断言：任务确实属于该节点、同 epoch 且已成功产出该资产
  const taskRow = db.prepare(
    `SELECT 1 FROM creative_canvas_tasks
      WHERE id = ? AND canvasId = ? AND nodeId = ? AND nodeEpoch = ? AND outputAssetId = ?`,
  ).get(taskId, canvasId, nodeId, nodeEpoch, assetId);
  if (!taskRow) return { published: false, reason: 'epoch_mismatch' };
  db.prepare(`
    UPDATE creative_canvas_node_states
       SET currentAssetId = ?, resultTaskId = ?,
           activeTaskId = CASE WHEN activeTaskId = ? THEN NULL ELSE activeTaskId END,
           updatedAt = ?
     WHERE canvasId = ? AND nodeId = ?
  `).run(assetId, taskId, taskId, at, canvasId, nodeId);
  return { published: true };
}

/**
 * 节点候选投影（v2）：按节点列出成功任务及其输出资产，供前端候选列表。
 * 每节点取最近 12 条（时间倒序），走 idx_cct_node_results 索引。
 */
export interface CanvasNodeCandidate {
  nodeId: string;
  taskId: string;
  assetId: string;
  variantIndex: number;
  createdAt: string;
}

export function listCanvasNodeCandidates(db: Database.Database, canvasId: string): CanvasNodeCandidate[] {
  const rows = db.prepare(
    `SELECT nodeId, id AS taskId, outputAssetId, variantIndex, createdAt
       FROM creative_canvas_tasks
      WHERE canvasId = ? AND phase = 'succeeded' AND outputAssetId IS NOT NULL
      ORDER BY nodeId, createdAt DESC`,
  ).all(canvasId) as Array<Record<string, unknown>>;
  const perNode = new Map<string, CanvasNodeCandidate[]>();
  for (const row of rows) {
    const nodeId = String(row.nodeId);
    const bucket = perNode.get(nodeId) ?? [];
    if (bucket.length >= 12) continue;
    bucket.push({
      nodeId,
      taskId: String(row.taskId),
      assetId: String(row.outputAssetId),
      variantIndex: Number(row.variantIndex ?? 0),
      createdAt: String(row.createdAt),
    });
    perNode.set(nodeId, bucket);
  }
  return [...perNode.values()].flat();
}

export function cloneCanvasRecordGraph(canvas: CanvasRecord): CanvasGraph {
  return cloneCanvasGraph(canvas.graph);
}

/** 供复制等复合事务复用：让 node_states 与图定义对齐。 */
export function syncCanvasNodeStates(
  db: Database.Database,
  canvasId: string,
  graph: CanvasGraph,
  at: string,
): void {
  syncNodeStates(db, canvasId, graph, at);
}
