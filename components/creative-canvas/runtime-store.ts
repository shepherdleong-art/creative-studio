/**
 * 节点运行投影的客户端订阅。
 *
 * 任务轮询每 1.5 秒更新一次，如果用普通 state 会把整张画布一起重渲染，
 * 也会打断正在输入的用户。这里按 nodeId 做精确订阅：只有真正变化的节点才重渲染。
 */

import { useCallback, useSyncExternalStore } from 'react';
import type { CanvasNodeRunProjection, CanvasTaskPhase } from '@/lib/creative-canvas/types';
import type { CanvasNodeCandidateDto, CanvasTaskDto } from './api';

export interface NodeActiveTask {
  taskId: string;
  phase: CanvasTaskPhase;
  variantIndex: number;
  errorMessage: string | null;
}

export interface NodeRuntime {
  nodeId: string;
  nodeEpoch: number;
  deleted: boolean;
  currentAssetId: string | null;
  activeTaskId: string | null;
  activeTaskPhase: CanvasTaskPhase | null;
  activeTaskError: string | null;
  activeTaskIdForCancel: string | null;
  /** 该节点全部未结束任务（并发多变体，v2）。 */
  activeTasks: NodeActiveTask[];
  /** 该节点的成功任务候选（服务端投影，时间倒序）。 */
  candidates: CanvasNodeCandidateDto[];
}

const EMPTY_RUNTIME: NodeRuntime | undefined = undefined;

function sameRuntime(left: NodeRuntime | undefined, right: NodeRuntime | undefined): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  return left.nodeEpoch === right.nodeEpoch
    && left.deleted === right.deleted
    && left.currentAssetId === right.currentAssetId
    && left.activeTaskId === right.activeTaskId
    && left.activeTaskPhase === right.activeTaskPhase
    && left.activeTaskError === right.activeTaskError
    && left.activeTasks.length === right.activeTasks.length
    && left.activeTasks.every((task, index) => task.taskId === right.activeTasks[index]?.taskId
      && task.phase === right.activeTasks[index]?.phase)
    && left.candidates.length === right.candidates.length
    && left.candidates.every((candidate, index) => candidate.taskId === right.candidates[index]?.taskId
      && candidate.assetId === right.candidates[index]?.assetId);
}

export class CanvasRuntimeStore {
  private runtimes = new Map<string, NodeRuntime>();

  private listeners = new Map<string, Set<() => void>>();

  /** 用最新一次投影与任务列表重建运行态，只通知发生变化的节点。 */
  update(
    nodeStates: CanvasNodeRunProjection[],
    tasks: CanvasTaskDto[],
    nodeCandidates: CanvasNodeCandidateDto[] = [],
  ): void {
    const taskById = new Map(tasks.map((task) => [task.id, task]));
    const next = new Map<string, NodeRuntime>();
    const candidatesByNode = new Map<string, CanvasNodeCandidateDto[]>();
    for (const candidate of nodeCandidates) {
      const bucket = candidatesByNode.get(candidate.nodeId) ?? [];
      bucket.push(candidate);
      candidatesByNode.set(candidate.nodeId, bucket);
    }
    for (const state of nodeStates) {
      const activeTask = state.activeTaskId ? taskById.get(state.activeTaskId) : undefined;
      // 并发多变体：本节点全部未结束任务（列表内本画布任务按 taskId 匹配）
      const activeTasks = tasks
        .filter((task) => task.nodeId === state.nodeId
          && !['succeeded', 'failed', 'blocked', 'cancelled'].includes(task.phase))
        .map((task) => ({
          taskId: task.id,
          phase: task.phase,
          variantIndex: task.variantIndex,
          errorMessage: task.errorMessage,
        }));
      next.set(state.nodeId, {
        nodeId: state.nodeId,
        nodeEpoch: state.nodeEpoch,
        deleted: state.deleted,
        currentAssetId: state.currentAssetId,
        activeTaskId: state.activeTaskId,
        activeTaskPhase: activeTask?.phase ?? (state.activeTaskId ? 'queued' : null),
        activeTaskError: activeTask?.errorMessage ?? null,
        activeTaskIdForCancel: state.activeTaskId,
        activeTasks,
        candidates: candidatesByNode.get(state.nodeId) ?? [],
      });
    }
    const changed: string[] = [];
    for (const [nodeId, runtime] of next) {
      if (!sameRuntime(this.runtimes.get(nodeId), runtime)) changed.push(nodeId);
    }
    for (const nodeId of this.runtimes.keys()) {
      if (!next.has(nodeId)) changed.push(nodeId);
    }
    this.runtimes = next;
    for (const nodeId of changed) {
      for (const listener of this.listeners.get(nodeId) ?? []) listener();
    }
  }

  get(nodeId: string): NodeRuntime | undefined {
    return this.runtimes.get(nodeId);
  }

  subscribe(nodeId: string, listener: () => void): () => void {
    const set = this.listeners.get(nodeId) ?? new Set();
    set.add(listener);
    this.listeners.set(nodeId, set);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.listeners.delete(nodeId);
    };
  }
}

export function useNodeRuntime(store: CanvasRuntimeStore, nodeId: string): NodeRuntime | undefined {
  return useSyncExternalStore(
    useCallback((listener: () => void) => store.subscribe(nodeId, listener), [store, nodeId]),
    useCallback(() => store.get(nodeId), [store, nodeId]),
    useCallback(() => EMPTY_RUNTIME, []),
  );
}
