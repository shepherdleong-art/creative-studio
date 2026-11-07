'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Segmented, Tag } from '@/components/ui/Appearance';
import { Icon } from '@/components/ui/Icon';
import { MAX_SHOTS_PER_SET } from '@/lib/shot-set-domain';
import { getGptImage2AspectRatio } from '@/lib/gpt-image-2-size-presets';
import FurniturePromptControls from '@/components/FurniturePromptControls';
import { getResultJobKind, type SceneReferenceSummary } from '@/lib/result-gallery-jobs';
import {
  clampIndex,
  hasShotResult,
  isSceneViewMode,
  resolveShotResultState,
  stepIndex,
  type SceneViewMode,
} from '@/lib/workbench-shots';
import { MainHead, PaneHead, PaneList, SettingsHeading, StepFrame } from './Frame';
import { StepEmpty } from './StepEmpty';
import UploadDrop from './UploadDrop';
import s from './workbench.module.css';
import {
  getJobDisplayName,
  getJobResultUrl,
  isActiveJobStatus,
  type WorkbenchImage,
  type WorkbenchJob,
  type WorkbenchProvider,
} from './types';

const MARK_LABELS: Record<string, string> = { available: '可用', rework: '待返工', discard: '废弃' };

function markTone(mark: string): 'ok' | 'warn' | 'idle' {
  if (mark === 'available') return 'ok';
  if (mark === 'rework') return 'warn';
  return 'idle';
}

/**
 * 第 1 步 新场景图（07 号票）。
 *
 * 布局按规格：左栏原始场景图 A + 候选列表，中间**默认对照视图**（原图在左、
 * 选中候选在右，下面一排候选小图），右栏生成参数。
 *
 * 三条验收点长在这里：
 * 1. 左右键切候选会 `preventDefault`，**不翻页**（也不和横向滚动条抢方向键）；
 * 2. 对照 ↔ 网格往返，选中的候选保持不变（选中态在组件 state，不随视图重置）；
 * 3. 右栏**没有并发设置**；按钮文案是「生成 N 张」。
 */
export default function SceneStep({
  projectId,
  imageSize,
  seedImages,
  selectedSeedId,
  onSelectSeed,
  jobs,
  images,
  providers,
  sceneReferences,
  queueStatus,
  onStart,
  onPause,
  onResume,
  onCancel,
  onMark,
  onRetry,
  onRegenerate,
  onSetSceneRef,
  onDeleteAsset,
  loadProject,
}: {
  projectId: string;
  imageSize?: string;
  seedImages: WorkbenchImage[];
  selectedSeedId: string;
  onSelectSeed: (id: string) => void;
  jobs: WorkbenchJob[];
  images: WorkbenchImage[];
  providers: WorkbenchProvider[];
  sceneReferences: Map<string, SceneReferenceSummary>;
  queueStatus: 'idle' | 'running' | 'paused';
  onStart: () => void;
  onPause: () => void;
  onResume: () => void;
  onCancel: () => void;
  onMark: (jobId: string, mark: string) => void | Promise<void>;
  onRetry: (jobId: string) => void | Promise<void>;
  onRegenerate: (jobId: string, prompt: string, providerId: string) => void | Promise<void>;
  onSetSceneRef: (jobId: string, imageAssetId: string) => void;
  onDeleteAsset: (assetId: string) => void | Promise<void>;
  loadProject: () => void | Promise<void>;
}) {
  const [view, setView] = useState<SceneViewMode>('compare');
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [prompt, setPrompt] = useState('');
  const [count, setCount] = useState(4);
  const [providerId, setProviderId] = useState('');
  const [generating, setGenerating] = useState(false);
  const [promptError, setPromptError] = useState('');
  const [regenOpen, setRegenOpen] = useState(false);
  const [regenPrompt, setRegenPrompt] = useState('');
  const promptSaveRef = useRef(Promise.resolve());
  const promptLoadedRef = useRef(false);

  const imageById = useMemo(() => new Map(images.map((image) => [image.id, image])), [images]);
  const selectableProviders = useMemo(
    () => providers.filter((provider) => provider.enabled && provider.hasApiKey),
    [providers],
  );
  const effectiveProviderId = selectableProviders.some((provider) => provider.id === providerId)
    ? providerId
    : selectableProviders[0]?.id ?? '';

  // 默认场景提示词与供应商来自项目（选类目会同步到项目，再读回来）。
  useEffect(() => {
    if (promptLoadedRef.current) return;
    let active = true;
    fetch(`/api/projects/${projectId}`)
      .then((response) => response.json())
      .then((data: { scenePrompt?: string; providerId?: string }) => {
        if (!active) return;
        promptLoadedRef.current = true;
        setPrompt((current) => (current ? current : data.scenePrompt || ''));
        if (data.providerId) setProviderId((current) => current || data.providerId || '');
      })
      .catch(() => { /* 提示词读不到就留空，用户自己填 */ });
    return () => { active = false; };
  }, [projectId]);

  // 候选 = 已出结果或已失败的任务；排队/生成中的任务只占位、不可选中。
  const candidates = useMemo(
    () => jobs.filter((job) => {
      const kind = getResultJobKind(job);
      return kind === 'succeeded' || kind === 'failed';
    }),
    [jobs],
  );
  // 选中的候选是**派生**的：用户点过哪张就记哪张，但它被删/刷新掉时自动回到第一张，
  // 不需要在 effect 里回写 state（那样会多一轮渲染，也容易和轮询打架）。
  const selectedIndex = selectedJobId ? candidates.findIndex((job) => job.id === selectedJobId) : -1;
  const effectiveSelectedId = selectedIndex >= 0 ? selectedJobId : (candidates[0]?.id ?? null);
  const effectiveIndex = effectiveSelectedId ? candidates.findIndex((job) => job.id === effectiveSelectedId) : -1;
  const selectedJob = effectiveIndex >= 0 ? candidates[effectiveIndex] : null;

  const stepCandidate = useCallback((delta: number) => {
    if (candidates.length === 0) return;
    const current = effectiveIndex >= 0 ? effectiveIndex : 0;
    const nextIndex = stepIndex(current, delta, candidates.length);
    setSelectedJobId(candidates[nextIndex].id);
  }, [candidates, effectiveIndex]);

  // 左右键切候选、不翻页：焦点在输入框/文本域里时不抢键。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      if (event.altKey || event.ctrlKey || event.metaKey) return;
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target?.isContentEditable) return;
      // 弹窗（新建分镜组、项目信息、删除确认）开着时方向键归它们。
      if (document.querySelector('.dialog-scrim')) return;
      if (candidates.length < 2) return;
      event.preventDefault();
      stepCandidate(event.key === 'ArrowRight' ? 1 : -1);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [candidates.length, stepCandidate]);

  const selectedSeed = seedImages.find((image) => image.id === selectedSeedId) ?? null;
  const selectedResultUrl = getJobResultUrl(selectedJob ?? undefined, imageById);
  const selectedKind = selectedJob ? getResultJobKind(selectedJob) : 'empty';
  const selectedState = resolveShotResultState(selectedJob?.status, Boolean(selectedResultUrl));
  const selectedReference = selectedJob?.outputImageId ? sceneReferences.get(selectedJob.outputImageId) : undefined;
  const marked = hasShotResult(selectedState);

  const activeCount = jobs.filter((job) => isActiveJobStatus(job.status)).length;
  const succeededCount = jobs.filter((job) => getResultJobKind(job) === 'succeeded').length;
  const failedCount = jobs.filter((job) => getResultJobKind(job) === 'failed').length;
  const pendingCount = jobs.filter((job) => job.status === 'pending').length;
  const running = queueStatus === 'running';
  const hasCandidates = candidates.length > 0;
  const showEmpty = seedImages.length === 0;

  const savePrompt = (nextPrompt: string) => {
    promptSaveRef.current = promptSaveRef.current
      .catch(() => { /* 上一次失败不阻塞下一次 */ })
      .then(async () => {
        const response = await fetch(`/api/projects/${projectId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ scenePrompt: nextPrompt }),
        });
        if (!response.ok) throw new Error('类目与场景同步失败，请重新选择');
        setPromptError('');
      })
      .catch((error: unknown) => {
        setPromptError(error instanceof Error ? error.message : '同步失败');
      });
  };

  const submitGeneration = async () => {
    if (!selectedSeed) {
      window.alert('请先在左栏选择一张原始场景图 A');
      return;
    }
    if (!prompt.trim()) {
      window.alert('请输入场景提示词');
      return;
    }
    if (!effectiveProviderId) {
      window.alert('请选择可用供应商');
      return;
    }
    setGenerating(true);
    try {
      await promptSaveRef.current;
      const response = await fetch(`/api/projects/${projectId}/scene-jobs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sceneSeedImageId: selectedSeed.id,
          scenePrompt: prompt.trim(),
          generationCount: count,
          providerId: effectiveProviderId,
        }),
      });
      const data = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) {
        window.alert(`创建失败: ${data.error || '未知错误'}`);
        return;
      }
      onStart();
      await loadProject();
    } catch (error) {
      window.alert(`创建失败: ${String(error)}`);
    } finally {
      setGenerating(false);
    }
  };

  const openRegen = () => {
    if (!selectedJob) return;
    setRegenPrompt(selectedJob.prompt || prompt);
    setRegenOpen(true);
  };

  const submitRegen = async () => {
    if (!selectedJob) return;
    if (!regenPrompt.trim()) {
      window.alert('请输入提示词');
      return;
    }
    await onRegenerate(selectedJob.id, regenPrompt.trim(), effectiveProviderId);
    setRegenOpen(false);
  };

  return (
    <div className={s.page}>
      <StepFrame
        left={<>
          <PaneHead action={<Tag tone={seedImages.length > 0 ? 'ok' : 'idle'}>{seedImages.length} 张</Tag>}>
            原始场景图
          </PaneHead>
          <PaneList>
            {seedImages.map((image) => (
              <div key={image.id} className={s.itemWrap}>
                <button
                  type="button"
                  className={s.item}
                  aria-current={image.id === selectedSeedId}
                  onClick={() => onSelectSeed(image.id)}
                >
                  {image.imageUrl
                    ? <img src={image.imageUrl} alt={image.filename} />
                    : <span className={s.itemThumb}><Icon name="image" size={15} /></span>}
                  <span className={s.itemBody}>
                    <b title={image.filename}>{image.filename}</b>
                    <small>{image.id === selectedSeedId ? '已选为输入' : '点一下换成输入'}</small>
                  </span>
                </button>
                <button
                  type="button"
                  className={s.itemDelete}
                  aria-label={`删除 ${image.filename}`}
                  title="删除这张图"
                  onClick={() => void onDeleteAsset(image.id)}
                ><Icon name="close" size={12} /></button>
              </div>
            ))}
            {seedImages.length === 0 ? <p className={s.note}>还没有原始场景图。</p> : null}
          </PaneList>
          <UploadDrop
            projectId={projectId}
            usage="scene_seed"
            label="上传原始场景图"
            hint="拖入或点击，可多选"
            maxFiles={MAX_SHOTS_PER_SET}
            onUploaded={loadProject}
          />
          <PaneHead>候选</PaneHead>
          <PaneList>
            {hasCandidates ? candidates.map((job, index) => {
              const url = getJobResultUrl(job, imageById);
              const kind = getResultJobKind(job);
              const reference = job.outputImageId ? sceneReferences.get(job.outputImageId) : undefined;
              return (
                <button
                  key={job.id}
                  type="button"
                  className={s.item}
                  aria-current={job.id === effectiveSelectedId}
                  onClick={() => setSelectedJobId(job.id)}
                >
                  {url
                    ? <img src={url} alt={getJobDisplayName(job, `候选 ${index + 1}`)} />
                    : <span className={s.itemThumb}><Icon name={kind === 'failed' ? 'alert' : 'logs'} size={15} /></span>}
                  <span className={s.itemBody}>
                    <b>{kind === 'succeeded' ? '候选' : '未生成'} {index + 1}</b>
                    <small className={s.itemDot}>
                      {job.reviewMark
                        ? <Tag tone={markTone(job.reviewMark)}>{MARK_LABELS[job.reviewMark]}</Tag>
                        : kind === 'failed' ? <Tag tone="fail">失败</Tag> : <Tag tone="idle">未标记</Tag>}
                      {reference ? <Tag tone="run">参考图</Tag> : null}
                    </small>
                  </span>
                </button>
              );
            }) : <p className={s.note}>把候选标成可用或设为场景参考图，后面的分镜会用到。</p>}
          </PaneList>
        </>}
        main={<>
          <MainHead
            title={showEmpty ? '还没有原始场景图' : '候选'}
            note={showEmpty
              ? '先放一张实拍或产品图，AI 换场景时会保持产品不变。'
              : hasCandidates
                ? `${candidates.length} 张${activeCount > 0 ? `，${activeCount} 张还在生成` : ''}`
                : '右边填好参数，生成第一批'}
          >
            <Segmented<SceneViewMode>
              value={view}
              onChange={(next) => { if (isSceneViewMode(next)) setView(next); }}
              options={[{ value: 'compare', label: '对照' }, { value: 'grid', label: '网格' }]}
              label="候选视图"
              size="small"
              semantics="toggle"
            />
          </MainHead>

          {showEmpty ? (
            <div className={s.emptyWrap}>
              <StepEmpty
                title="先放一张原始场景图"
                description="放一张实拍或产品图，AI 换场景时会保持产品不变。"
                icon="image"
                action={<UploadDrop projectId={projectId} usage="scene_seed" label="上传图片" hint="支持多选" onUploaded={loadProject} solid />}
              />
            </div>
          ) : view === 'grid' ? (
            <div className={s.grid} role="listbox" aria-label="候选网格">
              {hasCandidates ? candidates.map((job, index) => {
                const url = getJobResultUrl(job, imageById);
                const kind = getResultJobKind(job);
                const reference = job.outputImageId ? sceneReferences.get(job.outputImageId) : undefined;
                return (
                  <button
                    key={job.id}
                    type="button"
                    role="option"
                    aria-selected={job.id === effectiveSelectedId}
                    aria-current={job.id === effectiveSelectedId}
                    className={s.card}
                    onClick={() => setSelectedJobId(job.id)}
                  >
                    <span className={s.cardBox}>
                      {url
                        ? <img src={url} alt={getJobDisplayName(job, `候选 ${index + 1}`)} loading="lazy" />
                        : <span className={`${s.placeholder} ${kind === 'failed' ? s.placeholderFail : ''}`}>
                            {kind === 'failed'
                              ? <><b>这张没生成出来</b><span>{job.errorMessage || '可以重新生成'}</span></>
                              : <span className={s.spin} />}
                          </span>}
                      {reference ? <span className={s.thumbBadge}>参考</span> : null}
                    </span>
                    <span className={s.cardMeta}>
                      <b>候选 {index + 1}</b>
                      {job.reviewMark
                        ? <Tag tone={markTone(job.reviewMark)}>{MARK_LABELS[job.reviewMark]}</Tag>
                        : <Tag tone={kind === 'failed' ? 'fail' : 'idle'}>{kind === 'failed' ? '失败' : '未标记'}</Tag>}
                    </span>
                  </button>
                );
              }) : <p className={s.note}>还没有候选。右边填好参数后点「生成 {count} 张」。</p>}
            </div>
          ) : (
            <div className={s.compare}>
              <figure className={s.figure}>
                <div className={s.frameBox}>
                  {selectedSeed?.imageUrl
                    ? <img src={selectedSeed.imageUrl} alt="原始场景图" />
                    : <span className={s.placeholder}><Icon name="image" size={22} /><span>原图不可用</span></span>}
                </div>
                <figcaption className={s.caption}>
                  <b>原图</b>
                  <span title={selectedSeed?.filename}>{selectedSeed?.filename || ''}</span>
                </figcaption>
              </figure>
              <figure className={s.figure}>
                <div className={s.frameBox}>
                  {selectedJob ? (
                    selectedResultUrl
                      ? <img src={selectedResultUrl} alt="候选结果" />
                      : <span className={`${s.placeholder} ${selectedKind === 'failed' ? s.placeholderFail : ''}`}>
                          {selectedKind === 'failed'
                            ? <><b>这张没生成出来</b><span>{selectedJob.errorMessage || '可以重新生成'}</span>
                                <button type="button" className="cap" onClick={() => void onRetry(selectedJob.id)}>重试</button></>
                            : <><span className={s.spin} /><span>生成中</span></>}
                        </span>
                  ) : (
                    <span className={s.placeholder}><Icon name="image" size={22} /><b>还没有候选</b><span>右边填好参数，生成第一批</span></span>
                  )}
                  {selectedReference ? <span className={s.openingBadge}>场景参考图</span> : null}
                </div>
                <figcaption className={s.caption}>
                  <b>{selectedJob ? `候选 ${effectiveIndex + 1}` : '候选'}</b>
                  <span>
                    {hasShotResult(selectedState)
                      ? (selectedJob?.reviewMark ? MARK_LABELS[selectedJob.reviewMark] : '未标记')
                      : selectedState === 'failed' ? '失败' : hasCandidates ? '生成中' : ''}
                  </span>
                </figcaption>
              </figure>
            </div>
          )}

          {!showEmpty && hasCandidates && view === 'compare' ? (
            <div className={s.strip} aria-label="候选缩略图">
              {candidates.map((job, index) => {
                const url = getJobResultUrl(job, imageById);
                const kind = getResultJobKind(job);
                return (
                  <button
                    key={job.id}
                    type="button"
                    className={s.thumb}
                    aria-current={job.id === effectiveSelectedId}
                    aria-label={`候选 ${index + 1}`}
                    onClick={() => setSelectedJobId(job.id)}
                  >
                    {url ? <img src={url} alt={`候选 ${index + 1}`} /> : <span className={s.thumbBox} />}
                    <figcaption>
                      <b>{index + 1}</b>
                      <i className={`status-dot-${kind === 'failed' ? 'fail' : job.reviewMark === 'available' ? 'ok' : job.reviewMark === 'rework' ? 'warn' : 'idle'}`} />
                    </figcaption>
                  </button>
                );
              })}
            </div>
          ) : null}

          {regenOpen && selectedJob ? (
            <div className={s.regenBox}>
              <label className={s.field}>
                <span>提示词</span>
                <textarea className={s.textarea} rows={3} value={regenPrompt} onChange={(event) => setRegenPrompt(event.target.value)} />
              </label>
              <div className={s.dialogRow}>
                <span className={s.dialogFootNote}>重新生成会保留这次的结果，旧候选不会丢。</span>
                <button type="button" className="cap" onClick={() => setRegenOpen(false)}>取消</button>
                <button type="button" className="cap cap-primary" onClick={() => void submitRegen()}>重新生成</button>
              </div>
            </div>
          ) : null}

          {!showEmpty ? (
            <div className={s.actions}>
              <button
                type="button"
                className="cap"
                aria-pressed={selectedJob?.reviewMark === 'available'}
                disabled={!marked}
                onClick={() => selectedJob && void onMark(selectedJob.id, 'available')}
              ><Icon name="check" size={14} />可用</button>
              <button
                type="button"
                className="cap"
                aria-pressed={selectedJob?.reviewMark === 'rework'}
                disabled={!marked}
                onClick={() => selectedJob && void onMark(selectedJob.id, 'rework')}
              ><Icon name="retry" size={14} />待返工</button>
              <button
                type="button"
                className="cap"
                aria-pressed={selectedJob?.reviewMark === 'discard'}
                disabled={!marked}
                onClick={() => selectedJob && void onMark(selectedJob.id, 'discard')}
              ><Icon name="trash" size={14} />废弃</button>
              <hr />
              <button type="button" className="cap" disabled={!marked} onClick={openRegen}>
                <Icon name="retry" size={14} />重新生成
              </button>
              <button
                type="button"
                className="cap"
                disabled={!marked || !selectedJob?.outputImageId || Boolean(selectedReference)}
                onClick={() => { if (selectedJob?.outputImageId) onSetSceneRef(selectedJob.id, selectedJob.outputImageId); }}
              ><Icon name="video" size={14} />设为场景参考图</button>
              {selectedResultUrl ? (
                <a className="cap" href={selectedResultUrl} download><Icon name="download" size={14} />下载</a>
              ) : null}
              <span className={s.stretch} />
              <span className={s.note}>
                {candidates.length > 1 ? `左右键切换（${clampIndex(effectiveIndex, candidates.length) + 1}/${candidates.length}）` : null}
              </span>
            </div>
          ) : null}
        </>}
        right={<>
          <SettingsHeading>生成参数</SettingsHeading>
          <div className={s.settingsBody}>
            <FurniturePromptControls prompt={prompt} onChange={(next) => { setPrompt(next); savePrompt(next); }} />
            <label className={s.field}>
              <span>场景提示词</span>
              <textarea
                className={s.textarea}
                rows={5}
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                onBlur={() => savePrompt(prompt)}
                placeholder="描述想要的场景；选类目会自动带出提示词"
              />
            </label>
            <p className={s.note} role="status">{promptError || '类目和场景会自动同步到分镜提示词。'}</p>

            {selectableProviders.length > 0 ? (
              <label className={s.field}>
                <span>供应商</span>
                <select
                  className={s.select}
                  value={effectiveProviderId}
                  onChange={(event) => setProviderId(event.target.value)}
                >
                  {selectableProviders.map((provider) => (
                    <option key={provider.id} value={provider.id}>{provider.name}（{provider.model}）</option>
                  ))}
                </select>
              </label>
            ) : (
              <p className={s.errorText}>
                当前没有可用图片供应商，请先到 <a className="link-accent" href="/settings">供应商配置</a> 启用并填写 Key。
              </p>
            )}

            <div className={s.field}>
              <span>数量</span>
              <span className={s.stepper}>
                <button
                  type="button"
                  className={s.stepperBtn}
                  aria-label="减少数量"
                  disabled={count <= 1}
                  onClick={() => setCount((value) => Math.max(1, value - 1))}
                ><Icon name="minus" size={13} /></button>
                <span className={s.stepperValue} aria-live="polite">{count}</span>
                <button
                  type="button"
                  className={s.stepperBtn}
                  aria-label="增加数量"
                  disabled={count >= 9}
                  onClick={() => setCount((value) => Math.min(9, value + 1))}
                ><Icon name="plus" size={13} /></button>
              </span>
            </div>
            <p className={s.note}>
              输出画幅：{getGptImage2AspectRatio(imageSize) || '自定义'}{imageSize ? ` · ${imageSize}` : ''}（项目创建时锁定）。一次最多 9 张。
            </p>
          </div>

          <button
            type="button"
            className={s.go}
            disabled={generating || !selectedSeed || !effectiveProviderId}
            onClick={() => void submitGeneration()}
          >{generating ? '创建中…' : `生成 ${count} 张`}</button>
          {!selectedSeed ? <p className={s.note}>先在左栏选择 1 张原始场景图 A。</p> : null}
        </>}
      />

      <div className={s.status}>
        <b><i className={`status-dot-${running ? 'run' : 'idle'}`} />{running ? '生成中' : queueStatus === 'paused' ? '已暂停' : '队列空闲'}</b>
        <span>排队中 {pendingCount}</span>
        <span>生成中 {activeCount}</span>
        <span className="text-ok">成功 {succeededCount}</span>
        <span className={failedCount > 0 ? 'text-fail' : undefined}>失败 {failedCount}</span>
        <span className={s.statusActions}>
          {!running && pendingCount > 0 && queueStatus !== 'paused'
            ? <button type="button" className="cap" onClick={onStart}>开始</button> : null}
          {running ? <button type="button" className="cap" onClick={onPause}>暂停</button> : null}
          {queueStatus === 'paused' ? <button type="button" className="cap cap-primary" onClick={onResume}>继续</button> : null}
          {running || queueStatus === 'paused' ? <button type="button" className="cap" onClick={onCancel}>取消</button> : null}
        </span>
      </div>
    </div>
  );
}
