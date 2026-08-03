'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { BatchPreparationResult } from '@/lib/batch-production/prepare';
import type { BatchSnapshotDetail, BatchSnapshotResult } from '@/lib/batch-production/batch-flow';
import type { BatchProductionRow, BatchProductionStatus } from '@/lib/batch-production/versions';
import type { BatchLutRow } from '@/lib/batch-production/lut-catalog';
import type { BatchTasksView } from '@/lib/batch-production/tasks';
import {
  BatchAssetSelectionCard,
  BatchFrozenScriptCard,
  BatchScriptSelectionCard,
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

interface BatchPreparationPanelProps {
  projectId: string;
}

interface Feedback {
  kind: 'success' | 'error';
  message: string;
}

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
  verifying_lut: '核验 LUT',
  encoding: '编码中',
  verifying: '核验产物',
  ready: '已就绪',
};

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
  /** 当前 UI 选择是否与已确认的批次版本一致;修改脚本/素材/分析版本/LUT 后必须重新确认 */
  const [inputConfirmed, setInputConfirmed] = useState(false);

  const [luts, setLuts] = useState<BatchLutRow[]>([]);
  const [lutImporting, setLutImporting] = useState(false);
  const lutFileInputRef = useRef<HTMLInputElement | null>(null);
  const [proxyTasks, setProxyTasks] = useState<BatchTasksView['tasks']>([]);
  const [proxyBusyAssetId, setProxyBusyAssetId] = useState<string | null>(null);
  const [proxyBatchBusy, setProxyBatchBusy] = useState(false);
  const [cacheUsage, setCacheUsage] = useState<{ count: number; totalBytes: number } | null>(null);
  const [cleanupBusy, setCleanupBusy] = useState<'selected' | 'project' | null>(null);
  const [previewInfos, setPreviewInfos] = useState<Record<string, PreviewInfo>>({});

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const readiness = await readJson<ReadinessResponse>(await fetch('/api/batch-production/readiness', { cache: 'no-store' }));
      if (!readiness.available) throw new Error(readiness.message || '批量生产暂不可用');
      const [result, batchResult] = await Promise.all([
        readJson<BatchPreparationResult>(await fetch(
          `/api/batch-production/prepare?projectId=${encodeURIComponent(projectId)}`,
          { cache: 'no-store' },
        )),
        readJson<BatchListResponse>(await fetch(
          `/api/batch-production/batches?projectId=${encodeURIComponent(projectId)}`,
          { cache: 'no-store' },
        )),
      ]);
      setPreparation(result);
      setBatches(batchResult.batches);
      if (batchResult.batches.length === 0) {
        setOutputPlans([]);
        setBatchStatus('draft');
        setBatchInputState(null);
        setFrozenScriptSnapshots([]);
        setInputConfirmed(false);
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
      // 从已确认版本详情恢复的选择与快照一致,标记为已确认;
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
      // LUT 列表读取失败不阻塞批量准备区其他功能,保留上一次的列表。
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
      // 用量查询失败不阻塞清理操作本身,只是暂时不显示预计释放空间。
    }
  }, [projectId]);

  const loadProxyTasks = useCallback(async (batchId: string) => {
    if (!batchId) {
      setProxyTasks([]);
      return;
    }
    try {
      const view = await readJson<BatchTasksView>(await fetch(
        `/api/batch-production/batches/${encodeURIComponent(batchId)}/tasks?projectId=${encodeURIComponent(projectId)}`,
        { cache: 'no-store' },
      ));
      setProxyTasks(view.tasks.filter((task) => task.workType === 'proxy_generate'));
    } catch {
      // 任务状态轮询失败不阻塞其他操作,下一轮轮询会自动重试。
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
    const initial = window.setTimeout(() => void loadProxyTasks(selectedBatchId), 0);
    if (!selectedBatchId) return () => window.clearTimeout(initial);
    const interval = window.setInterval(() => void loadProxyTasks(selectedBatchId), 3_000);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(interval);
    };
  }, [selectedBatchId, loadProxyTasks]);

  useEffect(() => {
    if (!selectedBatchId) return;
    const timer = window.setTimeout(() => void loadBatchDetail(selectedBatchId), 0);
    return () => window.clearTimeout(timer);
  }, [loadBatchDetail, selectedBatchId]);

  const currentBatch = batches.find(({ id }) => id === selectedBatchId);
  const currentVersionId = currentBatch?.currentVersionId ?? null;

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
  const plannedCount = useMemo(
    () => selectedScriptEntries.reduce((sum, [, copyCount]) => sum + copyCount, 0),
    [selectedScriptEntries],
  );

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
            defaultsJson: { performanceMode: 'full_speed' },
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
      await readJson<{ batchId: string; status: 'running' }>(await fetch(
        `/api/batch-production/batches/${encodeURIComponent(selectedBatchId)}/start?projectId=${encodeURIComponent(projectId)}`,
        { method: 'PUT' },
      ));
      setBatchStatus('running');
      setBatches((current) => current.map((batch) => batch.id === selectedBatchId
        ? { ...batch, status: 'running' }
        : batch));
      setFeedback({ kind: 'success', message: '批次已开始生产' });
      await loadBatchDetail(selectedBatchId);
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
      setFeedback({ kind: 'error', message: '请先确认整体输入,代理请求需要读取已确认的色彩快照。' });
      return;
    }
    if (!inputConfirmed) {
      setFeedback({ kind: 'error', message: '整体输入已修改但尚未重新确认,不能请求代理;请先确认当前输入。' });
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
      setFeedback({ kind: 'success', message: result.reused ? 'LUT 内容已存在,复用既有记录' : 'LUT 导入成功' });
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
        message: `已清理 ${result.deletedCount} 个代理,释放 ${freedMb}MB${result.skippedCount > 0 ? `,跳过 ${result.skippedCount} 个使用中的文件` : ''}`,
      });
      await loadCacheUsage();
    } catch (cleanupError) {
      setFeedback({ kind: 'error', message: cleanupError instanceof Error ? cleanupError.message : '代理清理失败' });
    } finally {
      setCleanupBusy(null);
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

  const onlineAssets = prep.assets.filter(({ status }) => status === 'online').length;
  const selectableAssets = prep.assets.filter(({ status, currentAnalysisId }) => status === 'online' && currentAnalysisId).length;

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
    const videoUrl = previewUrl(assetId);
    return (
      <div className="mt-3 space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          {badges.map((badge) => (
            <span key={badge.text} className={`rounded-full px-2 py-0.5 text-[11px] ${badge.tone}`}>{badge.text}</span>
          ))}
          {info.kind === 'proxy' && !info.originalOnline && (
            <span className="text-[11px] text-fail">正式导出不可用</span>
          )}
        </div>
        {info.kind === 'proxy' && !info.originalOnline && (
          <p className="text-xs text-fail">原片离线,当前播放已生成的代理;正式导出仍要求原片在线且内容指纹一致。</p>
        )}
        {videoUrl && (
          <video
            controls
            preload="metadata"
            data-testid={`asset-preview-${assetId}`}
            className="w-full max-h-64 rounded-xl border border-hairline bg-black"
          >
            <source src={videoUrl} />
          </video>
        )}
      </div>
    );
  }

  function renderMediaPrepSection() {
    const proxyButtonsDisabled = !hasConfirmedVersion || proxyBatchBusy;
    const proxyButtonsBlockedByUnconfirmed = !inputConfirmed && hasConfirmedVersion;
    return (
      <section className="card space-y-4 p-5" aria-label="媒体准备:代理与 LUT">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.12em] text-accent">Phase D · 媒体准备</p>
          <h3 className="mt-1 font-semibold text-ink">代理与 LUT</h3>
          <p className="mt-1 text-sm text-ink-secondary">默认直接预览原片;卡顿时再按需生成代理。LUT 默认关闭,选择后对应素材会额外请求一份色彩代理。最终导出始终读取原片。</p>
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
            <p className="text-xs text-warn">脚本、素材、分析版本或 LUT 已修改,重新确认整体输入后代理请求才会匹配新快照。</p>
          )}
          {!hasConfirmedVersion && <p className="text-xs text-ink-tertiary">先确认整体输入,代理才能对应到已锁定的色彩快照。</p>}
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

        <div className="tile space-y-3 p-4">
          <p className="text-sm font-medium text-ink">素材预览</p>
          {Object.keys(selectedAssets).length === 0
            ? <p className="text-xs text-ink-tertiary">选择素材后这里会显示可播放的预览(代理或原片)。</p>
            : <ul className="space-y-4">
              {Object.entries(selectedAssets).map(([assetId, selection]) => {
                const displayName = prep.assets.find((asset) => asset.id === assetId)?.media.displayName
                  ?? prep.assets.find((asset) => asset.id === assetId)?.media.filename
                  ?? `素材 ${assetId.slice(0, 8)}`;
                const lutName = selection.lutId ? luts.find((lut) => lut.id === selection.lutId)?.displayName : null;
                return (
                  <li key={assetId} className="rounded-xl bg-surface-subtle p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="min-w-0 truncate text-xs font-medium text-ink">{displayName}</p>
                      <p className="text-xs text-ink-tertiary">{lutName ? `LUT：${lutName}` : 'LUT：关闭'}</p>
                    </div>
                    {renderPreviewBadge(assetId)}
                  </li>
                );
              })}
            </ul>}
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
          <p className="text-xs text-ink-tertiary">清理不影响原片、分析结果、批次快照和正式成片;清理后预览自动回退原片,可随时重新生成。正在使用中的文件会自动延后删除,不需要再次点击清理。</p>
        </div>
      </section>
    );
  }

  return (
    <section className="space-y-5" aria-label="批量生产准备区">
      <header className="card flex flex-wrap items-center justify-between gap-4 p-5">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.12em] text-accent">Phase A · 项目输入</p>
          <h2 className="mt-1 text-lg font-semibold text-ink">批量生产准备区</h2>
          <p className="mt-1 text-sm text-ink-secondary">项目脚本和成功视频会继续自动同步；选定输入后可建立 Phase B 批次快照。</p>
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
            <p className="text-xs font-semibold uppercase tracking-[0.12em] text-accent">Phase B · 批次快照</p>
            <h3 className="mt-1 font-semibold text-ink">创建或选择批次</h3>
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
            </div>
            <button
              type="button"
              className="btn-secondary"
              onClick={() => {
                setBatchInputState('draft');
                setFrozenScriptSnapshots([]);
                setSelectedScripts({});
                setSelectedAssets({});
                setOutputPlans([]);
                setInputConfirmed(false);
                setFeedback({ kind: 'success', message: '请选择当前项目输入并确认，新输入会形成批次新版本。' });
              }}
            >基于当前项目输入创建新版本</button>
          </div>
          <div className="grid gap-3 lg:grid-cols-2">
            {frozenScriptSnapshots.map((snapshot) => <BatchFrozenScriptCard key={snapshot.id} snapshot={snapshot} />)}
          </div>
          <div className="tile p-4 text-sm text-ink-secondary">
            <p className="font-medium text-ink">冻结素材池 · {Object.keys(selectedAssets).length} 条</p>
            <ul className="mt-2 space-y-1 text-xs text-ink-tertiary">
              {Object.entries(selectedAssets).map(([assetId, selection]) => (
                <li key={assetId}>
                  素材 {assetId.slice(0, 8)} · 分析版本 {selection.analysisId.slice(0, 8)}
                  {selection.lutId && <> · LUT {luts.find((lut) => lut.id === selection.lutId)?.displayName ?? selection.lutId.slice(0, 8)}</>}
                </li>
              ))}
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

          <section>
            <div className="mb-3 flex items-end justify-between gap-3">
              <div><h3 className="font-semibold text-ink">项目素材</h3><p className="mt-1 text-sm text-ink-secondary">只有当前在线且已有可用分析版本的素材才能进入批次素材池。</p></div>
              <span className="text-sm text-ink-secondary">已选 {Object.keys(selectedAssets).length} 条</span>
            </div>
            {prep.assets.length > 0
              ? <div className="grid gap-3 lg:grid-cols-2">{prep.assets.map((asset) => (
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
                />
              ))}</div>
              : <div className="tile p-6 text-sm text-ink-secondary">暂无可用视频素材，请先在第 4 步完成视频生成。</div>}
          </section>

          {renderMediaPrepSection()}

          <section className="card space-y-4 p-5" aria-label="批次确认与开始">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div>
                <h3 className="font-semibold text-ink">确认整体输入</h3>
                <p className="mt-1 text-sm text-ink-secondary">将 {selectedScriptEntries.length} 份脚本、{Object.keys(selectedAssets).length} 条素材与 {plannedCount} 条成片计划作为可检查的 draft 快照；点击开始时再同步最新脚本并冻结。</p>
                {!inputConfirmed && hasConfirmedVersion && (
                  <p className="mt-1 text-xs text-warn">输入已修改,重新确认后才会覆盖当前批次版本。</p>
                )}
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

      {outputPlans.length > 0 && (
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

      <footer className="rounded-2xl border border-dashed border-hairline p-4 text-sm text-ink-secondary">
        Phase B 确认时建立可检查的 draft 快照，开始时同步最新项目脚本并冻结当前版本；持久调度、真实进度、暂停与恢复属于 Phase C；代理与 LUT 属于 Phase D。
      </footer>
    </section>
  );
}
