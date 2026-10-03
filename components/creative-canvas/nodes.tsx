'use client';

/**
 * 四类画布节点。运行投影只通过 useNodeRuntime 订阅，任务轮询不会重渲染未变化的节点，
 * 也不会把正在输入的文本框替换掉。
 */

import { memo, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Handle, NodeResizeControl, Position, ResizeControlVariant, type NodeProps } from '@xyflow/react';
import { resolveCanvasMentions } from '@/lib/creative-canvas/graph';
import {
  filterMentionCandidates,
  findActiveMentionQuery,
  replaceMentionWithLabel,
  type MentionCandidate,
  type MentionQuery,
} from '@/lib/creative-canvas/mention-completion';
import { nodeKindSpec } from '@/lib/creative-canvas/node-kinds';
import type { CanvasGenerationMode, CanvasNodeKind, CanvasReferenceSlot } from '@/lib/creative-canvas/types';
import { canvasApi, canvasAssetUrl } from './api';
import type { CanvasFlowNode, CanvasEditorController } from './editor-store';
import { useNodeRuntime } from './runtime-store';
import { CanvasNodeContext } from './node-context';
import { useNodeTextField } from './use-node-text-field';
import { DraftActions } from './DraftActions';
import { AssetLightbox } from './AssetLightbox';
import { pauseAllMediaExcept, registerMedia, unregisterMedia } from './media-registry';

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

/**
 * 节点文本输入统一走 useNodeTextField：聚焦期间本地草稿驱动，不经受控往返，
 * 中文组合输入与逐键性能问题在 hook 内根治（见 use-node-text-field.ts）。
 */

function DragHandle() {
  return (
    <span className="sc-canvas-drag-handle" data-testid="node-drag-handle" aria-hidden="true">⠿</span>
  );
}

/** 节点拖拽改宽（对标主流节点画布，选中时显示）：四角手柄 + 右缘拖条，宽度持久化在 size.width。 */
const RESIZE_CORNERS = ['top-left', 'top-right', 'bottom-left', 'bottom-right'] as const;

function WidthResizeHandle({ kind, selected }: { kind: CanvasNodeKind; selected?: boolean }) {
  const controller = useController();
  if (!selected) return null;
  const minWidth = nodeKindSpec(kind).defaultWidth;
  return (
    <>
      {RESIZE_CORNERS.map((position) => (
        <NodeResizeControl
          key={position}
          position={position}
          variant={ResizeControlVariant.Handle}
          resizeDirection="horizontal"
          minWidth={minWidth}
          maxWidth={720}
          onResizeStart={controller.onNodeResizeStart}
          style={{ width: 14, height: 14 }}
        />
      ))}
      <NodeResizeControl
        position="right"
        variant={ResizeControlVariant.Line}
        resizeDirection="horizontal"
        minWidth={minWidth}
        maxWidth={720}
        onResizeStart={controller.onNodeResizeStart}
        /* 拖条整体放在节点外侧（left:100% 起向外），加宽热区也不遮挡节点内按钮 */
        style={{ border: 'none', width: 10, transform: 'translate(0, 0)', cursor: 'ew-resize' }}
      />
    </>
  );
}

/**
 * 种类图标：彩色小图标强化节点类型识别（颜色走设计令牌），
 * 形状对应注册表 iconKey。素材节点另保留动态媒体类型徽章。
 */
function KindIcon({ iconKey }: { iconKey: 'material' | 'prompt' | 'image' | 'video' }) {
  const config = {
    material: {
      color: 'var(--color-ink-secondary)', label: '素材',
      path: (<><rect x="3" y="5" width="18" height="14" rx="2" /><circle cx="8.5" cy="10" r="1.5" /><path d="m21 15-5-5L5 21" /></>),
    },
    prompt: {
      color: 'var(--color-accent)', label: '提示词',
      path: <path d="M4 6h16M4 12h10M4 18h7" />,
    },
    image: {
      color: 'var(--color-ok)', label: '图片生成',
      path: (<><path d="M15 4h-5l-2.5 3H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3.5L15 4z" /><circle cx="12" cy="13" r="3" /></>),
    },
    video: {
      color: 'var(--color-warn)', label: '视频生成',
      path: (<><rect x="2" y="5" width="20" height="14" rx="2" /><path d="m10 9 5 3-5 3V9z" /></>),
    },
  }[iconKey];
  return (
    <span className="sc-canvas-kind-icon" style={{ color: config.color }} title={config.label} aria-hidden="true">
      <svg
        viewBox="0 0 24 24"
        width="14"
        height="14"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {config.path}
      </svg>
    </span>
  );
}

function TitleInput({ nodeId, value, placeholder }: { nodeId: string; value: string; placeholder: string }) {
  const controller = useController();
  const { field: ime } = useNodeTextField(value, useCallback(
    (next) => controller.updateNodeData(nodeId, { title: next }, { coalesce: `title:${nodeId}` }),
    [controller, nodeId],
  ));
  return (
    <input
      className="nodrag sc-canvas-input w-full bg-transparent text-[13px] font-medium outline-none"
      {...ime}
      placeholder={placeholder}
      data-testid="node-title"
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

/**
 * 注册到媒体注册表的视频播放器：同一时刻只保留一个在播
 * （避免视口外视频持续解码），播放列表／候选列表后续复用同一机制。
 */
function RegisteredVideo({ nodeId, src, className, testId }: {
  nodeId: string;
  src: string;
  className: string;
  testId?: string;
}) {
  const ref = useRef<HTMLVideoElement | null>(null);
  useEffect(() => {
    const element = ref.current;
    if (!element) return undefined;
    registerMedia(nodeId, element);
    return () => unregisterMedia(nodeId, element);
  }, [nodeId]);
  return (
    <video
      ref={ref}
      src={src}
      controls
      preload="metadata"
      className={className}
      {...(testId ? { 'data-testid': testId } : {})}
      onPlay={(event) => pauseAllMediaExcept(nodeId, event.currentTarget)}
    />
  );
}

function NodeStatus({ nodeId }: { nodeId: string }) {
  const controller = useController();
  const runtime = useNodeRuntime(controller.runtime, nodeId);
  const [busy, setBusy] = useState(false);
  // uncertain 核查的远端 ID 行内输入（null = 未展开）
  const [remoteIdInput, setRemoteIdInput] = useState<string | null>(null);
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
      await canvasApi.taskAction(taskId, action, body);
    } finally {
      setBusy(false);
    }
  };

  const submitRemoteId = () => {
    const providerTaskId = remoteIdInput?.trim();
    if (!providerTaskId) return;
    setRemoteIdInput(null);
    void act('reconcile', { outcome: 'remote_id', providerTaskId });
  };

  return (
    <div className={`mt-2 text-[11px] ${tone}`} data-canvas-status={phase}>
      {STATUS_TEXT[phase] ?? phase}
      {runtime.activeTaskError ? `：${runtime.activeTaskError}` : ''}
      {/* 并发多变体：多任务并存时按变体逐个显示阶段 */}
      {runtime.activeTasks.length > 1 ? (
        <div className="mt-1 flex flex-wrap items-center gap-1" data-testid="variant-status-row">
          {runtime.activeTasks.map((task) => (
            <span key={task.taskId} className="rounded bg-surface-subtle px-1.5 py-0.5 text-[10px]">
              #{task.variantIndex + 1} {STATUS_TEXT[task.phase] ?? task.phase}
            </span>
          ))}
        </div>
      ) : null}
      {taskId ? (
        <div className="mt-1 flex flex-wrap items-center gap-1">
          {phase === 'download_failed' ? (
            <button
              type="button"
              className="nodrag sc-canvas-button"
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
                className="nodrag sc-canvas-button"
                data-testid="reconcile-not-created"
                disabled={busy}
                onClick={() => { void act('reconcile', { outcome: 'not_created' }); }}
              >
                核查：远端未创建
              </button>
              <button
                type="button"
                className="nodrag sc-canvas-button"
                data-testid="reconcile-remote-id"
                disabled={busy}
                onClick={() => setRemoteIdInput(remoteIdInput === null ? '' : null)}
              >
                核查：填入远端 ID
              </button>
              {remoteIdInput !== null ? (
                <span className="flex items-center gap-1">
                  <input
                    className="nodrag sc-canvas-input w-36 text-[11px]"
                    placeholder="粘贴远端任务 ID"
                    value={remoteIdInput}
                    data-testid="reconcile-remote-id-input"
                    autoFocus
                    onChange={(event) => setRemoteIdInput(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') submitRemoteId();
                      if (event.key === 'Escape') setRemoteIdInput(null);
                    }}
                  />
                  <button
                    type="button"
                    className="nodrag sc-canvas-button"
                    data-testid="reconcile-remote-id-confirm"
                    disabled={busy || !remoteIdInput.trim()}
                    onClick={submitRemoteId}
                  >
                    确认
                  </button>
                </span>
              ) : null}
            </>
          ) : null}
          {phase === 'resume_pending' ? (
            <button
              type="button"
              className="nodrag sc-canvas-button"
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
              className="nodrag sc-canvas-button"
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

export const MaterialNode = memo(function MaterialNode({ id, data, selected, positionAbsoluteX, positionAbsoluteY }: NodeProps<CanvasFlowNode>) {
  const controller = useController();
  const inputRef = useRef<HTMLInputElement>(null);
  const assetId = data.assetId ?? null;
  const mediaKind = data.mediaKind ?? 'image';
  const [busy, setBusy] = useState(false);
  const [zoomed, setZoomed] = useState(false);

  const onPick = useCallback(async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    await controller.uploadIntoNode(id, file);
    setBusy(false);
  }, [controller, id]);

  return (
    <div
      className={`sc-canvas-node w-full ${selected ? 'sc-canvas-node-selected' : ''}`}
      data-node-kind="material"
      data-node-position={`${Math.round(positionAbsoluteX)},${Math.round(positionAbsoluteY)}`}
    >
      <WidthResizeHandle kind="material" selected={selected} />
      <div className="flex items-center justify-between gap-2">
        <DragHandle />
        <KindIcon iconKey="material" />
        <TitleInput nodeId={id} value={String(data.title ?? '')} placeholder="素材名称" />
        {assetId ? (
          <span className="rounded bg-surface-subtle px-1.5 py-0.5 text-[10px] text-ink-tertiary">
            {mediaKind === 'image' ? '图片' : mediaKind === 'video' ? '视频' : '音频'}
          </span>
        ) : null}
      </div>
      <div className="mt-2">
        {assetId ? (
          mediaKind === 'image' ? (
            <img
              src={canvasAssetUrl(assetId)}
              alt="素材"
              className="nodrag block w-full cursor-zoom-in rounded-lg"
              data-testid="material-image"
              onClick={() => setZoomed(true)}
            />
          ) : mediaKind === 'video' ? (
            <RegisteredVideo
              nodeId={id}
              src={canvasAssetUrl(assetId)}
              className="nodrag block w-full rounded-lg"
            />
          ) : (
            <audio src={canvasAssetUrl(assetId)} controls className="nodrag block w-full" />
          )
        ) : (
          <div className="flex h-20 items-center justify-center rounded-lg bg-surface-subtle px-2 text-center text-[11px] text-ink-tertiary">
            尚未导入素材（图片 / 视频 / 音频）
          </div>
        )}
      </div>
      <div className="mt-2 flex gap-2">
        <button
          type="button"
          className="nodrag sc-canvas-button flex-1"
          disabled={busy}
          onClick={() => inputRef.current?.click()}
          data-testid="material-upload"
        >
          {busy ? '导入中…' : assetId ? '替换素材' : '选择本地文件'}
        </button>
        {assetId ? (
          <a
            className="nodrag sc-canvas-button"
            href={`${canvasAssetUrl(assetId)}?download=1`}
            data-testid="download-material"
            download
          >
            下载
          </a>
        ) : null}
      </div>
      {mediaKind === 'video' && assetId ? <DraftActions assetId={assetId} controller={controller} position={{ x: positionAbsoluteX + 340, y: positionAbsoluteY }} /> : null}
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
      {/* 溯源连线的入口：生成节点物化结果时自动连到这里；素材节点本身不产生参考槽位 */}
      <Handle type="target" position={Position.Left} />
      {zoomed && assetId ? (
        <AssetLightbox
          assetId={assetId}
          mediaKind="image"
          onClose={() => setZoomed(false)}
          testId="material-lightbox"
        />
      ) : null}
    </div>
  );
});

export const PromptNode = memo(function PromptNode({ id, data, selected, positionAbsoluteX, positionAbsoluteY }: NodeProps<CanvasFlowNode>) {
  const controller = useController();
  const { field: ime } = useNodeTextField(String(data.text ?? ''), useCallback(
    (next) => controller.updateNodeData(id, { text: next }, { coalesce: `text:${id}` }),
    [controller, id],
  ));
  return (
    <div
      className={`sc-canvas-node w-full ${selected ? 'sc-canvas-node-selected' : ''}`}
      data-node-kind="prompt"
      data-node-position={`${Math.round(positionAbsoluteX)},${Math.round(positionAbsoluteY)}`}
    >
      <WidthResizeHandle kind="prompt" selected={selected} />
      <div className="flex items-center gap-2">
        <DragHandle />
        <KindIcon iconKey="prompt" />
        <TitleInput nodeId={id} value={String(data.title ?? '')} placeholder="提示词名称" />
      </div>
      <textarea
        className="nodrag sc-canvas-input mt-2 h-20 w-full resize-none bg-transparent text-[12px] outline-none"
        {...ime}
        placeholder="可复用的文本"
        data-testid="prompt-text"
      />
      <Handle type="source" position={Position.Right} />
    </div>
  );
});

/** 模式在界面上用中文呈现：枚举值本身是合同常量，不直接暴露给用户。 */
const MODE_LABELS: Record<string, string> = {
  'text-to-image': '文生图',
  'image-to-image': '图生图',
  'text-to-video': '文生视频',
  'image-to-video': '图生视频（首帧／首尾帧）',
  'video-to-video': '视频生视频（参考视频）',
  'reference-to-video': '参考生成（参考图／音频）',
  'frames-to-video': '智能多帧',
  'video-edit': '智能编辑',
  'video-extend': '超长视频',
};

const REFERENCE_MODE_HINTS: Record<string, string> = {
  'image-to-video': '接两张图时按列表顺序作为首帧／尾帧（↑↓ 可调换）。',
  'video-to-video': '至少接 1 段参考视频（2–15 秒）；参考视频／音频经 COS 中转提交，需已配置 CREATIVE_STUDIO_COS_*。',
  'reference-to-video': '至少接 1 张参考图，可再加参考视频／音频；视频与音频经 COS 中转提交。',
  'frames-to-video': '至少接 2 张关键帧图，模型在帧间生成连续过渡。',
  'video-edit': '至少接 1 段参考视频，提示词需含编辑类指令（替换／删除／增加／修改…）。',
  'video-extend': '至少接 1 段参考视频，提示词需含延长类指令（向前／向后延长、续写…）。',
};

/** @ 补全候选：来源节点 + 展示所需的缩略图与类型。 */
interface MentionOption extends MentionCandidate {
  assetId: string | null;
  mediaKind: 'image' | 'video' | 'audio' | 'text';
  kindLabel: string;
}

function ReferenceRow({
  nodeId,
  slot,
  index,
  total,
  assetId,
}: {
  nodeId: string;
  slot: CanvasReferenceSlot;
  index: number;
  total: number;
  assetId: string | null;
}) {
  const controller = useController();
  const { field: noteField } = useNodeTextField(String(slot.note ?? ''), useCallback(
    (next) => controller.updateReference(nodeId, slot.refId, { note: next }),
    [controller, nodeId, slot.refId],
  ));
  return (
    <div className="sc-canvas-reference" data-reference={slot.label}>
      <div className="flex items-center gap-2">
        <span className="sc-canvas-mention">@参考{slot.label}</span>
        {assetId ? (
          <img src={canvasAssetUrl(assetId)} alt="" className="h-8 w-8 rounded object-cover" />
        ) : (
          <span className="flex h-8 w-8 items-center justify-center rounded bg-surface-subtle text-[10px] text-ink-tertiary">
            {slot.sourceKind === 'text' ? '文本' : '—'}
          </span>
        )}
        <input
          className="nodrag sc-canvas-input flex-1 bg-transparent text-[11px] outline-none"
          placeholder="说明（可选）"
          {...noteField}
        />
        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            className="nodrag sc-canvas-icon-button"
            aria-label="上移"
            disabled={index === 0}
            onClick={() => controller.moveReference(nodeId, slot.refId, -1)}
          >
            ↑
          </button>
          <button
            type="button"
            className="nodrag sc-canvas-icon-button"
            aria-label="下移"
            disabled={index === total - 1}
            onClick={() => controller.moveReference(nodeId, slot.refId, 1)}
          >
            ↓
          </button>
          <button
            type="button"
            className="nodrag sc-canvas-icon-button"
            aria-label={`移除 @参考${slot.label}`}
            data-testid={`detach-ref-${slot.label}`}
            onClick={() => controller.disconnectReference(nodeId, slot.refId)}
          >
            ×
          </button>
        </div>
      </div>
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
  const [modelChangeNote, setModelChangeNote] = useState('');

  const references = useMemo(() => data.references ?? [], [data.references]);
  const mentionIssues = useMemo(() => {
    const node = graph.nodes.find((candidate) => candidate.id === id);
    if (!node || (node.kind !== 'image-generation' && node.kind !== 'video-generation')) {
      return { unknownLabels: [] as number[] };
    }
    const resolution = resolveCanvasMentions(graph, node, String(data.prompt ?? ''));
    return { unknownLabels: resolution.unknownLabels };
  }, [graph, id, data.prompt]);

  const [variantCount, setVariantCount] = useState<1 | 2 | 4>(1);
  const onRun = useCallback(() => { void controller.runNode(id, { variantCount }); }, [controller, id, variantCount]);
  const onBranch = useCallback(() => { void controller.previewBranch(id, true); }, [controller, id]);
  const runtime = useNodeRuntime(controller.runtime, id);
  // 并发多变体（v2）：有活跃任务时可追加变体（上限护栏在服务端）
  const activePhase = runtime?.activeTaskId ? (runtime.activeTaskPhase ?? 'queued') : null;
  const activeCount = runtime?.activeTasks.length ?? 0;
  const runLabel = activePhase
    ? (activeCount > 1 ? `追加变体（${activeCount} 个进行中）` : '追加变体')
    : (runtime?.currentAssetId ? '重新生成' : '生成');
  const { field: promptIme, setValue: setPromptValue } = useNodeTextField(String(data.prompt ?? ''), useCallback(
    (next) => controller.updateNodeData(id, { prompt: next }, { coalesce: `prompt:${id}` }),
    [controller, id],
  ));

  // —— @ 素材自动补全：光标落在 `@查询` token 内时弹出候选，选中即连线并插入 @参考N ——
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const [mention, setMention] = useState<MentionQuery | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);

  const mentionOptions = useMemo<MentionOption[]>(() => {
    // 只列已经连线进本节点的来源（references 槽位），不弹全画布节点
    const options: MentionOption[] = [];
    for (const slot of references) {
      const node = controller.nodes.find((candidate) => candidate.id === slot.sourceNodeId);
      if (!node) continue;
      if (node.type === 'material') {
        const assetId = (node.data.assetId as string | null) ?? null;
        const kind = node.data.mediaKind === 'video' ? 'video' : node.data.mediaKind === 'audio' ? 'audio' : 'image';
        options.push({
          nodeId: node.id,
          title: String(node.data.title ?? '') || '未命名素材',
          assetId,
          mediaKind: kind,
          kindLabel: kind === 'video' ? '视频' : kind === 'audio' ? '音频' : '图片',
          label: slot.label,
        });
      } else if (node.type === 'prompt') {
        options.push({
          nodeId: node.id,
          title: String(node.data.title ?? '') || '提示词',
          assetId: null,
          mediaKind: 'text',
          kindLabel: '文本',
          label: slot.label,
        });
      } else if (node.type === 'image-generation' || node.type === 'video-generation') {
        options.push({
          nodeId: node.id,
          title: String(node.data.title ?? '') || '生成结果',
          assetId: resolveSourceAssetId(node.id),
          mediaKind: node.type === 'video-generation' ? 'video' : 'image',
          kindLabel: node.type === 'video-generation' ? '视频' : '图片',
          label: slot.label,
        });
      }
    }
    return options;
  }, [controller.nodes, references, resolveSourceAssetId]);

  const filteredMentionOptions = useMemo(
    () => (mention ? filterMentionCandidates(mentionOptions, mention.query) : []),
    [mention, mentionOptions],
  );
  const activeMentionIndex = Math.min(mentionIndex, Math.max(filteredMentionOptions.length - 1, 0));

  const syncMentionFromDom = useCallback(() => {
    const el = promptRef.current;
    if (!el) return;
    const caret = el.selectionStart ?? el.value.length;
    setMention(findActiveMentionQuery(el.value, caret));
    setMentionIndex(0);
  }, [setMention, setMentionIndex]);

  const pickMention = useCallback((option: MentionOption) => {
    const el = promptRef.current;
    if (!el) return;
    const caret = el.selectionStart ?? el.value.length;
    const active = findActiveMentionQuery(el.value, caret);
    setMention(null);
    setMentionIndex(0);
    if (!active) return;
    const label = controller.connectReference(id, option.nodeId);
    if (label === null) return;
    const replaced = replaceMentionWithLabel(el.value, active.start, caret, label);
    setPromptValue(replaced.text);
    requestAnimationFrame(() => {
      const target = promptRef.current;
      if (!target) return;
      target.focus();
      target.setSelectionRange(replaced.caret, replaced.caret);
    });
  }, [controller, id, setPromptValue, setMention, setMentionIndex]);

  const onPromptKeyDown = useCallback((event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing || !mention) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      setMention(null);
      return;
    }
    if (filteredMentionOptions.length === 0) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setMentionIndex((index) => (index + 1) % filteredMentionOptions.length);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setMentionIndex((index) => (index - 1 + filteredMentionOptions.length) % filteredMentionOptions.length);
    } else if (event.key === 'Enter' || event.key === 'Tab') {
      event.preventDefault();
      pickMention(filteredMentionOptions[activeMentionIndex] ?? filteredMentionOptions[0]);
    }
  }, [mention, filteredMentionOptions, activeMentionIndex, pickMention, setMention, setMentionIndex]);

  const modeOptions = capability?.modes.filter((mode) => !capability.legacyModes?.includes(mode) || mode === data.generationMode) ?? (mediaKind === 'video'
    ? ['text-to-video', 'image-to-video']
    : ['text-to-image', 'image-to-image']);
  const currentMode = (data.generationMode ?? modeOptions[0]) as CanvasGenerationMode;
  const modeHint = capability?.modeHints?.[currentMode] ?? REFERENCE_MODE_HINTS[currentMode];

  return (
    <div
      className={[
        'sc-canvas-node w-full',
        selected ? 'sc-canvas-node-selected' : '',
        activePhase ? 'sc-canvas-node-running' : '',
      ].filter(Boolean).join(' ')}
      data-node-kind={mediaKind === 'video' ? 'video-generation' : 'image-generation'}
      data-node-position={`${Math.round(positionAbsoluteX)},${Math.round(positionAbsoluteY)}`}
      {...(runtime?.currentAssetId ? { 'data-canvas-result': runtime.currentAssetId } : {})}
    >
      <WidthResizeHandle kind={mediaKind === 'video' ? 'video-generation' : 'image-generation'} selected={selected} />
      <Handle type="target" position={Position.Left} />
      <div className="flex items-center gap-2">
        <DragHandle />
        <KindIcon iconKey={mediaKind === 'video' ? 'video' : 'image'} />
        <TitleInput nodeId={id} value={String(data.title ?? '')} placeholder="节点名称" />
      </div>

      <label className="mt-2 block text-[11px] text-ink-secondary">模型</label>
      <select
        className="nodrag sc-canvas-select w-full"
        value={data.modelKey ?? ''}
        data-testid="model-select"
        onChange={(event) => {
          const next = available.find((candidate) => candidate.key === event.target.value);
          const parameters: Record<string, string | number | boolean> = {};
          const changes: string[] = [];
          for (const parameter of next?.parameters ?? []) {
            const old = data.parameters?.[parameter.key];
            if (old === undefined) continue;
            const invalid = (parameter.options && !parameter.options.includes(String(old)))
              || (typeof old === 'number' && !parameter.specialValues?.includes(old) && ((parameter.min !== undefined && old < parameter.min) || (parameter.max !== undefined && old > parameter.max)));
            if (invalid) {
              if (parameter.default !== undefined) parameters[parameter.key] = parameter.default;
              const label = parameter.default === 'gateway-default' ? '网关默认（待验证）' : String(parameter.default ?? '默认');
              changes.push(`${parameter.label}调整为 ${label}`);
            }
            else parameters[parameter.key] = old;
          }
          if (!data.modelKey && next?.parameters.some((parameter) => parameter.key === 'withAudio')) parameters.withAudio = true;
          if (data.parameters?.generationStage === 'draft' && next && !next.parameters.some((parameter) => parameter.key === 'generationStage')) {
            const resolution = next.parameters.find((parameter) => parameter.key === 'resolution');
            const previous = String(data.parameters.directResolution ?? '');
            if (resolution) parameters.resolution = resolution.options?.includes(previous) ? previous : resolution.default ?? '1080p';
            changes.push('当前模型不支持样片，已切换为直接生成');
          }
          let generationMode = data.generationMode;
          if (next && !next.modes.includes(currentMode) && data.parameters?.generationStage !== 'final-from-draft') {
            generationMode = next.modes.find((mode) => !next.legacyModes?.includes(mode));
            if (generationMode) changes.push(`模式调整为 ${next.modeLabels?.[generationMode] ?? MODE_LABELS[generationMode] ?? generationMode}，请检查参考素材`);
          }
          // A bound final retains its source so a channel switch cannot silently become an ordinary generation.
          if (data.parameters?.generationStage === 'final-from-draft') {
            parameters.generationStage = 'final-from-draft'; parameters.draftAssetId = String(data.parameters.draftAssetId ?? '');
            changes.push('固定样片只可在原模型和渠道转正式');
          }
          setModelChangeNote(changes.join('；'));
          controller.updateNodeData(id, { modelKey: event.target.value || null, parameters, generationMode });
        }}
      >
        <option value="">未选择</option>
        {available.map((candidate) => (
          <option key={candidate.key} value={candidate.key}>
            {candidate.displayName}
            {candidate.evidence === 'verified' ? ' · 已验证' : candidate.evidence === 'mapped' ? ' · 已映射' : ''}
          </option>
        ))}
      </select>

      {modelChangeNote ? <div role="status" className="mt-1 text-[11px] text-ink-secondary">{modelChangeNote}</div> : null}
      {capability ? (
        <div className="mt-1 text-[10px] text-ink-tertiary" data-testid="capability-evidence">
          {capability.evidence === 'verified'
            ? '能力状态：已通过真实链路验证'
            : capability.evidence === 'mapped'
              ? '能力状态：请求映射已验证，画布真实样例待补'
              : '能力状态：仅平台资料，公司转发未核对'}
        </div>
      ) : null}

      {capability?.parameters.some((parameter) => parameter.key === 'generationStage') ? <>
        <label className="mt-2 block text-[11px] text-ink-secondary">生成阶段</label>
        <select className="nodrag sc-canvas-select w-full" aria-label="生成阶段" value={String(data.parameters?.generationStage ?? 'direct')}
          onChange={(event) => {
            const previous = data.parameters?.generationStage ?? 'direct';
            const next = event.target.value;
            const parameters: Record<string, string | number | boolean> = { ...(data.parameters ?? {}), generationStage: next };
            if (previous === 'direct') parameters.directResolution = String(data.parameters?.resolution ?? '1080p');
            parameters.resolution = next === 'draft' ? '480p' : String(data.parameters?.directResolution ?? '1080p');
            delete parameters.draftAssetId;
            controller.updateNodeData(id, { parameters });
          }}>
          <option value="direct">直接生成正式视频</option><option value="draft">先生成样片 · 480p</option>
          {data.parameters?.generationStage === 'final-from-draft' ? <option value="final-from-draft">基于选中样片转正式 · 1080p</option> : null}
        </select>
        {data.parameters?.generationStage === 'final-from-draft' ? <DraftActions bound assetId={String(data.parameters.draftAssetId ?? '')} controller={controller} position={{ x: positionAbsoluteX + 340, y: positionAbsoluteY }} /> : null}
      </> : null}
      {runtime?.currentAssetId ? <DraftActions assetId={runtime.currentAssetId} controller={controller} position={{ x: positionAbsoluteX + 340, y: positionAbsoluteY }} /> : null}
      <label className="mt-2 block text-[11px] text-ink-secondary">模式</label>
      <select
        className="nodrag sc-canvas-select w-full"
        value={currentMode}
        data-testid="mode-select"
        disabled={data.parameters?.generationStage === 'final-from-draft'}
        onChange={(event) => {
          const nextMode = event.target.value as CanvasGenerationMode;
          // 切模式时清掉新模式不接受的参数键（界面同步隐藏，残留值也不进计划）
          const remainingParameters = Object.fromEntries(
            Object.entries(data.parameters ?? {}).filter(([key]) => {
              const declared = capability?.parameters.find((parameter) => parameter.key === key);
              return !declared?.modes || declared.modes.includes(nextMode);
            }),
          );
          controller.updateNodeData(id, {
            generationMode: nextMode,
            parameters: remainingParameters,
          });
        }}
      >
        {(modeOptions as string[]).map((mode) => (
          <option key={mode} value={mode}>
            {capability?.modeLabels?.[mode as CanvasGenerationMode] ?? MODE_LABELS[mode] ?? mode}
          </option>
        ))}
      </select>

      {capability?.legacyModes?.includes(currentMode) ? (
        <button type="button" className="nodrag sc-canvas-button mt-1" onClick={(event) => {
          event.currentTarget.blur();
          controller.updateNodeData(id, { generationMode: 'reference-to-video' });
        }}>转换为全能参考（保留素材与提示词）</button>
      ) : null}

      {modeHint ? (
        <div className="mt-1 text-[10px] text-ink-tertiary" data-testid="mode-hint">
          {modeHint}
        </div>
      ) : null}

      {capability && capability.parameters.length > 0 ? (
        <div className="mt-2 space-y-1">
          {capability.parameters
            .filter((parameter) => !['generationStage', 'draftAssetId', 'directResolution'].includes(parameter.key))
            .filter((parameter) => data.parameters?.generationStage !== 'final-from-draft' || ['resolution', 'outputFormat', 'watermark', 'returnLastFrame'].includes(parameter.key))
            .filter((parameter) => !parameter.modes || parameter.modes.includes(currentMode))
            .map((parameter) => (
            <div key={parameter.key} className="flex items-center gap-2">
              <span className="text-[11px] text-ink-secondary">{parameter.label}</span>
              {parameter.type === 'enum' ? (
                <select
                  className="nodrag sc-canvas-select flex-1"
                  disabled={parameter.key === 'resolution' && ['draft', 'final-from-draft'].includes(String(data.parameters?.generationStage))}
                  value={String(parameter.key === 'resolution' && data.parameters?.generationStage === 'draft' ? '480p' : data.parameters?.[parameter.key] ?? parameter.default ?? '')}
                  aria-label={parameter.label}
                  onChange={(event) => controller.updateNodeData(id, {
                    parameters: { ...(data.parameters ?? {}), [parameter.key]: event.target.value },
                  })}
                >
                  {(parameter.options ?? []).map((option) => (
                    <option key={option} value={option}>{option === 'gateway-default' ? '网关默认（待验证）' : option === 'adaptive' ? '自动' : option === '4k' ? '4K' : option}</option>
                  ))}
                </select>
              ) : parameter.specialValues?.includes(-1) ? (
                <select className="nodrag sc-canvas-select flex-1" aria-label={parameter.label}
                  value={Number(data.parameters?.[parameter.key] ?? parameter.default ?? 5)}
                  onChange={(event) => controller.updateNodeData(id, {
                    parameters: { ...(data.parameters ?? {}), [parameter.key]: Number(event.target.value) },
                  })}>
                  <option value={-1}>自动</option>
                  {Array.from({ length: (parameter.max ?? 15) - (parameter.min ?? 4) + 1 }, (_, index) => (parameter.min ?? 4) + index)
                    .map((seconds) => <option key={seconds} value={seconds}>{seconds} 秒</option>)}
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
                  className="nodrag sc-canvas-input flex-1 bg-transparent text-[11px] outline-none"
                  type="number"
                  aria-label={parameter.label}
                  min={parameter.min}
                  max={parameter.max}
                  step={parameter.type === 'integer' ? 1 : 'any'}
                  value={Number(data.parameters?.[parameter.key] ?? parameter.default ?? 0)}
                  /* 输入中只夹上限（不打断多位数录入），失焦再夹下限、取整并兜底默认值 */
                  onChange={(event) => {
                    const raw = Number(event.target.value);
                    if (!Number.isFinite(raw)) return;
                    const value = parameter.max !== undefined ? Math.min(parameter.max, raw) : raw;
                    controller.updateNodeData(id, {
                      parameters: { ...(data.parameters ?? {}), [parameter.key]: value },
                    }, { coalesce: `param:${id}:${parameter.key}` });
                  }}
                  onBlur={(event) => {
                    const fallback = Number(parameter.default ?? parameter.min ?? 0);
                    const raw = event.target.value.trim() === '' ? fallback : Number(event.target.value);
                    let value = Number.isFinite(raw) ? raw : fallback;
                    if (parameter.min !== undefined) value = Math.max(parameter.min, value);
                    if (parameter.max !== undefined) value = Math.min(parameter.max, value);
                    if (parameter.type === 'integer') value = Math.round(value);
                    if (value !== Number(data.parameters?.[parameter.key] ?? parameter.default ?? 0)) {
                      controller.updateNodeData(id, {
                        parameters: { ...(data.parameters ?? {}), [parameter.key]: value },
                      });
                    }
                  }}
                />
              )}
            </div>
          ))}
        </div>
      ) : null}

      <div className="relative">
        <textarea
          ref={promptRef}
          disabled={data.parameters?.generationStage === 'final-from-draft'}
          className="nodrag sc-canvas-input mt-2 h-20 w-full resize-none bg-transparent text-[12px] outline-none"
          placeholder="提示词，输入 @ 选择素材"
          {...promptIme}
          onChange={(event) => {
            promptIme.onChange(event);
            if (!(event.nativeEvent as InputEvent).isComposing) syncMentionFromDom();
          }}
          onCompositionEnd={(event) => {
            promptIme.onCompositionEnd(event);
            syncMentionFromDom();
          }}
          onSelect={syncMentionFromDom}
          onKeyDown={onPromptKeyDown}
          onBlur={() => {
            promptIme.onBlur();
            setMention(null);
          }}
          data-testid="generation-prompt"
        />
        {mention ? (
          <div className="sc-canvas-mention-menu nodrag" data-testid="mention-menu">
            {filteredMentionOptions.length === 0 ? (
              <div className="sc-canvas-mention-empty">还没有已连线的素材，先从素材节点拉线到本节点</div>
            ) : (
              filteredMentionOptions.map((option, index) => (
                <button
                  key={option.nodeId}
                  type="button"
                  className={`sc-canvas-mention-option ${index === activeMentionIndex ? 'sc-canvas-mention-option-active' : ''}`}
                  data-testid={`mention-option-${option.nodeId}`}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    pickMention(option);
                  }}
                  onMouseEnter={() => setMentionIndex(index)}
                >
                  {option.assetId && option.mediaKind === 'image' ? (
                    <img src={canvasAssetUrl(option.assetId)} alt="" className="sc-canvas-mention-thumb" />
                  ) : option.assetId && option.mediaKind === 'video' ? (
                    <video src={canvasAssetUrl(option.assetId)} muted playsInline preload="metadata" className="sc-canvas-mention-thumb" />
                  ) : (
                    <span className="sc-canvas-mention-thumb sc-canvas-mention-thumb-text">
                      {option.kindLabel}
                    </span>
                  )}
                  <span className="min-w-0 flex-1 truncate">{option.title}</span>
                  {option.label !== null ? (
                    <span className="sc-canvas-mention">@参考{option.label}</span>
                  ) : (
                    <span className="sc-canvas-mention-kind">{option.kindLabel}</span>
                  )}
                </button>
              ))
            )}
          </div>
        ) : null}
      </div>

      {references.length > 0 ? (
        <div className="mt-2 space-y-1" data-testid="reference-list">
          {references.map((slot, index) => (
            <ReferenceRow
              key={slot.refId}
              nodeId={id}
              slot={slot}
              index={index}
              total={references.length}
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

      <div className="mt-3 flex items-center gap-2">
        <div className="nodrag flex items-center rounded-full border border-[var(--color-hairline)]" data-testid="variant-count">
          {([1, 2, 4] as const).map((count) => (
            <button
              key={count}
              type="button"
              className={`sc-canvas-variant-option ${variantCount === count ? 'sc-canvas-variant-option-active' : ''}`}
              aria-label={`生成 ${count} 个变体`}
              aria-pressed={variantCount === count}
              onClick={() => setVariantCount(count)}
            >
              ×{count}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="nodrag sc-canvas-button sc-canvas-button-primary flex-1"
          data-testid="run-node"
          title={activePhase
            ? `已有 ${activeCount} 个任务进行中（${STATUS_TEXT[activePhase] ?? activePhase}），新变体将并行排队。`
            : undefined}
          onClick={onRun}
        >
          {runLabel}
        </button>
        <button type="button" className="nodrag sc-canvas-button" data-testid="run-branch" onClick={onBranch}>
          运行分支
        </button>
      </div>

      <NodeStatus nodeId={id} />
      <Handle type="source" position={Position.Right} />
    </div>
  );
});
