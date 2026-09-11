/**
 * 画布适配器合同（技术约定 C6）。
 *
 * prepare／submit／poll／download／cancel 分开，测试可以分别替换：
 * - prepare 只做素材交付，不产生生成调用；
 * - submit 是可以精确计数的单次生成 POST；
 * - poll／download 使用已保存的远端任务身份，地址缺失时仍能按原始 ID 恢复。
 */

import type { CanvasTaskInputRecord, CanvasTaskRecord } from '../tasks.ts';
import type { CanvasGenerationMode, CanvasReferenceRole } from '../types.ts';

export type CanvasAdapterStage = 'prepare' | 'submit' | 'poll' | 'download' | 'cancel';

export class CanvasAdapterError extends Error {
  readonly stage: CanvasAdapterStage;
  /** true 表示提交结果不明（可能已经送达上游），调用方必须按待核查处理，不能自动重发。 */
  readonly uncertain: boolean;
  readonly code: string;

  constructor(stage: CanvasAdapterStage, message: string, options: { uncertain?: boolean; code?: string } = {}) {
    super(message);
    this.name = 'CanvasAdapterError';
    this.stage = stage;
    this.uncertain = options.uncertain ?? false;
    this.code = options.code ?? `${stage}_failed`;
  }
}

export interface CanvasResolvedInput {
  refId: string;
  orderIndex: number;
  role: CanvasReferenceRole;
  note: string;
  kind: 'image' | 'video' | 'audio' | 'text';
  assetId: string | null;
  absolutePath: string | null;
  mimeType: string | null;
  byteSize: number | null;
  durationSec: number | null;
  textContent: string | null;
  upstreamTaskId: string | null;
  /**
   * prepare 阶段写入的交付地址（COS 预签名 URL 或本机 URL）。
   * submit 只读这个字段，保证「素材准备」与「单次 POST」分开、可分别测试。
   */
  deliveryRef?: string | null;
  record: CanvasTaskInputRecord;
}

export interface CanvasTaskContext {
  task: CanvasTaskRecord;
  mediaKind: 'image' | 'video';
  generationMode: CanvasGenerationMode;
  prompt: string;
  parameters: Record<string, string | number | boolean>;
  capabilityKey: string;
  providerIdentity: string;
  modelAlias: string;
  inputs: CanvasResolvedInput[];
}

export interface CanvasSubmitOutcome {
  providerTaskId: string;
  raw?: unknown;
}

export type CanvasPollOutcome =
  | { status: 'pending' | 'running'; progress?: number }
  | { status: 'succeeded' }
  | { status: 'failed'; code?: string; message: string };

export interface CanvasDownloadOutcome {
  bytes: Buffer;
  mimeType: string;
  filename?: string;
}

export interface CanvasCancelOutcome {
  /** 远端是否确认取消；false 表示远端仍可能继续，必须保留身份与名额。 */
  remoteCancelled: boolean;
}

export interface CanvasTaskAdapter {
  readonly kind: string;
  prepare(context: CanvasTaskContext, signal?: AbortSignal): Promise<void>;
  submit(context: CanvasTaskContext, signal?: AbortSignal): Promise<CanvasSubmitOutcome>;
  poll(context: CanvasTaskContext & { providerTaskId: string }, signal?: AbortSignal): Promise<CanvasPollOutcome>;
  download(context: CanvasTaskContext & { providerTaskId: string }, signal?: AbortSignal): Promise<CanvasDownloadOutcome>;
  cancel?(context: CanvasTaskContext & { providerTaskId: string }, signal?: AbortSignal): Promise<CanvasCancelOutcome>;
}
