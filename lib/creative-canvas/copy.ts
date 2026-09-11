/**
 * 完整节点复制（技术约定 C3／C7）。
 *
 * 复制是独立的服务端命令：服务端重新分配节点身份、映射选择范围内的内部连线、
 * 保留范围外输入的引用、固定复制时保留的当前结果，并且不复制任务、lease、activeTaskId。
 * 粘贴用 snapshotKey 幂等：同一次粘贴重试返回同一结果。
 *
 * 首版只支持同一画布内复制；跨画布复制不在本次交付必需项，服务端明确拒绝而不是半支持。
 */

import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { CanvasError } from './errors.ts';
import {
  applyCopyPlan,
  parseCanvasGraph,
  planCanvasCopy,
  reconcileCanvasGraph,
  serializeCanvasGraph,
} from './graph.ts';
import {
  listCanvasNodeStates,
  requireCanvas,
  syncCanvasNodeStates,
} from './repository.ts';
import type { CanvasGraph, CanvasGraphEdge, CanvasGraphNode } from './types.ts';
import { isGenerationNode } from './types.ts';

export interface CanvasCopyRequest {
  sourceCanvasId: string;
  snapshotKey: string;
  nodes: unknown;
  edges: unknown;
  /** 复制时各节点可见的当前结果；不复制运行中任务。 */
  resultAssetIds?: unknown;
  expectedGraphRevision?: number;
}

export interface CanvasCopyResult {
  canvasId: string;
  graphRevision: number;
  nodes: CanvasGraphNode[];
  edges: CanvasGraphEdge[];
  nodeIdMap: Record<string, string>;
  idempotentReplay: boolean;
}

function parseSnapshot(body: CanvasCopyRequest): CanvasGraph {
  try {
    return parseCanvasGraph({
      schemaVersion: 1,
      nodes: body.nodes,
      edges: body.edges,
    });
  } catch (error) {
    throw new CanvasError(
      'invalid_input',
      error instanceof Error ? error.message : '复制快照不合法。',
    );
  }
}

function parseResultAssets(value: unknown, snapshotNodeIds: Set<string>): Map<string, string> {
  const result = new Map<string, string>();
  if (value === undefined || value === null) return result;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new CanvasError('invalid_input', 'resultAssetIds 必须是对象。');
  }
  for (const [nodeId, assetId] of Object.entries(value as Record<string, unknown>)) {
    if (!snapshotNodeIds.has(nodeId)) {
      throw new CanvasError('invalid_input', `resultAssetIds 含快照之外的节点：${nodeId}。`);
    }
    if (assetId === null || assetId === undefined || assetId === '') continue;
    if (typeof assetId !== 'string') {
      throw new CanvasError('invalid_input', `节点 ${nodeId} 的当前结果必须是资产 id 或 null。`);
    }
    result.set(nodeId, assetId);
  }
  return result;
}

function assertSnapshotIntegrity(
  sourceGraph: CanvasGraph,
  snapshot: CanvasGraph,
): void {
  const snapshotIds = new Set(snapshot.nodes.map((node) => node.id));
  const sourceIds = new Set(sourceGraph.nodes.map((node) => node.id));
  for (const node of snapshot.nodes) {
    if (!isGenerationNode(node)) continue;
    for (const slot of node.data.references) {
      if (snapshotIds.has(slot.sourceNodeId)) continue;
      if (sourceIds.has(slot.sourceNodeId)) continue;
      throw new CanvasError(
        'invalid_input',
        `节点 ${node.id} 的参考来源既不在复制范围内，也不在原画布中。`,
      );
    }
  }
  for (const edge of snapshot.edges) {
    if (!snapshotIds.has(edge.source) || !snapshotIds.has(edge.target)) {
      throw new CanvasError('invalid_input', '复制快照只能包含选择范围内部的连线。');
    }
  }
}

function readCopyOperation(
  db: Database.Database,
  canvasId: string,
  snapshotKey: string,
): CanvasCopyResult | null {
  const row = db.prepare(
    `SELECT resultJson FROM creative_canvas_copy_operations WHERE canvasId = ? AND snapshotKey = ?`,
  ).get(canvasId, snapshotKey) as { resultJson: string } | undefined;
  if (!row) return null;
  const parsed = JSON.parse(row.resultJson) as Omit<CanvasCopyResult, 'idempotentReplay'>;
  return { ...parsed, idempotentReplay: true };
}

export function copyCanvasNodes(
  db: Database.Database,
  params: {
    canvasId: string;
    request: CanvasCopyRequest;
    now?: () => Date;
  },
): CanvasCopyResult {
  const { canvasId, request } = params;
  const now = params.now ?? (() => new Date());
  requireCanvas(db, canvasId);

  if (typeof request.snapshotKey !== 'string' || request.snapshotKey.trim().length === 0) {
    throw new CanvasError('invalid_input', '缺少粘贴操作标识。');
  }
  if (request.snapshotKey.length > 200) {
    throw new CanvasError('invalid_input', '粘贴操作标识过长。');
  }
  if (typeof request.sourceCanvasId !== 'string' || request.sourceCanvasId.length === 0) {
    throw new CanvasError('invalid_input', '缺少复制来源画布。');
  }
  if (request.sourceCanvasId !== canvasId) {
    throw new CanvasError('forbidden', '首版只支持同一画布内复制粘贴。');
  }

  const replayed = readCopyOperation(db, canvasId, request.snapshotKey);
  if (replayed) return replayed;

  const source = requireCanvas(db, request.sourceCanvasId);
  const snapshot = parseSnapshot(request);
  assertSnapshotIntegrity(source.graph, snapshot);
  const pinnedResults = parseResultAssets(
    request.resultAssetIds,
    new Set(snapshot.nodes.map((node) => node.id)),
  );

  for (const assetId of pinnedResults.values()) {
    const asset = db.prepare(
      `SELECT id, canvasId FROM creative_canvas_assets WHERE id = ?`,
    ).get(assetId) as { id: string; canvasId: string } | undefined;
    if (!asset || asset.canvasId !== canvasId) {
      throw new CanvasError('invalid_input', '复制快照引用了不属于本画布的当前结果。');
    }
  }

  const plan = planCanvasCopy({
    graph: snapshot,
    nodeIds: snapshot.nodes.map((node) => node.id),
    createId: () => randomUUID(),
  });

  const run = db.transaction((): CanvasCopyResult => {
    const current = db.prepare(
      `SELECT graphRevision, graphJson FROM creative_canvases WHERE id = ?`,
    ).get(canvasId) as { graphRevision: number; graphJson: string } | undefined;
    if (!current) throw new CanvasError('not_found', '画布不存在。');
    if (
      request.expectedGraphRevision !== undefined
      && Number(current.graphRevision) !== request.expectedGraphRevision
    ) {
      throw new CanvasError('conflict', '画布已在别处被修改，请重新加载后再粘贴。', {
        currentGraphRevision: Number(current.graphRevision),
      });
    }

    const targetGraph = reconcileCanvasGraph(parseCanvasGraph(JSON.parse(current.graphJson)));
    const nextGraph = applyCopyPlan(targetGraph, plan);
    const at = now().toISOString();
    const nextRevision = Number(current.graphRevision) + 1;

    db.prepare(
      `UPDATE creative_canvases SET graphRevision = ?, graphJson = ?, updatedAt = ? WHERE id = ?`,
    ).run(nextRevision, serializeCanvasGraph(nextGraph), at, canvasId);

    syncCanvasNodeStates(db, canvasId, nextGraph, at);

    for (const [originalId, assetId] of pinnedResults) {
      const newNodeId = plan.nodeIdMap.get(originalId);
      if (!newNodeId) continue;
      db.prepare(
        `UPDATE creative_canvas_node_states SET currentAssetId = ?, updatedAt = ? WHERE canvasId = ? AND nodeId = ?`,
      ).run(assetId, at, canvasId, newNodeId);
    }

    const result: CanvasCopyResult = {
      canvasId,
      graphRevision: nextRevision,
      nodes: plan.nodes,
      edges: plan.edges,
      nodeIdMap: Object.fromEntries(plan.nodeIdMap),
      idempotentReplay: false,
    };

    try {
      db.prepare(`
        INSERT INTO creative_canvas_copy_operations (id, canvasId, snapshotKey, resultJson, createdAt)
        VALUES (?, ?, ?, ?, ?)
      `).run(randomUUID(), canvasId, request.snapshotKey, JSON.stringify(result), at);
    } catch {
      // 并发重试已经写入同一 snapshotKey：读回既有结果，保持幂等语义。
      const existing = readCopyOperation(db, canvasId, request.snapshotKey);
      if (existing) return existing;
      throw new CanvasError('conflict', '粘贴操作冲突，请重试。');
    }

    return result;
  });

  const result = run.immediate();
  return result;
}

/** 复制后的节点运行投影（用于测试与界面刷新）。 */
export function copiedNodeStates(
  db: Database.Database,
  canvasId: string,
  nodeIds: ReadonlyArray<string>,
): Array<{ nodeId: string; currentAssetId: string | null; activeTaskId: string | null }> {
  const wanted = new Set(nodeIds);
  return listCanvasNodeStates(db, canvasId)
    .filter((state) => wanted.has(state.nodeId))
    .map((state) => ({
      nodeId: state.nodeId,
      currentAssetId: state.currentAssetId,
      activeTaskId: state.activeTaskId,
    }));
}
