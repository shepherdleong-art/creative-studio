/**
 * 待核对卡片的纯展示映射（02 号票）。
 *
 * 只做一件事：把后端已经算好的 `attentionReasons`、业务状态、费用状态和通道证据，
 * 翻译成管理员不用读任务 ID 就能看懂的中文。
 *
 * 红线（与功能方案第 4 节一致）：
 *   - 只用「还没有确认 / 需要人工核对」这类被动说法，不替系统承诺后台会持续代替人工查询；
 *   - 生成成功与费用核实是两个维度：成功不等于已核账；
 *   - 候选且未提交的通道只说「备用通道，未提交」，不暗示重复生成或额外扣费；
 *   - 技术字段（通道键、远端 ID、规则版本、错误码）不在这里拼，留给「核对详情」。
 *
 * 纯函数、零依赖：浏览器与 Node 测试共用。
 */

export type ReconcileCostStatus = 'estimated' | 'settled' | 'released' | 'unpriced' | 'uncertain';

export interface ReconcileDisplayAttempt {
  submissionState: string;
  terminalState: string | null;
  remoteId: string | null;
  receiptRemoteId: string | null;
  errorCode: string | null;
}

export interface ReconcileDisplayChannelInput {
  channelKey: string;
  state: string;
  operationStatus?: string | null;
  waitReason?: string | null;
  remoteId?: string | null;
  attempts: ReconcileDisplayAttempt[];
}

export interface ReconcileDisplayTaskInput {
  mediaTaskId: string;
  status: string;
  currentChannelKey: string | null;
  cancelRequestedAt: string | null;
  businessStatus: string | null;
  businessProviderStatus: string | null;
  businessError: string | null;
  attention: boolean;
  attentionReasons: string[];
  cost: {
    reservedMinor: number;
    actualMinor: number;
    unknownCount: number;
    costStatus: ReconcileCostStatus;
  };
  channels: ReconcileDisplayChannelInput[];
}

export interface ReconcileDisplayChannel {
  channelKey: string;
  /** 七牛通道 / 腾讯通道 / 原通道键。 */
  label: string;
  /** 通俗通道状态；候选且未提交时固定「备用通道，未提交」。 */
  stateLabel: string;
  standbyUnsubmitted: boolean;
  /** 一句补充说明（备用通道不产生费用、结果未确认等），没有就是 null。 */
  note: string | null;
  attemptCount: number;
}

export interface ReconcileDisplay {
  /** 当前状态（通俗说法）。 */
  statusLabel: string;
  /** 全部通俗原因，顺序稳定、已去重。 */
  reasons: string[];
  /** 卡片上一句原因；没有原因时说明「没有待核对的问题」。 */
  reasonText: string;
  /** 费用状态（通俗说法，与生成成功分开）。 */
  costLabel: string;
  /** 费用是否还需要人工核实。 */
  costNeedsCheck: boolean;
  /** 生成是否已经成功（含晚到的通道成功）。 */
  succeeded: boolean;
  channels: ReconcileDisplayChannel[];
}

const STATUS_LABELS: Record<string, string> = {
  routing: '正在选择通道',
  waiting: '等待运行资源',
  pending: '排队中',
  accepted: '供应商已受理',
  maybe_sent: '提交中（待确认）',
  unknown: '结果待确认',
  succeeded: '生成成功',
  failed: '生成失败',
  canceled: '已取消',
  not_created: '未创建',
  download_failed: '下载未完成',
  needs_check: '待核对',
};

const CHANNEL_STATE_LABELS: Record<string, string> = {
  candidate: '候选通道',
  selected: '已选用',
  skipped: '未选用',
  waiting_capacity: '等待名额',
  overflowed: '名额满，已溢出',
  succeeded: '成功',
  failed: '失败',
  canceled: '已取消',
  unknown: '结果未确认',
  accepted: '已受理',
};

/**
 * 后端的 `attentionReasons` 是给管理员看的内部短语（「结果确认中」等），
 * 卡片上要换成「发生了什么、现在还不知道什么」的白话。认不出来的原因保留原文，
 * 不擅自归类成「失败」或「系统处理中」。
 */
const REASON_LABELS: Record<string, string> = {
  结果确认中: '生成结果还没有确认',
  提交结果未知: '供应商是否接单还没有确认',
  通道结果未知: '生成结果还没有确认',
  已请求取消: '已请求取消，已提交的部分还要等结果收尾',
  业务任务待核对: '任务记录还需要人工核对',
  供应商结果未知: '生成结果还没有确认',
  结果待补下载: '生成结果已就绪，但下载未完成',
};

const CANCEL_REASON = '已请求取消，已提交的部分还要等结果收尾';
const DOWNLOAD_REASON = '生成结果已就绪，但下载未完成';
const REMOTE_ID_REASON = '还没有记录到供应商的远端任务 ID';
const UNKNOWN_SUBMISSION_REASON = '供应商是否接单还没有确认';
const UNKNOWN_RESULT_REASON = '生成结果还没有确认';
const COST_UNKNOWN_REASON = '费用尚未核实';
const SUCCEEDED_COST_UNKNOWN_REASON = '生成已成功，费用尚未核实';

export function formatReconcileMoney(minor: number | null | undefined): string {
  if (minor === null || minor === undefined || !Number.isFinite(minor)) return '金额未记录';
  return `¥${(minor / 100).toFixed(2)}`;
}

function channelLabel(channelKey: string): string {
  if (channelKey === 'qiniu') return '七牛通道';
  if (channelKey === 'tencent') return '腾讯通道';
  return channelKey || '未记录通道';
}

function costLabelOf(cost: ReconcileDisplayTaskInput['cost']): { label: string; needsCheck: boolean } {
  switch (cost.costStatus) {
    case 'settled':
      return { label: `已核实 ${formatReconcileMoney(cost.actualMinor)}`, needsCheck: false };
    case 'released':
      return { label: '已释放，不计费', needsCheck: false };
    case 'estimated':
      return { label: `预估 ${formatReconcileMoney(cost.reservedMinor)}，尚未核实`, needsCheck: true };
    case 'unpriced':
      return { label: '未定价，待核实', needsCheck: true };
    case 'uncertain':
    default:
      return { label: '尚未核实', needsCheck: true };
  }
}

function isSucceeded(task: ReconcileDisplayTaskInput): boolean {
  if (task.status === 'succeeded') return true;
  return task.channels.some((channel) => channel.state === 'succeeded'
    || channel.attempts.some((attempt) => attempt.terminalState === 'succeeded'));
}

function missingRemoteIdentity(channel: ReconcileDisplayChannelInput): boolean {
  // 已经明确受理 / 有终态，却没留下远端 ID 或回执 ID —— 这是「远端身份缺失」，
  // 只能说明缺证据，不能据此猜成功或失败。`maybe_sent` 已由「是否接单还没确认」表达，
  // 不在这里重复一条。
  return channel.attempts.some((attempt) =>
    (attempt.submissionState === 'accepted'
      || attempt.terminalState === 'succeeded' || attempt.terminalState === 'failed')
    && !attempt.remoteId
    && !attempt.receiptRemoteId);
}

function describeChannel(
  channel: ReconcileDisplayChannelInput,
  task: ReconcileDisplayTaskInput,
): ReconcileDisplayChannel {
  const standbyUnsubmitted = channel.attempts.length === 0
    && channel.channelKey !== task.currentChannelKey;
  const stateLabel = standbyUnsubmitted
    ? '备用通道，未提交'
    : CHANNEL_STATE_LABELS[channel.state] ?? (channel.state || '状态未记录');
  let note: string | null = null;
  if (standbyUnsubmitted) {
    note = '当前没有向这条通道提交，也不会产生额外费用。';
  } else if (channel.state === 'unknown') {
    note = '这条通道有没有收到结果还没有确认。';
  } else if (channel.attempts.length === 0) {
    note = '这条通道还没有真实提交尝试。';
  }
  return {
    channelKey: channel.channelKey,
    label: channelLabel(channel.channelKey),
    stateLabel,
    standbyUnsubmitted,
    note,
    attemptCount: channel.attempts.length,
  };
}

export function describeReconcileTask(task: ReconcileDisplayTaskInput): ReconcileDisplay {
  const succeeded = isSucceeded(task);
  const cost = costLabelOf(task.cost);
  const reasons: string[] = [];
  const push = (reason: string) => {
    if (reason && !reasons.includes(reason)) reasons.push(reason);
  };

  for (const reason of task.attentionReasons) {
    push(REASON_LABELS[reason] ?? reason);
  }

  if (task.cancelRequestedAt) push(CANCEL_REASON);
  if (task.businessStatus === 'download_failed' || task.businessProviderStatus === 'download_failed') {
    push(DOWNLOAD_REASON);
  }
  if (task.businessStatus === 'needs_check') push('任务记录还需要人工核对');
  if (task.businessProviderStatus === 'unknown') push(UNKNOWN_RESULT_REASON);
  if (task.channels.some((channel) => channel.state === 'unknown')) push(UNKNOWN_RESULT_REASON);
  if (task.channels.some((channel) => channel.attempts.some((attempt) =>
    attempt.submissionState === 'maybe_sent' && attempt.terminalState === null))) {
    push(UNKNOWN_SUBMISSION_REASON);
  }
  if (task.channels.some(missingRemoteIdentity)) push(REMOTE_ID_REASON);

  if (succeeded && cost.needsCheck) {
    push(SUCCEEDED_COST_UNKNOWN_REASON);
  } else if ((task.cost.costStatus === 'uncertain' || task.cost.costStatus === 'unpriced')
    && !reasons.includes(SUCCEEDED_COST_UNKNOWN_REASON)) {
    push(COST_UNKNOWN_REASON);
  }

  return {
    statusLabel: STATUS_LABELS[task.status] ?? (task.status || '状态未记录'),
    reasons,
    reasonText: reasons.length > 0 ? reasons.join('；') : '没有待核对的问题，仅供查看。',
    costLabel: cost.label,
    costNeedsCheck: cost.needsCheck,
    succeeded,
    channels: task.channels.map((channel) => describeChannel(channel, task)),
  };
}
