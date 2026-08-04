'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { BatchPreparationResult } from '@/lib/batch-production/prepare';
import type { BatchSnapshotDetail, BatchSnapshotResult } from '@/lib/batch-production/batch-flow';
import type { BatchProductionRow, BatchProductionStatus } from '@/lib/batch-production/versions';
import type { BatchLutRow } from '@/lib/batch-production/lut-catalog';
import type { BatchTasksView } from '@/lib/batch-production/tasks';
import type { BatchOutputCardStatus, BatchWorkspaceView } from '@/lib/batch-production/batch-workspace';
import {
  type AssetPrepareTaskView,
  BatchAssetSelectionCard,
  BatchFrozenScriptCard,
  BatchScriptSelectionCard,
  type PrepareAssetCardView,
} from './BatchInputSelectionCards';

interface AssetSelectionState {
  analysisId: string;
  lutId: string | null;
}

interface ReadinessResponse {
  available: boolean;
  message: string;
  code?: string;
}

type BatchListItem = Pick<BatchProductionRow, 'id' | 'projectId' | 'name' | 'status' | 'currentVersionId'>;

interface BatchListResponse {
  projectId: string;
  batches: BatchListItem[];
}

interface BatchCreateResponse {
  id: string;
  projectId: string;
  name: string;
}

interface BatchSnapshotResponse extends BatchSnapshotResult {
  batchId: string;
}

interface PreviewInfo {
  kind: 'proxy' | 'original' | 'original_pending_lut' | 'unavailable';
  originalOnline: boolean;
  warning?: string;
}

interface AnalyzeAssetsResponse {
  items?: Array<{ assetId: string; taskId: string | null; status: string; ready: boolean }>;
}

interface PreviewAsset {
  id: string;
  title: string;
  url: string;
}

interface VisionProviderView {
  id: string;
  name: string;
  model: string;
  configured: boolean;
  supportsVision?: boolean;
}

interface BatchPreparationPanelProps {
  projectId: string;
}

interface Feedback {
  kind: 'success' | 'error';
  message: string;
}

type OutputPreset = '3:4' | '9:16' | '16:9';
type CardFilter = 'all' | BatchOutputCardStatus;

async function readJson<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = typeof body.message === 'string' ? body.message : `HTTP ${response.status}`;
    throw new Error(message);
  }
  return body as T;
}

const BATCH_STATUS_LABELS: Record<BatchProductionStatus, string> = {
  draft: '待确认',
  running: '生产中',
  partially_completed: '部分完成',
  completed: '已完成',
  failed: '失败',
};

const TASK_STATUS_LABELS: Record<string, string> = {
  queued: '排队中',
  running: '生成中',
  succeeded: '已完成',
  failed: '失败',
  cancelled: '已取消',
};

const TASK_PHASE_LABELS: Record<string, string> = {
  starting: '准备中',
  running: '执行中',
  locating: '定位来源',
  preflight: '环境检查',
  probing: '探测媒体',
  content_analyzing: '画面内容分析',
  verifying_lut: '核验 LUT',
  encoding: '编码中',
  verifying: '核验产物',
  ready: '已就绪',
  rendering: '渲染中',
  cover: '生成封面',
};

const CARD_STATUS_LABELS: Record<BatchOutputCardStatus, string> = {
  completed: '已完成',
  needs_attention: '需处理',
  processing: '渲染中',
  waiting: '等待中',
  paused: '已暂停',
  retryable_failed: '可重试',
  stopped: '已停止',
};

/** 后端原始错误 → 用户可读文案。匹配用 includes，避免依赖完整字符串。 */
const EXPORT_SKIP_REASONS: Array<{ match: string; text: string }> = [
  { match: 'productionReady', text: '还没有配音' },
  { match: 'narration', text: '还没有配音' },
  { match: '原片来源', text: '找不到原始素材文件' },
  { match: '内容指纹', text: '原始素材已被修改' },
  { match: 'LUT', text: '调色滤镜已丢失或被修改' },
  { match: '已存在', text: '成品文件已存在，不覆盖' },
];

function humanizeSkipReason(reason: string | undefined): string {
  if (!reason) return '未知原因';
  const hit = EXPORT_SKIP_REASONS.find(({ match }) => reason.includes(match));
  return hit ? hit.text : '导出前检查未通过';
}

export default function BatchPreparationPanel({ projectId }: BatchPreparationPanelProps) {
  const [preparation, setPreparation] = useState<BatchPreparationResult | null>(null);
  const [batches, setBatches] = useState<BatchListItem[]>([]);
  const [selectedBatchId, setSelectedBatchId] = useState('');
  const [newBatchName, setNewBatchName] = useState('');
  const [selectedScripts, setSelectedScripts] = useState<Record<string, number>>({});
  const [selectedAssets, setSelectedAssets] = useState<Record<string, AssetSelectionState>>({});
  const [outputPlans, setOutputPlans] = useState<Array<{ id: string; seq: number }>>([]);
  const [batchStatus, setBatchStatus] = useState<BatchProductionStatus>('draft');
  const [batchInputState, setBatchInputState] = useState<'draft' | 'frozen' | null>(null);
  const [frozenScriptSnapshots, setFrozenScriptSnapshots] = useState<BatchSnapshotDetail['scriptSnapshots']>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<'create' | 'snapshot' | 'start' | null>(null);
  const [error, setError] = useState('');
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  /** 当前 UI 选择是否与已确认的批次版本一致；修改脚本/素材/分析版本/LUT 后必须重新确认 */
  const [inputConfirmed, setInputConfirmed] = useState(false);

  const [luts, setLuts] = useState<BatchLutRow[]>([]);
  const [lutImporting, setLutImporting] = useState(false);
  const lutFileInputRef = useRef<HTMLInputElement | null>(null);
  const [proxyTasks, setProxyTasks] = useState<BatchTasksView['tasks']>([]);
  const [assetPrepareTasks, setAssetPrepareTasks] = useState<AssetPrepareTaskView[]>([]);
  const [analysisBusy, setAnalysisBusy] = useState<string | null>(null);
  const [previewAsset, setPreviewAsset] = useState<PreviewAsset | null>(null);
  const [visionProviders, setVisionProviders] = useState<VisionProviderView[]>([]);
  const [visionProviderId, setVisionProviderId] = useState('');
  const previewCloseButtonRef = useRef<HTMLButtonElement | null>(null);
  const analysisReloadedTaskIdsRef = useRef<Set<string>>(new Set());
  const [proxyBusyAssetId, setProxyBusyAssetId] = useState<string | null>(null);
  const [proxyBatchBusy, setProxyBatchBusy] = useState(false);
  const [cacheUsage, setCacheUsage] = useState<{ count: number; totalBytes: number } | null>(null);
  const [cleanupBusy, setCleanupBusy] = useState<'selected' | 'project' | null>(null);
  const [previewInfos, setPreviewInfos] = useState<Record<string, PreviewInfo>>({});
  const [outputPreset, setOutputPreset] = useState<OutputPreset>('3:4');
  const [targetDurationSec, setTargetDurationSec] = useState(15);
  const [workspace, setWorkspace] = useState<BatchWorkspaceView | null>(null);
  const [cardFilter, setCardFilter] = useState<CardFilter>('all');
  const [selectedPlanIds, setSelectedPlanIds] = useState<string[]>([]);
  const [phaseEBusy, setPhaseEBusy] = useState<'export' | 'control' | string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const readiness = await readJson<ReadinessResponse>(await fetch('/api/batch-production/readiness', { cache: 'no-store' }));
      if (!readiness.available) throw new Error(readiness.message || '批量生产暂不可用');
      const [result, batchResult, providerResult] = await Promise.all([
        readJson<BatchPreparationResult>(await fetch(
          `/api/batch-production/prepare?projectId=${encodeURIComponent(projectId)}`,
          { cache: 'no-store' },
        )),
        readJson<BatchListResponse>(await fetch(
          `/api/batch-production/batches?projectId=${encodeURIComponent(projectId)}`,
          { cache: 'no-store' },
        )),
        readJson<VisionProviderView[]>(await fetch('/api/providers/script', { cache: 'no-store' }))
          .catch(() => []),
      ]);
      setPreparation(result);
      setBatches(batchResult.batches);
      setVisionProviders(providerResult);
      setVisionProviderId((current) => (
        providerResult.some((provider) => provider.id === current && provider.configured && provider.supportsVision)
          ? current
          : providerResult.find((provider) => provider.configured && provider.supportsVision)?.id ?? ''
      ));
      if (batchResult.batches.length === 0) {
        setOutputPlans([]);
        setBatchStatus('draft');
        setBatchInputState(null);
        setFrozenScriptSnapshots([]);
        setInputConfirmed(false);
        setAssetPrepareTasks([]);
      }
      setSelectedBatchId((current) => (
        batchResult.batches.some(({ id }) => id === current) ? current : batchResult.batches[0]?.id ?? ''
      ));
    } catch (loadError) {
      setPreparation(null);
      setBatches([]);
      setError(loadError instanceof Error ? loadError.message : '无法读取批量准备区');
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  const loadBatchDetail = useCallback(async (batchId: string) => {
    const batch = batches.find(({ id }) => id === batchId);
    setBatchStatus(batch?.status ?? 'draft');
    if (!batch?.currentVersionId) {
      setOutputPlans([]);
      setSelectedScripts({});
      setSelectedAssets({});
      setBatchInputState(null);
      setFrozenScriptSnapshots([]);
      setInputConfirmed(false);
      return;
    }
    try {
      const detail = await readJson<BatchSnapshotDetail>(await fetch(
        `/api/batch-production/batches/${encodeURIComponent(batchId)}?projectId=${encodeURIComponent(projectId)}`,
        { cache: 'no-store' },
      ));
      setBatchStatus(detail.batch.status);
      setBatchInputState(detail.version.inputState);
      setOutputPlans(detail.outputPlans);
      setSelectedScripts(Object.fromEntries(detail.scriptSnapshots.map(({ sourceScriptId, copyCount }) => [sourceScriptId, copyCount])));
      setSelectedAssets(Object.fromEntries(detail.assetPool.map(({ assetId, analysisId, colorSnapshot }) => (
        [assetId, { analysisId, lutId: colorSnapshot.lutId }]
      ))));
      setFrozenScriptSnapshots(detail.version.inputState === 'frozen' ? detail.scriptSnapshots : []);
      // 从已确认版本详情恢复的选择与快照一致，标记为已确认；
      // 用户随后任何修改都会通过 markInputChanged 取消该标记。
      setInputConfirmed(true);
    } catch (detailError) {
      setOutputPlans([]);
      setInputConfirmed(false);
      setFeedback({
        kind: 'error',
        message: detailError instanceof Error ? detailError.message : '批次详情读取失败',
      });
    }
  }, [batches, projectId]);

  const loadLuts = useCallback(async () => {
    try {
      const result = await readJson<{ luts: BatchLutRow[] }>(await fetch(
        `/api/batch-production/luts?projectId=${encodeURIComponent(projectId)}`,
        { cache: 'no-store' },
      ));
      setLuts(result.luts);
    } catch {
      // LUT 列表读取失败不阻塞批量准备区其他功能，保留上一次的列表。
    }
  }, [projectId]);

  const loadCacheUsage = useCallback(async () => {
    try {
      const usage = await readJson<{ count: number; totalBytes: number }>(await fetch(
        `/api/batch-production/proxies/usage?projectId=${encodeURIComponent(projectId)}`,
        { cache: 'no-store' },
      ));
      setCacheUsage(usage);
    } catch {
      // 用量查询失败不阻塞清理操作本身，只是暂时不显示预计释放空间。
    }
  }, [projectId]);

  const loadProxyTasks = useCallback(async (batchId: string) => {
    if (!batchId) {
      setProxyTasks([]);
      setAssetPrepareTasks([]);
      return;
    }
    try {
      const view = await readJson<BatchTasksView>(await fetch(
        `/api/batch-production/batches/${encodeURIComponent(batchId)}/tasks?projectId=${encodeURIComponent(projectId)}`,
        { cache: 'no-store' },
      ));
      setProxyTasks(view.tasks.filter((task) => task.workType === 'proxy_generate'));
      setAssetPrepareTasks(view.tasks
        .filter((task) => task.workType === 'asset_prepare')
        .map((task) => ({
          id: task.id,
          targetId: task.targetId,
          status: task.status,
          progressJson: task.progressJson,
          attemptCount: task.attemptCount,
          attempts: task.attempts,
        })));
    } catch {
      // 任务状态轮询失败不阻塞其他操作，下一轮轮询会自动重试。
    }
  }, [projectId]);

  const loadWorkspace = useCallback(async (batchId: string) => {
    if (!batchId) {
      setWorkspace(null);
      return;
    }
    try {
      const view = await readJson<BatchWorkspaceView>(await fetch(
        `/api/batch-production/batches/${encodeURIComponent(batchId)}/workspace?projectId=${encodeURIComponent(projectId)}`,
        { cache: 'no-store' },
      ));
      setWorkspace(view);
      setBatchStatus(view.batch.status);
      if (view.cards.length > 0) {
        setOutputPlans(view.cards.map(({ planId, seq }) => ({ id: planId, seq })));
      }
      setSelectedPlanIds((current) => current.filter((id) => view.cards.some(({ planId }) => planId === id)));
    } catch {
      setWorkspace(null);
    }
  }, [projectId]);

  const loadPreviewInfos = useCallback(async (batchId: string, versionId: string | null, assetIds: string[]) => {
    if (!versionId || assetIds.length === 0) {
      setPreviewInfos({});
      return;
    }
    const entries = await Promise.all(assetIds.map(async (assetId) => {
      try {
        const info = await readJson<PreviewInfo>(await fetch(
          `/api/batch-production/preview/${encodeURIComponent(assetId)}?projectId=${encodeURIComponent(projectId)}`
          + `&batchId=${encodeURIComponent(batchId)}&batchVersionId=${encodeURIComponent(versionId)}&previewInfo=1`,
          { cache: 'no-store' },
        ));
        return [assetId, info] as const;
      } catch {
        return [assetId, { kind: 'unavailable', originalOnline: false, warning: '预览信息读取失败' }] as const;
      }
    }));
    setPreviewInfos(Object.fromEntries(entries));
  }, [projectId]);

  useEffect(() => {
    const timer = window.setTimeout(() => { void load(); void loadLuts(); void loadCacheUsage(); }, 0);
    return () => window.clearTimeout(timer);
  }, [load, loadLuts, loadCacheUsage]);

  useEffect(() => {
    if (!selectedBatchId) return;
    const initial = window.setTimeout(() => void loadProxyTasks(selectedBatchId), 0);
    return () => window.clearTimeout(initial);
  }, [selectedBatchId, loadProxyTasks]);

  useEffect(() => {
    if (!selectedBatchId) return;
    const hasActiveTask = [...proxyTasks, ...assetPrepareTasks].some((task) => task.status === 'queued' || task.status === 'running');
    if (!hasActiveTask) return;
    const interval = window.setInterval(() => void loadProxyTasks(selectedBatchId), 3_000);
    return () => window.clearInterval(interval);
  }, [selectedBatchId, loadProxyTasks, proxyTasks, assetPrepareTasks]);

  useEffect(() => {
    const initial = window.setTimeout(() => void loadWorkspace(selectedBatchId), 0);
    if (!selectedBatchId) return () => window.clearTimeout(initial);
    const interval = window.setInterval(() => void loadWorkspace(selectedBatchId), 3_000);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(interval);
    };
  }, [selectedBatchId, loadWorkspace]);

  useEffect(() => {
    if (!selectedBatchId) return;
    const timer = window.setTimeout(() => void loadBatchDetail(selectedBatchId), 0);
    return () => window.clearTimeout(timer);
  }, [loadBatchDetail, selectedBatchId]);

  const currentBatch = batches.find(({ id }) => id === selectedBatchId);
  const currentVersionId = currentBatch?.currentVersionId ?? null;

  // Technical and content tasks both replace the asset's current analysis
  // pointer. Refresh exactly once per succeeded task so upgrades from
  // technical → content also become visible without a manual global reload.
  useEffect(() => {
    for (const task of assetPrepareTasks) {
      if (task.status !== 'succeeded') analysisReloadedTaskIdsRef.current.delete(task.id);
    }
    const completedWithoutProjection = assetPrepareTasks.filter((task) => (
      task.status === 'succeeded'
      && !analysisReloadedTaskIdsRef.current.has(task.id)
    ));
    if (completedWithoutProjection.length === 0) return;
    completedWithoutProjection.forEach((task) => analysisReloadedTaskIdsRef.current.add(task.id));
    void load();
  }, [assetPrepareTasks, load]);

  // 代理任务状态变化后刷新各素材的预览来源信息(代理就绪/未应用 LUT 警告/原片离线等)
  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (!selectedBatchId || !currentVersionId) {
        setPreviewInfos({});
        return;
      }
      const assetIds = Object.keys(selectedAssets);
      if (assetIds.length === 0) {
        setPreviewInfos({});
        return;
      }
      void loadPreviewInfos(selectedBatchId, currentVersionId, assetIds);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [selectedBatchId, currentVersionId, selectedAssets, proxyTasks, loadPreviewInfos]);

  const selectedScriptEntries = useMemo(() => Object.entries(selectedScripts), [selectedScripts]);
  const analysisTaskByAsset = useMemo(() => {
    const byAsset = new Map<string, AssetPrepareTaskView>();
    for (const task of assetPrepareTasks) byAsset.set(task.targetId, task);
    return byAsset;
  }, [assetPrepareTasks]);
  const analysisCandidates = useMemo(
    () => (preparation?.assets ?? []).filter(({ status, currentAnalysisId }) => status === 'online' && !currentAnalysisId),
    [preparation],
  );
  const contentAnalysisCandidates = useMemo(
    () => (preparation?.assets ?? []).filter(({ status, analysisLevel }) => status === 'online' && analysisLevel !== 'content'),
    [preparation],
  );
  const plannedCount = useMemo(
    () => selectedScriptEntries.reduce((sum, [, copyCount]) => sum + copyCount, 0),
    [selectedScriptEntries],
  );
  const visibleCards = useMemo(() => (
    workspace?.cards.filter(({ status }) => cardFilter === 'all' || status === cardFilter) ?? []
  ), [workspace, cardFilter]);

  function markInputChanged(): void {
    setOutputPlans([]);
    setInputConfirmed(false);
    setFeedback(null);
  }

  function previewUrl(assetId: string): string {
    if (!selectedBatchId || !currentVersionId) return '';
    return `/api/batch-production/preview/${encodeURIComponent(assetId)}?projectId=${encodeURIComponent(projectId)}`
      + `&batchId=${encodeURIComponent(selectedBatchId)}&batchVersionId=${encodeURIComponent(currentVersionId)}`;
  }

  useEffect(() => {
    if (!previewAsset) return;
    const timer = window.setTimeout(() => previewCloseButtonRef.current?.focus(), 0);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setPreviewAsset(null);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [previewAsset]);

  function openAssetPreview(asset: PrepareAssetCardView): void {
    if (!asset.previewUrl) return;
    setPreviewAsset({
      id: asset.id,
      title: asset.media.displayName || asset.media.filename || '视频素材',
      url: asset.previewUrl,
    });
  }

  function openPreparedAssetPreview(assetId: string): void {
    const asset = preparation?.assets.find((item) => item.id === assetId);
    const url = previewUrl(assetId);
    if (!asset || !url) return;
    setPreviewAsset({
      id: assetId,
      title: asset.media.displayName || asset.media.filename || '视频素材',
      url,
    });
  }

  async function analyzeAssets(assetIds: string[], mode: 'technical' | 'content' = 'technical'): Promise<void> {
    if (!selectedBatchId) {
      setFeedback({ kind: 'error', message: '请先创建或选择一个批次，再开始素材分析。' });
      return;
    }
    if (mode === 'content' && !visionProviderId) {
      setFeedback({ kind: 'error', message: '请先在设置中启用并配置一个支持图片理解的脚本供应商。' });
      return;
    }
    const candidates = new Set(
      (preparation?.assets ?? [])
        .filter((asset) => asset.status === 'online' && (
          mode === 'content' ? asset.analysisLevel !== 'content' : !asset.currentAnalysisId
        ))
        .map((asset) => asset.id),
    );
    const requestedAssetIds = [...new Set(assetIds)].filter((assetId) => candidates.has(assetId));
    if (requestedAssetIds.length === 0) {
      setFeedback({ kind: 'success', message: mode === 'content' ? '在线素材都已有内容分析。' : '没有需要基础分析的在线素材。' });
      return;
    }
    const busyKey = requestedAssetIds.length === candidates.size ? '__all__' : requestedAssetIds[0];
    setAnalysisBusy(busyKey);
    setFeedback(null);
    try {
      const result = await readJson<AnalyzeAssetsResponse>(await fetch(
        `/api/batch-production/batches/${encodeURIComponent(selectedBatchId)}/assets/analyze?projectId=${encodeURIComponent(projectId)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ assetIds: requestedAssetIds, mode, providerId: mode === 'content' ? visionProviderId : undefined }),
        },
      ));
      analysisReloadedTaskIdsRef.current.clear();
      await loadProxyTasks(selectedBatchId);
      const responseItems = result.items ?? [];
      if (responseItems.some((item) => item.ready)) await load();
      const providerName = visionProviders.find((provider) => provider.id === visionProviderId)?.name;
      setFeedback({
        kind: 'success',
        message: mode === 'content'
          ? `已为 ${requestedAssetIds.length} 条素材安排内容分析${providerName ? `，抽帧将发送给 ${providerName}` : ''}。`
          : `已为 ${requestedAssetIds.length} 条素材安排基础分析。`,
      });
    } catch (analyzeError) {
      setFeedback({ kind: 'error', message: analyzeError instanceof Error ? analyzeError.message : '素材基础分析请求失败' });
    } finally {
      setAnalysisBusy(null);
    }
  }

  async function retryAssetAnalysis(taskId: string): Promise<void> {
    if (!selectedBatchId) {
      setFeedback({ kind: 'error', message: '请先创建或选择一个批次。' });
      return;
    }
    setAnalysisBusy(taskId);
    setFeedback(null);
    try {
      await readJson(await fetch(
        `/api/batch-production/tasks/${encodeURIComponent(taskId)}/retry?projectId=${encodeURIComponent(projectId)}`,
        { method: 'POST' },
      ));
      analysisReloadedTaskIdsRef.current.delete(taskId);
      await loadProxyTasks(selectedBatchId);
      setFeedback({ kind: 'success', message: '已重新排队素材基础分析。' });
    } catch (retryError) {
      setFeedback({ kind: 'error', message: retryError instanceof Error ? retryError.message : '素材分析重试失败' });
    } finally {
      setAnalysisBusy(null);
    }
  }

  async function createBatch(): Promise<void> {
    const name = newBatchName.trim();
    if (!name) {
      setFeedback({ kind: 'error', message: '请先输入新批次名称。' });
      return;
    }
    setBusy('create');
    setFeedback(null);
    try {
      const created = await readJson<BatchCreateResponse>(await fetch('/api/batch-production/batches', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId, name }),
      }));
      const batch: BatchListItem = {
        ...created,
        status: 'draft',
        currentVersionId: null,
      };
      setBatches((current) => [...current, batch]);
      setSelectedBatchId(created.id);
      setProxyTasks([]);
      setAssetPrepareTasks([]);
      analysisReloadedTaskIdsRef.current.clear();
      setNewBatchName('');
      setSelectedScripts({});
      setSelectedAssets({});
      setOutputPlans([]);
      setBatchInputState(null);
      setFrozenScriptSnapshots([]);
      setBatchStatus('draft');
      setInputConfirmed(false);
      setFeedback({ kind: 'success', message: `批次已创建：${created.name}` });
    } catch (createError) {
      setFeedback({ kind: 'error', message: createError instanceof Error ? createError.message : '批次创建失败' });
    } finally {
      setBusy(null);
    }
  }

  async function confirmSnapshot(): Promise<void> {
    if (!selectedBatchId) {
      setFeedback({ kind: 'error', message: '请先创建或选择一个批次。' });
      return;
    }
    if (selectedScriptEntries.length === 0) {
      setFeedback({ kind: 'error', message: '请至少选择一份脚本。' });
      return;
    }
    const assetSelections = Object.entries(selectedAssets).map(([assetId, selection]) => ({
      assetId,
      analysisId: selection.analysisId,
      colorSnapshot: { lutId: selection.lutId },
    }));
    if (assetSelections.length === 0) {
      setFeedback({ kind: 'error', message: '请至少选择一条已完成分析的可用素材。' });
      return;
    }
    setBusy('snapshot');
    setFeedback(null);
    try {
      const result = await readJson<BatchSnapshotResponse>(await fetch(
        `/api/batch-production/batches/${encodeURIComponent(selectedBatchId)}/snapshot?projectId=${encodeURIComponent(projectId)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            scriptSelections: selectedScriptEntries.map(([scriptId, copyCount]) => ({ scriptId, copyCount })),
            assetSelections,
            defaultsJson: {
              performanceMode: 'full_speed',
              outputPreset,
              preset: outputPreset,
              fps: 24,
              targetDurationSec,
            },
          }),
        },
      ));
      if (result.planIds.length !== result.totalPlans) {
        throw new Error(`成片计划数量不一致：应有 ${result.totalPlans} 张，实际 ${result.planIds.length} 张`);
      }
      setInputConfirmed(true);
      const lutAssetIds = assetSelections
        .filter(({ colorSnapshot }) => colorSnapshot.lutId !== null)
        .map(({ assetId }) => assetId);
      if (result.inputState === 'frozen') {
        await loadBatchDetail(selectedBatchId);
        try {
          const requestedCount = await submitProxyRequests(selectedBatchId, lutAssetIds);
          setFeedback({
            kind: 'success',
            message: requestedCount > 0
              ? `整体输入没有变化，继续使用已冻结版本；已为 ${requestedCount} 条启用 LUT 的素材请求匹配代理。`
              : '整体输入没有变化，继续使用已冻结的批次版本。',
          });
        } catch (proxyError) {
          setFeedback({
            kind: 'error',
            message: `整体输入已确认，但 LUT 代理请求失败：${proxyError instanceof Error ? proxyError.message : '未知错误'}`,
          });
        }
        return;
      }
      setOutputPlans(result.planIds.map((id, index) => ({
        id,
        seq: index + 1,
      })));
      setBatchStatus('draft');
      setBatchInputState('draft');
      setFrozenScriptSnapshots([]);
      setBatches((current) => current.map((batch) => batch.id === selectedBatchId
        ? { ...batch, currentVersionId: result.batchVersionId, status: 'draft' }
        : batch));
      try {
        const requestedCount = await submitProxyRequests(selectedBatchId, lutAssetIds);
        setFeedback({
          kind: 'success',
          message: requestedCount > 0
            ? `已确认 ${result.totalPlans} 张成片计划，并为 ${requestedCount} 条启用 LUT 的素材请求匹配代理`
            : `已确认 ${result.totalPlans} 张成片计划`,
        });
      } catch (proxyError) {
        setFeedback({
          kind: 'error',
          message: `整体输入已确认，但 LUT 代理请求失败：${proxyError instanceof Error ? proxyError.message : '未知错误'}`,
        });
      }
    } catch (snapshotError) {
      setFeedback({ kind: 'error', message: snapshotError instanceof Error ? snapshotError.message : '批次输入确认失败' });
    } finally {
      setBusy(null);
    }
  }

  async function startBatch(): Promise<void> {
    if (!selectedBatchId || outputPlans.length === 0) {
      setFeedback({ kind: 'error', message: '请先确认整体输入并建立成片计划。' });
      return;
    }
    setBusy('start');
    setFeedback(null);
    try {
      const result = await readJson<{
        batchId: string;
        status: 'running';
        allocationStatus: 'completed' | 'partial' | 'blocked';
        outputCount: number;
      }>(await fetch(
        `/api/batch-production/batches/${encodeURIComponent(selectedBatchId)}/start?projectId=${encodeURIComponent(projectId)}`,
        { method: 'PUT' },
      ));
      setBatchStatus('running');
      setBatches((current) => current.map((batch) => batch.id === selectedBatchId
        ? { ...batch, status: 'running' }
        : batch));
      setFeedback({
        kind: result.allocationStatus === 'blocked' ? 'error' : 'success',
        message: result.allocationStatus === 'blocked'
          ? '联合分配被阻塞，请查看成片卡片中的原因。'
          : `联合分配完成，已建立 ${result.outputCount} 条渲染候选。`,
      });
      await loadBatchDetail(selectedBatchId);
      await loadWorkspace(selectedBatchId);
    } catch (startError) {
      setFeedback({ kind: 'error', message: startError instanceof Error ? startError.message : '批次启动失败' });
    } finally {
      setBusy(null);
    }
  }

  const hasConfirmedVersion = Boolean(currentVersionId);

  async function submitProxyRequests(batchId: string, assetIds: string[] | undefined): Promise<number> {
    if (assetIds && assetIds.length === 0) return 0;
    const result = await readJson<{ requested: Array<{ assetId: string }> }>(await fetch(
      `/api/batch-production/batches/${encodeURIComponent(batchId)}/proxies?projectId=${encodeURIComponent(projectId)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ assetIds }),
      },
    ));
    await loadProxyTasks(batchId);
    return result.requested.length;
  }

  async function requestProxies(assetIds: string[] | undefined, busyMarker: string | null): Promise<void> {
    if (!selectedBatchId || !hasConfirmedVersion) {
      setFeedback({ kind: 'error', message: '请先确认整体输入，代理请求需要读取已确认的色彩快照。' });
      return;
    }
    if (!inputConfirmed) {
      setFeedback({ kind: 'error', message: '整体输入已修改但尚未重新确认，不能请求代理；请先确认当前输入。' });
      return;
    }
    if (busyMarker) setProxyBusyAssetId(busyMarker); else setProxyBatchBusy(true);
    setFeedback(null);
    try {
      const requestedCount = await submitProxyRequests(selectedBatchId, assetIds);
      setFeedback({ kind: 'success', message: `已为 ${requestedCount} 条素材请求代理` });
    } catch (requestError) {
      setFeedback({ kind: 'error', message: requestError instanceof Error ? requestError.message : '代理请求失败' });
    } finally {
      setProxyBusyAssetId(null);
      setProxyBatchBusy(false);
    }
  }

  async function importLutFile(file: File): Promise<void> {
    setLutImporting(true);
    setFeedback(null);
    try {
      const form = new FormData();
      form.append('file', file);
      const result = await readJson<{ id: string; reused: boolean }>(await fetch(
        `/api/batch-production/luts?projectId=${encodeURIComponent(projectId)}`,
        { method: 'POST', body: form },
      ));
      setFeedback({ kind: 'success', message: result.reused ? 'LUT 内容已存在，复用既有记录' : 'LUT 导入成功' });
      await loadLuts();
    } catch (importError) {
      setFeedback({ kind: 'error', message: importError instanceof Error ? importError.message : 'LUT 导入失败' });
    } finally {
      setLutImporting(false);
      if (lutFileInputRef.current) lutFileInputRef.current.value = '';
    }
  }

  async function lutAction(lutId: string, action: 'archive' | 'restore' | 'delete'): Promise<void> {
    setFeedback(null);
    try {
      await readJson(await fetch(
        `/api/batch-production/luts/${encodeURIComponent(lutId)}/control?projectId=${encodeURIComponent(projectId)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action }),
        },
      ));
      await loadLuts();
    } catch (actionError) {
      setFeedback({ kind: 'error', message: actionError instanceof Error ? actionError.message : 'LUT 操作失败' });
    }
  }

  async function retryProxyTask(taskId: string): Promise<void> {
    setFeedback(null);
    try {
      await readJson(await fetch(
        `/api/batch-production/tasks/${encodeURIComponent(taskId)}/retry?projectId=${encodeURIComponent(projectId)}`,
        { method: 'POST' },
      ));
      if (selectedBatchId) await loadProxyTasks(selectedBatchId);
    } catch (retryError) {
      setFeedback({ kind: 'error', message: retryError instanceof Error ? retryError.message : '重试失败' });
    }
  }

  async function controlProxyTask(taskId: string, action: 'pause' | 'resume' | 'cancel'): Promise<void> {
    setFeedback(null);
    try {
      await readJson(await fetch(
        `/api/batch-production/tasks/${encodeURIComponent(taskId)}/control?projectId=${encodeURIComponent(projectId)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action }),
        },
      ));
      if (selectedBatchId) await loadProxyTasks(selectedBatchId);
    } catch (controlError) {
      setFeedback({ kind: 'error', message: controlError instanceof Error ? controlError.message : '任务控制失败' });
    }
  }

  async function cleanupProxies(scope: 'selected' | 'project'): Promise<void> {
    setCleanupBusy(scope);
    setFeedback(null);
    try {
      const assetIds = scope === 'selected' ? Object.keys(selectedAssets) : undefined;
      if (scope === 'selected' && (!assetIds || assetIds.length === 0)) {
        setFeedback({ kind: 'error', message: '请先选择要清理代理的素材。' });
        return;
      }
      const result = await readJson<{ deletedCount: number; freedBytes: number; skippedCount: number }>(await fetch(
        `/api/batch-production/proxies/cleanup?projectId=${encodeURIComponent(projectId)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ assetIds }),
        },
      ));
      const freedMb = (result.freedBytes / (1024 * 1024)).toFixed(1);
      setFeedback({
        kind: 'success',
        message: `已清理 ${result.deletedCount} 个代理，释放 ${freedMb}MB${result.skippedCount > 0 ? `，跳过 ${result.skippedCount} 个使用中的文件` : ''}`,
      });
      await loadCacheUsage();
    } catch (cleanupError) {
      setFeedback({ kind: 'error', message: cleanupError instanceof Error ? cleanupError.message : '代理清理失败' });
    } finally {
      setCleanupBusy(null);
    }
  }

  async function retryRenderTask(taskId: string): Promise<void> {
    setPhaseEBusy(taskId);
    setFeedback(null);
    try {
      await readJson(await fetch(
        `/api/batch-production/tasks/${encodeURIComponent(taskId)}/retry?projectId=${encodeURIComponent(projectId)}`,
        { method: 'POST' },
      ));
      if (selectedBatchId) await loadWorkspace(selectedBatchId);
    } catch (retryError) {
      setFeedback({ kind: 'error', message: retryError instanceof Error ? retryError.message : '重试失败' });
    } finally {
      setPhaseEBusy(null);
    }
  }

  async function reallocateOutput(planId: string): Promise<void> {
    if (!selectedBatchId) return;
    setPhaseEBusy(planId);
    setFeedback(null);
    try {
      const result = await readJson<{ outputVersionId: string | null; taskId: string | null }>(await fetch(
        `/api/batch-production/batches/${encodeURIComponent(selectedBatchId)}/outputs/${encodeURIComponent(planId)}/reallocate?projectId=${encodeURIComponent(projectId)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ reason: '用户从成片卡片请求重新分配' }),
        },
      ));
      setFeedback({
        kind: 'success',
        message: result.outputVersionId ? '已为这一条建立新候选，其他成片保持不变。' : '本次没有得到不同的合法安排，已保留当前版本。',
      });
      await loadWorkspace(selectedBatchId);
    } catch (reallocateError) {
      setFeedback({ kind: 'error', message: reallocateError instanceof Error ? reallocateError.message : '重新分配失败' });
    } finally {
      setPhaseEBusy(null);
    }
  }

  async function toggleAssetExclusion(assetId: string, excluded: boolean): Promise<void> {
    if (!selectedBatchId) return;
    setPhaseEBusy(`exclude:${assetId}`);
    setFeedback(null);
    try {
      await readJson(await fetch(
        `/api/batch-production/batches/${encodeURIComponent(selectedBatchId)}/assets/${encodeURIComponent(assetId)}/exclusion?projectId=${encodeURIComponent(projectId)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ excluded, reason: '用户从冻结素材池手工排除' }),
        },
      ));
      setFeedback({
        kind: 'success',
        message: excluded ? '已从后续联合分配排除该素材；旧正式成片保持不变。' : '该素材已恢复参与后续联合分配。',
      });
      await loadWorkspace(selectedBatchId);
    } catch (exclusionError) {
      setFeedback({ kind: 'error', message: exclusionError instanceof Error ? exclusionError.message : '素材排除修改失败' });
    } finally {
      setPhaseEBusy(null);
    }
  }

  async function publishSelected(): Promise<void> {
    if (!selectedBatchId || selectedPlanIds.length === 0) {
      setFeedback({ kind: 'error', message: '请先勾选要正式导出的成片。' });
      return;
    }
    setPhaseEBusy('export');
    setFeedback(null);
    try {
      const result = await readJson<{
        published: number;
        skipped: number;
        items: Array<{ status: 'published' | 'skipped'; reason?: string }>;
      }>(await fetch(
        `/api/batch-production/batches/${encodeURIComponent(selectedBatchId)}/exports?projectId=${encodeURIComponent(projectId)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ planIds: selectedPlanIds }),
        },
      ));
      const skipped = result.items.filter(({ status }) => status === 'skipped');
      const grouped = new Map<string, number>();
      for (const item of skipped) {
        const text = humanizeSkipReason(item.reason);
        grouped.set(text, (grouped.get(text) ?? 0) + 1);
      }
      const detail = [...grouped].map(([text, count]) => `${count} 条${text}`).join('；');
      setFeedback({
        kind: result.published > 0 ? 'success' : 'error',
        message: `已导出 ${result.published} 条${result.skipped > 0 ? `，跳过 ${result.skipped} 条：${detail}` : ''}`,
      });
      setSelectedPlanIds([]);
      await loadWorkspace(selectedBatchId);
    } catch (publishError) {
      setFeedback({ kind: 'error', message: publishError instanceof Error ? publishError.message : '正式导出失败' });
    } finally {
      setPhaseEBusy(null);
    }
  }

  async function controlBatch(action: 'pause' | 'resume' | 'stop'): Promise<void> {
    if (!selectedBatchId) return;
    setPhaseEBusy('control');
    setFeedback(null);
    try {
      await readJson(await fetch(
        `/api/batch-production/batches/${encodeURIComponent(selectedBatchId)}/control?projectId=${encodeURIComponent(projectId)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action }),
        },
      ));
      await loadWorkspace(selectedBatchId);
    } catch (controlError) {
      setFeedback({ kind: 'error', message: controlError instanceof Error ? controlError.message : '批次控制失败' });
    } finally {
      setPhaseEBusy(null);
    }
  }

  if (loading) {
    return <div className="card p-8 text-center text-sm text-ink-secondary">正在同步项目脚本和素材…</div>;
  }

  if (error) {
    return (
      <section className="card p-6">
        <h2 className="font-semibold text-ink">批量准备区暂不可用</h2>
        <p className="mt-2 text-sm text-fail">{error}</p>
        <button type="button" className="btn-secondary mt-4" onClick={() => void load()}>重新检查</button>
      </section>
    );
  }

  if (!preparation) return null;
  const prep = preparation;
  const assetCards = prep.assets as PrepareAssetCardView[];

  const onlineAssets = prep.assets.filter(({ status }) => status === 'online').length;
  const selectableAssetCards = assetCards.filter(({ status, currentAnalysisId }) => status === 'online' && Boolean(currentAnalysisId));
  const selectableAssets = selectableAssetCards.length;
  const allSelectableAssetsSelected = selectableAssetCards.length > 0
    && selectableAssetCards.every(({ id }) => selectedAssets[id] !== undefined);

  function toggleSelectAllAssets(): void {
    if (selectableAssetCards.length === 0) return;
    markInputChanged();
    const selectableIds = new Set(selectableAssetCards.map(({ id }) => id));
    setSelectedAssets((current) => {
      if (selectableAssetCards.every(({ id }) => current[id] !== undefined)) {
        // Only remove the currently selectable assets. Preserve any selection
        // that may be carried by a recovery state which is no longer online.
        return Object.fromEntries(Object.entries(current).filter(([assetId]) => !selectableIds.has(assetId)));
      }
      return selectableAssetCards.reduce<Record<string, AssetSelectionState>>((next, asset) => {
        const existing = current[asset.id];
        next[asset.id] = {
          analysisId: asset.currentAnalysisId as string,
          lutId: existing?.lutId ?? null,
        };
        return next;
      }, { ...current });
    });
  }

  function renderPreviewBadge(assetId: string) {
    const info = previewInfos[assetId];
    if (!info) return null;
    if (info.kind === 'unavailable') {
      return <p className="text-xs text-fail">{info.warning ?? '预览不可用'}</p>;
    }
    const badges: Array<{ text: string; tone: string }> = [];
    if (info.kind === 'proxy') {
      badges.push({ text: '代理预览', tone: 'bg-ok/10 text-ok' });
      if (!info.originalOnline) {
        badges.push({ text: '原片离线', tone: 'bg-fail/10 text-fail' });
      }
    } else if (info.kind === 'original_pending_lut') {
      badges.push({ text: '原片预览', tone: 'bg-warn/20 text-warn' });
      badges.push({ text: 'LUT 代理未就绪', tone: 'bg-warn/20 text-warn' });
    } else {
      badges.push({ text: '原片预览', tone: 'bg-surface-subtle text-ink-secondary' });
    }
    return (
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          {badges.map((badge) => (
            <span key={badge.text} className={`rounded-full px-2 py-0.5 text-[11px] ${badge.tone}`}>{badge.text}</span>
          ))}
          {info.kind === 'proxy' && !info.originalOnline && (
            <span className="text-[11px] text-fail">正式导出不可用</span>
          )}
        </div>
        {info.kind === 'proxy' && !info.originalOnline && (
          <p className="text-xs text-fail">原片离线，当前播放已生成的代理；正式导出仍要求原片在线且内容指纹一致。</p>
        )}
      </div>
    );
  }

  function renderMediaPrepSection() {
    const proxyButtonsDisabled = !hasConfirmedVersion || proxyBatchBusy;
    const proxyButtonsBlockedByUnconfirmed = !inputConfirmed && hasConfirmedVersion;
    return (
      <section className="card space-y-4 p-5" aria-label="媒体准备：代理与 LUT">
        <div>
          <h3 className="mt-1 font-semibold text-ink">画质与调色</h3>
          <p className="mt-1 text-sm text-ink-secondary">默认直接预览原片；卡顿时再按需生成代理。LUT 默认关闭，选择后对应素材会额外请求一份色彩代理。最终导出始终读取原片。</p>
        </div>

        <div className="tile space-y-3 p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm font-medium text-ink">LUT 列表</p>
            <div className="flex items-center gap-2">
              <input
                ref={lutFileInputRef}
                type="file"
                accept=".cube"
                aria-label="导入 LUT 文件"
                className="hidden"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) void importLutFile(file);
                }}
              />
              <button
                type="button"
                className="btn-secondary text-xs"
                disabled={lutImporting}
                onClick={() => lutFileInputRef.current?.click()}
              >{lutImporting ? '导入中…' : '导入 .cube LUT'}</button>
            </div>
          </div>
          {luts.length === 0
            ? <p className="text-xs text-ink-tertiary">尚未导入任何 LUT。</p>
            : <ul className="space-y-2">
              {luts.map((lut) => (
                <li key={lut.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-surface-subtle px-3 py-2 text-xs">
                  <span className="min-w-0 truncate text-ink-secondary">
                    {lut.displayName}{lut.status === 'archived' && <span className="ml-2 text-ink-tertiary">已归档</span>}
                  </span>
                  <span className="flex gap-2">
                    {lut.status === 'active'
                      ? <button type="button" className="text-ink-tertiary underline" onClick={() => void lutAction(lut.id, 'archive')}>归档</button>
                      : <>
                        <button type="button" className="text-ink-tertiary underline" onClick={() => void lutAction(lut.id, 'restore')}>恢复</button>
                        <button type="button" className="text-fail underline" onClick={() => void lutAction(lut.id, 'delete')}>清理</button>
                      </>}
                  </span>
                </li>
              ))}
            </ul>}
        </div>

        <div className="tile space-y-3 p-4">
          <p className="text-sm font-medium text-ink">代理生成</p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className="btn-secondary text-xs"
              disabled={proxyButtonsDisabled || proxyButtonsBlockedByUnconfirmed || Object.keys(selectedAssets).length === 0}
              onClick={() => void requestProxies(Object.keys(selectedAssets), null)}
            >{proxyBatchBusy ? '请求中…' : '为选中素材生成代理'}</button>
            <button
              type="button"
              className="btn-secondary text-xs"
              disabled={proxyButtonsDisabled || proxyButtonsBlockedByUnconfirmed}
              onClick={() => void requestProxies(undefined, null)}
            >为当前批次全部素材生成代理</button>
          </div>
          {proxyButtonsBlockedByUnconfirmed && (
            <p className="text-xs text-warn">脚本、素材、分析版本或 LUT 已修改，重新确认整体输入后代理请求才会匹配新快照。</p>
          )}
          {!hasConfirmedVersion && <p className="text-xs text-ink-tertiary">先确认整体输入，代理才能对应到已锁定的色彩快照。</p>}
          {proxyTasks.length > 0 && (
            <ul className="space-y-1.5">
              {proxyTasks.map((task) => {
                const progress = task.progressJson as { phase?: string; percent?: number | null; description?: string } | null;
                const percent = typeof progress?.percent === 'number' ? `${Math.round(progress.percent * 100)}%` : '';
                const phaseLabel = progress?.phase ? TASK_PHASE_LABELS[progress.phase] : undefined;
                const statusLabel = TASK_STATUS_LABELS[task.status] ?? task.status;
                return (
                  <li key={task.id} className="flex items-center justify-between gap-3 rounded-xl bg-surface-subtle px-3 py-2 text-xs">
                    <span className="min-w-0 truncate text-ink-secondary">
                      {phaseLabel || progress?.description || statusLabel} {percent}
                      {task.attemptCount > 1 && ` · 第 ${task.attemptCount} 次尝试`}
                    </span>
                    <span className="flex items-center gap-2">
                      <span className={`rounded-full px-2 py-0.5 ${task.status === 'failed' ? 'bg-fail/10 text-fail' : task.status === 'succeeded' ? 'bg-ok/10 text-ok' : task.status === 'cancelled' ? 'bg-surface-subtle text-ink-tertiary' : 'bg-accent/10 text-accent'}`}>
                        {statusLabel}
                      </span>
                      {task.status === 'failed' && (
                        <button type="button" className="text-accent underline" onClick={() => void retryProxyTask(task.id)}>重试</button>
                      )}
                      {(task.status === 'queued' || task.status === 'running') && task.expectedState === 'running' && (
                        <button type="button" className="text-ink-tertiary underline" onClick={() => void controlProxyTask(task.id, 'pause')}>暂停</button>
                      )}
                      {task.status === 'queued' && task.expectedState === 'paused' && (
                        <button type="button" className="text-accent underline" onClick={() => void controlProxyTask(task.id, 'resume')}>继续</button>
                      )}
                      {(task.status === 'queued' || task.status === 'running') && (
                        <button type="button" className="text-fail underline" onClick={() => void controlProxyTask(task.id, 'cancel')}>取消</button>
                      )}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div className="tile flex h-[620px] min-h-0 flex-col gap-3 p-4" data-testid="media-prep-asset-pool">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <p className="text-sm font-medium text-ink">批次素材池</p>
              <p className="mt-1 text-xs text-ink-tertiary">固定区域内浏览；点击缩略图播放代理或原片。</p>
            </div>
            <span className="text-xs text-ink-tertiary">{Object.keys(selectedAssets).length} 条</span>
          </div>
          {Object.keys(selectedAssets).length === 0
            ? <p className="text-xs text-ink-tertiary">选择素材后这里会显示可播放的预览(代理或原片)。</p>
            : <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain pr-1 [scrollbar-gutter:stable]">
              <ul className="grid content-start gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {Object.entries(selectedAssets).map(([assetId, selection]) => {
                const asset = prep.assets.find((item) => item.id === assetId);
                const displayName = asset?.media.displayName
                  ?? asset?.media.filename
                  ?? `素材 ${assetId.slice(0, 8)}`;
                const lutName = selection.lutId ? luts.find((lut) => lut.id === selection.lutId)?.displayName : null;
                return (
                  <li key={assetId} data-testid={`media-prep-asset-tile-${assetId}`} className="overflow-hidden rounded-xl border border-hairline bg-white">
                    <button
                      type="button"
                      className="group relative block aspect-video w-full overflow-hidden bg-black text-left"
                      aria-label={`播放批次素材 ${displayName}`}
                      onClick={() => openPreparedAssetPreview(assetId)}
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={asset?.thumbnailUrl} alt={`${displayName} 缩略图`} loading="lazy" className="h-full w-full object-cover transition group-hover:scale-[1.02]" />
                      <span className="absolute inset-0 flex items-center justify-center bg-black/0 transition group-hover:bg-black/15">
                        <span className="rounded-full bg-black/65 px-3 py-1.5 text-xs font-medium text-white">播放</span>
                      </span>
                    </button>
                    <div className="space-y-2 p-3">
                      <div className="flex items-start justify-between gap-2">
                        <p className="min-w-0 truncate text-xs font-medium text-ink">{displayName}</p>
                        <p className="shrink-0 text-[11px] text-ink-tertiary">{lutName ? `LUT：${lutName}` : 'LUT：关闭'}</p>
                      </div>
                      {renderPreviewBadge(assetId)}
                    </div>
                  </li>
                );
                })}
              </ul>
            </div>}
        </div>

        <div className="tile space-y-3 p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm font-medium text-ink">代理缓存清理</p>
            {cacheUsage && <span className="text-xs text-ink-tertiary">当前项目占用 {(cacheUsage.totalBytes / (1024 * 1024)).toFixed(1)}MB · {cacheUsage.count} 个文件</span>}
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className="btn-secondary text-xs"
              disabled={cleanupBusy !== null || Object.keys(selectedAssets).length === 0}
              onClick={() => void cleanupProxies('selected')}
            >{cleanupBusy === 'selected' ? '清理中…' : '清理选中素材代理'}</button>
            <button
              type="button"
              className="btn-secondary text-xs"
              disabled={cleanupBusy !== null}
              onClick={() => void cleanupProxies('project')}
            >{cleanupBusy === 'project' ? '清理中…' : '清理当前项目代理'}</button>
          </div>
          <p className="text-xs text-ink-tertiary">清理不影响原片、分析结果、批次快照和正式成片；清理后预览自动回退原片，可随时重新生成。正在使用中的文件会自动延后删除，不需要再次点击清理。</p>
        </div>
      </section>
    );
  }

  return (
    <section className="space-y-5" aria-label="批量生产准备区">
      <header className="card flex flex-wrap items-center justify-between gap-4 p-5">
        <div>
          <h2 className="text-lg font-semibold text-ink">批量生产准备区</h2>
          <p className="mt-1 text-sm text-ink-secondary">项目脚本和成功视频会继续自动同步；选定输入后可锁定为一个批次。</p>
        </div>
        <button type="button" className="btn-secondary" onClick={() => void load()}>重新同步</button>
      </header>

      <div className="grid gap-3 sm:grid-cols-4">
        <div className="tile p-4"><p className="text-xs text-ink-tertiary">项目脚本</p><strong className="mt-1 block text-2xl text-ink">{prep.scripts.length}</strong></div>
        <div className="tile p-4"><p className="text-xs text-ink-tertiary">项目素材</p><strong className="mt-1 block text-2xl text-ink">{prep.assets.length}</strong></div>
        <div className="tile p-4"><p className="text-xs text-ink-tertiary">当前在线</p><strong className="mt-1 block text-2xl text-ok">{onlineAssets}</strong></div>
        <div className="tile p-4"><p className="text-xs text-ink-tertiary">可入池素材</p><strong className="mt-1 block text-2xl text-ok">{selectableAssets}</strong></div>
      </div>

      {prep.warnings.length > 0 && (
        <div className="rounded-2xl border border-warn/30 bg-warn-tint p-4 text-sm text-ink-secondary">
          <p className="font-medium text-ink">需要留意</p>
          <ul className="mt-2 list-disc space-y-1 pl-5">{prep.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>
        </div>
      )}

      <section className="card space-y-4 p-5" aria-label="批次管理">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="font-semibold text-ink">创建或选择批次</h3>
            <p className="mt-1 text-sm text-ink-secondary">批次保留已确认的脚本、素材分析版本和成片数量。</p>
          </div>
          <span className="rounded-full bg-surface-subtle px-3 py-1 text-xs text-ink-secondary">
            {selectedBatchId ? BATCH_STATUS_LABELS[batchStatus] : '未选择批次'}
          </span>
        </div>
        <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
          <label className="text-sm text-ink-secondary">
            <span className="mb-1.5 block">当前批次</span>
            <select
              aria-label="当前批次"
              value={selectedBatchId}
              onChange={(event) => {
                setSelectedBatchId(event.target.value);
                setProxyTasks([]);
                setAssetPrepareTasks([]);
                analysisReloadedTaskIdsRef.current.clear();
                setSelectedScripts({});
                setSelectedAssets({});
                setOutputPlans([]);
                setBatchInputState(null);
                setFrozenScriptSnapshots([]);
                setBatchStatus(batches.find(({ id }) => id === event.target.value)?.status ?? 'draft');
                setInputConfirmed(false);
                setFeedback(null);
              }}
              className="h-10 w-full rounded-xl border border-hairline bg-white px-3 text-ink"
            >
              <option value="">尚未选择</option>
              {batches.map((batch) => <option key={batch.id} value={batch.id}>{batch.name} · {BATCH_STATUS_LABELS[batch.status]}</option>)}
            </select>
          </label>
          <label className="text-sm text-ink-secondary">
            <span className="mb-1.5 block">新批次名称</span>
            <input
              type="text"
              aria-label="新批次名称"
              value={newBatchName}
              onChange={(event) => setNewBatchName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && busy === null) void createBatch();
              }}
              placeholder="例如：8 月产品口播"
              className="h-10 w-full rounded-xl border border-hairline bg-white px-3 text-ink"
            />
          </label>
          <button
            type="button"
            className="btn-secondary self-end"
            disabled={busy !== null}
            onClick={() => void createBatch()}
          >{busy === 'create' ? '创建中…' : '创建批次'}</button>
        </div>
      </section>

      {batchInputState === 'frozen' ? (
        <section className="space-y-4" aria-label="冻结批次输入">
          <div className="card flex flex-wrap items-center justify-between gap-4 p-5">
            <div>
              <h3 className="font-semibold text-ink">已冻结的批次输入</h3>
              <p className="mt-1 text-sm text-ink-secondary">以下正文、标题、份数和素材分析版本来自开跑快照，不随项目当前内容变化。冻结版本仍可查看和管理该版本的代理与 LUT 预览。</p>
              <p className="mt-1 text-xs text-ink-tertiary">如需补充画面语义、镜头标签和可用区间，请创建新版本后在“项目素材池”运行内容分析；旧版本的分析身份不会被覆盖。</p>
            </div>
            <div className="flex flex-wrap gap-2">
              {workspace && workspace.cards.some(({ versionId }) => !versionId) && (
                <button type="button" className="btn-primary" disabled={busy !== null} onClick={() => void startBatch()}>
                  {busy === 'start' ? '继续中…' : '继续联合分配'}
                </button>
              )}
              <button
                type="button"
                className="btn-secondary"
                onClick={() => {
                  setBatchInputState('draft');
                  setFrozenScriptSnapshots([]);
                  setSelectedScripts({});
                  setSelectedAssets({});
                  setOutputPlans([]);
                  setWorkspace(null);
                  setSelectedPlanIds([]);
                  setInputConfirmed(false);
                  setFeedback({ kind: 'success', message: '请选择当前项目输入并确认，新输入会形成批次新版本。' });
                }}
              >基于当前项目输入创建新版本</button>
            </div>
          </div>
          <div className="grid gap-3 lg:grid-cols-2">
            {frozenScriptSnapshots.map((snapshot) => <BatchFrozenScriptCard key={snapshot.id} snapshot={snapshot} />)}
          </div>
          <div className="tile p-4 text-sm text-ink-secondary">
            <p className="font-medium text-ink">冻结素材池 · {Object.keys(selectedAssets).length} 条</p>
            <ul className="mt-2 space-y-1 text-xs text-ink-tertiary">
              {Object.entries(selectedAssets).map(([assetId, selection]) => {
                const exclusion = workspace?.exclusions.find((item) => item.assetId === assetId);
                return (
                  <li key={assetId} className="flex flex-wrap items-center justify-between gap-2">
                    <span>
                      素材 {assetId.slice(0, 8)} · 分析版本 {selection.analysisId.slice(0, 8)}
                      {selection.lutId && <> · LUT {luts.find((lut) => lut.id === selection.lutId)?.displayName ?? selection.lutId.slice(0, 8)}</>}
                      {exclusion && <> · 已排除：{exclusion.reason || '未填写原因'}</>}
                    </span>
                    {workspace && workspace.batch.controlState !== 'stopped' && (
                      <button
                        type="button"
                        className="text-xs text-accent underline"
                        disabled={phaseEBusy !== null}
                        onClick={() => void toggleAssetExclusion(assetId, !exclusion)}
                      >
                        {phaseEBusy === `exclude:${assetId}` ? '处理中…' : exclusion ? '恢复参与分配' : '从后续分配排除'}
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
          {renderMediaPrepSection()}
        </section>
      ) : (
        <>
          <section>
            <div className="mb-3 flex items-end justify-between gap-3">
              <div><h3 className="font-semibold text-ink">项目脚本</h3><p className="mt-1 text-sm text-ink-secondary">选择本批次使用的脚本，并为每份设置生成份数。</p></div>
              <span className="text-sm text-ink-secondary">已选 {selectedScriptEntries.length} 份 · 计划 {plannedCount} 条</span>
            </div>
            {prep.scripts.length > 0
              ? <div className="grid gap-3 lg:grid-cols-2">{prep.scripts.map((script) => (
                <BatchScriptSelectionCard
                  key={script.id}
                  script={script}
                  selected={selectedScripts[script.id] !== undefined}
                  copyCount={selectedScripts[script.id] ?? 1}
                  onSelectedChange={(selected) => {
                    markInputChanged();
                    setSelectedScripts((current) => {
                      if (selected) return { ...current, [script.id]: current[script.id] ?? 1 };
                      return Object.fromEntries(Object.entries(current).filter(([id]) => id !== script.id));
                    });
                  }}
                  onCopyCountChange={(copyCount) => {
                    markInputChanged();
                    setSelectedScripts((current) => ({ ...current, [script.id]: copyCount }));
                  }}
                />
              ))}</div>
              : <div className="tile p-6 text-sm text-ink-secondary">暂无可用项目脚本，请先在第 3 步保存脚本。</div>}
          </section>

          <section className="card flex h-[820px] min-h-0 flex-col space-y-4 p-5" aria-label="项目素材池">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h3 className="font-semibold text-ink">项目素材池</h3>
                <p className="mt-1 text-sm text-ink-secondary">只有当前在线且已有可用分析版本的素材才能进入批次素材池。</p>
                {!selectedBatchId && <p className="mt-1 text-xs text-warn">请先创建或选择批次，才能开始素材基础分析。</p>}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm text-ink-secondary">已选 {Object.keys(selectedAssets).length} / 可选 {selectableAssets} 条</span>
                <select
                  aria-label="内容分析供应商"
                  value={visionProviderId}
                  onChange={(event) => setVisionProviderId(event.target.value)}
                  className="h-10 max-w-52 rounded-xl border border-hairline bg-white px-3 text-sm text-ink"
                >
                  <option value="">未配置视觉供应商</option>
                  {visionProviders.filter((provider) => provider.configured && provider.supportsVision).map((provider) => (
                    <option key={provider.id} value={provider.id}>{provider.name}</option>
                  ))}
                </select>
                <button
                  type="button"
                  className="btn-secondary"
                  disabled={!selectedBatchId || analysisCandidates.length === 0 || analysisBusy !== null}
                  onClick={() => void analyzeAssets(analysisCandidates.map((asset) => asset.id))}
                >{analysisBusy === '__all__' ? '分析中…' : `基础分析（${analysisCandidates.length}）`}</button>
                <button
                  type="button"
                  className="btn-primary"
                  disabled={!selectedBatchId || !visionProviderId || contentAnalysisCandidates.length === 0 || analysisBusy !== null}
                  onClick={() => void analyzeAssets(contentAnalysisCandidates.map((asset) => asset.id), 'content')}
                >{analysisBusy === '__all__' ? '分析中…' : `内容分析待补齐（${contentAnalysisCandidates.length}）`}</button>
                <button
                  type="button"
                  className="btn-secondary"
                  aria-label={allSelectableAssetsSelected ? '取消全选' : '一键全选'}
                  disabled={selectableAssetCards.length === 0}
                  onClick={toggleSelectAllAssets}
                >{allSelectableAssetsSelected ? '取消全选' : '一键全选'}</button>
              </div>
            </div>
            <div
              data-testid="batch-asset-pool-scroll"
              aria-label="项目素材列表"
              className="min-h-0 flex-1 overflow-x-hidden overflow-y-scroll overscroll-contain rounded-2xl bg-surface-subtle p-3 [scrollbar-gutter:stable]"
            >
              {assetCards.length > 0
                ? <div className="grid gap-3 lg:grid-cols-2">{assetCards.map((asset) => {
                const analysisTask = analysisTaskByAsset.get(asset.id);
                const assetAnalysisBusy = analysisBusy === asset.id
                  || analysisBusy === analysisTask?.id
                  || analysisBusy === '__all__';
                return (
                <BatchAssetSelectionCard
                  key={asset.id}
                  asset={asset}
                  selected={selectedAssets[asset.id] !== undefined}
                  onSelectedChange={(selected) => {
                    markInputChanged();
                    setSelectedAssets((current) => {
                      if (selected && asset.currentAnalysisId) {
                        return { ...current, [asset.id]: { analysisId: asset.currentAnalysisId, lutId: null } };
                      }
                      return Object.fromEntries(Object.entries(current).filter(([id]) => id !== asset.id));
                    });
                  }}
                  luts={luts}
                  lutId={selectedAssets[asset.id]?.lutId ?? null}
                  onLutChange={(lutId) => {
                    markInputChanged();
                    setSelectedAssets((current) => (
                      current[asset.id] ? { ...current, [asset.id]: { ...current[asset.id], lutId } } : current
                    ));
                  }}
                  onRequestProxy={hasConfirmedVersion && inputConfirmed ? () => void requestProxies([asset.id], asset.id) : undefined}
                  proxyBusy={proxyBusyAssetId === asset.id}
                  analysisTask={analysisTask}
                  onAnalyze={() => void analyzeAssets([asset.id])}
                  onAnalyzeContent={asset.analysisLevel !== 'content' && visionProviderId
                    ? () => void analyzeAssets([asset.id], 'content')
                    : undefined}
                  onRetryAnalyze={analysisTask?.status === 'failed' ? () => void retryAssetAnalysis(analysisTask.id) : undefined}
                  onResync={() => void load()}
                  analyzeBusy={assetAnalysisBusy}
                  onPreview={() => openAssetPreview(asset)}
                />
                );
                })}</div>
                : <div className="tile p-6 text-sm text-ink-secondary">暂无可用视频素材，请先在第 4 步完成视频生成。</div>}
            </div>
          </section>

          {renderMediaPrepSection()}

          <section className="card space-y-4 p-5" aria-label="批次确认与开始">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div>
                <h3 className="font-semibold text-ink">确认整体输入</h3>
                <p className="mt-1 text-sm text-ink-secondary">将 {selectedScriptEntries.length} 份脚本、{Object.keys(selectedAssets).length} 条素材与 {plannedCount} 条成片计划作为可检查的 draft 快照；点击开始时再同步最新脚本并冻结。</p>
                {!inputConfirmed && hasConfirmedVersion && (
                  <p className="mt-1 text-xs text-warn">输入已修改，重新确认后才会覆盖当前批次版本。</p>
                )}
              </div>
              <div className="grid w-full gap-3 sm:grid-cols-2">
                <label className="text-sm text-ink-secondary">
                  <span className="mb-1.5 block">输出比例</span>
                  <select
                    aria-label="批量输出比例"
                    value={outputPreset}
                    onChange={(event) => { setOutputPreset(event.target.value as OutputPreset); markInputChanged(); }}
                    className="h-10 w-full rounded-xl border border-hairline bg-white px-3 text-ink"
                  >
                    <option value="3:4">3:4 · 1080×1440</option>
                    <option value="9:16">9:16 · 1080×1920</option>
                    <option value="16:9">16:9 · 1920×1080</option>
                  </select>
                </label>
                <label className="text-sm text-ink-secondary">
                  <span className="mb-1.5 block">视觉候选目标时长（秒）</span>
                  <input
                    type="number"
                    min={3}
                    max={300}
                    step={1}
                    aria-label="批量目标时长"
                    value={targetDurationSec}
                    onChange={(event) => {
                      setTargetDurationSec(Math.max(3, Math.min(300, Number(event.target.value) || 15)));
                      markInputChanged();
                    }}
                    className="h-10 w-full rounded-xl border border-hairline bg-white px-3 text-ink"
                  />
                </label>
              </div>
              <div className="flex flex-wrap gap-2">
                <button type="button" className="btn-secondary" disabled={busy !== null} onClick={() => void confirmSnapshot()}>
                  {busy === 'snapshot' ? '确认中…' : '确认整体输入'}
                </button>
                <button
                  type="button"
                  className="btn-primary"
                  disabled={busy !== null || outputPlans.length === 0 || batchStatus !== 'draft'}
                  onClick={() => void startBatch()}
                >{busy === 'start' ? '启动中…' : '开始批量生产'}</button>
              </div>
            </div>
          </section>
        </>
      )}

      {feedback && (
        <div
          role={feedback.kind === 'error' ? 'alert' : 'status'}
          aria-live="polite"
          className={`rounded-xl px-4 py-3 text-sm ${feedback.kind === 'error' ? 'bg-fail/10 text-fail' : 'bg-ok/10 text-ok'}`}
        >{feedback.message}</div>
      )}

      {previewAsset && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="batch-asset-preview-title"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
        >
          <div className="w-full max-w-3xl rounded-2xl bg-white p-4 shadow-xl">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.12em] text-accent">项目素材预览</p>
                <h3 id="batch-asset-preview-title" className="mt-1 font-semibold text-ink">
                  {previewAsset.title}
                </h3>
              </div>
              <button
                ref={previewCloseButtonRef}
                type="button"
                className="btn-secondary text-xs"
                aria-label="关闭素材预览"
                onClick={() => setPreviewAsset(null)}
              >关闭</button>
            </div>
            <video
              className="mt-4 aspect-video w-full rounded-xl bg-black"
              controls
              autoFocus
              preload="metadata"
              data-testid={`asset-preview-modal-${previewAsset.id}`}
            >
              <source src={previewAsset.url} />
            </video>
          </div>
        </div>
      )}

      {workspace && workspace.cards.length > 0 ? (
        <section className="space-y-4" aria-label="成片工作区">
          <div className="card space-y-4 p-5">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <h3 className="mt-1 font-semibold text-ink">批次成片工作区</h3>
                <p className="mt-1 text-sm text-ink-secondary">状态来自持久任务、候选版本和正式产物聚合；新版失败不会隐藏旧成片。</p>
              </div>
              <div className="flex flex-wrap gap-2">
                {workspace.batch.controlState === 'running' && (
                  <button type="button" className="btn-secondary text-xs" disabled={phaseEBusy !== null} onClick={() => void controlBatch('pause')}>暂停批次</button>
                )}
                {workspace.batch.controlState === 'paused' && (
                  <button type="button" className="btn-secondary text-xs" disabled={phaseEBusy !== null} onClick={() => void controlBatch('resume')}>继续批次</button>
                )}
                {workspace.batch.controlState !== 'stopped' && (
                  <button type="button" className="btn-secondary text-xs text-fail" disabled={phaseEBusy !== null} onClick={() => void controlBatch('stop')}>停止批次</button>
                )}
                <button type="button" className="btn-primary text-xs" disabled={phaseEBusy !== null || selectedPlanIds.length === 0} onClick={() => void publishSelected()}>
                  {phaseEBusy === 'export' ? '发布中…' : `正式导出选中项（${selectedPlanIds.length}）`}
                </button>
              </div>
              {workspace.counts.publishable === 0 && workspace.counts.total > 0 && (
                <p className="w-full text-xs text-warn">
                  当前没有可导出的成片 —— 批量生产尚未接入配音，成片只有画面和字幕。配音打通后即可导出。
                </p>
              )}
            </div>
            <div className="grid gap-3 sm:grid-cols-5">
              <div className="tile p-3"><p className="text-xs text-ink-tertiary">全部</p><strong className="text-xl text-ink">{workspace.counts.total}</strong></div>
              <div className="tile p-3"><p className="text-xs text-ink-tertiary">可正式发布</p><strong className="text-xl text-ok">{workspace.counts.publishable}</strong></div>
              <div className="tile p-3"><p className="text-xs text-ink-tertiary">处理中</p><strong className="text-xl text-accent">{workspace.counts.processing}</strong></div>
              <div className="tile p-3"><p className="text-xs text-ink-tertiary">需处理</p><strong className="text-xl text-warn">{workspace.counts.needsAttention}</strong></div>
              <div className="tile p-3"><p className="text-xs text-ink-tertiary">可重试失败</p><strong className="text-xl text-fail">{workspace.counts.failed}</strong></div>
            </div>
            <div className="flex flex-wrap gap-2" aria-label="成片状态筛选">
              {([
                ['all', '全部'],
                ['completed', '已完成'],
                ['needs_attention', '需处理'],
                ['processing', '渲染中'],
                ['waiting', '等待中'],
                ['paused', '已暂停'],
                ['retryable_failed', '可重试'],
                ['stopped', '已停止'],
              ] as Array<[CardFilter, string]>).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  className={`rounded-full px-3 py-1 text-xs ${cardFilter === value ? 'bg-accent text-white' : 'bg-surface-subtle text-ink-secondary'}`}
                  onClick={() => setCardFilter(value)}
                >{label}</button>
              ))}
            </div>
            <p className="text-xs text-ink-tertiary">没有真实口播时会先生成静音视觉候选供检查，但不会被冒充为可正式发布成片。</p>
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            {visibleCards.map((card) => {
              const mediaSource = card.candidate ? 'candidate' : card.currentVideo ? 'artifact' : null;
              const mediaUrl = mediaSource && selectedBatchId
                ? `/api/batch-production/batches/${encodeURIComponent(selectedBatchId)}/outputs/${encodeURIComponent(card.planId)}/media?projectId=${encodeURIComponent(projectId)}&kind=video&source=${mediaSource}`
                : null;
              const coverSource = card.candidate?.coverAvailable ? 'candidate' : card.currentCover ? 'artifact' : null;
              const coverUrl = coverSource && selectedBatchId
                ? `/api/batch-production/batches/${encodeURIComponent(selectedBatchId)}/outputs/${encodeURIComponent(card.planId)}/media?projectId=${encodeURIComponent(projectId)}&kind=cover&source=${coverSource}`
                : null;
              const progress = card.task?.progress as { phase?: string; percent?: number | null; description?: string } | null;
              return (
                <article key={card.planId} data-testid="batch-output-card" className="tile space-y-3 p-4">
                  <div className="flex items-start justify-between gap-3">
                    <label className="flex min-w-0 items-start gap-3">
                      <input
                        type="checkbox"
                        aria-label={`选择成片 ${card.seq}`}
                        checked={selectedPlanIds.includes(card.planId)}
                        disabled={!card.publishable}
                        title={card.publishable ? undefined : '这条成片还没有配音，暂时无法导出'}
                        onChange={(event) => setSelectedPlanIds((current) => (
                          event.target.checked ? [...new Set([...current, card.planId])] : current.filter((id) => id !== card.planId)
                        ))}
                        className="mt-1 disabled:opacity-40"
                      />
                      <span className="min-w-0">
                        <span className="block text-xs text-ink-tertiary">成片 {String(card.seq).padStart(2, '0')} · v{card.versionNumber ?? '—'}</span>
                        <strong className="mt-1 block truncate text-ink">{card.scriptTitle || '未命名脚本'}</strong>
                      </span>
                    </label>
                    <span className={`rounded-full px-2 py-1 text-[11px] ${card.status === 'completed' ? 'bg-ok/10 text-ok' : card.status === 'retryable_failed' || card.status === 'stopped' ? 'bg-fail/10 text-fail' : card.status === 'needs_attention' ? 'bg-warn/20 text-warn' : 'bg-accent/10 text-accent'}`}>
                      {CARD_STATUS_LABELS[card.status]}
                    </span>
                  </div>
                  {(mediaUrl || coverUrl) && (
                    <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_10rem]">
                      {mediaUrl && (
                        <video key={`${card.versionId}-${mediaSource}`} controls preload="metadata" className="aspect-video w-full rounded-xl bg-black" data-testid={`batch-output-preview-${card.planId}`}>
                          <source src={mediaUrl} type="video/mp4" />
                        </video>
                      )}
                      {coverUrl && (
                        <figure className="overflow-hidden rounded-xl border border-hairline bg-surface-subtle" data-testid={`batch-output-cover-${card.planId}`}>
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img src={coverUrl} alt={`成片 ${card.seq} 封面`} className="aspect-[3/4] h-full w-full object-cover" />
                          <figcaption className="border-t border-hairline px-2 py-1.5 text-center text-[11px] text-ink-secondary">封面已生成</figcaption>
                        </figure>
                      )}
                    </div>
                  )}
                  {card.candidate && (
                    <div className="flex flex-wrap gap-2 text-[11px]">
                      <span className="rounded-full bg-ok/10 px-2 py-1 text-ok">封面已生成</span>
                      <span className={`rounded-full px-2 py-1 ${card.candidate.subtitleCueCount > 0 ? 'bg-ok/10 text-ok' : 'bg-warn/10 text-warn'}`}>
                        {card.candidate.subtitleCueCount > 0 ? `字幕 ${card.candidate.subtitleCueCount} 条` : '字幕待生成'}
                      </span>
                    </div>
                  )}
                  {card.candidate?.audioMode === 'silent_placeholder' && (
                    <p className="rounded-xl bg-warn/10 px-3 py-2 text-xs text-warn">无配音样片 —— 仅供检查画面，不能导出。</p>
                  )}
                  {progress && (
                    <div className="text-xs text-ink-secondary">
                      <p>{(progress.phase && TASK_PHASE_LABELS[progress.phase]) || progress.description || card.nextAction}{typeof progress.percent === 'number' ? ` · ${Math.round(progress.percent * 100)}%` : ''}</p>
                      {typeof progress.percent === 'number' && <progress className="mt-1 w-full" max={1} value={progress.percent} />}
                    </div>
                  )}
                  {(card.blockers.length > 0 || card.warnings.length > 0 || card.task?.errorMessage) && (
                    <ul className="space-y-1 text-xs text-warn">
                      {card.blockers.map((message) => <li key={`b-${message}`}>阻塞：{message}</li>)}
                      {card.warnings.map((message) => <li key={`w-${message}`}>提醒：{message}</li>)}
                      {card.task?.errorMessage && <li>任务失败：{card.task.errorMessage}</li>}
                    </ul>
                  )}
                  <div className="flex flex-wrap items-center justify-between gap-2 border-t border-hairline pt-3">
                    <span className="text-xs text-ink-tertiary">历史产物 {card.history.length} 项 · {card.nextAction}</span>
                    <span className="flex flex-wrap gap-2">
                      {card.task?.status === 'failed' && (
                        <button type="button" className="text-xs text-accent underline" disabled={phaseEBusy !== null} onClick={() => void retryRenderTask(card.task!.id)}>重试渲染</button>
                      )}
                      {workspace.batch.controlState !== 'stopped' && (
                        <button type="button" className="text-xs text-ink-secondary underline" disabled={phaseEBusy !== null} onClick={() => void reallocateOutput(card.planId)}>
                          {phaseEBusy === card.planId ? '重新分配中…' : '只重新分配这一条'}
                        </button>
                      )}
                    </span>
                  </div>
                </article>
              );
            })}
          </div>
          {visibleCards.length === 0 && <div className="tile p-6 text-sm text-ink-secondary">当前筛选下没有成片。</div>}
        </section>
      ) : outputPlans.length > 0 && (
        <section aria-label="成片计划">
          <div className="mb-3 flex items-end justify-between gap-3">
            <div><h3 className="font-semibold text-ink">成片计划</h3><p className="mt-1 text-sm text-ink-secondary">一张卡片对应一条目标成片，重试不会增加卡片数量。</p></div>
            <strong className="text-sm text-ink">共 {outputPlans.length} 张</strong>
          </div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {outputPlans.map((plan, index) => (
              <article key={plan.id} data-testid="batch-output-card" className="tile p-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-xs text-ink-tertiary">成片计划</p>
                    <h4 className="mt-1 font-semibold text-ink">成片 {String(plan.seq || index + 1).padStart(2, '0')}</h4>
                  </div>
                  <span className={`rounded-full px-2 py-1 text-[11px] ${batchStatus === 'running' ? 'bg-accent/10 text-accent' : 'bg-surface-subtle text-ink-secondary'}`}>
                    {batchStatus === 'running' ? '等待调度' : BATCH_STATUS_LABELS[batchStatus]}
                  </span>
                </div>
                <p className="mt-3 truncate text-xs text-ink-tertiary">计划 {plan.id.slice(0, 8)}</p>
              </article>
            ))}
          </div>
        </section>
      )}
    </section>
  );
}
