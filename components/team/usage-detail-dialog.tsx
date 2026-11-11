'use client';

import type { ReactNode } from 'react';
import Link from 'next/link';
import { Dialog } from '@/components/ui/Dialog';
import { TASK_MODULE_LABELS } from '@/lib/team-task-labels';
import type { TeamUsageAttempt } from '@/lib/team-service/usage';
import type { TeamUnifiedChannelView, TeamUnifiedTaskView } from '@/lib/team-service/unified-usage';
import {
  STANDBY_CHANNEL_NOTE,
  attemptCostLabel,
  attemptResultLabel,
  attemptSubmissionLabel,
  attemptTerminalLabel,
  channelDisplayName,
  channelStateLabel,
  costStatusLabel,
  isStandbyChannel,
  taskCostLabel,
  usageMoney,
  usageTaskStatusLabel,
} from './usage-display';

/**
 * 用量明细的两个详情对话框（05 号票）。
 *
 * 主表只留短字段，长内容（远端 ID、项目名、错误、通道证据）全部搬进这里：
 * 内容是独立滚动的 `.dialog-body`，长文本在这里换行，主表列宽不受影响。
 * 开关对话框的焦点归还在调用方（`TeamUsagePanel`）做，Dialog 只管外壳与 Esc。
 */

const SOURCE_LABELS: Record<string, string> = {
  project_scene: '项目场景图',
  project_shot: '项目分镜',
  project_video: '项目视频',
  project_apply_scene: '分镜应用场景',
  project_regenerate: '项目重新生成',
  canvas: '创作画布',
  rework: '局部返工',
  team_film_rework: '团队实拍返工',
};

function formatTimestamp(value: string | null | undefined): string {
  if (!value) return '未记录';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
}

function DetailField({ label, children, breakAll = false }: { label: string; children: ReactNode; breakAll?: boolean }) {
  return <div className="min-w-0 rounded-[var(--radius-control)] bg-group px-3 py-2">
    <dt className="text-[12px] text-ink-tertiary">{label}</dt>
    <dd className={`mt-1 text-[13px] text-ink ${breakAll ? 'break-all' : 'break-words'}`}>{children}</dd>
  </div>;
}

function TechnicalField({ label, value }: { label: string; value: ReactNode }) {
  return <div className="grid min-w-0 grid-cols-[7.5rem_minmax(0,1fr)] gap-x-3 gap-y-1 text-[12px]">
    <span className="text-ink-tertiary">{label}</span>
    <span className="break-all text-ink-secondary">{value || '未记录'}</span>
  </div>;
}

function ChannelSummary({ channel }: { channel: TeamUnifiedChannelView }) {
  const standby = isStandbyChannel(channel);
  return <div className="min-w-0 rounded-[var(--radius-control)] border border-hairline px-3 py-2" data-testid="usage-channel-summary">
    <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] font-medium text-ink">
      <span>{channelDisplayName(channel.channelKey)}</span>
      <span className="text-[12px] font-normal text-ink-tertiary">·</span>
      <span className="text-[12px] font-normal text-ink-secondary">{standby ? '备用通道，未提交' : channelStateLabel(channel.state)}</span>
    </p>
    <p className="mt-1 break-all text-[12px] text-ink-tertiary">{channel.providerModel} · 优先级 {channel.priority}</p>
    {standby
      ? <p className="mt-1 text-[12px] leading-5 text-ink-secondary" data-testid="usage-standby-channel">{STANDBY_CHANNEL_NOTE}</p>
      : null}
    {channel.attempts.length === 0
      ? <p className="mt-1 text-[12px] text-ink-tertiary">{standby ? '这条通道没有真实提交记录。' : '这条通道还没有真实提交尝试。'}</p>
      : <ul className="mt-2 space-y-2">
        {channel.attempts.map((attempt) => <li key={attempt.attemptId} className="min-w-0 rounded-[9px] bg-surface px-2.5 py-2 text-[12px] text-ink-secondary">
          <p className="text-ink">{attemptResultLabel({ submissionState: attempt.submissionState, terminalState: attempt.terminalState })}</p>
          <p className="mt-0.5">费用：{attemptCostLabel(attempt)}</p>
          <p className="mt-0.5 break-all text-ink-tertiary">上游请求：{attempt.remoteId ?? '尚无回执'}</p>
          <p className="mt-0.5 break-all text-ink-tertiary">执行尝试：{attempt.attemptId}</p>
          {attempt.pricing?.pricingVersion || attempt.pricing?.coreModelKey ? <p className="mt-0.5 break-all text-ink-tertiary">
            计价：{attempt.pricing?.coreModelKey ?? '未记录'} · 版本 {attempt.pricing?.pricingVersion ?? '未记录'}
          </p> : null}
          {attempt.errorCode ? <p className="mt-0.5 break-all text-ink-tertiary">安全错误码：{attempt.errorCode}</p> : null}
        </li>)}
      </ul>}
  </div>;
}

/** 制作任务详情：通道摘要、费用、中文状态；技术字段折叠后按需展开。 */
export function TaskUsageDetailDialog({
  open,
  task,
  canViewTeam,
  onClose,
}: {
  open: boolean;
  task: TeamUnifiedTaskView | null;
  canViewTeam: boolean;
  onClose: () => void;
}) {
  if (!task) return null;
  const channels = task.channels ?? [];
  return <Dialog
    open={open}
    width="wide"
    title="制作任务详情"
    description={`${task.model} · ${formatTimestamp(task.createdAt)}`}
    onClose={onClose}
    footer={<button type="button" className="cap" onClick={onClose}>关闭</button>}
  >
    <div data-testid="usage-task-detail" className="space-y-4 pb-2">
      <dl className="grid gap-2 sm:grid-cols-2">
        <DetailField label="状态">{usageTaskStatusLabel(task)}{task.cancelRequestedAt
          ? <span className="mt-1 block text-[12px] text-warn">已请求取消，取消前已提交的结果和费用仍保留</span>
          : null}</DetailField>
        <DetailField label="费用">{taskCostLabel(task)}
          <span className="mt-1 block text-[12px] text-ink-tertiary">费用状态：{costStatusLabel(task.costStatus)}</span>
        </DetailField>
        <DetailField label="制作任务 / 通道调用">{task.generationTaskCount} 个制作任务 · {task.channelCallCount} 次通道调用</DetailField>
        <DetailField label="已提交 / 使用通道">{task.submissionCount} 次已提交 · 使用 {task.usedChannelCount} 个通道</DetailField>
        <DetailField label="成员">{task.actorDisplayName} · {task.employeeId}</DetailField>
        <DetailField label="模块 / 来源">{TASK_MODULE_LABELS[task.module] ?? task.module} · {SOURCE_LABELS[task.sourceType] ?? task.sourceType}</DetailField>
        <DetailField label="项目 / 范围" breakAll>{task.scopeName || '未记录'}</DetailField>
        <DetailField label="更新时间">{formatTimestamp(task.updatedAt)}</DetailField>
      </dl>

      <section aria-label="通道摘要" className="space-y-2">
        <h3 className="text-[13px] font-semibold text-ink">通道摘要</h3>
        {canViewTeam
          ? channels.length > 0
            ? channels.map((channel) => <ChannelSummary key={channel.channelKey} channel={channel} />)
            : <p className="text-[12px] leading-5 text-ink-tertiary">这条制作任务还没有真实通道记录。</p>
          : <p className="text-[12px] leading-5 text-ink-tertiary">员工视图只显示统一模型与任务合计，通道明细不对员工展示。</p>}
        <p className="text-[12px] leading-5 text-ink-tertiary">
          制作任务数与通道调用次数分开统计；自动兜底仍算一条制作任务，可能对应多条真实通道调用。费用以执行账本为准，未定价与待核账不显示为零元。
        </p>
      </section>

      <details className="rounded-[var(--radius-control)] border border-hairline px-3 py-2">
        <summary className="cursor-pointer text-[12px] font-medium text-ink-secondary">技术字段（排查用）</summary>
        <div className="mt-2 space-y-1.5">
          <TechnicalField label="制作任务 ID" value={task.mediaTaskId} />
          <TechnicalField label="业务任务 ID" value={task.taskId} />
          <TechnicalField label="统一模型" value={`${task.model}（${task.unifiedModel}）`} />
          <TechnicalField label="规则版本" value={task.ruleVersion} />
          <TechnicalField label="范围" value={`${task.scope.resourceType} · ${task.scope.resourceId}`} />
          <TechnicalField label="来源 ID" value={task.sourceId} />
          {channels.map((channel) => <TechnicalField
            key={`tech-${channel.channelKey}`}
            label={`通道 ${channel.channelKey}`}
            value={`${channel.providerModel} · ${channel.state} · 执行修订 ${channel.executionRevision}${channel.operationId ? ` · 操作 ${channel.operationId}` : ''}${channel.operationWaitReason ? ` · 等待原因 ${channel.operationWaitReason}` : ''}`}
          />)}
        </div>
      </details>
    </div>
  </Dialog>;
}

const ATTEMPT_SECTION_NOTES: Record<'channels' | 'legacy' | 'unmapped', string> = {
  channels: '已关联真实统一制作任务的一次通道调用。',
  legacy: '非统一模型记录：既没有统一模型身份，也没有制作任务关联。',
  unmapped: '待映射记录：带有统一任务关联但父任务不可用；保留原始身份并单列，不猜测归属。',
};

/** 调用记录详情（通道调用 / 非统一模型 / 待映射共用）。 */
export function AttemptUsageDetailDialog({
  open,
  item,
  section,
  onClose,
}: {
  open: boolean;
  item: TeamUsageAttempt | null;
  section: 'channels' | 'legacy' | 'unmapped';
  onClose: () => void;
}) {
  if (!item) return null;
  return <Dialog
    open={open}
    width="wide"
    title="调用记录详情"
    description={`${item.reportingModel || item.model} · ${formatTimestamp(item.createdAt)}`}
    onClose={onClose}
    footer={<button type="button" className="cap" onClick={onClose}>关闭</button>}
  >
    <div data-testid="usage-attempt-detail" className="space-y-4 pb-2">
      <dl className="grid gap-2 sm:grid-cols-2">
        <DetailField label="结果">{attemptResultLabel(item)}</DetailField>
        <DetailField label="费用">{attemptCostLabel(item)}
          <span className="mt-1 block text-[12px] text-ink-tertiary">费用状态：{costStatusLabel(item.costStatus)}</span>
        </DetailField>
        <DetailField label="时间">{formatTimestamp(item.createdAt)}</DetailField>
        <DetailField label="成员">{item.actorDisplayName} · {item.employeeId}</DetailField>
        <DetailField label="模型 / 模块">{item.reportingModel || item.model} · {TASK_MODULE_LABELS[item.module] ?? item.module}</DetailField>
        <DetailField label="统一模型">{item.unifiedModel ?? '无统一模型身份（非统一模型记录）'}</DetailField>
        <DetailField label="制作任务" breakAll>{item.mediaTaskId ?? '无制作任务关联'}</DetailField>
        <DetailField label="业务任务" breakAll>{item.taskId}</DetailField>
        <DetailField label="上游请求" breakAll>{item.remoteId ?? '尚无回执'}</DetailField>
        <DetailField label="提交阶段">{attemptSubmissionLabel(item.submissionState)}</DetailField>
        <DetailField label="终态">{item.outcome ? attemptTerminalLabel(item.outcome) : '尚未确认终态'}</DetailField>
        <DetailField label="序号">业务第 {item.businessAttemptNo} 次 · 提交轮次 {item.submitRound} · 传输序号 {item.transportSeq}</DetailField>
        <DetailField label="错误关联">{item.errorId
          ? <Link className="text-accent" href={`/team/errors?errorId=${encodeURIComponent(item.errorId)}`}>查看错误诊断</Link>
          : '没有关联错误记录'}</DetailField>
      </dl>

      <p className="text-[12px] leading-5 text-ink-tertiary">{ATTEMPT_SECTION_NOTES[section]}</p>

      <details className="rounded-[var(--radius-control)] border border-hairline px-3 py-2">
        <summary className="cursor-pointer text-[12px] font-medium text-ink-secondary">技术字段（排查用）</summary>
        <div className="mt-2 space-y-1.5">
          <TechnicalField label="调用记录 ID" value={item.attemptId} />
          <TechnicalField label="执行操作 ID" value={item.operationId} />
          <TechnicalField label="业务尝试 ID" value={item.businessAttemptId} />
          <TechnicalField label="提交状态" value={item.submissionState} />
          <TechnicalField label="终态" value={item.outcome ?? '未记录'} />
          <TechnicalField label="账期" value={item.accountingPeriod} />
          <TechnicalField label="策略版本" value={String(item.policyVersion)} />
          <TechnicalField label="配置版本" value={item.configVersion} />
          <TechnicalField label="客户端版本" value={item.clientVersion} />
          <TechnicalField label="服务端版本" value={item.serverReleaseId} />
          <TechnicalField label="用量镜像" value={item.usageMirrorStatus === 'recorded' ? '已记录' : '缺失'} />
          <TechnicalField label="预留 / 实际（分）" value={`${usageMoney(item.reservedMinor)} / ${item.actualMinor === null ? '无' : usageMoney(item.actualMinor)}`} />
        </div>
      </details>
    </div>
  </Dialog>;
}
