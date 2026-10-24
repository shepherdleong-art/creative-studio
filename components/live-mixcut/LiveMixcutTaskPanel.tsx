'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '@/components/ui/Icon';
import { requestPackagingExport } from '@/components/packaging/request-packaging-export';
import MixcutShell, { type MixcutStepDef } from '@/components/mixcut/MixcutShell';
import shellStyles from '@/components/mixcut/mixcut-shell.module.css';
import type { BatchSnapshotDetail } from '@/lib/live-mixcut/batch-flow';
import type { BatchProductionStatus } from '@/lib/live-mixcut/versions';
import type { BatchTasksView } from '@/lib/live-mixcut/tasks';
import type { BatchWorkspaceView } from '@/lib/live-mixcut/batch-workspace';
import type { BatchReviewTarget } from '@/lib/live-mixcut/review-context';
import type { BatchReviewWriteResult } from '@/lib/live-mixcut/review';
import type { LiveMixcutProject } from '@/lib/live-mixcut/projects';
import { batchExportElapsedSec } from '@/lib/live-mixcut/progress-summary';
import type { DesktopBridge } from '@/desktop/bridge-types';
import BatchProductionSidebar from './BatchProductionSidebar';
import BatchStepReview, { type CardFilter } from './BatchStepReview';
import BatchStepExport from './BatchStepExport';
import FormulaImportPanel, { type FormulaInputSummary } from './formula/FormulaImportPanel';
import FormulaGenerationProgressPanel from './formula/FormulaGenerationProgressPanel';

interface LiveMixcutTaskPanelProps {
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

/** 后端原始错误 → 用户可读文案。匹配用 includes，避免依赖完整字符串。 */
const EXPORT_SKIP_REASONS: Array<{ match: string; text: string }> = [
  { match: '重新渲染', text: '等待重新渲染完成' },
  { match: 'productionReady', text: '还没有配音' },
  { match: 'narration', text: '还没有配音' },
  { match: '口播尚未就绪', text: '口播尚未就绪，请先到检查页确认配音' },
  { match: '尚未审核通过', text: '尚未审核通过，请先到检查页点「通过」' },
  { match: '原片来源', text: '找不到原始素材文件' },
  { match: '内容指纹', text: '原始素材已被修改' },
  { match: 'LUT', text: '调色滤镜已丢失或被修改' },
  { match: '已存在', text: '成品文件已存在，不覆盖' },
  { match: '整片渲染失败', text: '整片渲染失败，请点「重试导出」或回检查页修改' },
  { match: '渲染期间成片内容已变化', text: '渲染期间内容被修改，请重新导出' },
  { match: '成片已被调整过', text: '成片已被调整，请重新导出' },
  { match: '封面已更换', text: '封面已更换，请重新导出' },
];

function humanizeSkipReason(reason: string | undefined): string {
  if (!reason) return '未知原因';
  const hit = EXPORT_SKIP_REASONS.find(({ match }) => reason.includes(match));
  return hit ? hit.text : '导出前检查未通过';
}

export default function LiveMixcutTaskPanel({ projectId }: LiveMixcutTaskPanelProps) {
  const [task, setTask] = useState<LiveMixcutProject | null>(null);
  const [selectedBatchId, setSelectedBatchId] = useState('');
  const [formulaSummary, setFormulaSummary] = useState<FormulaInputSummary | null>(null);
  const [outputPlans, setOutputPlans] = useState<Array<{ id: string; seq: number }>>([]);
  const [batchStatus, setBatchStatus] = useState<BatchProductionStatus>('draft');
  const [batchInputState, setBatchInputState] = useState<'draft' | 'frozen' | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  /** 选中项因编辑失效被 workspace 刷新移除(B4):按最新 card 状态列出失效原因,常驻可见。 */
  const [selectionDropped, setSelectionDropped] = useState<Array<{ planId: string; seq: number | null; title: string; reason: string }>>([]);
  /** 最近一次正式导出的结构化结果(B4):成功数、服务端跳过项、前端移除项分栏展示。 */
  const [exportResult, setExportResult] = useState<{
    published: number;
    skipped: Array<{ planId: string; seq: number | null; title: string; reason: string }>;
    removed: Array<{ planId: string; seq: number | null; title: string; reason: string }>;
  } | null>(null);
  const [batchTasks, setBatchTasks] = useState<BatchTasksView['tasks']>([]);

  const [workspace, setWorkspace] = useState<BatchWorkspaceView | null>(null);
  const [cardFilter, setCardFilter] = useState<CardFilter>('all');
  const [selectedPlanIds, setSelectedPlanIds] = useState<string[]>([]);
  // loadWorkspace 需要读当前选择做"失效移除"计算,又不希望它进 useCallback 依赖。
  const selectedPlanIdsRef = useRef<string[]>([]);
  useEffect(() => { selectedPlanIdsRef.current = selectedPlanIds; }, [selectedPlanIds]);
  // 导出流程滞留同页的渲染条目:轮询到全部成功后自动再调一次导出接口完成发布。
  const pendingAutoExportRef = useRef<string[]>([]);
  const publishPlansRef = useRef<(planIds: string[]) => Promise<void>>(async () => undefined);
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
      const { project } = await readJson<{ project: LiveMixcutProject }>(await fetch(
        `/api/live-mixcut/projects/${encodeURIComponent(projectId)}`,
        { cache: 'no-store' },
      ));
      setTask(project);
      setSelectedBatchId(project.batchId);
    } catch (loadError) {
      setTask(null);
      setSelectedBatchId('');
      setError(loadError instanceof Error ? loadError.message : '任务读取失败');
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  const loadBatchDetail = useCallback(async (batchId: string) => {
    try {
      const detail = await readJson<BatchSnapshotDetail>(await fetch(
        `/api/live-mixcut/batches/${encodeURIComponent(batchId)}?projectId=${encodeURIComponent(projectId)}`,
        { cache: 'no-store' },
      ));
      setBatchStatus(detail.batch.status);
      setBatchInputState(detail.version.inputState);
      setOutputPlans(detail.outputPlans);
    } catch (detailError) {
      setOutputPlans([]);
      setFeedback({
        kind: 'error',
        message: detailError instanceof Error ? detailError.message : '批次详情读取失败',
      });
    }
  }, [projectId]);

  const loadTasks = useCallback(async (batchId: string) => {
    if (!batchId) {
      setBatchTasks([]);
      return;
    }
    try {
      const view = await readJson<BatchTasksView>(await fetch(
        `/api/live-mixcut/batches/${encodeURIComponent(batchId)}/tasks?projectId=${encodeURIComponent(projectId)}`,
        { cache: 'no-store' },
      ));
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
        `/api/live-mixcut/batches/${encodeURIComponent(batchId)}/workspace?projectId=${encodeURIComponent(projectId)}`,
        { cache: 'no-store' },
      ));
      setWorkspace(view);
      setBatchStatus(view.batch.status);
      if (view.cards.length > 0) {
        setOutputPlans(view.cards.map(({ planId, seq }) => ({ id: planId, seq })));
      }
      // 画面/封面/字幕/BGM 编辑会清审核;即使编辑前已经勾选,也不能把旧选择
      // 静默带进下一次「通过」或正式导出。
      // B4：被移除的既有选择必须按最新 card 状态列出失效原因,不能静默减少"已选"。
      const currentSelected = selectedPlanIdsRef.current;
      const kept = currentSelected.filter((id) => view.cards.some(({ planId, reviewable }) => (
        planId === id && reviewable
      )));
      setSelectedPlanIds(kept);
      const removed = currentSelected.filter((id) => !kept.includes(id));
      if (removed.length > 0) {
        setSelectionDropped((previous) => {
          const existing = new Set(previous.map(({ planId }) => planId));
          const fresh = removed.filter((id) => !existing.has(id)).map((id) => {
            const card = view.cards.find(({ planId }) => planId === id);
            if (!card) return { planId: id, seq: null, title: '（未知成片）', reason: '该成片已不在当前批次' };
            return {
              planId: id,
              seq: card.seq,
              title: card.scriptTitle || '未命名脚本',
              reason: '该成片已不再可编辑（批次停止或还没有候选版本）',
            };
          });
          return [...previous, ...fresh];
        });
      }
    } catch {
      setWorkspace(null);
    }
  }, [projectId]);

  // 同页会话内:渲染中的导出条目全部成功后自动再调一次导出接口完成发布。
  // 关闭/刷新页面后服务端任务继续,但需要用户回到导出页再点一次「导出」。
  useEffect(() => {
    const pending = pendingAutoExportRef.current;
    if (pending.length === 0 || phaseEBusy !== null || !workspace) return;
    const cards = workspace.cards.filter((card) => pending.includes(card.planId));
    if (cards.length === 0) {
      pendingAutoExportRef.current = [];
      return;
    }
    if (cards.some((card) => card.fullRenderTask?.status === 'failed')) {
      pendingAutoExportRef.current = [];
      setFeedback({ kind: 'error', message: '渲染失败，已停止自动导出；请点「重试导出」或回检查成片修改。' });
      return;
    }
    if (cards.every((card) => card.fullRenderTask?.status === 'succeeded')) {
      pendingAutoExportRef.current = [];
      void publishPlansRef.current(pending);
    }
  }, [workspace, phaseEBusy]);

  useEffect(() => {
    const timer = window.setTimeout(() => { void load(); }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);

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

  // 任务轮询:进入批次时拉一次(与周期轮询彻底分开)。
  useEffect(() => {
    if (!selectedBatchId) return;
    const timer = window.setTimeout(() => void loadTasks(selectedBatchId), 0);
    return () => window.clearTimeout(timer);
  }, [selectedBatchId, loadTasks]);

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

  const currentVersionId = workspace?.batch.currentVersionId ?? null;
  const workspaceBatchId = workspace?.batch.id ?? null;

  // 新建任务还没有批次版本,详情接口会返回 409;必须等 workspace 报出
  // currentVersionId(含生成成功后刷新的 workspace)再拉,避免误报错误。
  useEffect(() => {
    if (!selectedBatchId) return;
    const timer = window.setTimeout(() => {
      if (workspaceBatchId !== selectedBatchId || !currentVersionId) {
        setOutputPlans([]);
        setBatchInputState(null);
        return;
      }
      void loadBatchDetail(selectedBatchId);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [currentVersionId, loadBatchDetail, selectedBatchId, workspaceBatchId]);

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

  async function retryRenderTask(taskId: string): Promise<void> {
    setPhaseEBusy(taskId);
    setFeedback(null);
    try {
      await readJson(await fetch(
        `/api/live-mixcut/tasks/${encodeURIComponent(taskId)}/retry?projectId=${encodeURIComponent(projectId)}`,
        { method: 'POST' },
      ));
      if (selectedBatchId) await loadWorkspace(selectedBatchId);
    } catch (retryError) {
      setFeedback({ kind: 'error', message: retryError instanceof Error ? retryError.message : '重试失败' });
    } finally {
      setPhaseEBusy(null);
    }
  }

  async function reviewPlans(items: BatchReviewTarget[], decision: 'approved' | 'rework' | 'cancelled'): Promise<boolean> {
    if (!selectedBatchId) return false;
    if (items.length === 0) {
      setFeedback({ kind: 'error', message: '请先选择要操作的成片。' });
      return false;
    }
    setPhaseEBusy(`review:${decision}`);
    setFeedback(null);
    try {
      const reviewResult = await readJson<BatchReviewWriteResult>(await fetch(
        `/api/live-mixcut/batches/${encodeURIComponent(selectedBatchId)}/outputs/review?projectId=${encodeURIComponent(projectId)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ items, decision }),
        },
      ));
      const failed = reviewResult.results.filter(item => item.status !== 'saved');
      const failures = failed.map(item => {
        const seq = workspace?.cards.find(card => card.planId === item.planId)?.seq;
        return `成片 ${seq ?? '已移除'}：${item.message || '未保存，请重新检查'}`;
      });
      await loadWorkspace(selectedBatchId);
      setSelectedPlanIds(current => [...new Set([
        ...current.filter(id => decision !== 'rework' || !reviewResult.planIds.includes(id)),
        ...failed.map(item => item.planId),
      ])]);
      const count = reviewResult.planIds.length;
      const savedMessage = decision === 'approved' ? `已确认 ${count} 条成片。`
        : decision === 'rework' ? `已标记返工 ${count} 条，请在当前成片中调整，或明确重新选片。`
        : `已撤销 ${count} 条成片的确认。`;
      setFeedback({
        kind: failures.length ? 'error' : 'success',
        message: `${savedMessage}${failed.length ? ` ${failed.length} 条未保存，保留待检查。` : ''}${failures.length ? ` ${failures.join('；')}` : ''}`,
      });
      return failures.length === 0;
    } catch (reviewError) {
      setFeedback({ kind: 'error', message: reviewError instanceof Error ? reviewError.message : '审核操作失败' });
      return false;
    } finally {
      setPhaseEBusy(null);
    }
  }

  async function publishPlans(planIds: string[]): Promise<void> {
    const uniquePlanIds = [...new Set(planIds)];
    if (!selectedBatchId || uniquePlanIds.length === 0) {
      setFeedback({ kind: 'error', message: '请先勾选要正式导出的成片。' });
      return;
    }
    setPhaseEBusy('export');
    setFeedback(null);
    setExportResult(null);
    try {
      const response = await requestPackagingExport(
        `/api/live-mixcut/batches/${encodeURIComponent(selectedBatchId)}/exports?projectId=${encodeURIComponent(projectId)}`,
        { planIds: uniquePlanIds },
      );
      if (!response) { pendingAutoExportRef.current = []; return; }
      const result = await readJson<{
        published: number;
        alreadyPublished?: number;
        pending: number;
        failed: number;
        skipped: number;
        items: Array<{
          planId: string;
          status: 'skipped' | 'render_queued' | 'rendering' | 'render_failed' | 'already_published' | 'published';
          reason?: string;
          taskId?: string;
          videoRelativePath?: string;
        }>;
      }>(response);
      const cardsById = new Map((workspace?.cards ?? []).map((card) => [card.planId, card]));
      const describe = (planId: string): { seq: number | null; title: string } => {
        const card = cardsById.get(planId);
        return { seq: card?.seq ?? null, title: card?.scriptTitle || '未命名脚本' };
      };
      const skipped = result.items
        .filter(({ status }) => status === 'skipped' || status === 'render_failed')
        .map(({ planId, reason }) => ({
          planId,
          ...describe(planId),
          reason: humanizeSkipReason(reason),
        }));
      const removed = selectionDropped;
      setExportResult({ published: result.published, skipped, removed });
      // 幂等命中也是「已导出」:重复点导出与首次成功同反馈,而不是「已导出 0 条」。
      const exportedTotal = result.published + (result.alreadyPublished ?? 0);
      if (result.pending > 0) {
        // 渲染中的条目滞留同一页面:轮询到全部成功后自动再调一次导出完成发布。
        pendingAutoExportRef.current = [...new Set([
          ...pendingAutoExportRef.current,
          ...result.items
            .filter(({ status }) => status === 'render_queued' || status === 'rendering')
            .map(({ planId }) => planId),
        ])];
      } else {
        pendingAutoExportRef.current = [];
      }
      setFeedback({
        kind: exportedTotal > 0 ? 'success' : result.failed > 0 ? 'error' : result.pending > 0 ? 'success' : 'error',
        message: result.pending > 0
          ? `已开始渲染 ${result.pending} 条成片并跳过 ${result.skipped} 条，渲染完成后自动导出（关闭或刷新页面后需再点一次导出）。`
          : `已导出 ${exportedTotal} 条${result.failed > 0 ? ` · 渲染失败 ${result.failed} 条` : ''}${result.skipped > 0 ? ` · 跳过 ${result.skipped} 条` : ''}${removed.length > 0 ? ` · 取消选择 ${removed.length} 条` : ''}`,
      });
      const exported = result.items.find(({ status }) => status === 'published');
      if (exported?.videoRelativePath) {
        const folder = exported.videoRelativePath.replace(/\\/g, '/').split('/').slice(0, -1).join('/');
        setFolderRelativePath(`storage/${folder}`);
      } else {
        setFolderRelativePath(null);
      }
      if (result.pending === 0 && result.failed === 0) {
        setSelectedPlanIds([]);
        setSelectionDropped([]);
      }
      await loadWorkspace(selectedBatchId);
    } catch (publishError) {
      pendingAutoExportRef.current = [];
      setFeedback({ kind: 'error', message: publishError instanceof Error ? publishError.message : '正式导出失败' });
    } finally {
      setPhaseEBusy(null);
    }
  }

  async function publishSelected(): Promise<void> {
    await publishPlans(selectedPlanIds);
  }

  useEffect(() => {
    publishPlansRef.current = publishPlans;
  });

  async function retryExportRender(planId: string, taskId: string): Promise<void> {
    setPhaseEBusy(`export:${taskId}`);
    setFeedback(null);
    try {
      await readJson(await fetch(
        `/api/live-mixcut/tasks/${encodeURIComponent(taskId)}/retry?projectId=${encodeURIComponent(projectId)}`,
        { method: 'POST' },
      ));
      await loadWorkspace(selectedBatchId);
      // 重新排队后直接为该计划再发起一次导出编排,让流程继续。
      // 不用 selectedPlanIds:刷新页面后选择集为空,重试必须仍能完成发布。
      await publishPlans([planId]);
    } catch (retryError) {
      setFeedback({ kind: 'error', message: retryError instanceof Error ? retryError.message : '重试导出失败' });
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
        `/api/live-mixcut/batches/${encodeURIComponent(selectedBatchId)}/control?projectId=${encodeURIComponent(projectId)}`,
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
        const result = await bridge.openFolder(`storage/live-mixcut/exports/${exportDirName}/成片`);
        if (result.opened) {
          setRevealFeedback({ kind: 'ok', message: '已请求系统打开文件夹' });
        } else {
          setRevealFeedback({ kind: 'error', message: result.message ?? '打开文件夹失败' });
        }
        return;
      }
      await readJson(await fetch(
        `/api/live-mixcut/batches/${encodeURIComponent(selectedBatchId)}/exports/reveal?projectId=${encodeURIComponent(projectId)}`,
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

  if (loading) {
    return <div className="card p-8 text-center text-sm text-ink-secondary">正在读取任务…</div>;
  }

  if (error) {
    return (
      <section className="card p-6">
        <h2 className="font-semibold text-ink">任务暂不可用</h2>
        <p className="mt-2 text-sm text-fail">{error}</p>
        <button type="button" className="btn-secondary mt-4" onClick={() => void load()}>重新检查</button>
      </section>
    );
  }

  if (!task) return null;

  const frozen = batchInputState === 'frozen';
  const formulaGeneration = workspace?.batch.id === selectedBatchId ? workspace.formulaGeneration : null;
  const formulaInputRevisionOpen = !!formulaGeneration?.inputRevisionOpen;
  const formulaStatusLabel = formulaGeneration
    ? formulaInputRevisionOpen ? '准备下一轮' : workspace?.batch.controlState === 'stopped' ? '已停止' : workspace?.batch.controlState === 'paused' ? '已暂停'
      : formulaGeneration.pending ? '制作中' : formulaGeneration.finished ? '可审片'
        : formulaGeneration.ready ? '部分就绪' : '需处理'
    : undefined;
  const overview = [
    { label: '已导入文件', value: formulaSummary?.batchId === selectedBatchId ? formulaSummary.videoSources : '—' },
    { label: '已导入脚本', value: formulaSummary?.batchId === selectedBatchId ? formulaSummary.scripts : '—' },
    { label: '目标成片', value: formulaGeneration?.total ?? '待生成', accent: true },
    { label: '可审片', value: formulaGeneration?.ready ?? 0 },
  ];

  const steps: MixcutStepDef[] = [
    { label: '准备素材', hint: '视频·素材表·原声', icon: 'folder', enabled: true },
    { label: '脚本与口播', hint: '脚本·配音·生成', icon: 'sparkle', enabled: true },
    { label: '检查成片', hint: '播放·重试·换画面', icon: 'play-circle', enabled: true },
    { label: '导出成片', hint: '正式导出·打开文件夹', icon: 'download', enabled: true },
  ];

  // 公式模式固定 3:4 输出（卡11 才引入可配置默认）,审片画幅 ID 与之一一对应。
  const reviewOutputPreset = '3x4' as const;
  const formulaProgress = workspace && formulaGeneration
    ? <FormulaGenerationProgressPanel progress={formulaGeneration} controlState={workspace.batch.controlState} compact={activeStep === 2}
      busy={phaseEBusy !== null} onControl={action => void controlBatch(action)} onRetry={taskId => void retryRenderTask(taskId)} onReview={() => setActiveStep(2)} /> : null;

  return (
    <MixcutShell
      steps={steps}
      activeStep={activeStep}
      onStepSelect={(index) => setActiveStep(index as 0 | 1 | 2 | 3)}
      stepDisabled={(index) => (
        (index >= 2 && !selectedBatchId)
        || (index === 2 && outputPlans.length === 0)
        || (index === 3 && (!workspace || workspace.cards.length === 0))
      )}
      stepsAriaLabel="实拍混剪步骤"
      collapseSidebarOnStep={2}
      pageScrollOnStep={2}
      stepsInTopbar
      dataAttributes={{ 'data-batch': '1' }}
      topbarLeft={(
        <div className="flex min-w-0 flex-1 items-center gap-3 px-1">
          <strong className="truncate text-ink">{task.name}</strong>
          <span className="shrink-0 text-xs text-ink-secondary">实拍公式混剪</span>
          {selectedBatchId && (
            <span className={`rounded-full px-2.5 py-0.5 text-[11px] ${batchStatus === 'running' ? 'bg-accent/10 text-accent' : batchStatus === 'failed' ? 'bg-fail/10 text-fail' : batchStatus === 'completed' ? 'bg-ok/10 text-ok' : 'bg-surface-subtle text-ink-secondary'}`}>
              {formulaStatusLabel ?? BATCH_STATUS_LABELS[batchStatus]}
            </span>
          )}
          {frozen && !formulaInputRevisionOpen && <span className="rounded-full bg-accent/10 px-2.5 py-0.5 text-[11px] text-accent">已锁定</span>}
        </div>
      )}
      sidebar={(
        <BatchProductionSidebar
          taskName={task?.name ?? '实拍混剪'}
          overview={overview}
        />
      )}
      previewActive={false}
      main={() => {
        const commonMain = (content: React.ReactNode) => (
          <main className={shellStyles.mainCol}>
            {feedback && (
              <div
                role={feedback.kind === 'error' ? 'alert' : 'status'}
                aria-live="polite"
                className={`mb-2 flex items-start gap-2 rounded-xl px-4 py-3 text-sm ${feedback.kind === 'error' ? 'bg-fail/10 text-fail' : 'bg-ok/10 text-ok'}`}
              >
                <span className="min-w-0 flex-1">{feedback.message}</span>
                <button
                  type="button"
                  aria-label="关闭提示"
                  className="shrink-0 opacity-60 transition-opacity hover:opacity-100"
                  onClick={() => setFeedback(null)}
                ><Icon name="close" size={14} /></button>
              </div>
            )}
            {/* B4：选中项失效列表——编辑后 workspace 刷新移除的既有选择,常驻可见,不静默消失。 */}
            {selectionDropped.length > 0 && (
              <div className="mb-2 rounded-xl border border-hairline bg-surface p-4 text-sm" role="status">
                <p className="font-medium text-warn">以下成片已取消选择：{selectionDropped.length} 条</p>
                <ul className="mt-1 space-y-1 text-xs text-warn">
                  {selectionDropped.map((item) => (
                    <li key={`drop-${item.planId}`}>
                      成片 {item.seq != null ? String(item.seq).padStart(2, '0') : '--'} · {item.title}：{item.reason}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {/* B4：正式导出结构化结果——成功数、服务端跳过项、前端取消项分栏展示。 */}
            {exportResult && (
              <div className="mb-2 rounded-xl border border-hairline bg-surface p-4 text-sm" role="status">
                <p className="font-medium text-ink">导出结果：成功 {exportResult.published} 条{exportResult.skipped.length > 0 ? ` · 跳过 ${exportResult.skipped.length} 条` : ''}{exportResult.removed.length > 0 ? ` · 已取消 ${exportResult.removed.length} 条` : ''}</p>
                {exportResult.skipped.length > 0 && (
                  <ul className="mt-1 space-y-1 text-xs text-warn">
                    {exportResult.skipped.map((item) => (
                      <li key={`skip-${item.planId}`}>
                        成片 {item.seq != null ? String(item.seq).padStart(2, '0') : '--'} · {item.title}：{item.reason}
                      </li>
                    ))}
                  </ul>
                )}
                {exportResult.removed.length > 0 && (
                  <ul className="mt-1 space-y-1 text-xs text-warn">
                    {exportResult.removed.map((item) => (
                      <li key={`removed-${item.planId}`}>
                        成片 {item.seq != null ? String(item.seq).padStart(2, '0') : '--'} · {item.title}：{item.reason}（已取消勾选）
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
            {/* 公式制作进度只在第 3 步置顶展示；检查成片步在批次全部完成且无失败后收起。
                注意:不要在 {content} 之后再挂同级节点——.mainCol 是 flex column,
                而各步根节点是 min-h-0 flex-1,会被压缩到容器高度、内容溢出并盖住
                后面的兄弟节点(表现为卡片叠在一起)。 */}
            {activeStep === 2 && formulaProgress && !formulaGeneration?.finished && <div className="mb-2 shrink-0">{formulaProgress}</div>}
            {activeStep === 3 && (() => {
              const elapsedSec = batchExportElapsedSec(batchTasks, nowMs);
              const cards = workspace?.cards ?? [];
              const rendering = cards.some(card => card.exportStatus === 'rendering');
              const failed = cards.some(card => card.exportStatus === 'failed');
              const exported = cards.some(card => card.exportStatus === 'exported');
              const status = rendering ? '导出中' : failed ? '导出失败' : exported ? '已完成' : '尚未导出';
              return (
                <section className="card mb-2 shrink-0 p-4" aria-label="导出用时">
                  <h3 className="text-sm font-semibold text-ink">导出用时</h3>
                  <p className="mt-1 text-xs text-ink-secondary">
                    {status} · 累计 {Math.floor(elapsedSec / 60)} 分 {elapsedSec % 60} 秒
                  </p>
                  <p className="mt-1 text-xs text-ink-tertiary">仅统计实际导出时间，不含准备与审片等待。</p>
                </section>
              );
            })()}
            {content}
          </main>
        );
        if (activeStep < 2) {
          return commonMain(
            <FormulaImportPanel key={`${selectedBatchId}:${activeStep}`} projectId={projectId} batchId={selectedBatchId} step={activeStep === 1 ? 1 : 0} onSummary={setFormulaSummary}
              progress={formulaProgress} readOnly={frozen || !!formulaGeneration} onInputRevised={() => loadWorkspace(selectedBatchId)} onGenerated={async () => {
                setBatchStatus('running');
                await Promise.all([loadBatchDetail(selectedBatchId), loadTasks(selectedBatchId), loadWorkspace(selectedBatchId)]);
              }} />,
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
              onTogglePlan={(planId, checked) => {
                setSelectionDropped([]);
                setSelectedPlanIds((current) => (
                  checked ? [...new Set([...current, planId])] : current.filter((id) => id !== planId)
                ));
              }}
              onSelectAll={() => {
                const selectable = (workspace?.cards ?? []).filter(({ approvable }) => approvable);
                const allSelected = selectable.length > 0 && selectable.every(({ planId }) => selectedPlanIds.includes(planId));
                setSelectionDropped([]);
                setSelectedPlanIds(allSelected ? [] : selectable.map(({ planId }) => planId));
              }}
              onReviewPlans={reviewPlans}
              phaseEBusy={phaseEBusy}
              onRetryRender={(taskId) => void retryRenderTask(taskId)}
              onRetryNarration={() => {}}
              onReallocate={() => {}}
              projectId={projectId}
              selectedBatchId={selectedBatchId}
              outputPreset={reviewOutputPreset}
              onOutputChanged={() => {
                // 编辑只保存;刷新 workspace 让封面/审核/导出状态即时更新。
                if (selectedBatchId) void loadWorkspace(selectedBatchId);
              }}
              busy={null}
              onStartBatch={() => {}}
            />,
          );
        }
        return commonMain(
          <BatchStepExport
            formulaMode
            workspace={workspace ?? { batch: { id: selectedBatchId, name: '', status: 'draft', controlState: 'stopped', currentVersionId: null }, phase: 'prepare_materials', exportDirName: '', counts: { total: 0, reviewable: 0, approvable: 0, approved: 0, processing: 0, needsAttention: 0, failed: 0 }, cards: [], exclusions: [], allocationReport: null }}
            selectedPlanIds={selectedPlanIds}
            onTogglePlan={(planId, checked) => {
              setSelectionDropped([]);
              setSelectedPlanIds((current) => (
                checked ? [...new Set([...current, planId])] : current.filter((id) => id !== planId)
              ));
            }}
            onSelectAll={() => {
              const selectable = (workspace?.cards ?? []).filter(({ exportEligible }) => exportEligible);
              const allSelected = selectable.length > 0 && selectable.every(({ planId }) => selectedPlanIds.includes(planId));
              setSelectionDropped([]);
              setSelectedPlanIds(allSelected ? [] : selectable.map(({ planId }) => planId));
            }}
            phaseEBusy={phaseEBusy}
            onPublish={() => void publishSelected()}
            onRetryExport={(planId, taskId) => void retryExportRender(planId, taskId)}
            onGoReview={() => setActiveStep(2)}
            onRevealFolder={() => void revealFolder()}
            revealAvailable={revealAvailable}
            revealBusy={revealBusy}
            revealFeedback={revealFeedback}
            folderRelativePath={folderRelativePath}
            projectId={projectId}
            selectedBatchId={selectedBatchId}
            productCode={task?.productName ?? ''}
          />,
        );
      }}
    />
  );
}
