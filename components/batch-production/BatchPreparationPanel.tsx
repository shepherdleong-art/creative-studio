'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '@/components/ui/Icon';
import MixcutShell, { type MixcutStepDef } from '@/components/mixcut/MixcutShell';
import shellStyles from '@/components/mixcut/mixcut-shell.module.css';
import type { BatchPreparationResult } from '@/lib/batch-production/prepare';
import type { BatchSnapshotDetail, BatchSnapshotResult } from '@/lib/batch-production/batch-flow';
import type { BatchProductionStatus } from '@/lib/batch-production/versions';
import type { BatchLutRow } from '@/lib/batch-production/lut-catalog';
import type { BatchTasksView } from '@/lib/batch-production/tasks';
import type { BatchWorkspaceView } from '@/lib/batch-production/batch-workspace';
import type { DesktopBridge } from '@/desktop/bridge-types';
import {
  type AssetPrepareTaskView,
  type PrepareAssetCardView,
} from './BatchInputSelectionCards';
import BatchProductionSidebar, { type BatchSidebarItem } from './BatchProductionSidebar';
import BatchProductionProgressCard, { type BatchProgressView } from './BatchProductionProgressCard';
import BatchStepMaterials, { type AssetSelectionState, type VisionProviderView } from './BatchStepMaterials';
import BatchStepScripts, {
  BATCH_PROGRESS_ANCHOR_ID,
  type BatchBgmParamsDraft,
  type BatchBgmTrackView,
  type BatchCoverTitleDraft,
  type BatchMusicSelectionDraft,
  type BatchTtsProviderView,
  type OutputPresetLabel,
} from './BatchStepScripts';
import BatchStepReview, { type CardFilter } from './BatchStepReview';
import BatchStepExport from './BatchStepExport';

interface ReadinessResponse {
  available: boolean;
  message: string;
  code?: string;
}

interface BatchListResponse {
  projectId: string;
  batches: BatchSidebarItem[];
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

interface TtsProviderView {
  id: string;
  name: string;
  model: string;
  configured: boolean;
  voices: Array<{ id: string; label: string }>;
}

interface BatchPreparationPanelProps {
  projectId: string;
}

interface Feedback {
  kind: 'success' | 'error';
  message: string;
}

type OutputPreset = '3:4' | '9:16' | '16:9';

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

/** 后端原始错误 → 用户可读文案。匹配用 includes，避免依赖完整字符串。 */
const EXPORT_SKIP_REASONS: Array<{ match: string; text: string }> = [
  { match: '重新渲染', text: '等待重新渲染完成' },
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

const OUTPUT_PRESET_LABELS: Record<OutputPreset, string> = {
  '3:4': '3:4 · 1080×1440',
  '9:16': '9:16 · 1080×1920',
  '16:9': '16:9 · 1920×1080',
};

function visionProviderStorageKey(projectId: string): string {
  return `batch-vision-provider:${projectId}`;
}

export default function BatchPreparationPanel({ projectId }: BatchPreparationPanelProps) {
  const [preparation, setPreparation] = useState<BatchPreparationResult | null>(null);
  const [batches, setBatches] = useState<BatchSidebarItem[]>([]);
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
  const [proxyTasks, setProxyTasks] = useState<BatchTasksView['tasks']>([]);
  const [assetPrepareTasks, setAssetPrepareTasks] = useState<AssetPrepareTaskView[]>([]);
  const [analysisBusy, setAnalysisBusy] = useState<string | null>(null);
  const [previewAsset, setPreviewAsset] = useState<PreviewAsset | null>(null);
  const [visionProviders, setVisionProviders] = useState<VisionProviderView[]>([]);
  const [visionProviderId, setVisionProviderId] = useState('');
  const [ttsProviders, setTtsProviders] = useState<BatchTtsProviderView[]>([]);
  const [ttsConfigured, setTtsConfigured] = useState(false);
  const [bgmParams, setBgmParams] = useState<BatchBgmParamsDraft>({ gainDb: -18, fadeInSec: 1, fadeOutSec: 1.5 });
  const [bgmLibrary, setBgmLibrary] = useState<BatchBgmTrackView[]>([]);
  const [bgmRescanning, setBgmRescanning] = useState(false);
  const [bgmSelection, setBgmSelection] = useState<BatchMusicSelectionDraft>({ mode: 'auto', trackIds: [] });
  // 封面标题设置草稿:mode none 时为完整稳定形状(其余字段 null),避免 canonical 比对抖动。
  const [coverTitle, setCoverTitle] = useState<BatchCoverTitleDraft>({
    mode: 'none',
    presetId: null,
    styles: null,
    stylesByScript: {},
    framing: null,
  });
  const [batchTasks, setBatchTasks] = useState<BatchTasksView['tasks']>([]);
  const previewCloseButtonRef = useRef<HTMLButtonElement | null>(null);
  const analysisReloadedTaskIdsRef = useRef<Set<string>>(new Set());
  // 开跑被语义匹配/口播门禁延迟时置位,相关任务全部终态后自动续跑;
  // startBatchRef 避免把非 useCallback 的 startBatch 塞进 effect 依赖。
  const autoStartAfterGatesRef = useRef(false);
  const startBatchRef = useRef<() => Promise<void>>(async () => undefined);
  // 点开跑后把进度卡滚进视野。进度卡在脚本步内容栈末尾(「开始」按钮之下),
  // 不置顶是有意的——置顶会落在按钮的视线之外(实测用户点完看不到它)。
  const scrollToProgressRef = useRef(false);
  const [proxyBusyAssetId, setProxyBusyAssetId] = useState<string | null>(null);
  const [proxyBatchBusy, setProxyBatchBusy] = useState(false);
  const [cacheUsage, setCacheUsage] = useState<{ count: number; totalBytes: number } | null>(null);
  const [cleanupBusy, setCleanupBusy] = useState<'selected' | 'project' | null>(null);
  const [previewInfos, setPreviewInfos] = useState<Record<string, PreviewInfo>>({});
  const [outputPreset, setOutputPreset] = useState<OutputPreset>('3:4');
  const [workspace, setWorkspace] = useState<BatchWorkspaceView | null>(null);
  const [cardFilter, setCardFilter] = useState<CardFilter>('all');
  const [selectedPlanIds, setSelectedPlanIds] = useState<string[]>([]);
  const [phaseEBusy, setPhaseEBusy] = useState<'export' | 'control' | string | null>(null);
  const [activeStep, setActiveStep] = useState<0 | 1 | 2 | 3>(0);
  const [folderRelativePath, setFolderRelativePath] = useState<string | null>(null);
  const [revealBusy, setRevealBusy] = useState(false);
  // 「打开文件夹」的结果反馈渲染在第 4 步按钮旁,不再挤到面板顶部的公共错误条。
  const [revealFeedback, setRevealFeedback] = useState<{ kind: 'ok' | 'error'; message: string } | null>(null);
  // 「打开文件夹」只有桌面安装版能用(服务端同样门禁)。与单条模式取同一个
  // 能力端点,不可用时直接隐藏按钮,而不是摆一个点了必然失败的按钮。
  const [revealAvailable, setRevealAvailable] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const readiness = await readJson<ReadinessResponse>(await fetch('/api/batch-production/readiness', { cache: 'no-store' }));
      if (!readiness.available) throw new Error(readiness.message || '批量生产暂不可用');
      const [result, batchResult, providerResult, ttsResult] = await Promise.all([
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
        readJson<TtsProviderView[]>(await fetch('/api/providers/tts', { cache: 'no-store' }))
          .catch(() => []),
      ]);
      setPreparation(result);
      setBatches(batchResult.batches);
      setVisionProviders(providerResult);
      setTtsProviders(ttsResult);
      setTtsConfigured(ttsResult.some((provider) => provider.configured));
      // 分析模型选择持久化:沿用上次显式选择;仅当该供应商已不存在或不再可用时才回落默认
      setVisionProviderId((current) => {
        if (providerResult.some((provider) => provider.id === current && provider.configured && provider.supportsVision)) {
          return current;
        }
        let remembered = '';
        try {
          remembered = localStorage.getItem(visionProviderStorageKey(projectId)) ?? '';
        } catch { /* 隐私模式忽略 */ }
        if (providerResult.some((provider) => provider.id === remembered && provider.configured && provider.supportsVision)) {
          return remembered;
        }
        return providerResult.find((provider) => provider.configured && provider.supportsVision)?.id ?? '';
      });
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

  /**
   * 只刷新准备区(脚本/素材列表),不复用 load():load() 会 setBatches,
   * 连锁触发批次详情重载,把用户尚未确认的份数/素材/LUT 选择冲掉(见方案 §6.7)。
   * 失败只提示,不清空已有 preparation。
   */
  const reloadPreparation = useCallback(async () => {
    try {
      const result = await readJson<BatchPreparationResult>(await fetch(
        `/api/batch-production/prepare?projectId=${encodeURIComponent(projectId)}`,
        { cache: 'no-store' },
      ));
      setPreparation(result);
    } catch (reloadError) {
      setFeedback({
        kind: 'error',
        message: reloadError instanceof Error ? reloadError.message : '脚本列表刷新失败',
      });
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

  // 代理任务、素材分析任务与批次生产任务来自同一个 /tasks 端点,合并为一次拉取,
  // 派生三种视图,避免同一接口重复轮询。
  const loadTasks = useCallback(async (batchId: string) => {
    if (!batchId) {
      setProxyTasks([]);
      setAssetPrepareTasks([]);
      setBatchTasks([]);
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
      setBatchTasks(view.tasks);
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

  const loadBgmLibrary = useCallback(async () => {
    try {
      const result = await readJson<{ tracks: BatchBgmTrackView[] }>(await fetch(
        '/api/batch-production/bgm',
        { cache: 'no-store' },
      ));
      setBgmLibrary(result.tracks);
      setBgmSelection((current) => ({
        mode: current.mode,
        trackIds: current.trackIds.filter((id) => result.tracks.some((track) => track.id === id)),
      }));
    } catch {
      // 曲库读取失败不阻塞其他功能,保留上一次的列表。
    }
  }, []);

  const rescanBgmLibrary = useCallback(async () => {
    setBgmRescanning(true);
    try {
      const result = await readJson<{ tracks: BatchBgmTrackView[] }>(await fetch('/api/batch-production/bgm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-creative-studio-action': 'rescan' },
      }));
      setBgmLibrary(result.tracks);
      setBgmSelection((current) => ({
        mode: current.mode,
        trackIds: current.trackIds.filter((id) => result.tracks.some((track) => track.id === id)),
      }));
      setFeedback({ kind: 'success', message: `曲库重新扫描完成，共 ${result.tracks.length} 首。` });
    } catch (rescanError) {
      setFeedback({ kind: 'error', message: rescanError instanceof Error ? rescanError.message : '曲库重新扫描失败' });
    } finally {
      setBgmRescanning(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => { void load(); void loadLuts(); void loadCacheUsage(); void loadBgmLibrary(); }, 0);
    return () => window.clearTimeout(timer);
  }, [load, loadLuts, loadCacheUsage, loadBgmLibrary]);

  useEffect(() => {
    void (async () => {
      try {
        const value = await readJson<{ revealInFolder: boolean }>(await fetch('/api/final-edit/capabilities'));
        setRevealAvailable(value.revealInFolder);
      } catch {
        setRevealAvailable(false);
      }
    })();
  }, []);

  // 稳定布尔:是否有活跃生产任务(queued/running 且未被暂停)。
  // 只允许布尔量进入周期轮询 effect 的依赖数组——数组/对象状态既是依赖
  // 又是产物,会让轮询 effect 以网络往返速度无限自触发。
  const hasActiveBatchTask = useMemo(
    () => batchTasks.some((task) => (
      (task.status === 'queued' || task.status === 'running') && task.expectedState === 'running'
    )),
    [batchTasks],
  );
  // 轮询闸门:除了"手上已有活跃任务",批次自称 running 时也必须轮询。
  // 否则开跑瞬间(batchTasks 尚未拉到新任务)或任务由服务端在别处创建时,
  // 闸门会因为看着一份空列表而永远不挂载。batchStatus 是字符串,进依赖安全。
  const shouldPollBatch = hasActiveBatchTask || batchStatus === 'running';

  // 任务轮询:进入/切批次时各拉一次(与周期轮询彻底分开)。
  useEffect(() => {
    if (!selectedBatchId) return;
    const timer = window.setTimeout(() => void loadTasks(selectedBatchId), 0);
    return () => window.clearTimeout(timer);
  }, [selectedBatchId, loadTasks]);

  useEffect(() => {
    startBatchRef.current = startBatch;
  });

  // 开跑被语义匹配/口播门禁延迟时:相关任务全部进入终态后自动续跑(PUT /start 幂等)。
  useEffect(() => {
    if (!selectedBatchId || !autoStartAfterGatesRef.current) return;
    const incomplete = batchTasks.filter((task) => (
      (task.workType === 'semantic_score' || task.workType === 'narration')
      && (task.status === 'queued' || task.status === 'running')
    )).length;
    if (incomplete > 0) return;
    autoStartAfterGatesRef.current = false;
    void startBatchRef.current();
  }, [batchTasks, selectedBatchId]);

  // 有活跃任务、或批次仍自称 running 时才周期轮询,全部结束后立即停止。
  useEffect(() => {
    if (!selectedBatchId || !shouldPollBatch) return;
    const interval = window.setInterval(() => void loadTasks(selectedBatchId), 3_000);
    return () => window.clearInterval(interval);
  }, [selectedBatchId, loadTasks, shouldPollBatch]);

  // workspace 轮询:与任务轮询同条件、同结构,依赖里只出现布尔量。
  useEffect(() => {
    if (!selectedBatchId) return;
    const timer = window.setTimeout(() => void loadWorkspace(selectedBatchId), 0);
    return () => window.clearTimeout(timer);
  }, [selectedBatchId, loadWorkspace]);

  useEffect(() => {
    if (!selectedBatchId || !shouldPollBatch) return;
    const interval = window.setInterval(() => void loadWorkspace(selectedBatchId), 3_000);
    return () => window.clearInterval(interval);
  }, [selectedBatchId, loadWorkspace, shouldPollBatch]);

  useEffect(() => {
    if (!selectedBatchId) return;
    const timer = window.setTimeout(() => void loadBatchDetail(selectedBatchId), 0);
    return () => window.clearTimeout(timer);
  }, [loadBatchDetail, selectedBatchId]);

  // 计时 tick:只在有活跃任务且批次未被停止时每秒跳动一次,终态后不再更新。
  // 已停止批次里可能残留 expectedState=running 的 queued 任务(停止前排队的),
  // 没有 stopped 闸门的话,一打开页面计时器就永远空转,看起来像"还在跑"。
  const [nowMs, setNowMs] = useState(() => Date.now());
  const batchStopped = workspace?.batch.controlState === 'stopped';
  useEffect(() => {
    if (!hasActiveBatchTask || batchStopped) return;
    const timer = window.setInterval(() => setNowMs(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [hasActiveBatchTask, batchStopped]);

  const progressView = useMemo<BatchProgressView | null>(() => {
    // 语义匹配/口播排队期间，服务端批次状态还不是 running，但生产任务已经
    // 排队——此时也必须显示进度卡，否则开跑后只剩顶部横幅、下方一片空白。
    const productionTaskCount = batchTasks.filter((task) => task.workType === 'narration' || task.workType === 'render' || task.workType === 'semantic_score').length;
    if (!['running', 'partially_completed', 'completed', 'failed'].includes(batchStatus) && productionTaskCount === 0) return null;
    const narration = batchTasks.filter((task) => task.workType === 'narration');
    const renders = batchTasks.filter((task) => task.workType === 'render');
    const semantic = batchTasks.filter((task) => task.workType === 'semantic_score');
    // 起点只算本次生产的任务(语义打分 + 口播 + 渲染),不包括第 1 步的素材分析/代理生成。
    const productionTasks = batchTasks.filter((task) => task.workType === 'narration' || task.workType === 'render' || task.workType === 'semantic_score');
    const renderSucceeded = renders.filter((task) => task.status === 'succeeded').length;
    const renderFailed = renders.filter((task) => task.status === 'failed').length;
    const renderActive = renders.filter((task) => task.status === 'running' || task.status === 'queued').length;
    const narrationSucceeded = narration.filter((task) => task.status === 'succeeded').length;
    const narrationFailed = narration.filter((task) => task.status === 'failed').length;
    const narrationActive = narration.filter((task) => task.status === 'running' || task.status === 'queued').length;
    const semanticSucceeded = semantic.filter((task) => task.status === 'succeeded').length;
    const semanticFailed = semantic.filter((task) => task.status === 'failed').length;
    const semanticActive = semantic.filter((task) => task.status === 'running' || task.status === 'queued').length;
    const allocationDone = workspace?.allocationReport != null || (workspace?.cards.length ?? 0) > 0;
    const startedAtMs = productionTasks.length > 0
      ? Math.min(...productionTasks.map((task) => new Date(task.createdAt).getTime()))
      : null;
    // 终态停表:没有活跃任务且已有生产任务时,用最后一条生产尝试的完成时刻,
    // 而不是 Date.now()——否则"做完了还在计时"。
    const finished = !hasActiveBatchTask && productionTasks.length > 0;
    const finishedAtMs = finished
      ? Math.max(...productionTasks.flatMap((task) =>
        task.attempts.map((attempt) => (attempt.finishedAt ? new Date(attempt.finishedAt).getTime() : 0))))
      : 0;
    const endMs = finished && finishedAtMs > 0 ? finishedAtMs : nowMs;
    const totalRenders = renders.length;
    const stage = (label: string, status: BatchProgressView['stages'][number]['status'], detail?: string, percent?: number) => ({ label, status, detail, percent });
    return {
      overallPercent: totalRenders > 0 ? renderSucceeded / totalRenders : 0,
      elapsedSec: startedAtMs ? Math.max(0, Math.floor((endMs - startedAtMs) / 1000)) : 0,
      finished,
      stages: [
        stage('锁定设置', 'done'),
        stage(
          '匹配画面语义',
          semantic.length === 0 ? 'waiting' : semanticFailed > 0 ? 'failed' : semanticActive > 0 ? 'running' : 'done',
          semantic.length > 0 ? `${semanticSucceeded}/${semantic.length}` : undefined,
          semantic.length > 0 ? semanticSucceeded / semantic.length : undefined,
        ),
        stage(
          '生成口播',
          narration.length === 0 ? 'waiting' : narrationFailed > 0 ? 'failed' : narrationActive > 0 ? 'running' : 'done',
          narration.length > 0 ? `${narrationSucceeded}/${narration.length}` : undefined,
          narration.length > 0 ? narrationSucceeded / narration.length : undefined,
        ),
        // 自动配画面不能以"工作区里存在分配报告"为准——那可能是确认输入时
        // 遗留的旧结果。本轮有语义任务时，等语义任务结束(成功或失败)再看分配状态;
        // 语义失败不再传染本阶段——开跑流程会走关键词兜底继续分配,失败由
        // 「匹配画面语义」阶段自己如实展示。
        stage(
          '自动配画面',
          semantic.length > 0 && semanticActive > 0
            ? 'waiting'
            : allocationDone
              ? 'done'
              : 'running',
        ),
        stage(
          '渲染成片',
          renders.length === 0 ? 'waiting' : renderFailed > 0 ? 'failed' : renderActive > 0 ? 'running' : 'done',
          totalRenders > 0 ? `${renderSucceeded}/${totalRenders}` : undefined,
          totalRenders > 0 ? renderSucceeded / totalRenders : undefined,
        ),
        stage(
          '生成封面',
          totalRenders === 0 ? 'waiting' : renderSucceeded === totalRenders && renderFailed === 0 ? 'done' : 'running',
          totalRenders > 0 ? `${renderSucceeded}/${totalRenders}` : undefined,
        ),
      ],
    };
  }, [batchStatus, batchTasks, workspace, hasActiveBatchTask, nowMs]);

  // 开跑后滚到进度卡。progressView 只在 setBatchStatus('running') 之后才非空,
  // 所以不能在 startBatch 里同步滚(那时元素还不存在);等它出现再用 rAF 滚。
  useEffect(() => {
    if (!scrollToProgressRef.current || !progressView) return;
    scrollToProgressRef.current = false;
    const frame = window.requestAnimationFrame(() => {
      document.getElementById(BATCH_PROGRESS_ANCHOR_ID)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [progressView]);

  const currentBatch = batches.find(({ id }) => id === selectedBatchId);
  const currentVersionId = currentBatch?.currentVersionId ?? null;

  // Technical and content tasks both replace the asset's current analysis
  // pointer. Update the affected asset locally (analysisId/analysisLevel from
  // the succeeded attempt result) instead of re-running the whole prepare,
  // so upgrades from technical → content become visible without a full reload.
  useEffect(() => {
    void (async () => {
      const patches: Array<{ assetId: string; analysisId: string; level: 'technical' | 'content' }> = [];
      for (const task of assetPrepareTasks) {
        if (task.status !== 'succeeded') analysisReloadedTaskIdsRef.current.delete(task.id);
        if (task.status !== 'succeeded' || analysisReloadedTaskIdsRef.current.has(task.id)) continue;
        const result = task.attempts?.at(-1)?.resultJson as { analysisId?: unknown; analysisLevel?: unknown } | undefined;
        if (typeof result?.analysisId !== 'string' || !result.analysisId) continue;
        analysisReloadedTaskIdsRef.current.add(task.id);
        patches.push({
          assetId: task.targetId,
          analysisId: result.analysisId,
          level: result.analysisLevel === 'content' ? 'content' : 'technical',
        });
      }
      if (patches.length === 0) return;
      setPreparation((current) => {
        if (!current) return current;
        const byId = new Map(patches.map((patch) => [patch.assetId, patch]));
        return {
          ...current,
          assets: current.assets.map((asset) => {
            const patch = byId.get(asset.id);
            if (!patch) return asset;
            return {
              ...asset,
              currentAnalysisId: patch.analysisId,
              analysisLevel: patch.level,
            };
          }),
        };
      });
    })();
  }, [assetPrepareTasks]);

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
  const plannedCount = useMemo(
    () => selectedScriptEntries.reduce((sum, [, copyCount]) => sum + copyCount, 0),
    [selectedScriptEntries],
  );
  const hasConfirmedVersion = Boolean(currentVersionId);

  function markInputChanged(): void {
    setOutputPlans([]);
    setInputConfirmed(false);
    setFeedback(null);
  }

  /** 手动脚本 CRUD 的状态迁移(方案 §7.5):三个操作各自独立,不合并。 */
  function handleScriptCreated(): void {
    // 新脚本默认未勾选,当前输入不受影响,不调 markInputChanged()。
    void reloadPreparation();
    setFeedback({ kind: 'success', message: '自定义脚本已导入，勾选后确认整体输入即可参与生产。' });
  }

  function handleScriptUpdated(scriptId: string): void {
    void reloadPreparation();
    // 已勾选的脚本内容变了:强制重新确认,避免「旧正文打分、新正文生产」(§6.7)。
    if (selectedScripts[scriptId] !== undefined) {
      markInputChanged();
      setFeedback({ kind: 'success', message: '脚本已更新；该脚本已在本批次选中，请重新确认整体输入。' });
    } else {
      setFeedback({ kind: 'success', message: '脚本已更新。' });
    }
  }

  function handleScriptDeleted(scriptId: string): void {
    void reloadPreparation();
    // markInputChanged 不碰 selectedScripts,必须无条件移除该 ID,
    // 否则卡片消失后野 ID 仍会随确认提交。
    const wasSelected = selectedScripts[scriptId] !== undefined;
    setSelectedScripts((current) => (
      Object.fromEntries(Object.entries(current).filter(([id]) => id !== scriptId))
    ));
    if (wasSelected) {
      markInputChanged();
      setFeedback({ kind: 'success', message: '脚本已删除；它此前已在本批次选中，请重新确认整体输入。' });
    } else {
      setFeedback({ kind: 'success', message: '脚本已删除。' });
    }
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

  function previewUrl(assetId: string): string {
    if (!selectedBatchId || !currentVersionId) return '';
    return `/api/batch-production/preview/${encodeURIComponent(assetId)}?projectId=${encodeURIComponent(projectId)}`
      + `&batchId=${encodeURIComponent(selectedBatchId)}&batchVersionId=${encodeURIComponent(currentVersionId)}`;
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

  async function analyzeAssets(assetIds: string[]): Promise<void> {
    if (!selectedBatchId) {
      setFeedback({ kind: 'error', message: '请先创建或选择一个批次，再开始素材分析。' });
      return;
    }
    if (!visionProviderId) {
      setFeedback({ kind: 'error', message: '请先在设置中启用并配置一个支持图片理解的脚本供应商。' });
      return;
    }
    const candidates = new Set(
      (preparation?.assets ?? [])
        .filter((asset) => asset.status === 'online' && asset.analysisLevel !== 'content')
        .map((asset) => asset.id),
    );
    const requestedAssetIds = [...new Set(assetIds)].filter((assetId) => candidates.has(assetId));
    if (requestedAssetIds.length === 0) {
      setFeedback({ kind: 'success', message: '在线素材都已有内容分析。' });
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
          body: JSON.stringify({ assetIds: requestedAssetIds, mode: 'content', providerId: visionProviderId }),
        },
      ));
      analysisReloadedTaskIdsRef.current.clear();
      await loadTasks(selectedBatchId);
      const responseItems = result.items ?? [];
      if (responseItems.some((item) => item.ready)) await load();
      const providerName = visionProviders.find((provider) => provider.id === visionProviderId)?.name;
      setFeedback({
        kind: 'success',
        message: `已为 ${requestedAssetIds.length} 条素材安排内容分析${providerName ? `，抽帧将发送给 ${providerName}` : ''}。`,
      });
    } catch (analyzeError) {
      setFeedback({ kind: 'error', message: analyzeError instanceof Error ? analyzeError.message : '素材内容分析请求失败' });
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
      await loadTasks(selectedBatchId);
      setFeedback({ kind: 'success', message: '已重新排队素材分析。' });
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
      const batch: BatchSidebarItem = {
        ...created,
        status: 'draft',
        currentVersionId: null,
        archivedAt: null,
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
      setActiveStep(0);
      setFeedback({ kind: 'success', message: `批次已创建：${created.name}` });
    } catch (createError) {
      setFeedback({ kind: 'error', message: createError instanceof Error ? createError.message : '批次创建失败' });
    } finally {
      setBusy(null);
    }
  }

  async function archiveBatch(batchId: string, archived: boolean): Promise<void> {
    setFeedback(null);
    try {
      await readJson(await fetch(
        `/api/batch-production/batches/${encodeURIComponent(batchId)}/archive?projectId=${encodeURIComponent(projectId)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ archived }),
        },
      ));
      setBatches((current) => current.map((batch) => batch.id === batchId
        ? { ...batch, archivedAt: archived ? new Date().toISOString() : null }
        : batch));
      setFeedback({ kind: 'success', message: archived ? '批次已归档，成片与导出文件完好保留。' : '批次已恢复。' });
      void load();
    } catch (archiveError) {
      setFeedback({ kind: 'error', message: archiveError instanceof Error ? archiveError.message : '批次归档失败' });
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
              targetDurationSec: 15,
              batchBgmParams: bgmParams,
              batchMusicSelection: bgmSelection,
              coverTitleMode: coverTitle.mode,
              coverTitlePresetId: coverTitle.presetId,
              coverTitleStyles: coverTitle.styles,
              coverTitleFraming: coverTitle.framing,
              ...(Object.keys(coverTitle.stylesByScript).length > 0
                ? { coverTitleStylesByScript: coverTitle.stylesByScript }
                : {}),
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
        status: 'running' | 'semantic_scoring' | 'narration_pending';
        semanticScorePending?: number;
        narrationPending?: number;
        allocationStatus?: 'completed' | 'partial' | 'blocked';
        outputCount?: number;
      }>(await fetch(
        `/api/batch-production/batches/${encodeURIComponent(selectedBatchId)}/start?projectId=${encodeURIComponent(projectId)}`,
        { method: 'PUT' },
      ));
      if (result.status === 'semantic_scoring') {
        // 语义打分由后端在快照确认后自动排队,这里只负责显示与自动续跑;
        // 直接进入"生产中",不再让界面停留在"没开始"的样子。
        autoStartAfterGatesRef.current = true;
        scrollToProgressRef.current = true;
        setBatchStatus('running');
        setBatches((current) => current.map((batch) => batch.id === selectedBatchId
          ? { ...batch, status: 'running' }
          : batch));
        setFeedback({
          kind: 'success',
          message: `正在按画面内容匹配素材…（还差 ${result.semanticScorePending ?? 0} 份），完成后自动继续生产，无需再点。`,
        });
        await loadTasks(selectedBatchId);
        return;
      }
      if (result.status === 'narration_pending') {
        // 口播由后端在冻结后自动排队,同样直接进入"生产中",终态后自动续跑。
        autoStartAfterGatesRef.current = true;
        scrollToProgressRef.current = true;
        setBatchStatus('running');
        setBatches((current) => current.map((batch) => batch.id === selectedBatchId
          ? { ...batch, status: 'running' }
          : batch));
        setFeedback({
          kind: 'success',
          message: `正在生成口播…（还差 ${result.narrationPending ?? 0} 份），完成后自动继续生产，无需再点。`,
        });
        await loadTasks(selectedBatchId);
        return;
      }
      autoStartAfterGatesRef.current = false;
      scrollToProgressRef.current = true;
      setBatchStatus('running');
      setBatches((current) => current.map((batch) => batch.id === selectedBatchId
        ? { ...batch, status: 'running' }
        : batch));
      setFeedback({
        kind: result.allocationStatus === 'blocked' ? 'error' : 'success',
        message: result.allocationStatus === 'blocked'
          ? '自动配画面被阻塞，请查看成片卡片中的原因。'
          : `已开跑，渲染进行中。进度可在本页查看，完成后可到「检查成片」确认并导出。`,
      });
      await loadBatchDetail(selectedBatchId);
      await loadWorkspace(selectedBatchId);
      // 必须立刻拉一次任务列表:周期轮询的闸门是从 batchTasks 派生的,
      // 开跑瞬间它还是空的,不在这里补一次就永远挂不上轮询(进度卡会
      // 停在「等待」且已用时 0 秒)。
      await loadTasks(selectedBatchId);
      // 不自动跳到「检查成片」:开跑时一条渲染都还没完成,留在本步查看真实进度。
    } catch (startError) {
      setFeedback({ kind: 'error', message: startError instanceof Error ? startError.message : '批次启动失败' });
    } finally {
      setBusy(null);
    }
  }

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
    await loadTasks(batchId);
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
      if (selectedBatchId) await loadTasks(selectedBatchId);
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
      if (selectedBatchId) await loadTasks(selectedBatchId);
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

  async function retryNarrationTask(taskId: string): Promise<void> {
    setPhaseEBusy(`narration:${taskId}`);
    setFeedback(null);
    try {
      await readJson(await fetch(
        `/api/batch-production/tasks/${encodeURIComponent(taskId)}/retry?projectId=${encodeURIComponent(projectId)}`,
        { method: 'POST' },
      ));
      if (selectedBatchId) await loadWorkspace(selectedBatchId);
      setFeedback({ kind: 'success', message: '已重新排队配音，完成后渲染会自动继续。' });
    } catch (retryError) {
      setFeedback({ kind: 'error', message: retryError instanceof Error ? retryError.message : '配音重试失败' });
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

  async function reviewSelected(decision: 'approved' | 'rework' | 'cancelled'): Promise<void> {
    if (!selectedBatchId) return;
    if (selectedPlanIds.length === 0) {
      setFeedback({ kind: 'error', message: '请先选择要操作的成片。' });
      return;
    }
    setPhaseEBusy(`review:${decision}`);
    setFeedback(null);
    try {
      const reviewResult = await readJson<{ pendingRender?: boolean }>(await fetch(
        `/api/batch-production/batches/${encodeURIComponent(selectedBatchId)}/outputs/review?projectId=${encodeURIComponent(projectId)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ planIds: selectedPlanIds, decision }),
        },
      ));
      if (decision === 'rework') {
        // 返工联动:逐条换一批画面;新版本没有 review 字段,天然回到未审核态。
        for (const planId of selectedPlanIds) {
          await readJson(await fetch(
            `/api/batch-production/batches/${encodeURIComponent(selectedBatchId)}/outputs/${encodeURIComponent(planId)}/reallocate?projectId=${encodeURIComponent(projectId)}`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ reason: '用户审核返工,换一批画面' }),
            },
          ));
        }
        setSelectedPlanIds([]);
      }
      await loadWorkspace(selectedBatchId);
      setFeedback({
        kind: 'success',
        message: decision === 'approved'
          ? reviewResult.pendingRender
            ? `已通过 ${selectedPlanIds.length} 条成片，渲染中，完成后才可导出。`
            : `已通过 ${selectedPlanIds.length} 条成片，可以正式导出。`
          : decision === 'rework'
            ? `已返工 ${selectedPlanIds.length} 条成片并换一批画面，新候选需要重新审核。`
            : `已撤销 ${selectedPlanIds.length} 条成片的审核。`,
      });
    } catch (reviewError) {
      setFeedback({ kind: 'error', message: reviewError instanceof Error ? reviewError.message : '审核操作失败' });
    } finally {
      setPhaseEBusy(null);
    }
  }

  async function changeCover(planId: string, timeUs: number): Promise<void> {
    if (!selectedBatchId) return;
    setPhaseEBusy(`cover:${planId}`);
    setFeedback(null);
    try {
      const result = await readJson<{ timeUs: number; coverRelativePath: string }>(await fetch(
        `/api/batch-production/batches/${encodeURIComponent(selectedBatchId)}/outputs/${encodeURIComponent(planId)}/cover?projectId=${encodeURIComponent(projectId)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ timeUs }),
        },
      ));
      setFeedback({ kind: 'success', message: `封面已更新为 ${(result.timeUs / 1_000_000).toFixed(2)} 秒处画面；封面同时是成片片头，正在重新渲染这一条，完成后需重新导出。` });
      await loadWorkspace(selectedBatchId);
    } catch (coverError) {
      setFeedback({ kind: 'error', message: coverError instanceof Error ? coverError.message : '换封面失败' });
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
        message: excluded ? '已从后续自动配画面排除该素材；旧正式成片保持不变。' : '该素材已恢复参与后续自动配画面。',
      });
      await loadWorkspace(selectedBatchId);
    } catch (exclusionError) {
      setFeedback({ kind: 'error', message: exclusionError instanceof Error ? exclusionError.message : '素材排除修改失败' });
    } finally {
      setPhaseEBusy(null);
    }
  }

  async function publishSelected(): Promise<void> {
    const planIdsToPublish = (workspace?.cards ?? [])
      .filter((card) => selectedPlanIds.includes(card.planId) && card.publishable && card.approved && !card.renderStale)
      .map(({ planId }) => planId);
    if (!selectedBatchId || planIdsToPublish.length === 0) {
      const selectedStale = (workspace?.cards ?? []).some((card) => selectedPlanIds.includes(card.planId) && card.renderStale);
      setFeedback({
        kind: 'error',
        message: selectedStale ? '选中的成片画面已调整，等待重新渲染完成后才能导出。' : '请先勾选要正式导出的成片。',
      });
      return;
    }
    setPhaseEBusy('export');
    setFeedback(null);
    try {
      const result = await readJson<{
        published: number;
        skipped: number;
        items: Array<{ status: 'published' | 'skipped'; reason?: string; videoRelativePath?: string }>;
      }>(await fetch(
        `/api/batch-production/batches/${encodeURIComponent(selectedBatchId)}/exports?projectId=${encodeURIComponent(projectId)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ planIds: planIdsToPublish }),
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
      const firstPublished = result.items.find(({ status }) => status === 'published' && result.published > 0 && result.skipped === 0);
      const exported = result.items.find(({ status }) => status === 'published');
      if (exported?.videoRelativePath) {
        const folder = exported.videoRelativePath.split('/').slice(0, -1).join('/');
        setFolderRelativePath(`storage/${folder}`);
      } else if (firstPublished) {
        setFolderRelativePath(null);
      }
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
      // 停止/暂停后轮询会随活跃任务消失而停,这里一次性补刷任务与 workspace,
      // 让阶段列表立刻落到 cancelled/已停止,而不是停留在「进行中」。
      await Promise.all([loadWorkspace(selectedBatchId), loadTasks(selectedBatchId)]);
    } catch (controlError) {
      setFeedback({ kind: 'error', message: controlError instanceof Error ? controlError.message : '批次控制失败' });
    } finally {
      setPhaseEBusy(null);
    }
  }

  async function revealFolder(): Promise<void> {
    if (!selectedBatchId) return;
    setRevealBusy(true);
    setRevealFeedback(null);
    try {
      // 桌面安装版优先走 Electron 主进程 shell.openPath:资源管理器前台弹出、
      // 失败带系统错误串;服务端 reveal 端点(隐藏控制台子进程 spawn)留作兜底。
      const bridge = (window as Window & { desktopBridge?: DesktopBridge }).desktopBridge;
      const exportDirName = workspace?.exportDirName;
      if (bridge?.openFolder && exportDirName) {
        const result = await bridge.openFolder(`storage/projects/${exportDirName}/成片`);
        if (result.opened) {
          setRevealFeedback({ kind: 'ok', message: '已请求系统打开文件夹' });
        } else {
          setRevealFeedback({ kind: 'error', message: result.message ?? '打开文件夹失败' });
        }
        return;
      }
      await readJson(await fetch(
        `/api/batch-production/batches/${encodeURIComponent(selectedBatchId)}/exports/reveal?projectId=${encodeURIComponent(projectId)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-creative-studio-action': 'reveal' },
        },
      ));
      setRevealFeedback({ kind: 'ok', message: '已请求系统打开文件夹' });
    } catch (revealError) {
      setRevealFeedback({ kind: 'error', message: revealError instanceof Error ? revealError.message : '打开文件夹失败' });
    } finally {
      setRevealBusy(false);
    }
  }

  // useCallback + 稳定的 previewInfos 依赖:轮询重渲染期间保持徽标引用稳定,
  // 避免素材卡因徽标变化而整卡重渲染(分析时的画面闪烁)。
  const renderPreviewBadge = useCallback((assetId: string) => {
    const info = previewInfos[assetId];
    if (!info) return null;
    if (info.kind === 'unavailable') {
      return <p className="text-xs text-fail">{info.warning ?? '预览不可用'}</p>;
    }
    const badges: Array<{ text: string; tone: string }> = [];
    if (info.kind === 'proxy') {
      badges.push({ text: '低清预览片', tone: 'bg-ok/10 text-ok' });
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
  }, [previewInfos]);

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

  const selectBatch = (batchId: string) => {
    setSelectedBatchId(batchId);
    setProxyTasks([]);
    setAssetPrepareTasks([]);
    analysisReloadedTaskIdsRef.current.clear();
    setSelectedScripts({});
    setSelectedAssets({});
    setOutputPlans([]);
    setBatchInputState(null);
    setFrozenScriptSnapshots([]);
    setBatchStatus(batches.find(({ id }) => id === batchId)?.status ?? 'draft');
    setInputConfirmed(false);
    setFeedback(null);
    setActiveStep(0);
  };

  const frozen = batchInputState === 'frozen';
  const visionProviderOptions = visionProviders.filter((provider) => provider.configured && provider.supportsVision);
  const visionProviderMissing = visionProviderOptions.length === 0;

  const changeVisionProvider = (providerId: string) => {
    setVisionProviderId(providerId);
    try { localStorage.setItem(visionProviderStorageKey(projectId), providerId); } catch { /* 隐私模式忽略 */ }
  };

  const overview = [
    { label: '已选素材', value: Object.keys(selectedAssets).length },
    { label: '脚本份数', value: selectedScriptEntries.length },
    { label: '目标成片', value: plannedCount, accent: true },
    { label: '已完成', value: workspace?.counts.publishable ?? 0 },
  ];

  const steps: MixcutStepDef[] = [
    { label: '准备素材', hint: '勾选素材·分析·调色', icon: 'folder', enabled: true },
    { label: '脚本与口播', hint: '份数·配音·确认锁定', icon: 'sparkle', enabled: true },
    { label: '检查成片', hint: '播放·重试·换画面', icon: 'play-circle', enabled: true },
    { label: '导出成片', hint: '正式导出·打开文件夹', icon: 'download', enabled: true },
  ];

  const outputPresetLabel: OutputPresetLabel = { id: outputPreset, label: OUTPUT_PRESET_LABELS[outputPreset] };
  // 检查成片的片段编辑预览用成片画幅 ID(3:4 → 3x4),与批量输出预设一一对应。
  const reviewOutputPreset = outputPreset.replace(':', 'x') as '3x4' | '9x16' | '16x9';

  return (
    <MixcutShell
      steps={steps}
      activeStep={activeStep}
      onStepSelect={(index) => setActiveStep(index as 0 | 1 | 2 | 3)}
      stepDisabled={(index) => (
        !selectedBatchId
        || (index === 1 && Object.keys(selectedAssets).length === 0)
        || (index === 2 && outputPlans.length === 0)
        || (index === 3 && (!workspace || workspace.cards.length === 0))
      )}
      stepsAriaLabel="批量生产步骤"
      topbarLeft={(
        <div className="flex min-w-0 flex-1 items-center gap-3 px-1">
          <strong className="truncate text-ink">{currentBatch?.name ?? '未选择批次'}</strong>
          {selectedBatchId && (
            <span className={`rounded-full px-2.5 py-0.5 text-[11px] ${batchStatus === 'running' ? 'bg-accent/10 text-accent' : batchStatus === 'failed' ? 'bg-fail/10 text-fail' : batchStatus === 'completed' ? 'bg-ok/10 text-ok' : 'bg-surface-subtle text-ink-secondary'}`}>
              {BATCH_STATUS_LABELS[batchStatus]}
            </span>
          )}
          {frozen && <span className="rounded-full bg-accent/10 px-2.5 py-0.5 text-[11px] text-accent">已锁定</span>}
        </div>
      )}
      topbarRight={(
        <>
          <span className={shellStyles.segLabel}>画幅</span>
          <span className={shellStyles.seg} role="group" aria-label="全局画幅">
            {(['3:4', '9:16', '16:9'] as const).map((preset) => (
              <button type="button" key={preset} className={outputPreset === preset ? shellStyles.segOn : ''} onClick={() => setOutputPreset(preset)}>{preset}</button>
            ))}
          </span>
        </>
      )}
      sidebar={(
        <div className="space-y-3">
          <div className={shellStyles.panel}>
            <h3 className="mb-2 flex items-center gap-2 text-[13px] font-semibold"><Icon name="plus" size={15} />新建批次</h3>
            <div className="flex gap-2">
              <input
                type="text"
                aria-label="新批次名称"
                value={newBatchName}
                onChange={(event) => setNewBatchName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && busy === null) void createBatch();
                }}
                placeholder="例如：8 月产品口播"
                className="h-9 min-w-0 flex-1 rounded-xl border border-hairline bg-surface px-3 text-sm text-ink"
              />
              <button
                type="button"
                className="btn-primary h-9 px-3 text-sm"
                disabled={busy !== null}
                onClick={() => void createBatch()}
              >{busy === 'create' ? '创建中…' : '创建'}</button>
            </div>
          </div>
          <BatchProductionSidebar
            batches={batches}
            selectedBatchId={selectedBatchId}
            onSelect={selectBatch}
            onArchive={(batchId, archived) => void archiveBatch(batchId, archived)}
            busy={busy !== null}
            overview={overview}
          />
        </div>
      )}
      previewActive={false}
      main={() => {
        const commonMain = (content: React.ReactNode) => (
          <main className={shellStyles.mainCol}>
            {feedback && (
              <div
                role={feedback.kind === 'error' ? 'alert' : 'status'}
                aria-live="polite"
                className={`mb-2 rounded-xl px-4 py-3 text-sm ${feedback.kind === 'error' ? 'bg-fail/10 text-fail' : 'bg-ok/10 text-ok'}`}
              >{feedback.message}</div>
            )}
            {/* 第 3、4 步:紧凑进度条置顶,保证“做的时候看得见”。
                脚本步(activeStep === 1)不置顶——「开始」按钮在该步内容栈底部,
                进度卡置顶会落在用户视线之外(实测:点完按钮看不到它,等滚上去
                语义打分已经跑完)。那一步的完整进度卡由 BatchStepScripts 渲染在
                自己的内容栈末尾,点开跑后由 scrollToProgressRef 滚进视野。
                注意:不要在 {content} 之后再挂同级节点——.mainCol 是 flex
                column,而各步根节点是 min-h-0 flex-1,会被压缩到容器高度、
                内容溢出并盖住后面的兄弟节点(表现为卡片叠在一起)。 */}
            {progressView && activeStep > 1 && (
              <div className="mb-4">
                <BatchProductionProgressCard
                  progress={progressView}
                  variant="compact"
                  controlState={workspace?.batch.controlState}
                  controlBusy={phaseEBusy !== null}
                  onControl={(action) => void controlBatch(action)}
                />
              </div>
            )}
            {content}
          </main>
        );
        if (activeStep === 0) {
          return commonMain(
            <BatchStepMaterials
              prep={prep}
              assetCards={assetCards}
              selectableAssets={selectableAssets}
              allSelectableAssetsSelected={allSelectableAssetsSelected}
              selectedAssets={selectedAssets}
              luts={luts}
              previewInfos={previewInfos}
              analysisBusy={analysisBusy}
              assetPrepareTasks={assetPrepareTasks}
              analysisTaskByAsset={analysisTaskByAsset}
              visionProviderId={visionProviderId}
              visionProviderOptions={visionProviderOptions}
              visionProviderMissing={visionProviderMissing}
              onVisionProviderChange={changeVisionProvider}
              onToggleSelectAllAssets={toggleSelectAllAssets}
              onToggleAsset={(assetId) => {
                const asset = assetCards.find((item) => item.id === assetId);
                if (!asset) return;
                markInputChanged();
                setSelectedAssets((current) => {
                  if (current[assetId]) {
                    return Object.fromEntries(Object.entries(current).filter(([id]) => id !== assetId));
                  }
                  if (asset.currentAnalysisId) {
                    return { ...current, [assetId]: { analysisId: asset.currentAnalysisId, lutId: null } };
                  }
                  return current;
                });
              }}
              onLutChange={(assetId, lutId) => {
                markInputChanged();
                setSelectedAssets((current) => (
                  current[assetId] ? { ...current, [assetId]: { ...current[assetId], lutId } } : current
                ));
              }}
              onAnalyzeContent={(assetIds) => void analyzeAssets(assetIds)}
              onRetryAnalyze={(taskId) => void retryAssetAnalysis(taskId)}
              onRequestProxy={(assetIds, busyMarker) => void requestProxies(assetIds, busyMarker)}
              onProxyControl={(taskId, action) => void controlProxyTask(taskId, action)}
              onProxyRetry={(taskId) => void retryProxyTask(taskId)}
              onCleanupProxies={(scope) => void cleanupProxies(scope)}
              onLutAction={(lutId, action) => void lutAction(lutId, action)}
              onImportLutFile={(file) => void importLutFile(file)}
              onResync={() => void load()}
              onPreviewAsset={openAssetPreview}
              onPreviewFrozenAsset={openPreparedAssetPreview}
              onToggleAssetExclusion={(assetId, excluded) => void toggleAssetExclusion(assetId, excluded)}
              onStartBatch={() => void startBatch()}
              onCreateVersionFromCurrent={() => {
                setBatchInputState('draft');
                setFrozenScriptSnapshots([]);
                setSelectedScripts({});
                setSelectedAssets({});
                setOutputPlans([]);
                setWorkspace(null);
                setSelectedPlanIds([]);
                setInputConfirmed(false);
                setActiveStep(0);
                setFeedback({ kind: 'success', message: '请选择当前项目输入并确认，新输入会形成批次新版本。' });
              }}
              renderPreviewBadge={renderPreviewBadge}
              frozen={frozen}
              hasConfirmedVersion={hasConfirmedVersion}
              inputConfirmed={inputConfirmed}
              workspace={workspace}
              proxyBusyAssetId={proxyBusyAssetId}
              proxyBatchBusy={proxyBatchBusy}
              cleanupBusy={cleanupBusy}
              cacheUsage={cacheUsage}
              lutImporting={lutImporting}
              phaseEBusy={phaseEBusy}
            />
          );
        }
        if (activeStep === 1) {
          return commonMain(
            <BatchStepScripts
              prep={prep}
              selectedScripts={selectedScripts}
              onToggleScript={(scriptId, selected) => {
                markInputChanged();
                setSelectedScripts((current) => {
                  if (selected) return { ...current, [scriptId]: current[scriptId] ?? 1 };
                  return Object.fromEntries(Object.entries(current).filter(([id]) => id !== scriptId));
                });
              }}
              onCopyCountChange={(scriptId, copyCount) => {
                markInputChanged();
                setSelectedScripts((current) => ({ ...current, [scriptId]: copyCount }));
              }}
              plannedCount={plannedCount}
              outputPreset={outputPresetLabel}
              frozen={frozen}
              frozenScriptSnapshots={frozenScriptSnapshots}
              busy={busy}
              outputPlans={outputPlans}
              batchStatus={batchStatus}
              ttsConfigured={ttsConfigured}
              ttsProviders={ttsProviders}
              bgmParams={bgmParams}
              bgmLibrary={bgmLibrary}
              bgmRescanning={bgmRescanning}
              bgmSelection={bgmSelection}
              onBgmParamsChange={(params) => {
                setBgmParams(params);
                markInputChanged();
              }}
              onRescanBgm={() => void rescanBgmLibrary()}
              onBgmSelectionChange={(selection) => {
                setBgmSelection(selection);
                markInputChanged();
              }}
              coverTitle={coverTitle}
              onCoverTitleChange={(draft) => {
                setCoverTitle(draft);
                markInputChanged();
              }}
              onNarrationConfigTouched={markInputChanged}
              onScriptCreated={handleScriptCreated}
              onScriptUpdated={handleScriptUpdated}
              onScriptDeleted={handleScriptDeleted}
              onConfirmSnapshot={() => void confirmSnapshot()}
              onStartBatch={() => void startBatch()}
              inputChangedWarning={!inputConfirmed && hasConfirmedVersion}
              progress={progressView}
              controlState={workspace?.batch.controlState}
              controlBusy={phaseEBusy !== null}
              onControlBatch={(action) => void controlBatch(action)}
            />
          );
        }
        if (activeStep === 2) {
          if (!workspace && outputPlans.length === 0) {
            return commonMain(<div className={shellStyles.emptyState}><strong>还没有成片</strong><span>先完成第 1、2 步确认并开始生产。</span></div>);
          }
          if (!workspace) {
            return commonMain(
              <section aria-label="成片计划">
                <div className="mb-3 flex items-end justify-between gap-3">
                  <div><h3 className="font-semibold text-ink">待生成成片</h3><p className="mt-1 text-sm text-ink-secondary">一张卡片对应一条目标成片，重试不会增加卡片数量。</p></div>
                  <strong className="text-sm text-ink">共 {outputPlans.length} 张</strong>
                </div>
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {outputPlans.map((plan, index) => (
                    <article key={plan.id} data-testid="batch-output-card" className="tile p-4">
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <p className="text-xs text-ink-tertiary">待生成成片</p>
                          <h4 className="mt-1 font-semibold text-ink">成片 {String(plan.seq || index + 1).padStart(2, '0')}</h4>
                        </div>
                        <span className={`rounded-full px-2 py-1 text-[11px] ${batchStatus === 'running' ? 'bg-accent/10 text-accent' : 'bg-surface-subtle text-ink-secondary'}`}>
                          {batchStatus === 'running' ? '等待调度' : BATCH_STATUS_LABELS[batchStatus]}
                        </span>
                      </div>
                    </article>
                  ))}
                </div>
              </section>,
            );
          }
          return commonMain(
            <BatchStepReview
              workspace={workspace}
              cardFilter={cardFilter}
              onCardFilterChange={setCardFilter}
              selectedPlanIds={selectedPlanIds}
              onTogglePlan={(planId, checked) => setSelectedPlanIds((current) => (
                checked ? [...new Set([...current, planId])] : current.filter((id) => id !== planId)
              ))}
              onSelectAll={() => {
                const selectable = (workspace?.cards ?? []).filter(({ publishable }) => publishable);
                const allSelected = selectable.length > 0 && selectable.every(({ planId }) => selectedPlanIds.includes(planId));
                setSelectedPlanIds(allSelected ? [] : selectable.map(({ planId }) => planId));
              }}
              onReview={(decision) => void reviewSelected(decision)}
              onChangeCover={(planId, timeUs) => void changeCover(planId, timeUs)}
              coverBusy={phaseEBusy?.startsWith('cover:') ? phaseEBusy.slice('cover:'.length) : null}
              phaseEBusy={phaseEBusy}
              onRetryRender={(taskId) => void retryRenderTask(taskId)}
              onRetryNarration={(taskId) => void retryNarrationTask(taskId)}
              onReallocate={(planId) => void reallocateOutput(planId)}
              onControlBatch={(action) => void controlBatch(action)}
              projectId={projectId}
              selectedBatchId={selectedBatchId}
              outputPreset={reviewOutputPreset}
              onOutputChanged={() => {
                // 片段编辑就地改当前版本并重渲染:刷新 workspace,卡片进入渲染中。
                if (selectedBatchId) void loadWorkspace(selectedBatchId);
              }}
              busy={busy}
              onStartBatch={() => void startBatch()}
            />
          );
        }
        return commonMain(
          <BatchStepExport
            workspace={workspace ?? { batch: { id: selectedBatchId, name: '', status: 'draft', controlState: 'stopped', currentVersionId: null }, phase: 'prepare_materials', exportDirName: '', counts: { total: 0, exportable: 0, publishable: 0, approved: 0, processing: 0, needsAttention: 0, failed: 0 }, cards: [], exclusions: [], allocationReport: null }}
            selectedPlanIds={selectedPlanIds}
            onTogglePlan={(planId, checked) => setSelectedPlanIds((current) => (
              checked ? [...new Set([...current, planId])] : current.filter((id) => id !== planId)
            ))}
            onSelectAll={() => {
              const selectable = (workspace?.cards ?? []).filter(({ publishable, approved, renderStale }) => publishable && approved && !renderStale);
              const allSelected = selectable.length > 0 && selectable.every(({ planId }) => selectedPlanIds.includes(planId));
              setSelectedPlanIds(allSelected ? [] : selectable.map(({ planId }) => planId));
            }}
            phaseEBusy={phaseEBusy}
            onPublish={() => void publishSelected()}
            onRevealFolder={() => void revealFolder()}
            revealAvailable={revealAvailable}
            revealBusy={revealBusy}
            revealFeedback={revealFeedback}
            folderRelativePath={folderRelativePath}
            projectId={projectId}
            selectedBatchId={selectedBatchId}
            productCode={prep.project.productCode}
          />
        );
      }}
    >
      {previewAsset && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="batch-asset-preview-title"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
        >
          <div className="w-full max-w-3xl rounded-2xl bg-surface p-4 shadow-xl">
            <div className="flex items-start justify-between gap-3">
              <div>
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
    </MixcutShell>
  );
}
