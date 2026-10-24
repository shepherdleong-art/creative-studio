'use client';

import type { BatchOutputClipEditView } from '@/lib/live-mixcut/output-arrangement';
import type { BatchWorkspaceView } from '@/lib/live-mixcut/batch-workspace';

export type InspectorTab = 'subtitle' | 'picture' | 'cover' | 'audio' | 'packaging';
export type TimelineTool = 'select' | 'split';

export interface UnifiedFilmState {
  formula?: BatchWorkspaceView['cards'][number]['formula'];
  planId: string;
  seq: number;
  scriptTitle: string;
  status: BatchWorkspaceView['cards'][number]['status'];
  approved: boolean;
  approvable: boolean;
  reviewable: boolean;
  formalOutdated: boolean;
  coverAttemptId: string | null;
  coverStatus: string | null;
  durationSec: number;
  arrangement: BatchOutputClipEditView | null;
  visible: boolean;
  warnings: string[];
  sourceWarnings?: string[];
  sourceConflictAssetIds?: string[];
  sourceConflictGroups?: BatchOutputClipEditView['sourceConflictGroups'];
  blockers: string[];
  /** 口播任务(失败时可重试配音);来自 workspace 卡片视图。 */
  narrationTask: BatchWorkspaceView['cards'][number]['narrationTask'];
  /** 公式成片的实际制作检查，失败后可重试同一任务。 */
  executionTask?: BatchWorkspaceView['cards'][number]['executionTask'];
  /** 独立封面渲染任务(失败时可重试封面)。 */
  coverTask: BatchWorkspaceView['cards'][number]['coverTask'];
  /** 整片渲染任务(仅用于失败信息展示)。 */
  fullRenderTask: BatchWorkspaceView['cards'][number]['fullRenderTask'];
  /** 存在人工字幕覆盖;重试口播前需要提示会清除它。 */
  subtitleOverride: boolean;
}

export interface SelectionTarget {
  planId: string;
  kind: 'clip' | 'subtitle' | 'audio' | 'cover';
  clipId?: string;
  track?: 'narration' | 'bgm';
  cueId?: string;
}

export interface MaterialDragItem {
  assetId: string;
  contentFingerprint: string;
  displayName: string;
  durationSec: number | null;
  thumbnailUrl: string | null;
  previewUrl: string | null;
}

export interface DropTargetInfo {
  planId: string;
  type: 'replace' | 'insert' | 'append';
  clipId?: string;
  afterClipId?: string | null;
  offsetSec?: number;
}
