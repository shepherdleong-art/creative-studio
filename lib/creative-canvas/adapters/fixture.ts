/**
 * fixture 适配器：只用于隔离测试，不访问真实公司模型与 COS。
 *
 * 提交次数、轮询次数、失败与迟到响应都由测试脚本控制；默认产物是真正可以解码的 PNG。
 * 生产环境通过 config.ts 的标记数据根检查拒绝 fixture，不会走到这里。
 */

import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import {
  CanvasAdapterError,
  type CanvasDownloadOutcome,
  type CanvasPollOutcome,
  type CanvasSubmitOutcome,
  type CanvasTaskAdapter,
  type CanvasTaskContext,
} from './types.ts';

export type FixtureSubmitBehavior = 'succeed' | 'fail' | 'uncertain';

export interface FixtureTaskScript {
  submit?: FixtureSubmitBehavior;
  /** 成功后需要几次轮询才返回完成（默认 1）。 */
  pollsBeforeSuccess?: number;
  poll?: 'succeed' | 'fail';
  download?: 'succeed' | 'fail';
  /** 每个任务的第一次下载失败，之后成功：用于验证「补下载」路径。 */
  failFirstDownload?: boolean;
  /** 每次阶段调用的延迟，用于制造可控的重叠与迟到响应。 */
  delayMs?: number;
  bytes?: Buffer;
  mimeType?: string;
}

export interface FixtureSubmission {
  taskId: string;
  nodeId: string;
  capabilityKey: string;
  prompt: string;
  inputs: Array<{ refId: string; kind: string; assetId: string | null; textContent: string | null }>;
  providerTaskId: string;
  at: string;
}

export interface CanvasFixtureAdapterOptions {
  scriptFor?: (context: CanvasTaskContext) => FixtureTaskScript;
  defaultScript?: FixtureTaskScript;
  now?: () => Date;
}

export interface CanvasFixtureAdapter extends CanvasTaskAdapter {
  readonly submissions: FixtureSubmission[];
  readonly prepareCalls: string[];
  readonly pollCalls: string[];
  readonly downloadCalls: string[];
  submitCountForNode(nodeId: string): number;
  setScriptForNode(nodeId: string, script: FixtureTaskScript): void;
}

async function defaultImageBytes(): Promise<Buffer> {
  return sharp({
    create: { width: 24, height: 24, channels: 3, background: '#4a7dff' },
  }).png().toBuffer();
}

function defaultVideoBytes(): Buffer {
  // 结构合法的 MP4 容器头 + 占位负载；fixture 只验证登记与交付链路。
  const header = Buffer.alloc(16);
  header.writeUInt32BE(24, 0);
  header.write('ftypisom', 4, 'latin1');
  return Buffer.concat([header, Buffer.alloc(240, 3)]);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

export function createCanvasFixtureAdapter(
  options: CanvasFixtureAdapterOptions = {},
): CanvasFixtureAdapter {
  const now = options.now ?? (() => new Date());
  const scriptedByNode = new Map<string, FixtureTaskScript>();
  const polls = new Map<string, number>();
  const downloads = new Map<string, number>();
  const submissions: FixtureSubmission[] = [];
  const prepareCalls: string[] = [];
  const pollCalls: string[] = [];
  const downloadCalls: string[] = [];

  const scriptFor = (context: CanvasTaskContext): FixtureTaskScript => (
    scriptedByNode.get(context.task.nodeId)
    ?? options.scriptFor?.(context)
    ?? options.defaultScript
    ?? {}
  );

  const wait = async (script: FixtureTaskScript): Promise<void> => {
    if (script.delayMs && script.delayMs > 0) await sleep(script.delayMs);
  };

  return {
    kind: 'fixture',
    submissions,
    prepareCalls,
    pollCalls,
    downloadCalls,
    submitCountForNode(nodeId: string): number {
      return submissions.filter((submission) => submission.nodeId === nodeId).length;
    },
    setScriptForNode(nodeId: string, script: FixtureTaskScript): void {
      scriptedByNode.set(nodeId, script);
    },
    async prepare(context: CanvasTaskContext): Promise<void> {
      prepareCalls.push(context.task.id);
      await wait(scriptFor(context));
    },
    async submit(context: CanvasTaskContext): Promise<CanvasSubmitOutcome> {
      const script = scriptFor(context);
      await wait(script);
      const behavior = script.submit ?? 'succeed';
      if (behavior === 'fail') {
        throw new CanvasAdapterError('submit', 'fixture 提交被拒绝', { code: 'fixture_submit_rejected' });
      }
      if (behavior === 'uncertain') {
        // 已经可能送达上游：调用方必须按待核查处理
        submissions.push({
          taskId: context.task.id,
          nodeId: context.task.nodeId,
          capabilityKey: context.capabilityKey,
          prompt: context.prompt,
          inputs: context.inputs.map((input) => ({
            refId: input.refId,
            kind: input.kind,
            assetId: input.assetId,
            textContent: input.textContent,
          })),
          providerTaskId: '(unknown)',
          at: now().toISOString(),
        });
        throw new CanvasAdapterError('submit', 'fixture 提交响应丢失', { uncertain: true, code: 'fixture_submit_uncertain' });
      }
      const providerTaskId = `fixture-${randomUUID()}`;
      submissions.push({
        taskId: context.task.id,
        nodeId: context.task.nodeId,
        capabilityKey: context.capabilityKey,
        prompt: context.prompt,
        inputs: context.inputs.map((input) => ({
          refId: input.refId,
          kind: input.kind,
          assetId: input.assetId,
          textContent: input.textContent,
        })),
        providerTaskId,
        at: now().toISOString(),
      });
      return { providerTaskId };
    },
    async poll(context: CanvasTaskContext & { providerTaskId: string }): Promise<CanvasPollOutcome> {
      const script = scriptFor(context);
      pollCalls.push(context.task.id);
      await wait(script);
      if (script.poll === 'fail') {
        return { status: 'failed', code: 'fixture_poll_failed', message: 'fixture 生成失败' };
      }
      const seen = (polls.get(context.task.id) ?? 0) + 1;
      polls.set(context.task.id, seen);
      const required = script.pollsBeforeSuccess ?? 1;
      return seen >= required ? { status: 'succeeded' } : { status: 'running' };
    },
    async download(context: CanvasTaskContext & { providerTaskId: string }): Promise<CanvasDownloadOutcome> {
      const script = scriptFor(context);
      downloadCalls.push(context.task.id);
      const attempt = (downloads.get(context.task.id) ?? 0) + 1;
      downloads.set(context.task.id, attempt);
      await wait(script);
      if (script.failFirstDownload && attempt === 1) {
        throw new CanvasAdapterError('download', 'fixture 首次下载失败', { code: 'fixture_download_failed' });
      }
      if (script.download === 'fail') {
        throw new CanvasAdapterError('download', 'fixture 下载失败', { code: 'fixture_download_failed' });
      }
      const bytes = script.bytes
        ?? (context.mediaKind === 'image' ? await defaultImageBytes() : defaultVideoBytes());
      return {
        bytes,
        mimeType: script.mimeType ?? (context.mediaKind === 'image' ? 'image/png' : 'video/mp4'),
        filename: `${context.task.nodeId}.${context.mediaKind === 'image' ? 'png' : 'mp4'}`,
      };
    },
  };
}
