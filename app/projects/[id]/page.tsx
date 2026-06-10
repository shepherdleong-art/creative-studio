'use client';

import { useEffect, useState, useCallback } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import JobQueueTable from '@/components/JobQueueTable';
import ResultGallery, { RegeneratePayload } from '@/components/ResultGallery';
import LogViewer from '@/components/LogViewer';
import SceneReferencePanel from '@/components/SceneReferencePanel';
import ShotSetPanel from '@/components/ShotSetPanel';

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

export default function ProjectDetailPage() {
  const params = useParams();
  const id = params.id as string;

  const [project, setProject] = useState<Project | null>(null);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [sceneRefModal, setSceneRefModal] = useState<{ jobId: string; imageAssetId: string } | null>(null);
  const [sceneRefName, setSceneRefName] = useState('');
  const [sceneRefs, setSceneRefs] = useState<Array<{ id: string; name: string; imageFilename: string; status: string }>>([]);

  const loadProject = useCallback(async () => {
    try {
      const res = await fetch(`/api/projects/${id}`);
      const data = await res.json();
      if (data.error) {
        console.error(data.error);
        return;
      }
      setProject(data);

      // Check if queue is running
      const queueRes = await fetch(`/api/projects/${id}/run`);
      const queueData = await queueRes.json();
      setRunning(queueData.queueStatus === 'running');
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadProject();
  }, [loadProject]);

  // Poll for updates when running
  useEffect(() => {
    if (!running) return;
    const interval = setInterval(loadProject, 2000);
    return () => clearInterval(interval);
  }, [running, loadProject]);

  const handleAction = async (action: string) => {
    setActionLoading(action);
    try {
      await fetch(`/api/projects/${id}/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, timeoutMs: project?.timeoutMs }),
      });
      if (action === 'start' || action === 'resume') {
        setRunning(true);
      } else if (action === 'pause') {
        setRunning(false);
      } else if (action === 'cancel') {
        setRunning(false);
      }
      await loadProject();
    } catch (err) {
      console.error(err);
    } finally {
      setActionLoading(null);
    }
  };

  const handleRetry = async (jobId: string) => {
    // Check if this job is in needs_check status -> use resume-poll instead
    const job = project?.jobs.find((j) => j.id === jobId);
    if (job?.status === 'needs_check') {
      await fetch(`/api/jobs/${jobId}/resume-poll`, { method: 'POST' });
    } else {
      await fetch(`/api/jobs/${jobId}/retry`, { method: 'POST' });
    }
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
    // Start queue; ignore 409 if already running
    const runRes = await fetch(`/api/projects/${id}/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'start' }),
    });
    if (!runRes.ok && runRes.status !== 409) {
      const runData = await runRes.json().catch(() => ({}));
      alert('任务已创建，但启动队列失败: ' + (runData.error || runRes.status));
    }
    await loadProject();
  };

  const handleBatchDownload = async () => {
    const succeededJobs = project?.jobs.filter((j) => j.status === 'succeeded' && j.outputFilename) || [];
    if (succeededJobs.length === 0) {
      alert('没有可下载的图片');
      return;
    }

    // Download individually (browser limitation)
    for (const job of succeededJobs) {
      if (job.outputFilename) {
        const a = document.createElement('a');
        a.href = `/api/images/outputs/${job.outputFilename}`;
        a.download = job.outputFilename;
        a.click();
        await new Promise((r) => setTimeout(r, 300));
      }
    }
  };

  const handleExportCSV = () => {
    window.open(`/api/projects/${id}/export`, '_blank');
  };

  // ── Scene Reference ──
  const handleSetSceneRef = (jobId: string, imageAssetId: string) => {
    setSceneRefModal({ jobId, imageAssetId });
  };

  const handleCreateSceneRef = async () => {
    if (!sceneRefModal || !sceneRefName.trim()) return;
    const res = await fetch(`/api/projects/${id}/scene-references`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: sceneRefName.trim(), imageAssetId: sceneRefModal.imageAssetId, sourceJobId: sceneRefModal.jobId }),
    });
    if (res.ok) { setSceneRefModal(null); setSceneRefName(''); await loadProject(); }
    else { const err = await res.json().catch(() => ({})); alert('创建失败: ' + (err.error || '未知错误')); }
  };

  const [applySceneModal, setApplySceneModal] = useState<string | null>(null);
  const [applySceneRefId, setApplySceneRefId] = useState('');
  const [applyScenePrompt, setApplyScenePrompt] = useState('图1 是待编辑分镜图。图2 是场景参考图。请参考图2的空间风格、光线、墙面、软装和布置，重绘图1的场景。保持图1中的产品结构、模特姿态、主体位置和画面构图尽量一致。不要改变产品结构，不要添加文字。');

  const loadSceneRefs = useCallback(async () => {
    try {
      const res = await fetch(`/api/projects/${id}/scene-references`);
      const data = await res.json();
      if (Array.isArray(data)) setSceneRefs(data.filter((r: { status: string }) => r.status === 'active'));
    } catch { /* ignore */ }
  }, [id]);

  const openApplySceneModal = async (shotSetId: string) => {
    await loadSceneRefs();
    setApplySceneModal(shotSetId);
    setApplySceneRefId('');
    setApplyScenePrompt('图1 是待编辑分镜图。图2 是场景参考图。请参考图2的空间风格、光线、墙面、软装和布置，重绘图1的场景。保持图1中的产品结构、模特姿态、主体位置和画面构图尽量一致。不要改变产品结构，不要添加文字。');
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
      // Auto-start queue
      await fetch(`/api/projects/${id}/run`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'start', timeoutMs: project?.timeoutMs }) });
      setRunning(true);
      await loadProject();
    } else {
      alert('应用失败: ' + (data.error || '未知错误'));
    }
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
        <Link href="/" className="text-blue-600 hover:underline mt-2 inline-block">
          返回列表
        </Link>
      </div>
    );
  }

  const succeededJobs = project.jobs.filter((j) => j.status === 'succeeded');
  const hasPendingJobs = project.jobs.some((j) =>
    ['pending', 'retrying'].includes(j.status)
  );
  const hasActiveJobs = project.jobs.some((j) =>
    ['pending', 'running', 'retrying', 'needs_check'].includes(j.status)
  );

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <div className="flex items-center gap-3">
            <Link href="/" className="text-gray-400 hover:text-gray-600">
              ← 返回
            </Link>
            <h1 className="text-2xl font-bold">{project.name}</h1>
            <span className={`status-badge status-${project.status === 'partial_failed' ? 'failed' : project.status}`}>
              {STATUS_LABELS[project.status] || project.status}
            </span>
          </div>
          <div className="flex gap-4 text-xs text-gray-500 mt-1 flex-wrap">
            <span>供应商: {project.provider?.name || '-'}</span>
            <span>模型: {project.model}</span>
            <span>任务数: {project.jobs.length}</span>
            <span>成功: {succeededJobs.length}</span>
            <span>失败: {project.jobs.filter((j) => j.status === 'failed').length}</span>
          </div>
        </div>

        <div className="flex gap-2">
          {!running && hasPendingJobs && (
            <button
              onClick={() => handleAction('start')}
              disabled={!!actionLoading}
              className="btn-primary"
            >
              {actionLoading === 'start' ? '...' : '▶ 开始运行'}
            </button>
          )}
          {running && (
            <button
              onClick={() => handleAction('pause')}
              disabled={!!actionLoading}
              className="btn-secondary"
            >
              {actionLoading === 'pause' ? '...' : '⏸ 暂停'}
            </button>
          )}
          {running && (
            <button
              onClick={() => handleAction('cancel')}
              disabled={!!actionLoading}
              className="btn-danger"
            >
              {actionLoading === 'cancel' ? '...' : '⏹ 取消'}
            </button>
          )}
          {succeededJobs.length > 0 && (
            <>
              <button onClick={handleBatchDownload} className="btn-secondary">
                批量下载
              </button>
              <button onClick={handleExportCSV} className="btn-secondary">
                导出 CSV
              </button>
            </>
          )}
        </div>
      </div>

      {/* Prompt */}
      {project.prompt && (
        <div className="card p-4 mb-6">
          <h3 className="text-xs font-medium text-gray-500 mb-1">提示词</h3>
          <p className="text-sm text-gray-700 whitespace-pre-wrap">{project.prompt}</p>
        </div>
      )}

      {/* Workflow stages */}
      <div className="space-y-6">
        {project.workflowType === 'complex_product' ? (
          <>
            {/* Stage 1: Scene B candidates */}
            <div className="card p-4">
              <h2 className="font-semibold mb-1">阶段 1：场景图 B 候选</h2>
              <p className="text-xs text-gray-400 mb-4">基于场景图 A 生成的新场景候选。选择一张设为场景参考图。</p>
              {project.scenePrompt && (
                <div className="mb-3 p-2 bg-gray-50 rounded text-xs text-gray-600">
                  场景提示词：{project.scenePrompt}
                </div>
              )}
              <ResultGallery
                jobs={project.jobs}
                images={project.images}
                onRetry={handleRetry}
                onMark={handleMark}
                onRegenerate={handleRegenerate}
                onSetSceneRef={handleSetSceneRef}
                projectId={project.id}
              />
            </div>

            {/* Stage 2: Scene References */}
            <SceneReferencePanel
              projectId={project.id}
              images={project.images.map((img) => ({ id: img.id, imageUrl: img.imageUrl, filename: img.filename, role: img.role }))}
            />

            {/* Stage 3: Shot Set & Batch Redo */}
            {project.shotPrompt && (
              <div className="card p-4">
                <h2 className="font-semibold mb-2">分镜重做模板</h2>
                <p className="text-xs text-gray-400 mb-2">确认场景参考图后，点击分镜组的「批量应用场景」使用此模板。</p>
                <pre className="text-xs text-gray-600 whitespace-pre-wrap bg-gray-50 p-3 rounded">{project.shotPrompt}</pre>
              </div>
            )}
            <ShotSetPanel
              projectId={project.id}
              images={project.images.map((img) => ({ id: img.id, imageUrl: img.imageUrl, filename: img.filename, role: img.role }))}
              jobs={project.jobs}
              onApplyScene={openApplySceneModal}
            />

            {/* Queue (compact) */}
            {project.jobs.length > 0 && (
              <div className="card p-4">
                <h2 className="font-semibold mb-4">任务队列</h2>
                <JobQueueTable
                  jobs={project.jobs}
                  queueStatus={running ? 'running' : 'idle'}
                  onRetry={handleRetry}
                  onPause={running ? () => handleAction('pause') : undefined}
                  onResume={!running && hasPendingJobs ? () => handleAction('start') : undefined}
                  onCancel={running ? () => handleAction('cancel') : undefined}
                  running={running}
                />
              </div>
            )}

            {/* Placeholder: Video + Script */}
            <div className="card p-4 bg-gray-50 border-dashed">
              <h2 className="font-semibold mb-2 text-gray-500">后续阶段（规划中）</h2>
              <div className="grid grid-cols-2 gap-4 text-sm text-gray-400">
                <div>
                  <span className="font-medium">阶段 5：视频任务草稿</span>
                  <p className="text-xs mt-1">分镜审核通过后可创建视频任务，未来接入即梦/可灵。</p>
                </div>
                <div>
                  <span className="font-medium">阶段 6：15 秒口播文案</span>
                  <p className="text-xs mt-1">分镜组 + 产品卖点 → LLM → 种草短视频口播。</p>
                </div>
              </div>
            </div>
          </>
        ) : (
          /* Legacy layout */
          <>
            {project.jobs.length > 0 && (
              <div className="card p-4">
                <h2 className="font-semibold mb-4">任务队列</h2>
                <JobQueueTable
                  jobs={project.jobs}
                  queueStatus={running ? 'running' : 'idle'}
                  onRetry={handleRetry}
                  onPause={running ? () => handleAction('pause') : undefined}
                  onResume={!running && hasPendingJobs ? () => handleAction('start') : undefined}
                  onCancel={running ? () => handleAction('cancel') : undefined}
                  running={running}
                />
              </div>
            )}
            <div className="card p-4">
              <h2 className="font-semibold mb-4">结果预览 {succeededJobs.length > 0 && <span className="text-gray-400 font-normal text-sm ml-2">({succeededJobs.length} 张)</span>}</h2>
              <ResultGallery jobs={project.jobs} images={project.images} onRetry={handleRetry} onMark={handleMark} onRegenerate={handleRegenerate} onSetSceneRef={handleSetSceneRef} projectId={project.id} />
            </div>
            <SceneReferencePanel projectId={project.id} images={project.images.map((img) => ({ id: img.id, imageUrl: img.imageUrl, filename: img.filename, role: img.role }))} />
            <ShotSetPanel projectId={project.id} images={project.images.map((img) => ({ id: img.id, imageUrl: img.imageUrl, filename: img.filename, role: img.role }))} jobs={project.jobs} onApplyScene={openApplySceneModal} />
          </>
        )}

        {/* Logs */}
        <div className="card p-4">
          <h2 className="font-semibold mb-4">运行日志</h2>
          <LogViewer projectId={project.id} autoRefresh={running || hasActiveJobs} refreshMs={1000} />
        </div>
      </div>

      {/* Scene Reference creation modal */}
      {sceneRefModal && (
        <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center p-4" onClick={() => setSceneRefModal(null)}>
          <div className="bg-white rounded-xl p-6 max-w-sm w-full" onClick={(e) => e.stopPropagation()}>
            <h3 className="font-semibold mb-4">设为场景参考图</h3>
            <div>
              <label className="text-sm text-gray-600">名称</label>
              <input value={sceneRefName} onChange={(e) => setSceneRefName(e.target.value)}
                className="input-field mt-1" placeholder="例如: 现代奶油风卧室场景" autoFocus />
            </div>
            <div className="flex gap-2 justify-end mt-4">
              <button onClick={() => setSceneRefModal(null)} className="btn-secondary btn-sm">取消</button>
              <button onClick={handleCreateSceneRef} disabled={!sceneRefName.trim()} className="btn-primary btn-sm">创建</button>
            </div>
          </div>
        </div>
      )}

      {/* Apply Scene to ShotSet modal */}
      {applySceneModal && (
        <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center p-4" onClick={() => setApplySceneModal(null)}>
          <div className="bg-white rounded-xl p-6 max-w-lg w-full max-h-[80vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <h3 className="font-semibold mb-4">批量应用场景到分镜组</h3>
            <div className="space-y-3">
              <div>
                <label className="text-sm text-gray-600">选择场景参考图</label>
                <select value={applySceneRefId} onChange={(e) => setApplySceneRefId(e.target.value)} className="input-field mt-1 text-sm">
                  <option value="">-- 选择场景 --</option>
                  {sceneRefs.map((ref) => (
                    <option key={ref.id} value={ref.id}>{ref.name} ({ref.imageFilename})</option>
                  ))}
                </select>
                {sceneRefs.length === 0 && (
                  <p className="text-xs text-red-400 mt-1">当前项目没有可用的场景参考图，请先在「场景参考图」面板中创建。</p>
                )}
              </div>
              <div>
                <label className="text-sm text-gray-600">提示词模板</label>
                <textarea value={applyScenePrompt} onChange={(e) => setApplyScenePrompt(e.target.value)}
                  rows={4} className="input-field mt-1 text-sm font-mono" />
                <p className="text-xs text-gray-400 mt-1">每张分镜图会作为图1（底图），场景参考图作为图2（参考图）</p>
              </div>
            </div>
            <div className="flex gap-2 justify-end mt-4">
              <button onClick={() => setApplySceneModal(null)} className="btn-secondary btn-sm">取消</button>
              <button onClick={handleApplySceneSubmit} disabled={!applySceneRefId || !applyScenePrompt.trim()} className="btn-primary btn-sm">创建任务并开始</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
