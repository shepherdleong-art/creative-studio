/**
 * 团队用量的纯展示映射（05 号票）。
 *
 * 只负责把后端算好的金额分类、费用状态、提交/终态、通道状态翻译成中文，
 * 让主表、详情对话框和浏览器测试共用同一套文案。**不判断权限、不重算金额**：
 * 金额与分类始终来自服务端响应，这里只做格式化。
 *
 * 纯函数、零 React 依赖，浏览器与 Node 都能用。
 */
import { TASK_STATUS_LABELS } from '@/lib/team-task-labels';

export type UsageCostStatus = 'estimated' | 'settled' | 'released' | 'unpriced' | 'uncertain' | 'mixed';

export interface UsageAttemptCostInput {
  costStatus: string;
  reservedMinor: number;
  actualMinor: number | null;
}

export interface UsageTaskCostInput {
  costStatus: string;
  chargedMinor: number;
  settledMinor: number;
  estimatedMinor: number;
}

export interface UsageTaskStatusInput {
  status: string;
  cancelRequestedAt: string | null;
}

/** 金额：人民币分 → `¥1,234.56`；空值表示「不限额」（仅额度栏用）。 */
export function usageMoney(minor: number | null | undefined): string {
  if (minor === null || minor === undefined || !Number.isFinite(minor)) return '不限额';
  return `¥${(minor / 100).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** 单次调用/尝试的费用文案（未知、未定价、估算、已释放不能混成 0 元）。 */
export function attemptCostLabel(item: UsageAttemptCostInput): string {
  if (item.costStatus === 'released') return '已释放';
  if (item.costStatus === 'unpriced') return '未定价';
  if (item.costStatus === 'uncertain') return `${usageMoney(item.reservedMinor)}（待核账）`;
  if (item.costStatus === 'estimated') return `${usageMoney(item.reservedMinor)}（估算）`;
  return `${usageMoney(item.actualMinor)}（实际已记录）`;
}

/** 一条制作任务的费用汇总文案。 */
export function taskCostLabel(task: UsageTaskCostInput): string {
  if (task.costStatus === 'released') return '已释放';
  if (task.costStatus === 'unpriced') return '未定价';
  if (task.costStatus === 'uncertain') return `待核账${task.chargedMinor ? ` · ${usageMoney(task.chargedMinor)}` : ''}`;
  if (task.costStatus === 'estimated') return `${usageMoney(task.estimatedMinor)}（估算）`;
  if (task.costStatus === 'mixed') return `${usageMoney(task.chargedMinor)}（混合）`;
  return `${usageMoney(task.settledMinor)}（已记录）`;
}

/** 制作任务状态（含「已请求取消」的既有口径）。 */
export function usageTaskStatusLabel(task: UsageTaskStatusInput): string {
  if (task.cancelRequestedAt) return task.status === 'succeeded' ? '已完成 · 停止后续' : '已停止后续生成';
  return TASK_STATUS_LABELS[task.status] ?? task.status;
}

const SUBMISSION_LABELS: Record<string, string> = {
  not_sent: '尚未发送',
  maybe_sent: '已发起提交，结果待确认',
  accepted: '供应商已受理',
  terminal: '已结束',
};

const TERMINAL_LABELS: Record<string, string> = {
  succeeded: '成功',
  failed: '失败',
  canceled: '已取消',
  unknown: '结果未确认',
};

/** 调用尝试的提交阶段文案（中文；认不出来的保留原文，不猜成成功/失败）。 */
export function attemptSubmissionLabel(state: string | null | undefined): string {
  if (!state) return '提交状态未记录';
  return SUBMISSION_LABELS[state] ?? TASK_STATUS_LABELS[state] ?? state;
}

/** 调用尝试的终态文案。 */
export function attemptTerminalLabel(state: string | null | undefined): string {
  if (!state) return '仍未确认结果';
  return TERMINAL_LABELS[state] ?? TASK_STATUS_LABELS[state] ?? state;
}

/** 一条尝试的结果：有终态说终态，否则说提交阶段。 */
export function attemptResultLabel(item: { submissionState: string; terminalState?: string | null; outcome?: string | null }): string {
  const terminal = item.terminalState ?? item.outcome ?? null;
  return terminal ? attemptTerminalLabel(terminal) : attemptSubmissionLabel(item.submissionState);
}

const CHANNEL_STATE_LABELS: Record<string, string> = {
  candidate: '候选通道（未提交）',
  selected: '已选用',
  skipped: '未选用',
  waiting_capacity: '等待名额',
  overflowed: '名额已满，已溢出',
  succeeded: '成功',
  failed: '失败',
  canceled: '已取消',
  unknown: '结果未确认',
  accepted: '已受理',
};

export function channelStateLabel(state: string): string {
  return CHANNEL_STATE_LABELS[state] ?? (state || '状态未记录');
}

/** 通道名：内部键换成给人看的名字，认不出来的保留原键。 */
export function channelDisplayName(channelKey: string): string {
  if (channelKey === 'qiniu') return '七牛通道';
  if (channelKey === 'tencent') return '腾讯通道';
  return channelKey || '未记录通道';
}

/**
 * 「备用通道，未提交」：候选通道且没有真实提交尝试。
 * 只说明没有向它提交、不会产生费用，不暗示重复生成。
 */
export function isStandbyChannel(channel: { state: string; attempts: unknown[] }): boolean {
  return channel.attempts.length === 0 && (channel.state === 'candidate' || channel.state === 'skipped');
}

/** 备用通道的单列说明（功能方案第 7 节：不能暗示重复生成或扣费）。 */
export const STANDBY_CHANNEL_NOTE = '备用通道，未提交：当前没有向这条通道提交，也不会产生额外费用。';

/** 技术字段里的费用状态（排查用，不替代上面的中文费用文案）。 */
export function costStatusLabel(status: string): string {
  const labels: Record<string, string> = {
    settled: '已结算',
    estimated: '估算预留',
    uncertain: '待核账',
    unpriced: '未定价',
    released: '已释放',
    mixed: '混合（含待核账或未定价）',
  };
  return labels[status] ?? status;
}
