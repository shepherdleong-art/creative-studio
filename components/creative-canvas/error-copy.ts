/**
 * 画布错误文案：错误码 → 面向用户的中文说明。
 * 服务端 message 面向开发者，这里按 code 映射成可读文案；
 * 未覆盖的 code 回退原始 message，不吞信息。
 */

import { CanvasApiError } from './api';

const CODE_COPY: Record<string, string> = {
  // 统一错误码（lib/creative-canvas/errors.ts）
  not_found: '找不到对应的画布或资源，可能已被删除。',
  invalid_input: '请求参数不合法，请检查节点配置。',
  conflict: '操作冲突：目标已被别处修改或存在冲突状态。',
  forbidden: '没有权限执行该操作。',
  canvas_disabled: '创作画布功能未开启。',
  canvas_unavailable: '画布暂时不可用，请稍后重试。',
  runtime_unavailable: '当前执行器不可用：可以继续编辑画布，但无法启动生成任务。',
  capability_unavailable: '所选模型能力不可用，请检查配置或更换模型。',
  submission_uncertain: '任务提交状态不确定，请在任务面板核查后再操作。',
  // 图定义校验（lib/creative-canvas/graph.ts）
  invalid_graph: '画布数据不合法。',
  invalid_node: '节点数据不合法。',
  invalid_edge: '连线数据不合法。',
  runtime_field_not_writable: '运行状态字段不允许在编辑中写入。',
  duplicate_node_id: '节点 ID 重复。',
  duplicate_edge_id: '连线 ID 重复。',
  unknown_node: '目标节点不存在。',
  node_not_found: '节点不存在或已被删除。',
  invalid_reference: '参考引用不合法。',
  // 连线校验（message 本身已是中文，此处兜底）
  self_loop: '节点不能连接到自己。',
  cycle: '这样连线会形成循环依赖。',
  target_not_generation: '只有生成节点接受输入连线。',
  incompatible_connection: '端口类型不兼容，这两个节点不能这样连线。',
  duplicate_connection: '这两个节点已经连过线了。',
  // 通用
  canvas_error: '画布服务出错，请稍后重试。',
};

export function canvasErrorText(error: unknown): string {
  if (error instanceof CanvasApiError) {
    return CODE_COPY[error.code] ?? error.message;
  }
  if (error instanceof Error && error.message) return error.message;
  return '操作失败，请稍后重试。';
}
