'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { BatchPreparationResult } from '@/lib/batch-production/prepare';
import type { BatchSnapshotDetail, BatchSnapshotResult } from '@/lib/batch-production/batch-flow';
import type { BatchProductionRow, BatchProductionStatus } from '@/lib/batch-production/versions';
import {
  BatchAssetSelectionCard,
  BatchFrozenScriptCard,
  BatchScriptSelectionCard,
} from './BatchInputSelectionCards';

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

export default function BatchPreparationPanel({ projectId }: BatchPreparationPanelProps) {
  const [preparation, setPreparation] = useState<BatchPreparationResult | null>(null);
  const [batches, setBatches] = useState<BatchListItem[]>([]);
  const [selectedBatchId, setSelectedBatchId] = useState('');
  const [newBatchName, setNewBatchName] = useState('');
  const [selectedScripts, setSelectedScripts] = useState<Record<string, number>>({});
  const [selectedAssets, setSelectedAssets] = useState<Record<string, string>>({});
  const [outputPlans, setOutputPlans] = useState<Array<{ id: string; seq: number }>>([]);
  const [batchStatus, setBatchStatus] = useState<BatchProductionStatus>('draft');
  const [batchInputState, setBatchInputState] = useState<'draft' | 'frozen' | null>(null);
  const [frozenScriptSnapshots, setFrozenScriptSnapshots] = useState<BatchSnapshotDetail['scriptSnapshots']>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<'create' | 'snapshot' | 'start' | null>(null);
  const [error, setError] = useState('');
  const [feedback, setFeedback] = useState<Feedback | null>(null);

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
      setSelectedAssets(Object.fromEntries(detail.assetPool.map(({ assetId, analysisId }) => [assetId, analysisId])));
      setFrozenScriptSnapshots(detail.version.inputState === 'frozen' ? detail.scriptSnapshots : []);
    } catch (detailError) {
      setOutputPlans([]);
      setFeedback({
        kind: 'error',
        message: detailError instanceof Error ? detailError.message : '批次详情读取失败',
      });
    }
  }, [batches, projectId]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  useEffect(() => {
    if (!selectedBatchId) return;
    const timer = window.setTimeout(() => void loadBatchDetail(selectedBatchId), 0);
    return () => window.clearTimeout(timer);
  }, [loadBatchDetail, selectedBatchId]);

  const selectedScriptEntries = useMemo(() => Object.entries(selectedScripts), [selectedScripts]);
  const plannedCount = useMemo(
    () => selectedScriptEntries.reduce((sum, [, copyCount]) => sum + copyCount, 0),
    [selectedScriptEntries],
  );

  function markInputChanged(): void {
    setOutputPlans([]);
    setFeedback(null);
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
    const assetSelections = Object.entries(selectedAssets).map(([assetId, analysisId]) => ({ assetId, analysisId }));
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
      if (result.inputState === 'frozen') {
        await loadBatchDetail(selectedBatchId);
        setFeedback({ kind: 'success', message: '整体输入没有变化，继续使用已冻结的批次版本。' });
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
      setFeedback({ kind: 'success', message: `已确认 ${result.totalPlans} 张成片计划` });
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

  const onlineAssets = preparation.assets.filter(({ status }) => status === 'online').length;
  const selectableAssets = preparation.assets.filter(({ status, currentAnalysisId }) => status === 'online' && currentAnalysisId).length;
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
        <div className="tile p-4"><p className="text-xs text-ink-tertiary">项目脚本</p><strong className="mt-1 block text-2xl text-ink">{preparation.scripts.length}</strong></div>
        <div className="tile p-4"><p className="text-xs text-ink-tertiary">项目素材</p><strong className="mt-1 block text-2xl text-ink">{preparation.assets.length}</strong></div>
        <div className="tile p-4"><p className="text-xs text-ink-tertiary">当前在线</p><strong className="mt-1 block text-2xl text-ok">{onlineAssets}</strong></div>
        <div className="tile p-4"><p className="text-xs text-ink-tertiary">可入池素材</p><strong className="mt-1 block text-2xl text-ok">{selectableAssets}</strong></div>
      </div>

      {preparation.warnings.length > 0 && (
        <div className="rounded-2xl border border-warn/30 bg-warn-tint p-4 text-sm text-ink-secondary">
          <p className="font-medium text-ink">需要留意</p>
          <ul className="mt-2 list-disc space-y-1 pl-5">{preparation.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>
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
              <p className="mt-1 text-sm text-ink-secondary">以下正文、标题、份数和素材分析版本来自开跑快照，不随项目当前内容变化。</p>
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
              {Object.entries(selectedAssets).map(([assetId, analysisId]) => (
                <li key={assetId}>素材 {assetId.slice(0, 8)} · 分析版本 {analysisId.slice(0, 8)}</li>
              ))}
            </ul>
          </div>
        </section>
      ) : (
        <>
          <section>
            <div className="mb-3 flex items-end justify-between gap-3">
              <div><h3 className="font-semibold text-ink">项目脚本</h3><p className="mt-1 text-sm text-ink-secondary">选择本批次使用的脚本，并为每份设置生成份数。</p></div>
              <span className="text-sm text-ink-secondary">已选 {selectedScriptEntries.length} 份 · 计划 {plannedCount} 条</span>
            </div>
            {preparation.scripts.length > 0
              ? <div className="grid gap-3 lg:grid-cols-2">{preparation.scripts.map((script) => (
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
            {preparation.assets.length > 0
              ? <div className="grid gap-3 lg:grid-cols-2">{preparation.assets.map((asset) => (
                <BatchAssetSelectionCard
                  key={asset.id}
                  asset={asset}
                  selected={selectedAssets[asset.id] !== undefined}
                  onSelectedChange={(selected) => {
                    markInputChanged();
                    setSelectedAssets((current) => {
                      if (selected && asset.currentAnalysisId) return { ...current, [asset.id]: asset.currentAnalysisId };
                      return Object.fromEntries(Object.entries(current).filter(([id]) => id !== asset.id));
                    });
                  }}
                />
              ))}</div>
              : <div className="tile p-6 text-sm text-ink-secondary">暂无可用视频素材，请先在第 4 步完成视频生成。</div>}
          </section>

          <section className="card space-y-4 p-5" aria-label="批次确认与开始">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div>
                <h3 className="font-semibold text-ink">确认整体输入</h3>
                <p className="mt-1 text-sm text-ink-secondary">将 {selectedScriptEntries.length} 份脚本、{Object.keys(selectedAssets).length} 条素材与 {plannedCount} 条成片计划作为可检查的 draft 快照；点击开始时再同步最新脚本并冻结。</p>
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
        Phase B 确认时建立可检查的 draft 快照，开始时同步最新项目脚本并冻结当前版本；持久调度、真实进度、暂停与恢复属于 Phase C。
      </footer>
    </section>
  );
}
