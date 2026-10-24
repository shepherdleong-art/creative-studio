'use client';

import type { BatchWorkspaceView } from '@/lib/live-mixcut/batch-workspace';
import type { BatchReviewTarget } from '@/lib/live-mixcut/review-context';
import type { OutputPresetId } from '@/lib/final-edit/types';
import BatchUnifiedReviewWorkspace from './review/BatchUnifiedReviewWorkspace';

export type CardFilter = 'all' | BatchWorkspaceView['cards'][number]['status'];

export { humanizeBatchWarning } from './batch-warning-text';

export interface BatchStepReviewProps {
  workspace: BatchWorkspaceView;
  cardFilter: CardFilter;
  onCardFilterChange: (filter: CardFilter) => void;
  selectedPlanIds: string[];
  onTogglePlan: (planId: string, checked: boolean) => void;
  onSelectAll: () => void;
  /** 按明确成片集合审核(预览区「确认这条」只作用于正在预览的那一条) */
  onReviewPlans: (items: BatchReviewTarget[], decision: 'approved' | 'rework' | 'cancelled') => Promise<boolean>;
  phaseEBusy: string | null;
  onRetryRender: (taskId: string) => void;
  onRetryNarration: (taskId: string) => void;
  onReallocate: (planId: string) => void;
  projectId: string;
  selectedBatchId: string;
  /** 批量输出画幅,供片段编辑的实时预览画布与字幕参数使用 */
  outputPreset: OutputPresetId;
  /** 片段编辑生效后回调(外层刷新 workspace) */
  onOutputChanged?: () => void;
  busy: 'create' | 'snapshot' | 'start' | null;
  onStartBatch: () => void;
}

/**
 * 第 3 步 · 检查成片:
 * 升级为已验证 v14 冻结基线的四区同屏工作台（素材池、实时成片预览、原版属性检查器、统一时间轴总览）。
 */
export default function BatchStepReview(props: BatchStepReviewProps) {
  return (
    <div className="flex w-full min-h-0 flex-none" data-testid="batch-unified-review-screen">
      <BatchUnifiedReviewWorkspace
        key={props.selectedBatchId}
        projectId={props.projectId}
        batchId={props.selectedBatchId}
        workspace={props.workspace}
        outputPreset={props.outputPreset}
        selectedPlanIds={props.selectedPlanIds}
        onTogglePlan={props.onTogglePlan}
        onSelectAll={props.onSelectAll}
        onReviewPlans={props.onReviewPlans}
        onReallocate={props.onReallocate}
        onRetryNarration={props.onRetryNarration}
        onRetryRender={props.onRetryRender}
        phaseEBusy={props.phaseEBusy}
        onOutputChanged={props.onOutputChanged}
      />
    </div>
  );
}
