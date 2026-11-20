'use client';

import { useCallback, useEffect, useState } from 'react';
import { EmptyState, Tag, ToolbarButton } from '@/components/ui/Appearance';
import { Dialog } from '@/components/ui/Dialog';
import { Icon } from '@/components/ui/Icon';
import { SOUND_LABELS, STRUCTURE_LABELS } from '@/lib/one-click-film/contract';
import type { FilmEntry, FilmState } from './types';
import styles from './one-click-film.module.css';

interface VideoProvider {
  id: string;
  name: string;
  type: string;
  model: string;
  hasApiKey: boolean;
}

interface ModelOption {
  key: string;
  label: string;
  providerId: string;
  providerName: string;
  model: string;
  durations: number[];
  durationLabel: string;
  aspectRatios: string[];
  modes: Array<'draft' | 'direct'>;
  hasApiKey: boolean;
}

interface VideoJob {
  id: string;
  videoJobId: string | null;
  entryCode: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  errorMessage: string | null;
  model: string;
  durationSec: number;
  aspectRatio: string;
  videoUrl?: string | null;
  cuts: { status: string; durationUs: number; fps: number; cuts: number[]; errorMessage: string | null } | null;
}

const STATUS_LABEL: Record<VideoJob['status'], string> = {
  queued: '排队中', running: '生成中', succeeded: '已生成', failed: '失败',
};
const STATUS_TONE: Record<VideoJob['status'], 'idle' | 'run' | 'ok' | 'fail'> = {
  queued: 'idle', running: 'run', succeeded: 'ok', failed: 'fail',
};

/**
 * 第三步 · 生成视频：先核对每条确认稿与声音，再选通道提交整批直出。
 * 队列按条目显示进度；成功原片可播放，并带实际切点。
 */
export function GenerationStage({ state, entries, onReview, onAdjustSound, onReload }: {
  state: FilmState; entries: FilmEntry[]; onReload: () => Promise<void>;
  onReview: (code: string, shotId?: string) => void; onAdjustSound: (code: string) => void;
}) {
  const [providers, setProviders] = useState<VideoProvider[]>([]);
  const [jobs, setJobs] = useState<VideoJob[]>([]);
  const [providerId, setProviderId] = useState('');
  const [models, setModels] = useState<ModelOption[]>([]);
  const [mode, setMode] = useState<'draft' | 'direct'>('direct');
  const [durationSec, setDurationSec] = useState(15);
  const [aspectRatio, setAspectRatio] = useState('3:4');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [loading, setLoading] = useState(true);
  const [promptReview, setPromptReview] = useState<{ code: string; original: string; suggested: string; text: string } | null>(null);
  const closePrompt = useCallback(() => setPromptReview(null), []);

  const load = useCallback(async () => {
    try {
      const response = await fetch(`/api/one-click-film/${state.project.id}/generation`, { cache: 'no-store' });
      const body = await response.json() as {
        providers?: VideoProvider[]; jobs?: VideoJob[]; message?: string; error?: string;
      };
      if (!response.ok) throw new Error(body.message || body.error || '读取生成队列失败');
      setProviders(body.providers ?? []);
      setJobs(body.jobs ?? []);
      setProviderId((current) => current || body.providers?.find((provider) => provider.hasApiKey)?.id || '');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, [state.project.id]);

  useEffect(() => {
    const timer = setTimeout(() => { void load(); }, 0);
    return () => clearTimeout(timer);
  }, [load]);

  useEffect(() => {
    const timer = setTimeout(() => {
      void fetch(`/api/one-click-film/${state.project.id}/models`, { cache: 'no-store' })
        .then((response) => (response.ok ? response.json() : { models: [] }))
        .then((body: { models?: ModelOption[] }) => setModels(body.models ?? []))
        .catch(() => setModels([]));
    }, 0);
    return () => clearTimeout(timer);
  }, [state.project.id]);

  const hasActive = jobs.some((job) => job.status === 'queued' || job.status === 'running');
  useEffect(() => {
    if (!hasActive) return;
    const timer = setInterval(() => { void load(); }, 5000);
    return () => clearInterval(timer);
  }, [hasActive, load]);

  const pending = entries.filter((entry) => entry.status !== 'confirmed');
  const ready = pending.length === 0 && entries.length > 0;
  const option = models.find((item) => item.providerId === providerId);
  const durations = option?.durations?.length ? option.durations : Array.from({ length: 29 }, (_, index) => index + 2);
  const ratios = option?.aspectRatios?.length ? option.aspectRatios : ['3:4', '9:16', '16:9', '1:1', '4:3'];
  const modes = option?.modes?.length ? option.modes : ['direct'];
  // 渲染期派生：通道切换后自动收敛到该通道声明的范围，
  // 不在 effect 里 setState（避免级联渲染），也不覆盖用户已选的合法值。
  const effectiveDurationSec = durations.includes(durationSec)
    ? durationSec : (durations.includes(15) ? 15 : durations[0] ?? 15);
  const effectiveAspectRatio = ratios.includes(aspectRatio)
    ? aspectRatio : (ratios.includes('3:4') ? '3:4' : ratios[0] ?? '3:4');
  const effectiveMode = modes.includes(mode) ? mode : (modes[0] ?? 'direct');
  const durationValid = durations.includes(effectiveDurationSec);
  const ratioValid = ratios.includes(effectiveAspectRatio);
  const modeValid = modes.includes(effectiveMode);
  const needsReview = entries.filter((entry) => entry.promptDurationSec !== effectiveDurationSec || entry.promptAspectRatio !== effectiveAspectRatio);

  const openPrompt = async (entry: FilmEntry) => {
    setError('');
    try {
      const response = await fetch(`/api/one-click-film/${state.project.id}/scripts`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'review-prompt', durationSec: effectiveDurationSec, aspectRatio: effectiveAspectRatio }),
      });
      const result = await response.json() as { reviews?: Array<{ code: string; review: { text: string } }>; message?: string };
      if (!response.ok) throw new Error(result.message || '无法生成提示词建议');
      const suggested = result.reviews?.find((item) => item.code === entry.code)?.review.text || entry.promptText;
      setPromptReview({ code: entry.code, original: entry.promptText, suggested, text: suggested });
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };

  const confirmPrompt = async () => {
    if (!promptReview) return;
    try {
      const response = await fetch(`/api/one-click-film/${state.project.id}/scripts`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'apply-prompt', code: promptReview.code, promptText: promptReview.text,
          durationSec: effectiveDurationSec, aspectRatio: effectiveAspectRatio }),
      });
      const result = await response.json() as { message?: string };
      if (!response.ok) throw new Error(result.message || '无法确认提示词');
      setPromptReview(null);
      await onReload();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };

  const submit = async () => {
    setError('');
    if (!providerId) { setError('请选择视频通道。'); return; }
    if (!durationValid) { setError(`正文时长须为 ${option?.durationLabel ?? '通道支持的范围'}`); return; }
    if (!ratioValid) { setError(`该通道不支持 ${aspectRatio} 画幅`); return; }
    if (!modeValid) { setError('该通道不支持所选生成模式'); return; }
    setSubmitting(true);
    try {
      const response = await fetch(`/api/one-click-film/${state.project.id}/generation`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          providerId, durationSec: effectiveDurationSec, aspectRatio: effectiveAspectRatio, mode: effectiveMode,
        }),
      });
      const body = await response.json() as { message?: string; error?: string };
      if (!response.ok) throw new Error(body.message || body.error || '提交失败');
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSubmitting(false);
    }
  };

  const retry = async (id: string) => {
    setError('');
    setSubmitting(true);
    try {
      const response = await fetch(`/api/video-jobs/${id}/retry`, { method: 'POST' });
      const result = await response.json() as { message?: string; error?: string };
      if (!response.ok) throw new Error(result.message || result.error || '重试失败');
      await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setSubmitting(false); }
  };

  const sounds = [...new Set(entries.map((entry) => SOUND_LABELS[entry.soundMode]))];
  const queueCodes = [...new Set([...entries.map((entry) => entry.code), ...jobs.map((job) => job.entryCode)])];
  const hasReviewableVideo = jobs.some((job) => job.videoUrl);
  const progress = hasReviewableVideo ? 2 : jobs.some((job) => job.status === 'succeeded') ? 1 : 0;

  return <section className={styles.generation}>
    <div className={styles.stageTitle}>
      <div>
        <h2>整条生成，自动识别镜头</h2>
        <p className={styles.hint}>选择通道、时长、画幅和生成模式。生成后可以按镜头审片。</p>
      </div>
    </div>
    <div className={styles.generationColumns}>
      <section className={styles.generationSide} aria-label="生成设置">
        <h3 className={styles.panelHeading}>生成设置</h3>
        <div className={styles.generationFields}>
          <label className={styles.field}>
            <span>视频通道</span>
            <select
              className="input-field"
              title={providers.find((item) => item.id === providerId)?.name}
              value={providerId}
              onChange={(event) => setProviderId(event.target.value)}
            >
              <option value="">请选择</option>
              {providers.map((item) => (
                <option key={item.id} value={item.id} disabled={!item.hasApiKey}>
                  {item.name}{item.hasApiKey ? '' : '（未配置）'}
                </option>
              ))}
            </select>
          </label>
          <label className={styles.field}>
            <span>正文时长</span>
            <select className="input-field" value={effectiveDurationSec} onChange={(event) => setDurationSec(Number(event.target.value))}>
              {durations.map((value) => (
                <option key={value} value={value}>{value} 秒</option>
              ))}
            </select>
          </label>
          <label className={styles.field}>
            <span>画幅</span>
            <select className="input-field" value={effectiveAspectRatio} onChange={(event) => setAspectRatio(event.target.value)}>
              {ratios.map((ratio) => <option key={ratio} value={ratio}>{ratio}</option>)}
            </select>
          </label>
          <label className={styles.field}>
            <span>生成模式</span>
            <select className="input-field" value={effectiveMode} onChange={(event) => setMode(event.target.value as 'draft' | 'direct')}>
              {modes.map((value) => <option key={value} value={value}>{value === 'draft' ? '样片生成' : '直接生成'}</option>)}
            </select>
          </label>
        </div>
        {option ? <p className={styles.hint}>
          {option.label} · {option.durationLabel} · 可选 {option.aspectRatios.join('、')}
        </p> : null}
        <p className={styles.hint}>
          {effectiveMode === 'draft' ? '样片通过审片后可转高清。' : '直出视频通过审片后可进入包装。'}
        </p>
        {sounds.length ? <div className={styles.generationSound}>
          <span className={styles.hint}>脚本阶段已确定的声音</span>
          <strong>{sounds.join('、')}</strong>
        </div> : null}
        <p className={`${styles.hint} tnum`}>{entries.length} 条 · {effectiveDurationSec} 秒 · {effectiveAspectRatio}</p>
        <button
          type="button"
          className="cap cap-primary w-full"
          disabled={!ready || needsReview.length > 0 || submitting || loading}
          onClick={() => void submit()}
          data-testid="one-click-film-generate"
        >
          <Icon name="sparkle" size={15} />
          {submitting ? '提交中…' : `生成 ${entries.length} 条正文`}
        </button>
        {!ready ? <p className={styles.hintWarn}>
          {pending.length ? `待确认脚本：${pending.map((entry) => entry.code).join('、')}` : '先生成并确认脚本。'}
        </p> : null}
        {needsReview.length ? <p className={styles.hintWarn}>时长或画幅已变更，请复核 {needsReview.map((entry) => entry.code).join('、')}。</p> : null}
        {error && !promptReview ? <p className={styles.hintFail} role="alert">{error}</p> : null}
      </section>

      <section className={styles.generationMain} aria-label="创作队列">
        <ol className={styles.queueProgress}>
          {['生成整条视频', '识别镜头切点', '进入审片'].map((label, index) => (
            <li key={label} aria-current={progress === index ? 'step' : undefined} data-done={progress > index}>
              <span aria-hidden="true">{progress > index ? <Icon name="check" size={13} /> : index + 1}</span>{label}
            </li>
          ))}
        </ol>
        <h3 className={styles.panelHeading}>创作队列</h3>
        {loading ? <div className={styles.center}><div className={styles.spinner} />读取队列…</div> : queueCodes.length === 0 ? (
          <EmptyState
            icon="film"
            title="还没有生成任务"
            description="确认脚本后，成片条目会出现在这里。"
          />
        ) : <div className={styles.jobList}>
          {queueCodes.map((code) => {
            const entry = entries.find((item) => item.code === code);
            const entryJobs = jobs.filter((job) => job.entryCode === code);
            return <article key={code} className={styles.jobCard}>
              <div className={styles.jobHead}>
                <h4>{code}{entry ? ` · ${STRUCTURE_LABELS[entry.structure]}` : ''}</h4>
                {entry ? <Tag tone={entry.status === 'confirmed' ? 'ok' : 'warn'}>{entry.status === 'confirmed' ? '确认稿' : '待确认'}</Tag> : null}
              </div>
              {entry ? <small className={styles.hint}>{SOUND_LABELS[entry.soundMode]}</small> : null}
              {entryJobs.map((job) => {
                const cuts = job.cuts;
                const boundaries = cuts?.status === 'succeeded' ? [0, ...cuts.cuts, cuts.durationUs] : [];
                return <div key={job.id} className={styles.queueJob}>
                  <div className={styles.jobHead}>
                    <span className={`${styles.hint} tnum`}>{job.model} · {job.durationSec} 秒 · {job.aspectRatio}</span>
                    <Tag tone={STATUS_TONE[job.status]}>{STATUS_LABEL[job.status]}</Tag>
                  </div>
                  {boundaries.length > 1 ? <div className={styles.queueShots} aria-label={`${code} 镜头`}>
                    {boundaries.slice(0, -1).map((start, index) => <button key={start} type="button"
                      style={{ flexGrow: boundaries[index + 1] - start }}
                      onClick={() => onReview(code, `s${index + 1}`)}>
                      <strong>镜头 {index + 1}</strong>
                      <small className="tnum">{((boundaries[index + 1] - start) / 1e6).toFixed(2)} 秒</small>
                    </button>)}
                  </div> : null}
                  {cuts?.status === 'failed' ? <p className={styles.hintWarn}>切点识别失败（{cuts.errorMessage || '原因未知'}），可在审片时手动切分。</p>
                    : job.status === 'succeeded' && cuts?.status !== 'succeeded' ? <p className={styles.hint}>正在识别实际切点…</p> : null}
                  {job.status === 'failed' ? <p className={styles.hintFail}>{job.errorMessage || '生成失败，可以单独重试。'}</p> : null}
                  {job.status === 'failed' && job.videoJobId ? <ToolbarButton disabled={submitting}
                    onClick={() => void retry(job.videoJobId!)}>重试 {code}</ToolbarButton> : null}
                  {job.videoUrl ? <>
                    <div className={styles.inlineActions}>
                      <ToolbarButton icon="chevron-right" onClick={() => onReview(code)}>审片 {code}</ToolbarButton>
                    </div>
                    <details className={styles.queuePreview}>
                      <summary>预览原片</summary>
                      <video className={styles.jobVideo} src={job.videoUrl} controls preload="none" />
                    </details>
                  </> : null}
                </div>;
              })}
              {entry ? <div className={styles.inlineActions}>
                <ToolbarButton icon="text" onClick={() => void openPrompt(entry)}>核对 {code} 提示词</ToolbarButton>
                <ToolbarButton icon="mic" onClick={() => onAdjustSound(code)}>调整声音</ToolbarButton>
              </div> : null}
            </article>;
          })}
        </div>}
      </section>
    </div>
    {promptReview ? <Dialog open title={`核对 ${promptReview.code} 提示词`} width="wide" onClose={closePrompt}
      description={`${effectiveDurationSec} 秒 · ${effectiveAspectRatio}`}
      footer={<div className={styles.inlineActions}>
        <ToolbarButton onClick={() => setPromptReview({ ...promptReview, text: promptReview.original })}>保留原稿</ToolbarButton>
        <ToolbarButton onClick={() => setPromptReview({ ...promptReview, text: promptReview.suggested })}>采用建议</ToolbarButton>
        <ToolbarButton onClick={closePrompt}>取消</ToolbarButton>
        <ToolbarButton variant="primary" onClick={() => void confirmPrompt()}>确认本条参数</ToolbarButton>
      </div>}>
      <details><summary>查看原确认稿</summary><pre className={styles.promptPreview}>{promptReview.original}</pre></details>
      <label className={styles.field}><span>建议稿，可继续编辑</span>
        <textarea aria-label="视频提示词复核稿" rows={10} className="input-field" value={promptReview.text}
          onChange={(event) => setPromptReview({ ...promptReview, text: event.target.value })} />
      </label>
      {error ? <p className={styles.hintFail} role="alert">{error}</p> : null}
    </Dialog> : null}
  </section>;
}
