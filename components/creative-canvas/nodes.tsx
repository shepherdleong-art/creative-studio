'use client';

/**
 * 四类画布节点。运行投影只通过 useNodeRuntime 订阅，任务轮询不会重渲染未变化的节点，
 * 也不会把正在输入的文本框替换掉。
 */

import { memo, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { detachedReferenceSlots, resolveCanvasMentions } from '@/lib/creative-canvas/graph';
import type { CanvasReferenceRole, CanvasReferenceSlot } from '@/lib/creative-canvas/types';
import { canvasAssetUrl } from './api';
import type { CanvasFlowNode, CanvasEditorController } from './editor-store';
import { useNodeRuntime } from './runtime-store';
import { CanvasNodeContext } from './node-context';

export const CANVAS_NODE_TYPES = {
  material: 'material',
  prompt: 'prompt',
  'image-generation': 'image-generation',
  'video-generation': 'video-generation',
} as const;

function useController(): CanvasEditorController {
  const context = useContext(CanvasNodeContext);
  if (!context) throw new Error('画布节点必须在 CanvasNodeContext 内使用');
  return context.controller;
}

function DragHandle() {
  return (
    <span className="sc-canvas-drag-handle" data-testid="node-drag-handle" aria-hidden="true">⠿</span>
  );
}

function TitleInput({ nodeId, value, placeholder }: { nodeId: string; value: string; placeholder: string }) {
  const controller = useController();
  return (
    <input
      className="sc-canvas-input w-full bg-transparent text-[13px] font-medium outline-none"
      value={value}
      placeholder={placeholder}
      data-testid="node-title"
      onChange={(event) => controller.updateNodeData(
        nodeId,
        { title: event.target.value },
        { coalesce: `title:${nodeId}` },
      )}
    />
  );
}

const STATUS_TEXT: Record<string, string> = {
  waiting_input: '等待上游',
  queued: '排队中',
  preparing: '准备中',
  submitting: '提交中',
  polling: '生成中',
  downloading: '下载保存中',
  download_failed: '下载失败',
  succeeded: '已完成',
  failed: '失败',
  blocked: '上游未完成',
  cancelled: '已停止',
  uncertain: '待核查',
  resume_pending: '待继续',
};

function NodeStatus({ nodeId }: { nodeId: string }) {
  const controller = useController();
  const runtime = useNodeRuntime(controller.runtime, nodeId);
  const [busy, setBusy] = useState(false);
  if (!runtime?.activeTaskId && !runtime?.activeTaskError) return null;
  const phase = runtime.activeTaskPhase ?? 'queued';
  const taskId = runtime.activeTaskIdForCancel;
  const tone = phase === 'failed' || phase === 'download_failed' || phase === 'blocked'
    ? 'text-[var(--color-fail)]'
    : phase === 'uncertain'
      ? 'text-[var(--color-warn)]'
      : 'text-ink-secondary';

  const act = async (action: 'cancel' | 'download-retry' | 'resume' | 'reconcile', body?: unknown) => {
    if (!taskId) return;
    setBusy(true);
    try {
      await fetch(`/api/canvas/tasks/${taskId}/${action}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={`mt-2 text-[11px] ${tone}`} data-canvas-status={phase}>
      {STATUS_TEXT[phase] ?? phase}
      {runtime.activeTaskError ? `：${runtime.activeTaskError}` : ''}
      {taskId ? (
        <div className="mt-1 flex flex-wrap items-center gap-1">
          {phase === 'download_failed' ? (
            <button
              type="button"
              className="sc-canvas-button"
              data-testid="retry-download"
              disabled={busy}
              onClick={() => { void act('download-retry'); }}
            >
              重试下载
            </button>
          ) : null}
          {phase === 'uncertain' ? (
            <>
              <button
                type="button"
                className="sc-canvas-button"
                data-testid="reconcile-not-created"
                disabled={busy}
                onClick={() => { void act('reconcile', { outcome: 'not_created' }); }}
              >
                核查：远端未创建
              </button>
              <button
                type="button"
                className="sc-canvas-button"
                data-testid="reconcile-remote-id"
                disabled={busy}
                onClick={() => {
                  const providerTaskId = window.prompt('粘贴远端任务 ID');
                  if (providerTaskId) void act('reconcile', { outcome: 'remote_id', providerTaskId });
                }}
              >
                核查：填入远端 ID
              </button>
            </>
          ) : null}
          {phase === 'resume_pending' ? (
            <button
              type="button"
              className="sc-canvas-button"
              data-testid="resume-task"
              disabled={busy}
              onClick={() => { void act('resume'); }}
            >
              继续任务
            </button>
          ) : null}
          {['waiting_input', 'queued', 'preparing', 'polling', 'downloading'].includes(phase) ? (
            <button
              type="button"
              className="sc-canvas-button"
              data-testid="cancel-task"
              disabled={busy}
              onClick={() => { void act('cancel'); }}
            >
              停止
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * 媒体进入视口才请求：50 个节点时视口外素材不占带宽、不持续解码。
 * 首次进入后保持加载（用户缩放回来不必重新请求），仍只保留一个视频在播放。
 */
function useInViewport<T extends HTMLElement>(enabled: boolean): { ref: React.RefObject<T | null>; visible: boolean } {
  const ref = useRef<T | null>(null);
  // 环境不支持 IntersectionObserver 时直接视为可见（初始化时决定，不在 effect 里改状态）
  const [visible, setVisible] = useState(() => typeof IntersectionObserver === 'undefined');
  useEffect(() => {
    // enabled 必须在依赖里：结果是在挂载之后才出现的，只依赖 visible 会导致
    // 容器首次渲染时 ref 还是 null，之后再也不建立观察器，预览永远不加载。
    if (!enabled || visible) return undefined;
    const element = ref.current;
    if (!element) return undefined;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setVisible(true);
        observer.disconnect();
      }
    }, { rootMargin: '200px' });
    observer.observe(element);
    return () => observer.disconnect();
  }, [enabled, visible]);
  return { ref, visible };
}

function ResultPreview({ nodeId, mediaKind }: { nodeId: string; mediaKind: 'image' | 'video' }) {
  const controller = useController();
  const runtime = useNodeRuntime(controller.runtime, nodeId);
  const [zoomed, setZoomed] = useState(false);
  const assetId = runtime?.currentAssetId;
  const { ref: viewportRef, visible } = useInViewport<HTMLDivElement>(assetId !== null);
  if (!assetId) return null;
  return (
    <div className="mt-2" data-canvas-result={assetId} ref={viewportRef}>
      <div className="overflow-hidden rounded-lg bg-surface-subtle" data-canvas-media-loaded={visible ? 'true' : 'false'}>
        {!visible ? (
          <div className="flex h-24 items-center justify-center text-[11px] text-ink-tertiary">滚动到可见区域后加载预览</div>
        ) : mediaKind === 'image' ? (
          <img
            src={canvasAssetUrl(assetId)}
            alt="当前结果"
            className="nodrag nopan block h-auto w-full cursor-zoom-in"
            data-testid="canvas-result-image"
            onClick={() => setZoomed(true)}
          />
        ) : (
          <video
            src={canvasAssetUrl(assetId)}
            controls
            preload="metadata"
            className="block h-auto w-full"
            data-testid="canvas-result-video"
            onPlay={(event) => {
              // 默认只保留一个正在播放的预览，避免视口外视频持续解码
              for (const other of document.querySelectorAll('video')) {
                if (other !== event.currentTarget) other.pause();
              }
            }}
          />
        )}
      </div>
      <div className="mt-1 flex items-center gap-2">
        <a
          className="sc-canvas-button nodrag nopan"
          href={`${canvasAssetUrl(assetId)}?download=1`}
          data-testid="download-result"
          download
        >
          下载成品
        </a>
      </div>
      {zoomed ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-[var(--color-media-scrim)] p-8"
          data-testid="result-lightbox"
          onClick={() => setZoomed(false)}
          role="presentation"
        >
          <img src={canvasAssetUrl(assetId)} alt="当前结果" className="max-h-full max-w-full rounded-lg" />
        </div>
      ) : null}
    </div>
  );
}

export const MaterialNode = memo(function MaterialNode({ id, data, selected, positionAbsoluteX, positionAbsoluteY }: NodeProps<CanvasFlowNode>) {
  const controller = useController();
  const inputRef = useRef<HTMLInputElement>(null);
  const assetId = data.assetId ?? null;
  const mediaKind = data.mediaKind ?? 'image';
  const [busy, setBusy] = useState(false);

  const onPick = useCallback(async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    await controller.uploadIntoNode(id, file);
    setBusy(false);
  }, [controller, id]);

  return (
    <div
      className={`sc-canvas-node w-[200px] ${selected ? 'sc-canvas-node-selected' : ''}`}
      data-node-kind="material"
      data-node-position={`${Math.round(positionAbsoluteX)},${Math.round(positionAbsoluteY)}`}
    >
      <div className="flex items-center justify-between gap-2">
        <DragHandle />
        <TitleInput nodeId={id} value={String(data.title ?? '')} placeholder="素材名称" />
        <span className="rounded bg-surface-subtle px-1.5 py-0.5 text-[10px] text-ink-tertiary">
          {mediaKind === 'image' ? '图片' : mediaKind === 'video' ? '视频' : '音频'}
        </span>
      </div>
      <div className="mt-2">
        {assetId ? (
          mediaKind === 'image' ? (
            <img src={canvasAssetUrl(assetId)} alt="素材" className="block w-full rounded-lg" />
          ) : mediaKind === 'video' ? (
            <video src={canvasAssetUrl(assetId)} controls preload="metadata" className="block w-full rounded-lg" />
          ) : (
            <audio src={canvasAssetUrl(assetId)} controls className="block w-full" />
          )
        ) : (
          <div className="flex h-20 items-center justify-center rounded-lg bg-surface-subtle text-[11px] text-ink-tertiary">
            尚未导入素材
          </div>
        )}
      </div>
      <button
        type="button"
        className="sc-canvas-button mt-2 w-full"
        disabled={busy}
        onClick={() => inputRef.current?.click()}
        data-testid="material-upload"
      >
        {busy ? '导入中…' : assetId ? '替换素材' : '选择本地文件'}
      </button>
      <input
        ref={inputRef}
        type="file"
        accept="image/*,video/*,audio/*"
        className="hidden"
        data-testid="material-file-input"
        onChange={(event) => {
          void onPick(event.target.files?.[0]);
          event.target.value = '';
        }}
      />
      <Handle type="source" position={Position.Right} />
    </div>
  );
});

export const PromptNode = memo(function PromptNode({ id, data, selected, positionAbsoluteX, positionAbsoluteY }: NodeProps<CanvasFlowNode>) {
  const controller = useController();
  return (
    <div
      className={`sc-canvas-node w-[220px] ${selected ? 'sc-canvas-node-selected' : ''}`}
      data-node-kind="prompt"
      data-node-position={`${Math.round(positionAbsoluteX)},${Math.round(positionAbsoluteY)}`}
    >
      <div className="flex items-center gap-2">
        <DragHandle />
        <TitleInput nodeId={id} value={String(data.title ?? '')} placeholder="提示词名称" />
      </div>
      <textarea
        className="sc-canvas-input mt-2 h-20 w-full resize-none bg-transparent text-[12px] outline-none"
        value={String(data.text ?? '')}
        placeholder="可复用的文本"
        data-testid="prompt-text"
        onChange={(event) => controller.updateNodeData(
          id,
          { text: event.target.value },
          { coalesce: `text:${id}` },
        )}
      />
      <Handle type="source" position={Position.Right} />
    </div>
  );
});

const ROLE_LABELS: Array<{ value: CanvasReferenceRole; label: string }> = [
  { value: 'subject', label: '主体' },
  { value: 'product', label: '产品' },
  { value: 'style', label: '风格' },
  { value: 'scene', label: '场景' },
  { value: 'first-frame', label: '首帧' },
  { value: 'last-frame', label: '尾帧' },
  { value: 'reference', label: '参考' },
  { value: 'camera', label: '运镜' },
  { value: 'audio', label: '音频' },
];

/** 模式在界面上用中文呈现：枚举值本身是合同常量，不直接暴露给用户。 */
const MODE_LABELS: Record<string, string> = {
  'text-to-image': '文生图',
  'image-to-image': '图生图',
  'text-to-video': '文生视频',
  'image-to-video': '图生视频（首帧／首尾帧）',
  'video-to-video': '视频生视频（参考视频）',
  'reference-to-video': '参考生成（参考图／音频）',
};

const REFERENCE_MODE_HINTS: Record<string, string> = {
  'video-to-video': '至少接 1 段参考视频（2–15 秒）；参考视频／音频经 COS 中转提交，需已配置 CREATIVE_STUDIO_COS_*。',
  'reference-to-video': '至少接 1 张参考图，可再加参考视频／音频；视频与音频经 COS 中转提交。',
};

function ReferenceRow({
  nodeId,
  slot,
  index,
  total,
  connected,
  assetId,
}: {
  nodeId: string;
  slot: CanvasReferenceSlot;
  index: number;
  total: number;
  connected: boolean;
  assetId: string | null;
}) {
  const controller = useController();
  return (
    <div
      className={`sc-canvas-reference ${connected ? '' : 'sc-canvas-reference-detached'}`}
      data-reference={slot.label}
      data-detached={connected ? 'false' : 'true'}
    >
      <div className="flex items-center gap-2">
        <span className="sc-canvas-mention">@参考{slot.label}</span>
        {assetId ? (
          <img src={canvasAssetUrl(assetId)} alt="" className="h-8 w-8 rounded object-cover" />
        ) : (
          <span className="flex h-8 w-8 items-center justify-center rounded bg-surface-subtle text-[10px] text-ink-tertiary">
            {slot.sourceKind === 'text' ? '文本' : '—'}
          </span>
        )}
        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            className="sc-canvas-icon-button"
            aria-label="上移"
            disabled={index === 0}
            onClick={() => controller.moveReference(nodeId, slot.refId, -1)}
          >
            ↑
          </button>
          <button
            type="button"
            className="sc-canvas-icon-button"
            aria-label="下移"
            disabled={index === total - 1}
            onClick={() => controller.moveReference(nodeId, slot.refId, 1)}
          >
            ↓
          </button>
          <button
            type="button"
            className="sc-canvas-icon-button"
            aria-label={`断开 @参考${slot.label}`}
            data-testid={`detach-ref-${slot.label}`}
            onClick={() => controller.disconnectReference(nodeId, slot.refId)}
          >
            ×
          </button>
        </div>
      </div>
      <div className="mt-1 flex items-center gap-1">
        <select
          className="sc-canvas-select"
          value={slot.role}
          aria-label={`@参考${slot.label} 用途`}
          onChange={(event) => controller.updateReference(nodeId, slot.refId, {
            role: event.target.value as CanvasReferenceRole,
          })}
        >
          {ROLE_LABELS.map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
        <input
          className="sc-canvas-input flex-1 bg-transparent text-[11px] outline-none"
          placeholder="说明（可选）"
          defaultValue={slot.note}
          onBlur={(event) => controller.updateReference(nodeId, slot.refId, { note: event.target.value })}
        />
      </div>
      {!connected ? <div className="mt-1 text-[10px] text-[var(--color-fail)]">连接已断开，重新连接后恢复</div> : null}
    </div>
  );
}

export const GenerationNode = memo(function GenerationNode({
  id,
  type,
  data,
  selected,
  positionAbsoluteX,
  positionAbsoluteY,
}: NodeProps<CanvasFlowNode>) {
  const context = useContext(CanvasNodeContext);
  if (!context) throw new Error('画布节点必须在 CanvasNodeContext 内使用');
  const { controller, capabilities, graph, resolveSourceAssetId } = context;
  // 媒体类型由节点种类决定，不能由当前模式推断（否则切模式会换掉整个能力列表）
  const mediaKind = type === 'video-generation' ? 'video' : 'image';
  const available = capabilities.filter((capability) => capability.mediaKind === mediaKind);
  const capability = available.find((candidate) => candidate.key === data.modelKey) ?? null;

  const references = data.references ?? [];
  const connectedSources = useMemo(
    () => new Set(graph.edges.filter((edge) => edge.target === id).map((edge) => edge.source)),
    [graph.edges, id],
  );
  const detached = useMemo(() => {
    const node = graph.nodes.find((candidate) => candidate.id === id);
    if (!node || (node.kind !== 'image-generation' && node.kind !== 'video-generation')) return new Set<string>();
    return new Set(detachedReferenceSlots(graph, node).map((slot) => slot.refId));
  }, [graph, id]);

  const mentionIssues = useMemo(() => {
    const node = graph.nodes.find((candidate) => candidate.id === id);
    if (!node || (node.kind !== 'image-generation' && node.kind !== 'video-generation')) {
      return { unknownLabels: [] as number[], detachedRefIds: [] as string[] };
    }
    const resolution = resolveCanvasMentions(graph, node, String(data.prompt ?? ''));
    return { unknownLabels: resolution.unknownLabels, detachedRefIds: resolution.detachedRefIds };
  }, [graph, id, data.prompt]);

  const onRun = useCallback(() => { void controller.runNode(id); }, [controller, id]);
  const onBranch = useCallback(() => { void controller.previewBranch(id, true); }, [controller, id]);

  const modeOptions = capability?.modes ?? (mediaKind === 'video'
    ? ['text-to-video', 'image-to-video']
    : ['text-to-image', 'image-to-image']);

  return (
    <div
      className={`sc-canvas-node w-[300px] ${selected ? 'sc-canvas-node-selected' : ''}`}
      data-node-kind={mediaKind === 'video' ? 'video-generation' : 'image-generation'}
      data-node-position={`${Math.round(positionAbsoluteX)},${Math.round(positionAbsoluteY)}`}
    >
      <Handle type="target" position={Position.Left} />
      <div className="flex items-center justify-between gap-2">
        <DragHandle />
        <TitleInput nodeId={id} value={String(data.title ?? '')} placeholder="节点名称" />
        <span className="rounded bg-surface-subtle px-1.5 py-0.5 text-[10px] text-ink-tertiary">
          {mediaKind === 'video' ? '视频' : '图片'}
        </span>
      </div>

      <label className="mt-2 block text-[11px] text-ink-secondary">模型</label>
      <select
        className="sc-canvas-select w-full"
        value={data.modelKey ?? ''}
        data-testid="model-select"
        onChange={(event) => controller.updateNodeData(id, { modelKey: event.target.value || null })}
      >
        <option value="">未选择</option>
        {available.map((candidate) => (
          <option key={candidate.key} value={candidate.key}>{candidate.displayName}</option>
        ))}
      </select>

      {capability ? (
        <div className="mt-1 text-[10px] text-ink-tertiary" data-testid="capability-evidence">
          {capability.evidence === 'verified'
            ? '能力状态：已通过真实链路验证'
            : capability.evidence === 'mapped'
              ? '能力状态：请求映射已验证，画布真实样例待补'
              : '能力状态：仅平台资料，公司转发未核对'}
        </div>
      ) : null}

      <label className="mt-2 block text-[11px] text-ink-secondary">模式</label>
      <select
        className="sc-canvas-select w-full"
        value={data.generationMode ?? modeOptions[0]}
        data-testid="mode-select"
        onChange={(event) => controller.updateNodeData(id, {
          generationMode: event.target.value as CanvasFlowNode['data']['generationMode'],
        })}
      >
        {(modeOptions as string[]).map((mode) => (
          <option key={mode} value={mode}>{MODE_LABELS[mode] ?? mode}</option>
        ))}
      </select>

      {REFERENCE_MODE_HINTS[String(data.generationMode)] ? (
        <div className="mt-1 text-[10px] text-ink-tertiary" data-testid="mode-hint">
          {REFERENCE_MODE_HINTS[String(data.generationMode)]}
        </div>
      ) : null}

      {capability && capability.parameters.length > 0 ? (
        <div className="mt-2 space-y-1">
          {capability.parameters.map((parameter) => (
            <div key={parameter.key} className="flex items-center gap-2">
              <span className="text-[11px] text-ink-secondary">{parameter.label}</span>
              {parameter.type === 'enum' ? (
                <select
                  className="sc-canvas-select flex-1"
                  value={String(data.parameters?.[parameter.key] ?? parameter.default ?? '')}
                  aria-label={parameter.label}
                  onChange={(event) => controller.updateNodeData(id, {
                    parameters: { ...(data.parameters ?? {}), [parameter.key]: event.target.value },
                  })}
                >
                  {(parameter.options ?? []).map((option) => (
                    <option key={option} value={option}>{option}</option>
                  ))}
                </select>
              ) : parameter.type === 'boolean' ? (
                <input
                  type="checkbox"
                  aria-label={parameter.label}
                  checked={Boolean(data.parameters?.[parameter.key] ?? parameter.default ?? false)}
                  onChange={(event) => controller.updateNodeData(id, {
                    parameters: { ...(data.parameters ?? {}), [parameter.key]: event.target.checked },
                  })}
                />
              ) : (
                <input
                  className="sc-canvas-input flex-1 bg-transparent text-[11px] outline-none"
                  type="number"
                  aria-label={parameter.label}
                  value={Number(data.parameters?.[parameter.key] ?? parameter.default ?? 0)}
                  onChange={(event) => controller.updateNodeData(id, {
                    parameters: { ...(data.parameters ?? {}), [parameter.key]: Number(event.target.value) },
                  }, { coalesce: `param:${id}:${parameter.key}` })}
                />
              )}
            </div>
          ))}
        </div>
      ) : null}

      <textarea
        className="sc-canvas-input mt-2 h-20 w-full resize-none bg-transparent text-[12px] outline-none"
        placeholder="提示词，可用 @参考1 引用输入"
        value={String(data.prompt ?? '')}
        data-testid="generation-prompt"
        onChange={(event) => controller.updateNodeData(
          id,
          { prompt: event.target.value },
          { coalesce: `prompt:${id}` },
        )}
      />

      {references.length > 0 ? (
        <div className="mt-2 space-y-1" data-testid="reference-list">
          {references.map((slot, index) => (
            <ReferenceRow
              key={slot.refId}
              nodeId={id}
              slot={slot}
              index={index}
              total={references.length}
              connected={connectedSources.has(slot.sourceNodeId)}
              assetId={resolveSourceAssetId(slot.sourceNodeId)}
            />
          ))}
        </div>
      ) : null}

      {mentionIssues.unknownLabels.length > 0 ? (
        <div className="mt-2 text-[11px] text-[var(--color-fail)]" data-testid="mention-unknown">
          提示词提到的 @参考{mentionIssues.unknownLabels.join('、@参考')} 不存在
        </div>
      ) : null}
      {mentionIssues.detachedRefIds.length > 0 ? (
        <div className="mt-2 text-[11px] text-[var(--color-fail)]" data-testid="mention-detached">
          提示词提到的参考已经断开连接
        </div>
      ) : null}
      {detached.size > 0 && mentionIssues.detachedRefIds.length === 0 ? (
        <div className="mt-1 text-[11px] text-ink-tertiary">{detached.size} 个失效引用不参与提交</div>
      ) : null}

      <div className="mt-3 flex items-center gap-2">
        <button type="button" className="sc-canvas-button sc-canvas-button-primary flex-1" data-testid="run-node" onClick={onRun}>
          生成
        </button>
        <button type="button" className="sc-canvas-button" data-testid="run-branch" onClick={onBranch}>
          运行分支
        </button>
      </div>

      <NodeStatus nodeId={id} />
      <ResultPreview nodeId={id} mediaKind={mediaKind} />
      <Handle type="source" position={Position.Right} />
    </div>
  );
});
