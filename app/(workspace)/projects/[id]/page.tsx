'use client';

import { useEffect, useState, useCallback, useMemo } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { Icon } from '@/components/ui/Icon';
import ImagePickerGrid, { ImagePickerItem } from '@/components/ImagePickerGrid';
import ScriptStudioPanel from '@/components/script-studio/ScriptStudioPanel';
import VideoGenerationPanel from '@/components/VideoGenerationPanel';
import MixcutWorkspace from '@/components/mixcut/MixcutWorkspace';
import { ReassembledReworkPanel } from '@/components/mixcut/ReassembledReworkPanel';
import LogDrawer from '@/components/LogDrawer';
import { ProjectInfoDialog, type ProjectInfoValue } from '@/components/ProjectInfoDialog';
import { ToolbarButton } from '@/components/ui/Appearance';
import PageToolbar from '@/components/team/PageToolbar';
import type { WorkspaceRole } from '@/lib/workspace-navigation';
import SceneStep from '@/components/workbench/SceneStep';
import ShotSetStep from '@/components/workbench/ShotSetStep';
import { StepEmptyBanner } from '@/components/workbench/StepEmpty';
import { parseWorkbenchTab, WorkbenchStepNav, type WorkbenchTabId } from '@/components/workbench/WorkbenchStepNav';
import type { WorkbenchImage, WorkbenchJob, WorkbenchProvider } from '@/components/workbench/types';
import {
  buildSceneReferenceByImageId,
  getActiveSceneReferences,
  SceneReferenceRecord,
} from '@/lib/result-gallery-jobs';

interface Project {
  id: string;
  name: string;
  productName?: string | null;
  productCode?: string | null;
  productCategory?: string | null;
  storeCode?: string | null;
  productSubmodel?: string | null;
  productionType?: string | null;
  editorName?: string | null;
  namingDate?: string | null;
  currentExportIdentityId?: string | null;
  providerId: string;
  model: string;
  size?: string;
  prompt: string;
  scenePrompt?: string;
  shotPrompt?: string;
  status: string;
  concurrency: number;
  maxAttempts: number;
  timeoutMs?: number;
  images: WorkbenchImage[];
  jobs: WorkbenchJob[];
  provider: { id: string; name: string; model: string } | null;
}

function toWorkbenchProvider(provider: { id: string; name: string; model: string; type?: string; enabled?: number; hasApiKey?: boolean }): WorkbenchProvider {
  return {
    id: provider.id,
    name: provider.name,
    model: provider.model,
    type: provider.type,
    enabled: provider.enabled ?? 1,
    hasApiKey: provider.hasApiKey ?? true,
  };
}

/**
 * 项目工作台（07 号票）：工具栏 + 五步分段按钮 + 三步容器。
 *
 * - 工具栏：**本页自己出**（外壳的紧凑标题已排除 `/projects/[id]`），
 *   内容按规格：返回、项目名、五步分段按钮、项目信息、导出项目包。
 * - 第 1/2 步是 07 的实现（`components/workbench/SceneStep.tsx`、`ShotSetStep.tsx`）；
 *   第 3/4/5 步只放进新框架，内容仍由 08/09 号票改动。
 * - 路由与 `?tab=` 标识不变：`scene | storyboard | script | video | final-edit`。
 */
export default function ProjectDetailPage() {
  const params = useParams();
  const router = useRouter();
  const searchParams = useSearchParams();
  const id = params.id as string;
  const activeTab = parseWorkbenchTab(searchParams.get('tab'));

  type QueueStatus = 'idle' | 'running' | 'paused';

  const [project, setProject] = useState<Project | null>(null);
  const [providers, setProviders] = useState<WorkbenchProvider[]>([]);
  const [loading, setLoading] = useState(true);
  const [role, setRole] = useState<WorkspaceRole>('employee');
  const [queueStatus, setQueueStatus] = useState<QueueStatus>('idle');
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [sceneRefModal, setSceneRefModal] = useState<{ jobId: string; imageAssetId: string } | null>(null);
  const [sceneRefName, setSceneRefName] = useState('');
  const [sceneRefs, setSceneRefs] = useState<SceneReferenceRecord[]>([]);
  const [applySceneModal, setApplySceneModal] = useState<string | null>(null);
  const [applySceneRefId, setApplySceneRefId] = useState('');
  const [applyScenePrompt, setApplyScenePrompt] = useState('图1是待编辑分镜图，是本次修改的主要对象。图2是场景参考图。参考图2，修改图1，保持图中床和模特的一致性不变，更换卧室的其他家具和软装布置，构图和机位景别严格参考图1。');
  const [applySceneProviderId, setApplySceneProviderId] = useState('');
  const [logOpen, setLogOpen] = useState(false);
  const [projectInfoOpen, setProjectInfoOpen] = useState(false);
  const [selectedSceneSeedIds, setSelectedSceneSeedIds] = useState<string[]>([]);

  const running = queueStatus === 'running';

  const handleProjectInfoSaved = useCallback((nextProject: ProjectInfoValue) => {
    setProject((current) => current ? { ...current, ...nextProject } : current);
  }, []);

  const loadProject = useCallback(async () => {
    try {
      const res = await fetch(`/api/projects/${id}`);
      const data = await res.json();
      if (data.error) {
        console.error(data.error);
        return;
      }
      setProject(data as Project);

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

  useEffect(() => {
    let active = true;
    fetch('/api/team/models?kind=image')
      .then((res) => res.json())
      .then((data: Array<{ id: string; name: string; model: string; type?: string; enabled?: number; hasApiKey?: boolean }>) => {
        if (active && Array.isArray(data)) setProviders(data.map(toWorkbenchProvider));
      })
      .catch(console.error);
    return () => { active = false; };
  }, []);

  // 角色决定工具栏标题（团队版外壳按角色命名），本地版拿不到就按员工。
  useEffect(() => {
    let active = true;
    fetch('/api/team/auth/session', { credentials: 'same-origin', cache: 'no-store' })
      .then((response) => response.json())
      .then((data: { role?: string }) => {
        if (!active) return;
        if (data.role === 'admin' || data.role === 'employee') setRole(data.role);
      })
      .catch(() => { /* 本地版没有团队会话，保持员工标题 */ });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (queueStatus === 'idle') return;
    const interval = setInterval(loadProject, 2000);
    return () => clearInterval(interval);
  }, [queueStatus, loadProject]);

  const sceneSeedImages = useMemo(
    () => (project?.images || []).filter((img) => img.role === 'input' && img.usage === 'scene_seed'),
    [project],
  );
  const shotSourceImages = useMemo(
    () => (project?.images || []).filter((img) => img.role === 'input' && img.usage === 'shot_source'),
    [project],
  );
  const validSelectedSceneSeedIds = useMemo(
    () => selectedSceneSeedIds.filter((assetId) => sceneSeedImages.some((img) => img.id === assetId)),
    [selectedSceneSeedIds, sceneSeedImages],
  );
  const activeSceneSeedId = validSelectedSceneSeedIds[0] || sceneSeedImages[0]?.id || '';

  const imageUsageMap = useMemo(() => {
    const map = new Map<string, string>();
    (project?.images || []).forEach((img) => { if (img.id) map.set(img.id, img.usage || ''); });
    return map;
  }, [project]);

  const sceneJobs = useMemo(
    () => (project?.jobs || []).filter((job) => {
      const usage = job.inputImageId ? (imageUsageMap.get(job.inputImageId) || '') : '';
      return !usage || usage === 'scene_seed';
    }),
    [project, imageUsageMap],
  );
  const shotJobs = useMemo(
    () => (project?.jobs || []).filter((job) => {
      const usage = job.inputImageId ? (imageUsageMap.get(job.inputImageId) || '') : '';
      return usage === 'shot_source';
    }),
    [project, imageUsageMap],
  );

  const sceneReferenceByImageId = useMemo(() => buildSceneReferenceByImageId(sceneRefs), [sceneRefs]);

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

  const ensureQueueRunning = useCallback(async (): Promise<boolean> => {
    const statusRes = await fetch(`/api/projects/${id}/run`);
    const statusData = await statusRes.json().catch(() => ({}));
    const currentStatus = (statusData.queueStatus || queueStatus || 'idle') as QueueStatus;
    if (currentStatus === 'running') {
      setQueueStatus('running');
      return true;
    }
    const res = await fetch(`/api/projects/${id}/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: currentStatus === 'paused' ? 'resume' : 'start', timeoutMs: project?.timeoutMs }),
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
  }, [id, project?.timeoutMs, queueStatus, loadProject]);

  const handleRetry = async (jobId: string) => {
    const job = project?.jobs.find((item) => item.id === jobId);
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

  const handleRegenerate = async (jobId: string, prompt: string, providerId: string) => {
    // 不传 referenceImageIds：沿用这个任务原来的参考图（传空数组会把参考图清掉）。
    const res = await fetch(`/api/jobs/${jobId}/regenerate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt,
        inputSource: 'original',
        providerId: providerId || undefined,
        markOriginal: true,
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      alert('重新生成失败: ' + (data.error || '未知错误'));
      return;
    }
    await ensureQueueRunning();
  };

  const handleSetSceneRef = (jobId: string, imageAssetId: string) => { setSceneRefModal({ jobId, imageAssetId }); };

  const handleDeleteAsset = async (assetId: string) => {
    try {
      const res = await fetch(`/api/images/${assetId}`, { method: 'DELETE' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        alert(res.status === 409 ? (data.error || '这张图已经被引用，不能删') : `删除失败: ${data.error || '未知错误'}`);
        return;
      }
    } catch {
      alert('删除失败: 网络错误，请稍后重试');
      return;
    }
    setSelectedSceneSeedIds((prev) => prev.filter((assetId2) => assetId2 !== assetId));
    await loadProject();
  };

  const loadSceneRefs = useCallback(async () => {
    try {
      const res = await fetch(`/api/projects/${id}/scene-references`);
      const data = await res.json();
      if (Array.isArray(data)) setSceneRefs(getActiveSceneReferences(data as SceneReferenceRecord[]));
    } catch { /* ignore */ }
  }, [id]);

  useEffect(() => {
    const timer = window.setTimeout(() => { void loadSceneRefs(); }, 0);
    return () => window.clearTimeout(timer);
  }, [loadSceneRefs]);

  const handleCreateSceneRef = async () => {
    if (!sceneRefModal || !sceneRefName.trim()) return;
    const res = await fetch(`/api/projects/${id}/scene-references`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: sceneRefName.trim(), imageAssetId: sceneRefModal.imageAssetId, sourceJobId: sceneRefModal.jobId }),
    });
    if (res.ok) {
      setSceneRefModal(null);
      setSceneRefName('');
      await loadSceneRefs();
      await loadProject();
    } else {
      const err = await res.json().catch(() => ({}));
      alert('创建失败: ' + (err.error || '未知错误'));
    }
  };

  const openApplySceneModal = async (shotSetId: string) => {
    await loadSceneRefs();
    setApplySceneModal(shotSetId);
    setApplySceneRefId('');
    setApplyScenePrompt(project?.shotPrompt || '');
    setApplySceneProviderId(project?.providerId || '');
  };

  const handleApplySceneSubmit = async () => {
    if (!applySceneModal || !applySceneRefId || !applyScenePrompt.trim()) {
      alert('请选择场景参考图并填写提示词');
      return;
    }
    const res = await fetch(`/api/shot-sets/${applySceneModal}/apply-scene`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sceneReferenceId: applySceneRefId, prompt: applyScenePrompt.trim(), providerId: applySceneProviderId || undefined }),
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
    await loadProject();
  };

  const goTab = (next: WorkbenchTabId) => {
    const nextParams = new URLSearchParams(searchParams.toString());
    nextParams.set('tab', next);
    // 用 Next 的客户端路由推地址：与链接跳转一致（地址栏可分享、后退可用），
    // 但不会触发整页刷新，切步骤时第 3/4/5 步的组件状态保留在各自 tab 里。
    router.replace(`/projects/${id}?${nextParams.toString()}`, { scroll: false });
  };

  if (loading) {
    return (
      <div className="text-center py-16">
        <div className="mx-auto mb-4 h-8 w-8 animate-spin rounded-full border-2 border-accent border-t-transparent" />
        <p className="text-ink-tertiary">加载项目...</p>
      </div>
    );
  }

  if (!project) {
    return (
      <div className="text-center py-20">
        <p className="text-ink-secondary">项目不存在</p>
        <Link href="/projects" className="link-accent mt-2 inline-block">返回项目空间</Link>
      </div>
    );
  }

  const projectInfo: ProjectInfoValue = {
    id: project.id,
    name: project.name,
    productName: project.productName || '',
    productCode: project.productCode || '',
    productCategory: project.productCategory || '',
    storeCode: project.storeCode || '',
    productSubmodel: project.productSubmodel || '',
    productionType: project.productionType || '',
    editorName: project.editorName || '',
    namingDate: project.namingDate || '',
    hasExportIdentity: Boolean(project.currentExportIdentityId),
  };

  const hasJobs = project.jobs.length > 0;
  const hasSceneResult = sceneJobs.some((job) => job.status === 'succeeded' || job.status === 'failed');
  const hasShotSources = shotSourceImages.length > 0;
  // 新项目 = 一张图都没有、也没有任何任务：第 3/4/5 步都在内容组件前面挂一条空状态。
  const hasAnyMaterial = project.images.length > 0 || hasJobs;

  return (
    <div className="flex min-h-0 w-full min-w-0 flex-1 flex-col gap-3">
      <PageToolbar
        role={role}
        title={project.name}
        back={{ href: '/projects', label: '返回' }}
        actions={<>
          <ToolbarButton icon="logs" label="运行日志" onClick={() => setLogOpen(true)} />
          <ToolbarButton icon="settings" onClick={() => setProjectInfoOpen(true)}>项目信息</ToolbarButton>
          <a className="cap" href={`/api/projects/${id}/creative-package`}>
            <Icon name="download" size={15} />导出项目包
          </a>
        </>}
      />

      <div className="flex flex-wrap items-center gap-3">
        <WorkbenchStepNav active={activeTab} onChange={goTab} />
        {running ? (
          <div className="ml-auto flex flex-wrap items-center gap-2 text-xs text-ink-secondary">
            <span className="inline-flex items-center gap-1.5"><i className="status-dot-run" />队列运行中</span>
            <ToolbarButton onClick={() => void handleAction('pause')} disabled={!!actionLoading}>暂停</ToolbarButton>
            <ToolbarButton onClick={() => void handleAction('cancel')} disabled={!!actionLoading}>取消</ToolbarButton>
          </div>
        ) : queueStatus === 'paused' ? (
          <div className="ml-auto flex flex-wrap items-center gap-2 text-xs text-ink-secondary">
            <span className="inline-flex items-center gap-1.5"><i className="status-dot-warn" />队列已暂停</span>
            <ToolbarButton onClick={() => void handleAction('resume')} disabled={!!actionLoading}>继续</ToolbarButton>
            <ToolbarButton onClick={() => void handleAction('cancel')} disabled={!!actionLoading}>取消</ToolbarButton>
          </div>
        ) : hasJobs ? (
          <div className="ml-auto flex flex-wrap items-center gap-2 text-xs text-ink-secondary">
            <span className="inline-flex items-center gap-1.5"><i className="status-dot-idle" />队列空闲</span>
            <ToolbarButton onClick={() => void handleAction('start')} disabled={!!actionLoading}>开始</ToolbarButton>
          </div>
        ) : null}
      </div>

      <div className="flex min-h-0 w-full min-w-0 flex-1 flex-col">
        {activeTab === 'scene' ? (
          <SceneStep
            projectId={project.id}
            imageSize={project.size}
            seedImages={sceneSeedImages}
            selectedSeedId={activeSceneSeedId}
            onSelectSeed={(nextId) => setSelectedSceneSeedIds([nextId])}
            jobs={sceneJobs}
            images={project.images}
            providers={providers}
            sceneReferences={sceneReferenceByImageId}
            defaultPrompt={project.scenePrompt || ''}
            defaultProviderId={project.providerId || ''}
            queueStatus={queueStatus}
            onStart={() => void handleAction('start')}
            onPause={() => void handleAction('pause')}
            onResume={() => void handleAction('resume')}
            onCancel={() => void handleAction('cancel')}
            onMark={handleMark}
            onRetry={handleRetry}
            onRegenerate={handleRegenerate}
            onSetSceneRef={handleSetSceneRef}
            onDeleteAsset={handleDeleteAsset}
            loadProject={loadProject}
          />
        ) : null}

        {(activeTab === 'storyboard' || activeTab === 'video') && searchParams.get('filmGroup') && searchParams.get('filmClip') ? (
          <ReassembledReworkPanel
            key={`${activeTab}:${searchParams.get('filmGroup')}:${searchParams.get('filmClip')}`}
            groupId={searchParams.get('filmGroup')!}
            clipId={searchParams.get('filmClip')!}
            step={activeTab}
          />
        ) : null}

        {activeTab === 'storyboard' && !(searchParams.get('filmGroup') && searchParams.get('filmClip')) ? (
          <ShotSetStep
            projectId={project.id}
            providerOptions={providers}
            shotSourceImages={shotSourceImages}
            images={project.images}
            sceneReferences={sceneRefs}
            jobs={shotJobs}
            onUploaded={loadProject}
            onApplyScene={(shotSetId) => void openApplySceneModal(shotSetId)}
            onShotChanged={async () => { await ensureQueueRunning(); await loadProject(); }}
            onDeleteAsset={handleDeleteAsset}
          />
        ) : null}

        {activeTab === 'script' ? (
          <div className="flex min-h-0 w-full min-w-0 flex-1 flex-col gap-3">
            {!hasAnyMaterial ? (
              <StepEmptyBanner
                title="还没有可以写脚本的素材"
                description="先在「场景图」或「分镜」做出素材，再来写口播脚本。"
              />
            ) : null}
            <ScriptStudioPanel projectId={project.id} />
          </div>
        ) : null}

        {activeTab === 'video' && !(searchParams.get('filmGroup') && searchParams.get('filmClip')) ? (
          <div className="flex min-h-0 w-full min-w-0 flex-1 flex-col gap-3">
            {!hasShotSources && !hasSceneResult ? (
              <StepEmptyBanner
                title="还没有分镜组"
                description="先在「分镜」建一个分镜组，或者用自由素材工位直接传图做视频。"
              />
            ) : null}
            {/* 08 号票：第 4 步占满内容区（三栏由面板自己排），不再用整页宽的
                `.video-generation-section` 全宽壳——它按 100vw 计算会越过侧栏、横向溢出。 */}
            <div className="video-generation-section flex min-h-0 min-w-0 flex-1 flex-col">
              <div className="video-generation-heading">
                <h2 className="text-base font-semibold">视频生成</h2>
                <p className="mt-1 text-sm text-ink-secondary">选择分镜组和视频供应商，创建图生视频任务。</p>
              </div>
              <VideoGenerationPanel projectId={project.id} />
            </div>
          </div>
        ) : null}

        {activeTab === 'final-edit' ? (
          <div className="flex min-h-0 w-full min-w-0 flex-1 flex-col gap-3">
            {!hasAnyMaterial ? (
              <StepEmptyBanner
                title="还没有可用视频"
                description="先在「视频」做好视频，这里才能混剪。"
              />
            ) : null}
            <MixcutWorkspace
              projectId={project.id}
              projectName={project.name}
              projectInfo={projectInfo}
              onProjectInfoChange={handleProjectInfoSaved}
            />
          </div>
        ) : null}
      </div>

      <LogDrawer open={logOpen} projectId={project.id} autoRefresh={logOpen} onClose={() => setLogOpen(false)} />

      <ProjectInfoDialog
        open={projectInfoOpen}
        project={projectInfo}
        intent="edit"
        onClose={() => setProjectInfoOpen(false)}
        onSaved={handleProjectInfoSaved}
      />

      {sceneRefModal ? (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/30 backdrop-blur-sm p-4" onClick={() => setSceneRefModal(null)}>
          <div className="card w-full max-w-sm p-6 shadow-[0_20px_60px_rgba(0,0,0,.18)]" onClick={(event) => event.stopPropagation()}>
            <h3 className="mb-4 text-base font-semibold">设为场景参考图</h3>
            <div>
              <label className="label">名称</label>
              <input
                value={sceneRefName}
                onChange={(event) => setSceneRefName(event.target.value)}
                className="input-field mt-1"
                placeholder="例如: 现代奶油风卧室场景"
                autoFocus
              />
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <button onClick={() => setSceneRefModal(null)} className="btn-secondary btn-sm">取消</button>
              <button onClick={() => void handleCreateSceneRef()} disabled={!sceneRefName.trim()} className="btn-primary btn-sm">创建</button>
            </div>
          </div>
        </div>
      ) : null}

      {applySceneModal ? (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/30 backdrop-blur-sm p-4" onClick={() => setApplySceneModal(null)}>
          <div className="card apply-scene-dialog" onClick={(event) => event.stopPropagation()}>
            <h3 className="mb-5 text-lg font-semibold tracking-[-0.01em]">选择新场景图并生成分镜</h3>
            <div className="apply-scene-dialog-body space-y-5">
              <div>
                <label className="label generation-label">选择场景参考图</label>
                {(() => {
                  const applySceneItems: ImagePickerItem[] = sceneRefs.map((ref) => {
                    const asset = project.images.find((img) => img.id === ref.imageAssetId);
                    return { id: ref.id, label: ref.name, filename: ref.imageFilename, imageUrl: asset?.imageUrl };
                  });
                  return <ImagePickerGrid items={applySceneItems} selectedId={applySceneRefId} onSelect={setApplySceneRefId} emptyText="当前项目没有可用的场景参考图，请先在「场景参考图」面板中创建。" />;
                })()}
                {sceneRefs.length === 0 ? <p className="mt-1 text-xs text-fail">当前项目没有可用的场景参考图，请先在第 1 步把候选设为场景参考图。</p> : null}
              </div>
              <div>
                <label className="label generation-label">提示词模板</label>
                <textarea value={applyScenePrompt} onChange={(event) => setApplyScenePrompt(event.target.value)} rows={4} className="input-field generation-control generation-textarea apply-scene-textarea" />
                <p className="generation-helper">每张分镜图会作为图1（底图），场景参考图作为图2（参考图）</p>
              </div>
            </div>
            <div className="apply-scene-dialog-actions">
              <button onClick={() => setApplySceneModal(null)} className="btn-secondary btn-sm">取消</button>
              <button onClick={() => void handleApplySceneSubmit()} disabled={!applySceneRefId || !applyScenePrompt.trim()} className="btn-primary btn-sm">创建任务并开始</button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
