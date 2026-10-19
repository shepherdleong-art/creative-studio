/**
 * 节点种类注册表：种类元信息的单一事实源。
 *
 * 服务端端口校验（graph.ts）、前端创建入口／拉线菜单／派生菜单全部从
 * 这里取数据；新增节点种类只改这一处（parseNode 的逐字段严格校验除外，
 * 它承担拒绝未知字段的职责，不属于重复定义）。
 * 纯数据＋纯函数：不导入 UI、不导入数据库。
 */

import type {
  CanvasGraph,
  CanvasGraphNode,
  CanvasMediaKind,
  CanvasNodeKind,
} from './types.ts';

export interface CanvasNodeKindSpec {
  kind: CanvasNodeKind;
  label: string;
  isGeneration: boolean;
  /** 静态输出端口类型；素材节点按 data.mediaKind 动态（此处为 null）。 */
  staticOutputKind: CanvasMediaKind | 'text' | null;
  /** 接受的输入类型；null = 不接受输入（非生成节点）。 */
  acceptsInputKinds: ReadonlyArray<CanvasMediaKind | 'text'> | null;
  /** 新建节点的默认 data（编辑定义层，不含运行投影字段）。 */
  defaultData(): Record<string, unknown>;
  /** 节点默认宽度（用户可拖右缘改宽；也是缩放的最小宽度）。 */
  defaultWidth: number;
  /** UI 图标键：组件侧映射到具体图形，本层保持纯数据。 */
  iconKey: 'material' | 'prompt' | 'image' | 'video';
}

export const CANVAS_NODE_KIND_SPECS: ReadonlyArray<CanvasNodeKindSpec> = [
  {
    kind: 'material',
    label: '素材',
    isGeneration: false,
    staticOutputKind: null,
    acceptsInputKinds: null,
    defaultData: () => ({ title: '素材', assetId: null, mediaKind: 'image' }),
    defaultWidth: 200,
    iconKey: 'material',
  },
  {
    kind: 'prompt',
    label: '提示词',
    isGeneration: false,
    staticOutputKind: 'text',
    acceptsInputKinds: null,
    defaultData: () => ({ title: '提示词', text: '' }),
    defaultWidth: 220,
    iconKey: 'prompt',
  },
  {
    kind: 'image-generation',
    label: '图片生成',
    isGeneration: true,
    staticOutputKind: 'image',
    acceptsInputKinds: ['image', 'text'],
    defaultData: () => ({
      title: '图片生成',
      modelKey: null,
      generationMode: 'image-to-image',
      prompt: '',
      parameters: {},
      references: [],
      referenceLabelCounter: 0,
    }),
    defaultWidth: 300,
    iconKey: 'image',
  },
  {
    kind: 'video-generation',
    label: '视频生成',
    isGeneration: true,
    staticOutputKind: 'video',
    acceptsInputKinds: ['image', 'video', 'audio', 'text'],
    defaultData: () => ({
      title: '视频生成',
      modelKey: null,
      generationMode: 'image-to-video',
      prompt: '',
      parameters: {},
      references: [],
      referenceLabelCounter: 0,
    }),
    defaultWidth: 300,
    iconKey: 'video',
  },
];

const SPEC_BY_KIND = new Map(CANVAS_NODE_KIND_SPECS.map((spec) => [spec.kind, spec]));

export function nodeKindSpec(kind: CanvasNodeKind): CanvasNodeKindSpec {
  const spec = SPEC_BY_KIND.get(kind);
  if (!spec) throw new Error(`未知节点种类：${kind}`);
  return spec;
}

/** 节点输出端口类型：素材节点输出自身媒体类型，提示词输出文本，生成节点输出结果媒体。 */
export function outputKindOf(node: CanvasGraphNode): CanvasMediaKind | 'text' {
  if (node.kind === 'material') return node.data.mediaKind;
  return nodeKindSpec(node.kind).staticOutputKind ?? 'text';
}

/** 节点接受的输入端口类型；null 表示不接受输入。 */
export function inputKindsOf(node: CanvasGraphNode): ReadonlyArray<CanvasMediaKind | 'text'> | null {
  return nodeKindSpec(node.kind).acceptsInputKinds;
}

/**
 * 拉线／派生菜单用：从既有节点连到「将要新建的 toKind 节点」是否允许。
 * 只判端口兼容与是否接受输入——自环、重复连线、环对「全新节点」场景天然不成立。
 */
export function canConnectKindTo(graph: CanvasGraph, fromNodeId: string, toKind: CanvasNodeKind): boolean {
  const source = graph.nodes.find((node) => node.id === fromNodeId);
  if (!source) return true;
  const accepted = nodeKindSpec(toKind).acceptsInputKinds;
  if (!accepted) return false;
  return accepted.includes(outputKindOf(source));
}
