'use client';

import { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import { useParams, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import JobQueueTable from '@/components/JobQueueTable';
import ResultGallery, { RegeneratePayload } from '@/components/ResultGallery';
import SceneReferencePanel from '@/components/SceneReferencePanel';
import ShotSetPanel from '@/components/ShotSetPanel';
import ImagePickerGrid, { ImagePickerItem } from '@/components/ImagePickerGrid';
import ScriptPanel from '@/components/ScriptPanel';
import VideoGenerationPanel from '@/components/VideoGenerationPanel';
import AssetUploadGrid, { AssetGridItem } from '@/components/AssetUploadGrid';
import ProjectWorkbenchTabs, { WorkbenchTabId } from '@/components/ProjectWorkbenchTabs';
import LogDrawer from '@/components/LogDrawer';

interface Project {
  id: string;
  name: string;
  providerId: string;
  model: string;
  prompt: string;
  status: string;
  concurrency: number;
  maxAttempts: number;
  timeoutMs?: number;
  workflowType?: string;
  scenePrompt?: string;
  shotPrompt?: string;
  images: ImageAsset[];
  jobs: Job[];
  provider: { name: string } | null;
}

interface ImageAsset {
  id: string;
  role: string;
  filename: string;
  path: string;
  imageUrl?: string;
  usage?: string;
}

interface Job {
  id: string;
  inputFilename: string;
  outputFilename?: string;
  status: string;
  attempt: number;
  maxAttempts: number;
  latencyMs?: number;
  estimatedCost?: number;
  errorMessage?: string;
  outputImageId?: string;
  inputImageId?: string;
  prompt?: string;
  parentJobId?: string;
  revision?: number;
  reviewMark?: string;
}

const STATUS_LABELS: Record<string, string> = {
  draft: '草稿',
  running: '运行中',
  completed: '已完成',
  partial_failed: '部分失败',
  canceled: '已取消',
  needs_check: '待补抓',
};

const WORKBENCH_TABS: WorkbenchTabId[] = ['scene', 'storyboard', 'script', 'video'];

function parseWorkbenchTab(value: string | null): WorkbenchTabId {
  return WORKBENCH_TABS.includes(value as WorkbenchTabId) ? (value as WorkbenchTabId) : 'scene';
}

function toAssetGridItem(img: ImageAsset): AssetGridItem {
  return { id: img.id, filename: img.filename, imageUrl: img.imageUrl, role: img.role, usage: img.usage };
}

export default function ProjectDetailPage() {
  const params = useParams();
  const searchParams = useSearchParams();
  const id = params.id as string;
  const activeTab = parseWorkbenchTab(searchParams.get('tab'));

  type QueueStatus = 'idle' | 'running' | 'paused';

  const [project, setProject] = useState<Project | null>(null);
  const [loading, setLoading] = useState(true);
  const [queueStatus, setQueueStatus] = useState<QueueStatus>('idle');
  const running = queueStatus === 'running';
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [sceneRefModal, setSceneRefModal] = useState<{ jobId: string; imageAssetId: string } | null>(null);
  const [sceneRefName, setSceneRefName] = useState('');
  const [editingShotPrompt, setEditingShotPrompt] = useState(false);
  const editingShotPromptRef = useRef(false);
  const [shotPromptDraft, setShotPromptDraft] = useState('');
  const [sceneRefs, setSceneRefs] = useState<Array<{
    id: string; name: string; imageAssetId: string; imageFilename: string; status: string;
  }>>([]);
  const [applySceneModal, setApplySceneModal] = useState<string | null>(null);
  const [applySceneRefId, setApplySceneRefId] = useState('');
  const [applyScenePrompt, setApplyScenePrompt] = useState('图1 是待编辑分镜图。图2 是场景参考图。请参考图2的空间风格、光线、墙面、软装和布置，重绘图1的场景。保持图1中的产品结构、模特姿态、主体位置和画面构图尽量一致。不要改变产品结构，不要添加文字。');
  const [logOpen, setLogOpen] = useState(false);
  const [selectedSceneSeedIds, setSelectedSceneSeedIds] = useState<string[]>([]);
  const [selectedShotSourceIds, setSelectedShotSourceIds] = useState<string[]>([]);
  const [shotSetRefreshKey, setShotSetRefreshKey] = useState(0);

  const loadProject = useCallback(async () => {
    try {
      const res = await fetch(`/api/projects/${id}`);
      const data = await res.json();
      if (data.error) {
        console.error(data.error);
        return;
      }
      setProject(data);
      if (!editingShotPromptRef.current) setShotPromptDraft(data.shotPrompt || '');

      const queueRes = await fetch(`/api/projects/${id}/run`);
      const queueData = await queueRes.json();
      setQueueStatus((queueData.queueStatus || 'idle') as QueueStatus);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    const timer = window.setTimeout(() => { void loadProject(); }, 0);
    return () => window.clearTimeout(timer);
  }, [loadProject]);
  useEffect(() => { editingShotPromptRef.current = editingShotPrompt; }, [editingShotPrompt]);

  useEffect(() => {
    if (queueStatus === 'idle') return;
    const interval = setInterval(loadProject, 2000);
    return () => clearInterval(interval);
  }, [queueStatus, loadProject]);

  const sceneSeedImages = useMemo(
    () => (project?.images || []).filter((img) => img.role === 'input' && img.usage === 'scene_seed').map(toAssetGridItem),
    [project]
  );
  const shotSourceImages = useMemo(
    () => (project?.images || []).filter((img) => img.role === 'input' && img.usage === 'shot_source').map(toAssetGridItem),
    [project]
  );

  const sceneJobs = useMemo(
    () => (project?.jobs || []).filter((j) => {
      const img = (project?.images || []).find((i) => i.id === j.inputImageId);
      return img?.usage === 'scene_seed';
    }),
    [project]
  );
  const shotJobs = useMemo(
    () => (project?.jobs || []).filter((j) => {
      const img = (project?.images || []).find((i) => i.id === j.inputImageId);
      return img?.usage === 'shot_source';
    }),
    [project]
  );


  const validSelectedSceneSeedIds = useMemo(
    () => selectedSceneSeedIds.filter((assetId) => sceneSeedImages.some((img) => img.id === assetId)),
    [selectedSceneSeedIds, sceneSeedImages]
  );
  const validSelectedShotSourceIds = useMemo(
    () => selectedShotSourceIds.filter((assetId) => shotSourceImages.some((img) => img.id === assetId)),
    [selectedShotSourceIds, shotSourceImages]
  );

  const handleAction = async (action: string) => {
    setActionLoading(action);
    try {
      const res = await fetch(`/api/projects/${id}/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, timeoutMs: project?.timeoutMs }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        alert(data.error || `操作失败: ${res.status}`);
        return;
      }
      if (action === 'start' || action === 'resume') setQueueStatus('running');
      if (action === 'pause') setQueueStatus('paused');
      if (action === 'cancel') setQueueStatus('idle');
      await loadProject();
    } catch (err) {
      alert('操作失败: ' + String(err));
    } finally {
      setActionLoading(null);
    }
  };

  const handleRetry = async (jobId: string) => {
    const job = project?.jobs.find((j) => j.id === jobId);
    if (job?.status === 'needs_check') await fetch(`/api/jobs/${jobId}/resume-poll`, { method: 'POST' });
    else await fetch(`/api/jobs/${jobId}/retry`, { method: 'POST' });
    await loadProject();
  };

  const handleMark = async (jobId: string, mark: string) => {
    await fetch(`/api/jobs/${jobId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mark }),
    });
    await loadProject();
  };

  const ensureQueueRunning = async (): Promise<boolean> => {
    const statusRes = await fetch(`/api/projects/${id}/run`);
    const statusData = await statusRes.json().catch(() => ({}));
    const currentStatus = (statusData.queueStatus || queueStatus || 'idle') as QueueStatus;

    if (currentStatus === 'running') {
      setQueueStatus('running');
      return true;
    }

    const action = currentStatus === 'paused' ? 'resume' : 'start';
    const res = await fetch(`/api/projects/${id}/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, timeoutMs: project?.timeoutMs }),
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      alert(data.error || `启动队列失败: ${res.status}`);
      await loadProject();
      return false;
    }

    setQueueStatus('running');
    await loadProject();
    return true;
  };

  const handleRegenerate = async (jobId: string, payload: RegeneratePayload) => {
    const res = await fetch(`/api/jobs/${jobId}/regenerate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...payload, markOriginal: true }),
    });
    const data = await res.json();
    if (!res.ok) {
      alert('重新生成失败: ' + (data.error || '未知错误'));
      return;
    }
    await ensureQueueRunning();
  };

  // Per-shot redo: regenerate + repoint happen inside ShotSetPanel; here we just
  // kick the queue and refresh project state.
  const handleShotChanged = async () => {
    await ensureQueueRunning();
    await loadProject();
  };

  const handleBatchDownload = () => {
    const succeededJobs = project?.jobs.filter((j) => j.status === 'succeeded' && j.outputFilename) || [];
    if (succeededJobs.length === 0) {
      alert('没有可下载的图片');
      return;
    }
    window.location.href = `/api/projects/${id}/download`;
  };

  const handleExportCSV = () => { window.open(`/api/projects/${id}/export`, '_blank'); };
  const handleSetSceneRef = (jobId: string, imageAssetId: string) => { setSceneRefModal({ jobId, imageAssetId }); };

  const handleCreateSceneRef = async () => {
    if (!sceneRefModal || !sceneRefName.trim()) return;
    const res = await fetch(`/api/projects/${id}/scene-references`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: sceneRefName.trim(), imageAssetId: sceneRefModal.imageAssetId, sourceJobId: sceneRefModal.jobId }),
    });
    if (res.ok) { setSceneRefModal(null); setSceneRefName(''); await loadProject(); }
    else { const err = await res.json().catch(() => ({})); alert('创建失败: ' + (err.error || '未知错误')); }
  };

  const loadSceneRefs = useCallback(async () => {
    try {
      const res = await fetch(`/api/projects/${id}/scene-references`);
      const data = await res.json();
      if (Array.isArray(data)) setSceneRefs(data.filter((r: { status: string }) => r.status === 'active'));
    } catch { /* ignore */ }
  }, [id]);

  const handleSaveShotPrompt = async () => {
    if (!shotPromptDraft.trim()) {
      alert('分镜生成模板不能为空');
      return;
    }
    const res = await fetch(`/api/projects/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ shotPrompt: shotPromptDraft.trim() }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      alert('保存失败: ' + (data.error || res.status));
      return;
    }
    setProject((prev) => prev ? { ...prev, shotPrompt: data.shotPrompt } : prev);
    setEditingShotPrompt(false);
  };

  const openApplySceneModal = async (shotSetId: string) => {
    await loadSceneRefs();
    setApplySceneModal(shotSetId);
    setApplySceneRefId('');
    setApplyScenePrompt(project?.shotPrompt || '');
  };

  const handleApplySceneSubmit = async () => {
    if (!applySceneModal || !applySceneRefId || !applyScenePrompt.trim()) {
      alert('请选择场景参考图并填写提示词');
      return;
    }
    const res = await fetch(`/api/shot-sets/${applySceneModal}/apply-scene`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sceneReferenceId: applySceneRefId, prompt: applyScenePrompt.trim() }),
    });
    const data = await res.json();
    if (res.ok) {
      alert(`已创建 ${data.jobCount} 个任务`);
      setApplySceneModal(null);
      await ensureQueueRunning();
    } else {
      alert('应用失败: ' + (data.error || '未知错误'));
    }
  };

  const handleShotSetCreated = async () => {
    setSelectedShotSourceIds([]);
    setShotSetRefreshKey((prev) => prev + 1);
    await loadProject();
  };

  if (loading) {
    return (
      <div className="text-center py-16">
        <div className="animate-spin w-8 h-8 border-2 border-blue-600 border-t-transparent rounded-full mx-auto mb-4" />
        <p className="text-gray-400">加载项目...</p>
      </div>
    );
  }

  if (!project) {
    return (
      <div className="text-center py-16">
        <p className="text-gray-500">项目不存在</p>
        <Link href="/" className="text-blue-600 hover:underline mt-2 inline-block">返回列表</Link>
      </div>
    );
  }

  const succeededJobs = project.jobs.filter((j) => j.status === 'succeeded');
  const hasPendingJobs = project.jobs.some((j) => ['pending', 'retrying'].includes(j.status));
  const hasActiveJobs = project.jobs.some((j) => ['pending', 'running', 'retrying', 'needs_check'].includes(j.status));
  const isComplex = project.workflowType === 'complex_product';

  return (
    <div>
      <div className="mb-6 flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <div className="flex flex-wrap items-center gap-3">
            <Link href="/" className="text-gray-400 hover:text-gray-600">← 返回</Link>
            <h1 className="text-2xl font-bold">{project.name}</h1>
            <span className={`status-badge status-${project.status === 'partial_failed' ? 'failed' : project.status}`}>
              {STATUS_LABELS[project.status] || project.status}
            </span>
          </div>
          <div className="mt-1 flex flex-wrap gap-4 text-xs text-gray-500">
            <span>供应商: {project.provider?.name || '-'}</span>
            <span>模型: {project.model}</span>
            <span>任务数: {project.jobs.length}</span>
            <span>成功: {succeededJobs.length}</span>
            <span>失败: {project.jobs.filter((j) => j.status === 'failed').length}</span>
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          <button onClick={() => setLogOpen(true)} className="btn-secondary">运行日志</button>
          {!running && hasPendingJobs && queueStatus !== 'paused' && (
            <button onClick={() => handleAction('start')} disabled={!!actionLoading} className="btn-primary">
              {actionLoading === 'start' ? '...' : '开始运行'}
            </button>
          )}
          {queueStatus === 'paused' && (
            <button onClick={() => handleAction('resume')} disabled={!!actionLoading} className="btn-primary">
              {actionLoading === 'resume' ? '...' : '继续运行'}
            </button>
          )}
          {running && (
            <button onClick={() => handleAction('pause')} disabled={!!actionLoading} className="btn-secondary">
              {actionLoading === 'pause' ? '...' : '暂停'}
            </button>
          )}
          {(running || queueStatus === 'paused') && (
            <button onClick={() => handleAction('cancel')} disabled={!!actionLoading} className="btn-danger">
              {actionLoading === 'cancel' ? '...' : '取消'}
            </button>
          )}
          {succeededJobs.length > 0 && (
            <>
              <button onClick={handleBatchDownload} className="btn-secondary">导出 ZIP</button>
              <button onClick={handleExportCSV} className="btn-secondary">导出 CSV</button>
            </>
          )}
          <a href={`/api/projects/${id}/creative-package`} className="btn-secondary">创意包</a>
        </div>
      </div>

      {project.prompt && (
        <div className="card mb-6 p-4">
          <h3 className="mb-1 text-xs font-medium text-gray-500">提示词</h3>
          <p className="whitespace-pre-wrap text-sm text-gray-700">{project.prompt}</p>
        </div>
      )}

      {isComplex && <ProjectWorkbenchTabs projectId={project.id} activeTab={activeTab} />}
      {isComplex && project.jobs.length > 0 && (
        <QueueCompactBar
          jobs={project.jobs}
          queueStatus={queueStatus}
          running={running}
          actionLoading={actionLoading}
          onStart={() => handleAction('start')}
          onPause={() => handleAction('pause')}
          onResume={() => handleAction('resume')}
          onCancel={() => handleAction('cancel')}
        />
      )}

      <div className="space-y-6">
        {isComplex ? (
          <>
            {activeTab === 'scene' && (
              <SceneWorkspace
                project={project}
                sceneSeedImages={sceneSeedImages}
                selectedSceneSeedIds={validSelectedSceneSeedIds}
                onSelectSceneSeed={setSelectedSceneSeedIds}
                onUploaded={loadProject}
                onJobsCreated={async () => { await loadProject(); await ensureQueueRunning(); }}
                onRetry={handleRetry}
                onMark={handleMark}
                onRegenerate={handleRegenerate}
                onSetSceneRef={handleSetSceneRef}
                jobs={sceneJobs}
              />
            )}
            {activeTab === 'storyboard' && (
              <StoryboardWorkspace
                project={project}
                shotSourceImages={shotSourceImages}
                selectedShotSourceIds={validSelectedShotSourceIds}
                onSelectShotSources={setSelectedShotSourceIds}
                onUploaded={loadProject}
                onShotSetCreated={handleShotSetCreated}
                shotSetRefreshKey={shotSetRefreshKey}
                jobs={shotJobs}
                onApplyScene={openApplySceneModal}
                editingShotPrompt={editingShotPrompt}
                setEditingShotPrompt={setEditingShotPrompt}
                shotPromptDraft={shotPromptDraft}
                setShotPromptDraft={setShotPromptDraft}
                onSaveShotPrompt={handleSaveShotPrompt}
                onShotChanged={handleShotChanged}
              />
            )}
            {activeTab === 'script' && <ScriptPanel projectId={project.id} />}
            {activeTab === 'video' && (
              <div className="card p-5">
                <div className="mb-4">
                  <h2 className="text-lg font-semibold">视频生成</h2>
                  <p className="mt-1 text-sm text-gray-500">选择分镜组和视频供应商，创建图生视频任务。</p>
                </div>
                <VideoGenerationPanel projectId={project.id} />
              </div>
            )}
          </>
        ) : (
          <LegacyProjectContent
            project={project}
            queueStatus={queueStatus}
            running={running}
            hasPendingJobs={hasPendingJobs}
            succeededJobs={succeededJobs}
            onRetry={handleRetry}
            onMark={handleMark}
            onRegenerate={handleRegenerate}
            onSetSceneRef={handleSetSceneRef}
            onAction={handleAction}
            onApplyScene={openApplySceneModal}
            onImagesUploaded={loadProject}
            onShotChanged={handleShotChanged}
          />
        )}
      </div>

      <LogDrawer open={logOpen} projectId={project.id} autoRefresh={running || hasActiveJobs} onClose={() => setLogOpen(false)} />

      {sceneRefModal && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 p-4" onClick={() => setSceneRefModal(null)}>
          <div className="w-full max-w-sm rounded-xl bg-white p-6" onClick={(e) => e.stopPropagation()}>
            <h3 className="mb-4 font-semibold">设为场景参考图</h3>
            <div>
              <label className="text-sm text-gray-600">名称</label>
              <input value={sceneRefName} onChange={(e) => setSceneRefName(e.target.value)} className="input-field mt-1" placeholder="例如: 现代奶油风卧室场景" autoFocus />
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <button onClick={() => setSceneRefModal(null)} className="btn-secondary btn-sm">取消</button>
              <button onClick={handleCreateSceneRef} disabled={!sceneRefName.trim()} className="btn-primary btn-sm">创建</button>
            </div>
          </div>
        </div>
      )}

      {applySceneModal && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 p-4" onClick={() => setApplySceneModal(null)}>
          <div className="max-h-[80vh] w-full max-w-lg overflow-y-auto rounded-xl bg-white p-6" onClick={(e) => e.stopPropagation()}>
            <h3 className="mb-4 font-semibold">选择新场景图并生成分镜</h3>
            <div className="space-y-3">
              <div>
                <label className="text-sm text-gray-600">选择场景参考图</label>
                {(() => {
                  const applySceneItems: ImagePickerItem[] = sceneRefs.map((ref) => {
                    const asset = project?.images.find((img) => img.id === ref.imageAssetId);
                    return { id: ref.id, label: ref.name, filename: ref.imageFilename, imageUrl: asset?.imageUrl };
                  });
                  return <ImagePickerGrid items={applySceneItems} selectedId={applySceneRefId} onSelect={setApplySceneRefId} emptyText="当前项目没有可用的场景参考图，请先在「场景参考图」面板中创建。" />;
                })()}
                {sceneRefs.length === 0 && <p className="mt-1 text-xs text-red-400">当前项目没有可用的场景参考图，请先在「场景参考图」面板中创建。</p>}
              </div>
              <div>
                <label className="text-sm text-gray-600">提示词模板</label>
                <textarea value={applyScenePrompt} onChange={(e) => setApplyScenePrompt(e.target.value)} rows={4} className="input-field mt-1 font-mono text-sm" />
                <p className="mt-1 text-xs text-gray-400">每张分镜图会作为图1（底图），场景参考图作为图2（参考图）</p>
              </div>
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <button onClick={() => setApplySceneModal(null)} className="btn-secondary btn-sm">取消</button>
              <button onClick={handleApplySceneSubmit} disabled={!applySceneRefId || !applyScenePrompt.trim()} className="btn-primary btn-sm">创建任务并开始</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function QueueCompactBar({
  jobs, queueStatus, running, actionLoading, onStart, onPause, onResume, onCancel,
}: {
  jobs: Job[];
  queueStatus: 'idle' | 'running' | 'paused';
  running: boolean;
  actionLoading: string | null;
  onStart: () => void;
  onPause: () => void;
  onResume: () => void;
  onCancel: () => void;
}) {
  const pending = jobs.filter((job) => ['pending', 'retrying'].includes(job.status)).length;
  const active = jobs.filter((job) => ['running', 'needs_check'].includes(job.status)).length;
  const failed = jobs.filter((job) => job.status === 'failed').length;
  const succeeded = jobs.filter((job) => job.status === 'succeeded').length;

  return (
    <div className="mb-5 flex flex-col gap-3 rounded-xl border border-gray-200 bg-white px-4 py-3 shadow-sm sm:flex-row sm:items-center sm:justify-between">
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <span className="font-medium text-gray-900">任务状态</span>
        <span className="text-gray-500">队列: {queueStatus === 'running' ? '运行中' : queueStatus === 'paused' ? '已暂停' : '空闲'}</span>
        <span className="text-gray-500">等待 {pending}</span>
        <span className="text-gray-500">活跃 {active}</span>
        <span className="text-green-600">成功 {succeeded}</span>
        {failed > 0 && <span className="text-red-600">失败 {failed}</span>}
      </div>
      <div className="flex gap-2">
        {!running && pending > 0 && queueStatus !== 'paused' && <button className="btn-primary btn-sm" disabled={!!actionLoading} onClick={onStart}>开始</button>}
        {running && <button className="btn-secondary btn-sm" disabled={!!actionLoading} onClick={onPause}>暂停</button>}
        {queueStatus === 'paused' && <button className="btn-primary btn-sm" disabled={!!actionLoading} onClick={onResume}>继续</button>}
        {(running || queueStatus === 'paused') && <button className="btn-danger btn-sm" disabled={!!actionLoading} onClick={onCancel}>取消</button>}
      </div>
    </div>
  );
}

function SceneWorkspace({
  project,
  sceneSeedImages,
  selectedSceneSeedIds,
  onSelectSceneSeed,
  onUploaded,
  onJobsCreated,
  onRetry,
  onMark,
  onRegenerate,
  onSetSceneRef,
  jobs,
}: {
  project: Project;
  sceneSeedImages: AssetGridItem[];
  selectedSceneSeedIds: string[];
  onSelectSceneSeed: (ids: string[]) => void;
  onUploaded: () => void | Promise<void>;
  onJobsCreated: () => void | Promise<void>;
  onRetry: (jobId: string) => void;
  onMark: (jobId: string, mark: string) => void;
  onRegenerate: (jobId: string, payload: RegeneratePayload) => void;
  onSetSceneRef: (jobId: string, imageAssetId: string) => void;
  jobs: Job[];
}) {
  return (
    <div className="space-y-6">
      <section className="card p-5">
        <div className="mb-4">
          <h2 className="text-lg font-semibold">新场景图生成</h2>
          <p className="mt-1 text-sm text-gray-500">先上传原始场景图 A，再选择 1 张作为生成输入。</p>
        </div>
        <AssetUploadGrid
          projectId={project.id}
          assets={sceneSeedImages}
          selectedIds={selectedSceneSeedIds}
          usage="scene_seed"
          uploadTitle="上传原始场景图 A"
          uploadHint="拖拽或点击上传。上传成功后会出现在右侧宫格。"
          emptyText="还没有原始场景图 A。上传后会在这里显示缩略图。"
          selectionLabel="可选择 1 张作为原始场景图 A。"
          maxSelection={1}
          onSelectionChange={onSelectSceneSeed}
          onUploaded={onUploaded}
        />
      </section>

      <SceneGenerationForm selectedImageId={selectedSceneSeedIds[0] || ''} defaultPrompt={project.scenePrompt || ''} onJobsCreated={onJobsCreated} projectId={project.id} />

      <section className="card p-5">
        <div className="mb-4">
          <h2 className="text-lg font-semibold">生成结果</h2>
          <p className="mt-1 text-sm text-gray-500">生成成功后，在这里挑选可用图并保存为场景参考图。</p>
        </div>
        <ResultGallery jobs={jobs} images={project.images} onRetry={onRetry} onMark={onMark} onRegenerate={onRegenerate} onSetSceneRef={onSetSceneRef} projectId={project.id} />
      </section>

      <SceneReferencePanel projectId={project.id} images={project.images.map((img) => ({ id: img.id, imageUrl: img.imageUrl, filename: img.filename, role: img.role, usage: img.usage }))} />
    </div>
  );
}

function SceneGenerationForm({
  projectId, selectedImageId, defaultPrompt, onJobsCreated,
}: {
  projectId: string;
  selectedImageId: string;
  defaultPrompt: string;
  onJobsCreated: () => void | Promise<void>;
}) {
  const [prompt, setPrompt] = useState(defaultPrompt);
  const [count, setCount] = useState(4);
  const [creating, setCreating] = useState(false);

  return (
    <section className="card p-5">
      <div className="mb-4">
        <h2 className="text-lg font-semibold">生成参数</h2>
        <p className="mt-1 text-sm text-gray-500">选中原始场景图 A 后，确认提示词和数量再开始生成。</p>
      </div>
      <div className="grid gap-4 md:grid-cols-[1fr_120px]">
        <div>
          <label className="label">场景提示词</label>
          <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={4} className="input-field font-mono text-sm" />
        </div>
        <div>
          <label className="label">数量</label>
          <input type="number" min={1} max={9} value={count} onChange={(e) => setCount(Math.max(1, Math.min(9, Number(e.target.value) || 1)))} className="input-field" />
        </div>
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button
          onClick={async () => {
            if (!selectedImageId) { alert('请先在上方宫格选择原始场景图 A'); return; }
            if (!prompt.trim()) { alert('请输入场景提示词'); return; }
            setCreating(true);
            try {
              const res = await fetch(`/api/projects/${projectId}/scene-jobs`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ sceneSeedImageId: selectedImageId, scenePrompt: prompt.trim(), generationCount: count }),
              });
              const data = await res.json();
              if (res.ok) await onJobsCreated();
              else alert('创建失败: ' + (data.error || '未知错误'));
            } catch (err) { alert('创建失败: ' + String(err)); }
            finally { setCreating(false); }
          }}
          disabled={creating || !selectedImageId}
          className="btn-primary"
        >
          {creating ? '创建中...' : `生成 ${count} 张新场景图`}
        </button>
        {!selectedImageId && <span className="text-sm text-gray-400">请先选择 1 张原始场景图 A</span>}
      </div>
    </section>
  );
}

function StoryboardWorkspace({
  project,
  shotSourceImages,
  selectedShotSourceIds,
  onSelectShotSources,
  onUploaded,
  onShotSetCreated,
  shotSetRefreshKey,
  jobs,
  onApplyScene,
  editingShotPrompt,
  setEditingShotPrompt,
  shotPromptDraft,
  setShotPromptDraft,
  onSaveShotPrompt,
  onShotChanged,
}: {
  project: Project;
  shotSourceImages: AssetGridItem[];
  selectedShotSourceIds: string[];
  onSelectShotSources: (ids: string[]) => void;
  onUploaded: () => void | Promise<void>;
  onShotSetCreated: () => void | Promise<void>;
  shotSetRefreshKey: number;
  jobs: Job[];
  onApplyScene: (shotSetId: string) => void;
  editingShotPrompt: boolean;
  setEditingShotPrompt: (value: boolean) => void;
  shotPromptDraft: string;
  setShotPromptDraft: (value: string) => void;
  onSaveShotPrompt: () => void;
  onShotChanged: () => void | Promise<void>;
}) {
  return (
    <div className="space-y-6">
      <section className="card p-5">
        <div className="mb-4">
          <h2 className="text-lg font-semibold">新分镜图</h2>
          <p className="mt-1 text-sm text-gray-500">上传后在宫格里按顺序选择 1-9 张，再创建分镜组。</p>
        </div>
        <AssetUploadGrid
          projectId={project.id}
          assets={shotSourceImages}
          selectedIds={selectedShotSourceIds}
          usage="shot_source"
          uploadTitle="上传原始分镜图"
          uploadHint="拖拽或点击上传。上传成功后会出现在右侧宫格。"
          emptyText="还没有原始分镜图。上传后会在这里显示缩略图。"
          selectionLabel="点击图片选择，选择顺序就是分镜顺序。"
          maxSelection={9}
          onSelectionChange={onSelectShotSources}
          onUploaded={onUploaded}
        />
        <StoryboardGroupCreator projectId={project.id} selectedImageIds={selectedShotSourceIds} onCreated={onShotSetCreated} />
      </section>

      <section className="card p-5">
        <div className="mb-3 flex items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold">分镜生成模板</h2>
            <p className="mt-1 text-sm text-gray-500">分镜生成时会使用这个模板描述图1和场景参考图的关系。</p>
          </div>
          {!editingShotPrompt && (
            <button onClick={() => { setShotPromptDraft(project.shotPrompt || ''); setEditingShotPrompt(true); }} className="btn-secondary btn-sm">
              编辑模板
            </button>
          )}
        </div>
        {editingShotPrompt ? (
          <div className="space-y-2">
            <textarea value={shotPromptDraft} onChange={(e) => setShotPromptDraft(e.target.value)} rows={6} className="input-field font-mono text-xs" />
            <div className="flex gap-2">
              <button onClick={onSaveShotPrompt} className="btn-primary btn-sm">保存</button>
              <button onClick={() => { setShotPromptDraft(project.shotPrompt || ''); setEditingShotPrompt(false); }} className="btn-secondary btn-sm">取消</button>
            </div>
          </div>
        ) : (
          <pre className="whitespace-pre-wrap rounded-lg bg-gray-50 p-3 text-xs text-gray-600">{project.shotPrompt || '未设置'}</pre>
        )}
      </section>

      <ShotSetPanel
        key={shotSetRefreshKey}
        projectId={project.id}
        images={project.images.map((img) => ({ id: img.id, imageUrl: img.imageUrl, filename: img.filename, role: img.role, usage: img.usage }))}
        jobs={jobs}
        onApplyScene={onApplyScene}
        onImagesUploaded={onUploaded}
        onShotChanged={onShotChanged}
        showUploader={false}
        showCreateControls={false}
      />
    </div>
  );
}

function StoryboardGroupCreator({ projectId, selectedImageIds, onCreated }: { projectId: string; selectedImageIds: string[]; onCreated: () => void | Promise<void> }) {
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);

  return (
    <div className="mt-4 rounded-lg border border-gray-200 bg-gray-50 p-4">
      <div className="grid gap-3 md:grid-cols-[1fr_auto] md:items-end">
        <div>
          <label className="label">分镜组名称</label>
          <input value={name} onChange={(e) => setName(e.target.value)} className="input-field" placeholder="例如：卧室场景分镜 1-6" />
        </div>
        <button
          onClick={async () => {
            if (!name.trim() || selectedImageIds.length === 0) return;
            setSaving(true);
            try {
              const res = await fetch(`/api/projects/${projectId}/shot-sets`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: name.trim(), shotImageIds: selectedImageIds }),
              });
              const data = await res.json().catch(() => ({}));
              if (res.ok) { setName(''); await onCreated(); }
              else alert('创建失败: ' + (data.error || '未知错误'));
            } catch (err) { alert('创建失败: ' + String(err)); }
            finally { setSaving(false); }
          }}
          disabled={!name.trim() || selectedImageIds.length === 0 || saving}
          className="btn-primary"
        >
          {saving ? '创建中...' : `创建分镜组 (${selectedImageIds.length})`}
        </button>
      </div>
      <p className="mt-2 text-xs text-gray-400">已选择 {selectedImageIds.length}/9 张。点击宫格图片可调整选择和顺序。</p>
    </div>
  );
}

function LegacyProjectContent({
  project,
  queueStatus,
  running,
  hasPendingJobs,
  succeededJobs,
  onRetry,
  onMark,
  onRegenerate,
  onSetSceneRef,
  onAction,
  onApplyScene,
  onImagesUploaded,
  onShotChanged,
}: {
  project: Project;
  queueStatus: 'idle' | 'running' | 'paused';
  running: boolean;
  hasPendingJobs: boolean;
  succeededJobs: Job[];
  onRetry: (jobId: string) => void;
  onMark: (jobId: string, mark: string) => void;
  onRegenerate: (jobId: string, payload: RegeneratePayload) => void;
  onSetSceneRef: (jobId: string, imageAssetId: string) => void;
  onAction: (action: string) => void;
  onApplyScene: (shotSetId: string) => void;
  onImagesUploaded: () => void;
  onShotChanged: () => void | Promise<void>;
}) {
  return (
    <>
      {project.jobs.length > 0 && (
        <div className="card p-4">
          <h2 className="mb-4 font-semibold">任务队列</h2>
          <JobQueueTable
            jobs={project.jobs}
            queueStatus={queueStatus}
            onRetry={onRetry}
            onPause={running ? () => onAction('pause') : undefined}
            onResume={queueStatus === 'paused' ? () => onAction('resume') : !running && hasPendingJobs ? () => onAction('start') : undefined}
            onCancel={(running || queueStatus === 'paused') ? () => onAction('cancel') : undefined}
            running={running}
          />
        </div>
      )}
      <div className="card p-4">
        <h2 className="mb-4 font-semibold">结果预览 {succeededJobs.length > 0 && <span className="ml-2 text-sm font-normal text-gray-400">({succeededJobs.length} 张)</span>}</h2>
        <ResultGallery jobs={project.jobs} images={project.images} onRetry={onRetry} onMark={onMark} onRegenerate={onRegenerate} onSetSceneRef={onSetSceneRef} projectId={project.id} />
      </div>
      <SceneReferencePanel projectId={project.id} images={project.images.map((img) => ({ id: img.id, imageUrl: img.imageUrl, filename: img.filename, role: img.role, usage: img.usage }))} />
      <ShotSetPanel projectId={project.id} images={project.images.map((img) => ({ id: img.id, imageUrl: img.imageUrl, filename: img.filename, role: img.role, usage: img.usage }))} jobs={project.jobs} onApplyScene={onApplyScene} onImagesUploaded={onImagesUploaded} onShotChanged={onShotChanged} />
    </>
  );
}