'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '@/components/ui/Icon';
import { ProjectInfoDialog, type ProjectInfoDialogIntent, type ProjectInfoValue } from '@/components/ProjectInfoDialog';
import { createOverlayBundlePayload, TextOverflowError } from '@/components/final-edit/text-canvas-renderer';
import { previewExportBaseName } from '@/lib/final-edit/export-identity';
import { OUTPUT_PRESETS, type ExportTargetView, type FinalEditGroupView, type MixcutContextResponse, type RenderJobRef } from '@/lib/final-edit/types';
import styles from './mixcut-content.module.css';

type ExportOutput = {
  videoFilename: string;
  coverFilename: string;
  displayDirectory: string;
  videoUrl: string;
  videoDownloadUrl: string;
  coverUrl: string;
  coverDownloadUrl: string;
};

type ExportJob = {
  id: string;
  groupId: string;
  variantId: string;
  status: string;
  phase: string;
  progress: number;
  errorMessage?: string | null;
  target?: ExportTargetView | null;
  output?: ExportOutput | null;
  renderRevision?: { groupRevision: number; variantRevision: number } | null;
};

const PHASE_LABELS: Record<string, string> = {
  queued: '等待渲染',
  preflight: '正在检查',
  rendering: '正在渲染',
  publishing: '正在写回项目',
  succeeded: '导出完成',
};

const EXPORT_ERROR_MESSAGES: Record<string, string> = {
  overlay_measurement_mismatch: '文字图层与当前样式不一致，请返回预览刷新后重试',
};

async function readJson<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.message || EXPORT_ERROR_MESSAGES[body.error] || body.error || `HTTP ${response.status}`);
  return body as T;
}

export function ExportStep({ project, group, initialVariantId, active, onBack, onGroupChange, onProjectInfoChange }: {
  project: MixcutContextResponse['project'];
  group: FinalEditGroupView;
  initialVariantId: string;
  active: boolean;
  onBack: () => void;
  onGroupChange: (group: FinalEditGroupView) => void;
  onProjectInfoChange: (project: ProjectInfoValue) => void;
}) {
  const [selectedVariantId, setSelectedVariantId] = useState(initialVariantId || group.variants[0]?.id || '');
  const [job, setJob] = useState<ExportJob | null>(null);
  const [target, setTarget] = useState<ExportTargetView | null>(null);
  const [busy, setBusy] = useState(false);
  const [restoringJob, setRestoringJob] = useState(true);
  const [message, setMessage] = useState('');
  const [revealAvailable, setRevealAvailable] = useState(false);
  const [projectInfoIntent, setProjectInfoIntent] = useState<ProjectInfoDialogIntent | null>(null);
  const pollTokenRef = useRef<symbol | null>(null);
  const variant = group.variants.find((item) => item.id === selectedVariantId) || group.variants[0] || null;
  const predictedBaseName = useMemo(() => previewExportBaseName(project.productCode, project.taskDate), [project.productCode, project.taskDate]);
  const blockingIssue = variant?.issues.find((issue) => issue.severity === 'blocking');
  const warningIssues = variant?.issues.filter((issue) => issue.severity === 'warning') ?? [];

  // ---------------------------------------------------------------------------
  // 导出新鲜度分类（D2）：render job 属于它创建时的 groupRevision + variantRevision。
  // 只有两个 revision 都与当前编辑一致的 job 才是「当前导出」；旧版成功 job 是
  // 「上一版可下载」，不得遮住当前修订号的再次导出。缺 revision 的旧 job 按
  // 历史产物处理，不猜测它与当前编辑一致。
  // ---------------------------------------------------------------------------
  const renderJobs = useMemo(
    () => group.jobs.filter((item) => item.kind === 'render' && item.variantId === variant?.id),
    [group.jobs, variant?.id],
  );
  const currentRenderJob = useMemo(() => {
    if (!variant) return null;
    return renderJobs.find((item) => item.renderRevision != null
      && item.renderRevision.groupRevision === group.revision
      && item.renderRevision.variantRevision === variant.revision) ?? null;
  }, [renderJobs, group.revision, variant]);
  const historicalSucceededJob = useMemo(() => renderJobs.find((item) => item.status === 'succeeded' && item.id !== currentRenderJob?.id) ?? null, [renderJobs, currentRenderJob?.id]);
  const jobStillListed = job ? group.jobs.some((item) => item.id === job.id) : false;
  const jobIsCurrentRevision = Boolean(job && currentRenderJob && job.id === currentRenderJob.id);
  // 刚创建、尚未出现在 group view 里的任务（jobStillListed=false）也视为当前在途；
  // 只有旧 revision 的在途任务不能遮住当前导出操作。
  const activeRenderJobInFlight = Boolean(job && ['queued', 'running'].includes(job.status) && (jobIsCurrentRevision || !jobStillListed));
  const currentRevisionExported = currentRenderJob?.status === 'succeeded';
  const activeJobId = currentRenderJob?.id || historicalSucceededJob?.id || '';

  const fetchJob = useCallback(async (id: string, signal?: AbortSignal) => {
    return readJson<ExportJob>(await fetch(`/api/final-edit-jobs/${encodeURIComponent(id)}`, { signal }));
  }, []);

  useEffect(() => {
    if (!active) return;
    void (async () => {
      try {
        const value = await readJson<{ revealInFolder: boolean }>(await fetch('/api/final-edit/capabilities'));
        setRevealAvailable(value.revealInFolder);
      } catch { setRevealAvailable(false); }
    })();
  }, [active]);

  useEffect(() => {
    if (!active) return;
    // group/variant revision 变化、切换 variant 或重新进入导出步时按分类重新取 job；
    // 刚创建、尚未出现在 group.jobs 里的在途任务（jobStillListed=false）保持展示，
    // 组件内的旧 job state 不得继续冒充当前结果。
    if (job && (!jobStillListed || job.id === activeJobId)) return;
    const controller = new AbortController();
    const requestedVariantId = variant?.id || '';
    const timer = window.setTimeout(() => {
      setRestoringJob(true);
      if (!activeJobId) { setJob(null); setRestoringJob(false); return; }
      void fetchJob(activeJobId, controller.signal).then((next) => {
        if (next.variantId !== requestedVariantId) return;
        setJob(next);
        setTarget(next.target || null);
      }).catch((error) => {
        if (!(error instanceof DOMException && error.name === 'AbortError')) setMessage(error instanceof Error ? error.message : String(error));
      }).finally(() => {
        if (!controller.signal.aborted) setRestoringJob(false);
      });
    }, 0);
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [active, activeJobId, fetchJob, job, jobStillListed, variant?.id]);

  useEffect(() => {
    if (!active || !job?.id || !['queued', 'running'].includes(job.status)) return;
    const token = Symbol(job.id);
    pollTokenRef.current = token;
    const poll = async () => {
      try {
        const next = await fetchJob(job.id);
        if (pollTokenRef.current !== token) return;
        if (next.variantId !== job.variantId) return;
        if (next.status === 'succeeded') {
          // 先取权威 group 再一次性落 job 与 group：setJob 会把 job.status 变为
          // succeeded、触发本 effect 自清理并把 token 置空，若先 setJob 再 fetch，
          // group 刷新会因 token 失效被丢弃，导出分类就只能看到陈旧的 group。
          const refreshed = await readJson<FinalEditGroupView>(await fetch(`/api/final-edit-groups/${encodeURIComponent(group.id)}`));
          if (pollTokenRef.current !== token) return;
          setJob(next);
          if (next.target) setTarget(next.target);
          onGroupChange(refreshed);
          return;
        }
        setJob(next);
        if (next.target) setTarget(next.target);
      } catch (error) {
        if (pollTokenRef.current === token) setMessage(error instanceof Error ? error.message : String(error));
      }
    };
    const immediate = window.setTimeout(() => void poll(), 0);
    const timer = window.setInterval(() => void poll(), 1500);
    return () => {
      pollTokenRef.current = null;
      window.clearTimeout(immediate);
      window.clearInterval(timer);
    };
  }, [active, fetchJob, group.id, job?.id, job?.status, job?.variantId, onGroupChange]);

  const startExport = async (productCode = project.productCode) => {
    if (!variant || busy || blockingIssue || !productCode.trim()) return;
    setBusy(true);
    setMessage('正在冻结当前文字与封面图层…');
    try {
      const payload = await createOverlayBundlePayload(group, variant.outputPreset);
      const bundle = await readJson<{ id: string }>(await fetch(`/api/final-edit-groups/${encodeURIComponent(group.id)}/overlay-bundles/${variant.outputPreset}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
      }));
      const created = await readJson<RenderJobRef>(await fetch(`/api/final-edit-variants/${encodeURIComponent(variant.id)}/render`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ groupId: group.id, expectedGroupRevision: group.revision, expectedVariantRevision: variant.revision, overlayBundleId: bundle.id }),
      }));
      setTarget(created.target);
      setJob({ id: created.id, groupId: created.groupId, variantId: created.variantId, status: created.status, phase: 'queued', progress: 0, output: null });
      setRestoringJob(false);
      setMessage('已进入本地串行渲染队列');
    } catch (error) {
      setMessage(error instanceof TextOverflowError ? error.message : error instanceof Error ? error.message : String(error));
    } finally { setBusy(false); }
  };

  const retry = async () => {
    if (!job || busy) return;
    setBusy(true);
    try {
      const queued = await readJson<{ id: string; status: string }>(await fetch(`/api/final-edit-jobs/${encodeURIComponent(job.id)}/retry`, { method: 'POST' }));
      setJob({ ...job, status: queued.status, phase: 'queued', progress: 0, errorMessage: null });
      setMessage('已重新加入渲染队列');
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };

  const reveal = async () => {
    if (!job) return;
    try {
      await readJson(await fetch(`/api/final-edit-jobs/${encodeURIComponent(job.id)}/reveal`, { method: 'POST', headers: { 'X-Creative-Studio-Action': 'reveal' } }));
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
  };

  const effectiveTarget = target || {
    taskName: project.name,
    productCode: project.productCode,
    taskDate: project.taskDate,
    videoFilename: predictedBaseName ? `${predictedBaseName}.mp4` : '填写产品型号后自动生成',
    coverFilename: predictedBaseName ? `${predictedBaseName}-封面.jpg` : '填写产品型号后自动生成',
    displayDirectory: `工作台/${project.name}/成片/`,
  };
  const progress = Math.max(0, Math.min(1, Number(job?.progress || 0)));
  const statusText = activeRenderJobInFlight && job
    ? `${PHASE_LABELS[job.phase] || job.phase} · ${Math.round(progress * 100)}%`
    : job?.status === 'failed'
      ? '上次导出失败'
      : currentRevisionExported
        ? '当前修改已导出'
        : job?.status === 'succeeded'
          ? '上一版可下载'
          : '尚未开始';
  const canExport = !blockingIssue && Boolean(project.productCode.trim());
  const canStartExport = Boolean(variant) && !blockingIssue;
  const checks = variant ? [
    { pass: variant.timeline.clips.length > 0, label: variant.timeline.clips.length ? `时间轴：${variant.timeline.clips.length} 个片段` : '时间轴：缺少片段' },
    { pass: group.subtitleCues.length > 0, label: group.subtitleCues.length ? `字幕：${group.subtitleCues.length} 条` : '字幕：无字幕' },
    { pass: Boolean(variant.cover.coverKey), label: `封面：${variant.cover.coverKey ? '已就绪' : '未设置'}` },
    { pass: Boolean(variant.bgm.trackId), label: `BGM：${variant.bgm.trackId ? '已选择' : '不使用'}` },
  ] : [];

  return (
    <>
      <header className={styles.stepHead}>
        <div>
          <p className={`${styles.eyebrow} ${styles.stepTitle}`} style={{ fontSize: 11 }}>STEP 04</p>
          <h1 className={styles.stepTitle} id="mixcut-export-heading">导出并写回项目</h1>
          <p className={styles.stepSub}>成片和封面会保留渲染副本，并原子写入当前项目的成片目录。</p>
        </div>
        <div className={styles.stepActions}>
          <button type="button" className={styles.btn} onClick={onBack}><Icon name="chevron-left" size={14} />返回预览修复</button>
        </div>
      </header>

      <div className={styles.stepScroll}>
        {variant && (
          <div className={styles.readyBanner}>
            <span className={styles.readyOk}><Icon name="check" size={14} /></span>
            <div>
              <div className={styles.readyT}>AI 时间线已就绪</div>
              <div className={styles.readyS}>{variant.timeline.clips.length} 个片段 · 约 {(group.totalDurationUs / 1_000_000).toFixed(0)} 秒 · 音色：{group.script?.narrationConfig?.voice || '默认'}</div>
            </div>
            <span className={styles.spacer} />
            <span className={`${styles.chip} ${styles.chipGrey}`}>{variant.outputPreset.replace('x', ':')}</span>
            <span className={`${styles.chip} ${styles.chipGrey}`}>字幕</span>
            <span className={`${styles.chip} ${styles.chipGrey}`}>BGM</span>
            <span className={`${styles.chip} ${styles.chipGrey}`}>口播</span>
          </div>
        )}

        {warningIssues.length > 0 && (
          <div className={styles.warningNotice} style={{ marginBottom: 12, flexDirection: 'column', alignItems: 'stretch', gap: 4 }}>
            {warningIssues.map((issue, index) => (
              <span key={`${issue.code}-${issue.targetId ?? index}`} style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                <Icon name="alert" size={13} />{issue.message}
              </span>
            ))}
          </div>
        )}

        <div className={styles.twoCol}>
          <section className={styles.card}>
            <div className={styles.cardHead}>
              <div className={styles.cardTitle}>导出身份</div>
              <button type="button" className={styles.textButton} disabled={busy} onClick={() => setProjectInfoIntent('edit')}>编辑项目信息</button>
            </div>
            <div className={styles.kv}><span className={styles.kvK}>任务名</span><span className={styles.kvV}>{effectiveTarget.taskName}</span></div>
            <div className={styles.kv}><span className={styles.kvK}>产品型号</span><span className={styles.kvV}>{effectiveTarget.productCode || '未填写'}</span></div>
            <div className={styles.kv}><span className={styles.kvK}>任务日期</span><span className={styles.kvV}>{effectiveTarget.taskDate}</span></div>
            <div className={styles.kv}><span className={styles.kvK}>成片文件</span><span className={styles.kvV}>{job?.output?.videoFilename || effectiveTarget.videoFilename}</span></div>
            <div className={styles.kv}><span className={styles.kvK}>封面文件</span><span className={styles.kvV}>{job?.output?.coverFilename || effectiveTarget.coverFilename}</span></div>
            <div className={styles.kv}><span className={styles.kvK}>写入位置</span><span className={styles.kvV}>{job?.output?.displayDirectory || effectiveTarget.displayDirectory}</span></div>
          </section>

          <section className={styles.card}>
            <div className={styles.cardHead}><div className={styles.cardTitle}>渲染设置</div></div>
            <label className={styles.field}>
              <span>成片草稿</span>
              <select aria-label="选择导出草稿" value={variant?.id || ''} disabled={busy || restoringJob || activeRenderJobInFlight} onChange={(event) => { setSelectedVariantId(event.target.value); setJob(null); setTarget(null); setRestoringJob(true); setMessage(''); }}>
                {group.variants.map((item) => <option key={item.id} value={item.id}>成片 {item.indexNum} · {item.outputPreset.replace('x', ':')}</option>)}
              </select>
            </label>
            <div className={styles.kv}><span className={styles.kvK}>分辨率</span><span className={styles.kvV}>{variant ? `${OUTPUT_PRESETS[variant.outputPreset].width} × ${OUTPUT_PRESETS[variant.outputPreset].height} · 24 fps` : '—'}</span></div>
            <div className={styles.kv}><span className={styles.kvK}>预计时长</span><span className={styles.kvV}>{(group.totalDurationUs / 1_000_000).toFixed(2)} 秒</span></div>
            <div className={styles.checkGrid}>
              {checks.map((check) => (
                <div key={check.label} className={`${styles.checkItem} ${check.pass ? styles.checkPass : styles.checkMiss}`}>
                  <span className={styles.checkCk}><Icon name="check-circle" size={14} /></span>{check.label}
                </div>
              ))}
            </div>
            <div style={{ marginTop: 10 }}><span className={`${styles.chip} ${canExport ? styles.chipGreen : styles.chipGrey}`}>{canExport ? '可以导出' : '尚不满足条件'}</span></div>
            {variant?.issues.filter((issue) => issue.severity === 'blocking').map((issue, index) => <p key={`${issue.code}-${index}`} className={styles.exportBlocker}><Icon name="alert" size={14} />{issue.message}</p>)}
            {!project.productCode.trim() && (
              <p className={styles.exportBlocker}>
                <Icon name="alert" size={14} />
                <span>请先填写产品型号</span>
                <button type="button" className={styles.textButton} onClick={() => setProjectInfoIntent('export')}>立即填写</button>
              </p>
            )}
          </section>
        </div>

        <section className={styles.card} data-testid="mixcut-export-status-card">
          <div className={styles.cardHead}>
            <div>
              <div className={styles.cardTitle}>{restoringJob ? '正在恢复导出任务' : statusText}</div>
              <div className={styles.cardSub}>{job?.status === 'succeeded' ? '文件已写回项目' : message || '准备好后开始本地渲染'}</div>
            </div>
            <span className={styles.flowHint}>导出在本地串行队列渲染，可离开页面后再回来查看。</span>
          </div>
          <div className={styles.progBar} role="progressbar" aria-label="导出进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress * 100)} style={{ marginBottom: 14 }}><i style={{ width: `${progress * 100}%` }} /></div>
          {job?.status === 'failed' && <p className={styles.exportBlocker}>{job.errorMessage || '渲染失败'}</p>}
          <div className={styles.ctaZone}>
            {!restoringJob && !currentRevisionExported && !activeRenderJobInFlight ? (
              <button
                type="button"
                className={`${styles.btn} ${styles.primary} ${styles.big}`}
                disabled={busy || !canStartExport}
                onClick={() => {
                  if (project.productCode.trim()) void startExport();
                  else setProjectInfoIntent('export');
                }}
              >
                <Icon name="download" size={16} />
                {project.productCode.trim() ? (historicalSucceededJob ? '重新导出当前修改' : '开始导出') : '填写信息并导出'}
              </button>
            ) : null}
            {job?.status === 'failed' && <button type="button" className={`${styles.btn} ${styles.primary}`} disabled={busy} onClick={() => void retry()}><Icon name="retry" size={15} />重试导出</button>}
            {currentRevisionExported && job?.output && (
              <div className={styles.dlRow}>
                <a className={styles.primaryButton} href={job.output.videoDownloadUrl}><Icon name="download" size={15} />下载视频</a>
                <a className={styles.secondaryButton} href={job.output.coverDownloadUrl}><Icon name="image" size={15} />下载封面</a>
                {revealAvailable && <button type="button" className={styles.secondaryButton} onClick={() => void reveal()}><Icon name="folder" size={15} />在文件夹中查看</button>}
              </div>
            )}
            {historicalSucceededJob && !currentRevisionExported && (
              <div className={styles.dlRow} data-testid="mixcut-previous-export-downloads">
                <span className={styles.flowHint}>上一版可下载：</span>
                <a className={styles.secondaryButton} href={`/api/final-edit-jobs/${encodeURIComponent(historicalSucceededJob.id)}/video?download=1`}><Icon name="download" size={14} />下载上一版视频</a>
                <a className={styles.secondaryButton} href={`/api/final-edit-jobs/${encodeURIComponent(historicalSucceededJob.id)}/cover?download=1`}><Icon name="image" size={14} />下载上一版封面</a>
              </div>
            )}
            <div className={styles.dlRow}>
              <a className={styles.secondaryButton} href={`/api/final-edit-groups/${encodeURIComponent(group.id)}/download`}><Icon name="download" size={14} />下载整组 ZIP</a>
              <a className={styles.secondaryButton} href={`/api/projects/${encodeURIComponent(project.id)}/creative-package`}><Icon name="download" size={14} />下载项目创意包</a>
            </div>
          </div>
        </section>

        {job?.status === 'succeeded' && job.output && <section className={styles.exportResult} aria-label="导出结果"><video controls preload="metadata" src={job.output.videoUrl} /><img src={job.output.coverUrl} alt="导出封面" /></section>}
      </div>

      <ProjectInfoDialog
        open={projectInfoIntent !== null}
        project={project}
        intent={projectInfoIntent || 'edit'}
        onClose={() => setProjectInfoIntent(null)}
        onSaved={(updatedProject) => {
          onProjectInfoChange(updatedProject);
          if (projectInfoIntent === 'export') void startExport(updatedProject.productCode);
        }}
      />
    </>
  );
}
