'use client';

import type { BatchWorkspaceView } from '@/lib/batch-production/batch-workspace';
import type { OutputPresetId } from '@/lib/final-edit/types';
import BatchUnifiedReviewWorkspace from './review/BatchUnifiedReviewWorkspace';

export type CardFilter = 'all' | BatchWorkspaceView['cards'][number]['status'];

/**
 * 分配器已知警告码 → 用户可读文案(卡片提醒与编辑器弹窗两处共用)。
 * 带冒号的按前缀匹配(码后面跟着 segment/asset 等内部 ID),其余精确匹配;未知码原样显示。
 */
const BATCH_WARNING_TEXTS: Array<{ code: string; text: string; prefix: boolean }> = [
  { code: 'previous-version-reused:', text: '换一批画面后素材池不足，沿用了上一版的部分画面', prefix: true },
  { code: 'stitched-segment:', text: '单条素材装不下这段口播，已自动拼接多个镜头', prefix: true },
  { code: 'source-overlap:', text: '部分画面区间与其他片段重复', prefix: true },
  { code: 'analysis-fallback:', text: '该素材没有画面分析，使用了兜底匹配', prefix: true },
  { code: 'semantic-degraded:', text: '该片段语义匹配度较低', prefix: true },
  { code: 'opening-reused:', text: '开头画面与其他成片重复', prefix: true },
  { code: 'no-legal-media:', text: '没有可用素材', prefix: true },
  { code: 'cover-unavailable', text: '封面抽帧不可用', prefix: false },
];

export function humanizeBatchWarning(warning: string): string {
  const hit = BATCH_WARNING_TEXTS.find(({ code, prefix }) => (prefix ? warning.startsWith(code) : warning === code));
  return hit ? hit.text : warning;
}

export interface BatchStepReviewProps {
  workspace: BatchWorkspaceView;
  cardFilter: CardFilter;
  onCardFilterChange: (filter: CardFilter) => void;
  selectedPlanIds: string[];
  onTogglePlan: (planId: string, checked: boolean) => void;
  onSelectAll: () => void;
  onReview: (decision: 'approved' | 'rework' | 'cancelled') => void;
  /** 按明确成片集合审核(预览区「确认这条」只作用于正在预览的那一条) */
  onReviewPlans: (planIds: string[], decision: 'approved' | 'rework' | 'cancelled') => void;
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
    <div className="flex w-full min-h-0 flex-1 overflow-hidden" data-testid="batch-unified-review-screen">
      <BatchUnifiedReviewWorkspace
        projectId={props.projectId}
        batchId={props.selectedBatchId}
        workspace={props.workspace}
        outputPreset={props.outputPreset}
        selectedPlanIds={props.selectedPlanIds}
        onTogglePlan={props.onTogglePlan}
        onSelectAll={props.onSelectAll}
        onReview={props.onReview}
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
