/**
 * 创作画布纯类型定义（技术约定 C1–C3）。
 *
 * 这一层不导入数据库、浏览器、供应商或进程级调度器，只描述：
 * - 图草稿（graphJson）：客户端可写的编辑定义，有 schemaVersion；
 * - 运行投影（node_states）：服务端维护的当前结果与活跃任务，客户端不能写；
 * - 不可变资产（assets）：已登记、内容不再变化的本地媒体；
 * - 一次任务（tasks）：一次提交的输入快照、参数与远端身份。
 */

export const CANVAS_GRAPH_SCHEMA_VERSION = 1;

export type CanvasNodeKind = 'material' | 'prompt' | 'image-generation' | 'video-generation';

export type CanvasMediaKind = 'image' | 'video' | 'audio';

export type CanvasGenerationMode =
  | 'text-to-image'
  | 'image-to-image'
  | 'text-to-video'
  | 'image-to-video'
  /** 以参考视频为主的生成（方舟多模态参考，至少 1 段参考视频）。 */
  | 'video-to-video'
  /** 以参考图／参考音频为主的生成（方舟多模态参考，至少 1 张参考图）。 */
  | 'reference-to-video'
  /** 智能多帧（方舟关键帧参考生视频）：多张 reference_image，≥2 张图。 */
  | 'frames-to-video'
  /** 智能编辑（方舟 omni 子任务 edit）：ratio 锁 adaptive、duration 锁 -1，需参考视频。 */
  | 'video-edit'
  /** 超长视频（方舟 omni 子任务 extend）：ratio 锁 adaptive，需参考视频。 */
  | 'video-extend';

export const CANVAS_GENERATION_MODES: ReadonlyArray<CanvasGenerationMode> = [
  'text-to-image',
  'image-to-image',
  'text-to-video',
  'image-to-video',
  'video-to-video',
  'reference-to-video',
  'frames-to-video',
  'video-edit',
  'video-extend',
];

export type CanvasReferenceRole =
  | 'subject'
  | 'product'
  | 'style'
  | 'scene'
  | 'first-frame'
  | 'last-frame'
  | 'reference'
  | 'camera'
  | 'audio';

export const CANVAS_REFERENCE_ROLES: ReadonlyArray<CanvasReferenceRole> = [
  'subject',
  'product',
  'style',
  'scene',
  'first-frame',
  'last-frame',
  'reference',
  'camera',
  'audio',
];

/** 参考槽位的来源种类：素材节点、提示词节点的文本、上游生成节点的当前结果。 */
export type CanvasReferenceSourceKind = 'asset' | 'text' | 'result';

export type CanvasParameterValue = string | number | boolean;

export interface CanvasPoint {
  x: number;
  y: number;
}

export interface CanvasViewport {
  x: number;
  y: number;
  zoom: number;
}

export const DEFAULT_CANVAS_VIEWPORT: CanvasViewport = { x: 0, y: 0, zoom: 1 };

/** 节点自定义尺寸（用户拖拽右缘改宽；缺省按节点类型默认宽度）。 */
export interface CanvasNodeSize {
  width: number;
}

/**
 * 生成节点内的一份参考。refId 与 label 在节点内稳定：
 * 排序只改变数组顺序（提交顺序），不会把提示词里的 @参考N 悄悄指向另一份参考。
 * 连线断开时槽位随对账移除；编号游标只增不减，重连会拿到新编号，
 * 提示词里的旧 @参考N 按「不存在」显式报错，绝不回收指向别的素材。
 */
export interface CanvasReferenceSlot {
  refId: string;
  label: number;
  role: CanvasReferenceRole;
  note: string;
  sourceNodeId: string;
  sourceKind: CanvasReferenceSourceKind;
}

export interface CanvasMaterialNodeData {
  title: string;
  assetId: string | null;
  mediaKind: CanvasMediaKind;
}

export interface CanvasPromptNodeData {
  title: string;
  text: string;
}

export interface CanvasGenerationNodeData {
  title: string;
  /** 能力表键；null 表示用户尚未选择模型。 */
  modelKey: string | null;
  generationMode: CanvasGenerationMode;
  prompt: string;
  parameters: Record<string, CanvasParameterValue>;
  references: CanvasReferenceSlot[];
  /** 参考编号分配游标；只增不减，保证 @参考N 不会被回收给别的素材。 */
  referenceLabelCounter: number;
}

export interface CanvasGraphNodeBase {
  id: string;
  kind: CanvasNodeKind;
  position: CanvasPoint;
  /** 用户拖拽调整过的节点宽度；未调整时不写该字段。 */
  size?: CanvasNodeSize;
}

export interface CanvasMaterialNode extends CanvasGraphNodeBase {
  kind: 'material';
  data: CanvasMaterialNodeData;
}

export interface CanvasPromptNode extends CanvasGraphNodeBase {
  kind: 'prompt';
  data: CanvasPromptNodeData;
}

export interface CanvasImageNode extends CanvasGraphNodeBase {
  kind: 'image-generation';
  data: CanvasGenerationNodeData;
}

export interface CanvasVideoNode extends CanvasGraphNodeBase {
  kind: 'video-generation';
  data: CanvasGenerationNodeData;
}

export type CanvasGraphNode =
  | CanvasMaterialNode
  | CanvasPromptNode
  | CanvasImageNode
  | CanvasVideoNode;

export type CanvasGenerationNode = CanvasImageNode | CanvasVideoNode;

export interface CanvasGraphEdge {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string;
  targetHandle?: string;
}

export interface CanvasGraph {
  schemaVersion: number;
  nodes: CanvasGraphNode[];
  edges: CanvasGraphEdge[];
}

export function isGenerationNode(node: CanvasGraphNode): node is CanvasGenerationNode {
  return node.kind === 'image-generation' || node.kind === 'video-generation';
}

export function isGenerationNodeKind(kind: CanvasNodeKind): boolean {
  return kind === 'image-generation' || kind === 'video-generation';
}

export function mediaKindForGenerationNodeKind(kind: CanvasNodeKind): CanvasMediaKind | null {
  if (kind === 'image-generation') return 'image';
  if (kind === 'video-generation') return 'video';
  if (kind === 'material') return null;
  return null;
}

/** 任务阶段（C4）。名字可调，但影响重提与名额的区别不能合并。 */
export type CanvasTaskPhase =
  | 'waiting_input'
  | 'queued'
  | 'preparing'
  | 'submitting'
  | 'polling'
  | 'downloading'
  | 'download_failed'
  | 'succeeded'
  | 'failed'
  | 'blocked'
  | 'cancelled'
  | 'uncertain'
  | 'resume_pending';

export const CANVAS_TASK_PHASES: ReadonlyArray<CanvasTaskPhase> = [
  'waiting_input',
  'queued',
  'preparing',
  'submitting',
  'polling',
  'downloading',
  'download_failed',
  'succeeded',
  'failed',
  'blocked',
  'cancelled',
  'uncertain',
  'resume_pending',
];

/** 已结束、不再占全局名额的阶段。 */
export const CANVAS_TERMINAL_TASK_PHASES: ReadonlyArray<CanvasTaskPhase> = [
  'succeeded',
  'failed',
  'blocked',
  'cancelled',
];

/** 需要占用全局并发名额的阶段（C4 表）。 */
export const CANVAS_SLOT_HOLDING_TASK_PHASES: ReadonlyArray<CanvasTaskPhase> = [
  'preparing',
  'submitting',
  'polling',
  'downloading',
  'uncertain',
];

export function isTerminalTaskPhase(phase: CanvasTaskPhase): boolean {
  return CANVAS_TERMINAL_TASK_PHASES.includes(phase);
}

export type CanvasSubmissionState = 'not_sent' | 'maybe_sent' | 'accepted' | 'terminal';

export type CanvasRunMode = 'single' | 'branch';

export type CanvasRunStatus = 'planned' | 'running' | 'partial' | 'succeeded' | 'failed' | 'cancelled';

/** 服务端执行器模式（C1）：非法值按 disabled 处理。 */
export type CanvasExecutorMode = 'disabled' | 'fixture' | 'company';

/** 能力证据层级（C6）：只有真实链路样例才能标 verified。 */
export type CanvasCapabilityEvidence = 'verified' | 'mapped' | 'candidate';

/** 一次任务中输入的身份（C3）：已有素材固定 assetId，等待输入固定 upstreamTaskId，文本固定正文。 */
export interface CanvasTaskInputSnapshot {
  refId: string;
  orderIndex: number;
  role: CanvasReferenceRole;
  note: string;
  sourceNodeId: string | null;
  assetId: string | null;
  upstreamTaskId: string | null;
  textContent: string | null;
}

/** 服务端返回给界面的节点运行投影；与 graphJson 分开维护。 */
export interface CanvasNodeRunProjection {
  nodeId: string;
  nodeEpoch: number;
  deleted: boolean;
  activeTaskId: string | null;
  currentAssetId: string | null;
  resultTaskId: string | null;
}
