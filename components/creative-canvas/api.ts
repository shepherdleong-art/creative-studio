/**
 * 画布接口客户端。所有写操作都由服务端校验，这里只做类型与错误归一化。
 */

import type {
  CanvasGraph,
  CanvasGraphEdge,
  CanvasGraphNode,
  CanvasMediaKind,
  CanvasNodeRunProjection,
  CanvasTaskPhase,
  CanvasViewport,
} from '@/lib/creative-canvas/types';

export interface CanvasSummaryDto {
  id: string;
  name: string;
  graphRevision: number;
  nodeCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface CanvasTaskDto {
  id: string;
  runId: string | null;
  canvasId: string;
  canvasName?: string;
  nodeId: string;
  mediaKind: 'image' | 'video';
  phase: CanvasTaskPhase;
  submissionState: string;
  slotHeld: boolean;
  outputAssetId: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  cancelRequestedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CanvasAssetDto {
  id: string;
  canvasId: string;
  mediaKind: CanvasMediaKind;
  mimeType: string;
  byteSize: number;
  width: number | null;
  height: number | null;
  durationSec: number | null;
  ready: boolean;
  createdAt: string;
}

export interface CanvasDto {
  id: string;
  name: string;
  graphRevision: number;
  graph: CanvasGraph;
  viewport: CanvasViewport;
  createdAt: string;
  updatedAt: string;
  nodeStates: CanvasNodeRunProjection[];
  tasks: CanvasTaskDto[];
}

export interface PlanInputDto {
  refId: string;
  orderIndex: number;
  role: string;
  sourceNodeId: string;
  kind: 'asset' | 'text' | 'result';
  assetId: string | null;
  upstreamNodeId: string | null;
  textContent: string | null;
}

export interface PlanTaskDto {
  nodeId: string;
  nodeEpoch: number;
  mediaKind: 'image' | 'video';
  capabilityKey: string;
  generationMode: string;
  prompt: string;
  inputs: PlanInputDto[];
}

export interface CanvasPlanDto {
  canvasId: string;
  mode: 'single' | 'branch';
  graphRevision: number;
  fingerprint: string;
  tasks: PlanTaskDto[];
  reused: Array<{ nodeId: string; assetId: string }>;
  scope: string[];
}

export class CanvasApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details: Record<string, unknown>;

  constructor(status: number, code: string, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'CanvasApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      ...(init?.body instanceof FormData ? {} : { 'content-type': 'application/json' }),
      ...(init?.headers ?? {}),
    },
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) as Record<string, unknown> : {};
  if (!response.ok) {
    throw new CanvasApiError(
      response.status,
      String(payload.error ?? 'canvas_error'),
      String(payload.message ?? `请求失败（${response.status}）`),
      payload,
    );
  }
  return payload as T;
}

export interface CopySnapshot {
  sourceCanvasId: string;
  snapshotKey: string;
  nodes: CanvasGraphNode[];
  edges: CanvasGraphEdge[];
  resultAssetIds: Record<string, string | null>;
  expectedGraphRevision?: number;
}

export interface CopyResultDto {
  canvasId: string;
  graphRevision: number;
  nodes: CanvasGraphNode[];
  edges: CanvasGraphEdge[];
  nodeIdMap: Record<string, string>;
  idempotentReplay: boolean;
}

export const canvasApi = {
  list: () => request<{ canvases: CanvasSummaryDto[] }>('/api/canvas'),
  create: (name: string) => request<{ canvas: CanvasDto }>('/api/canvas', {
    method: 'POST',
    body: JSON.stringify({ name }),
  }),
  get: (canvasId: string) => request<{ canvas: CanvasDto }>(`/api/canvas/${canvasId}`),
  saveGraph: (
    canvasId: string,
    body: { expectedGraphRevision: number; graph: CanvasGraph; viewport?: CanvasViewport },
  ) => request<{ canvas: { graphRevision: number; graph: CanvasGraph; nodeStates: CanvasNodeRunProjection[]; updatedAt: string } }>(
    `/api/canvas/${canvasId}`,
    { method: 'PATCH', body: JSON.stringify(body) },
  ),
  rename: (canvasId: string, name: string) => request<{ canvas: CanvasDto }>(`/api/canvas/${canvasId}`, {
    method: 'PATCH',
    body: JSON.stringify({ name }),
  }),
  uploadAsset: (canvasId: string, file: File) => {
    const form = new FormData();
    form.append('file', file);
    return request<{ asset: CanvasAssetDto }>(`/api/canvas/${canvasId}/assets`, {
      method: 'POST',
      body: form,
    });
  },
  copy: (canvasId: string, snapshot: CopySnapshot) => request<{ copy: CopyResultDto }>(
    `/api/canvas/${canvasId}/copies`,
    { method: 'POST', body: JSON.stringify(snapshot) },
  ),
  plan: (canvasId: string, body: Record<string, unknown>) => request<{ plan: CanvasPlanDto }>(
    `/api/canvas/${canvasId}/plan`,
    { method: 'POST', body: JSON.stringify(body) },
  ),
  run: (canvasId: string, body: Record<string, unknown>) => request<{
    run: { id: string; mode: string; status: string; createdAt: string };
    plan: CanvasPlanDto;
    idempotentReplay: boolean;
    tasks: Array<{ id: string; nodeId: string; mediaKind: string; phase: string }>;
  }>(`/api/canvas/${canvasId}/runs`, { method: 'POST', body: JSON.stringify(body) }),
  tasks: (query: { canvasId?: string; limit?: number } = {}) => {
    const params = new URLSearchParams();
    if (query.canvasId) params.set('canvasId', query.canvasId);
    if (query.limit) params.set('limit', String(query.limit));
    const suffix = params.toString();
    return request<{ tasks: CanvasTaskDto[] }>(`/api/canvas/tasks${suffix ? `?${suffix}` : ''}`);
  },
  models: () => request<{ models: unknown[]; executor: string }>('/api/canvas/models'),
};

export function canvasAssetUrl(assetId: string): string {
  return `/api/canvas/assets/${assetId}`;
}
