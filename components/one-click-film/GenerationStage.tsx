'use client';

import { useCallback, useEffect, useState } from 'react';
import { EmptyState, GroupHeading, GroupList, GroupRow, Tag } from '@/components/ui/Appearance';
import { STRUCTURE_LABELS } from '@/lib/one-click-film/contract';
import type { FilmEntry, FilmState } from './types';
import { NarrationPanel } from './NarrationPanel';
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
export function GenerationStage({ state, entries }: { state: FilmState; entries: FilmEntry[] }) {
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
  const provider = providers.find((item) => item.id === providerId);
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

  return <div className={styles.generation}>
    <div className={styles.generationSide}>
      <GroupHeading>生成设置</GroupHeading>
      <GroupList>
        <GroupRow label="视频通道">
          <select
            aria-label="视频通道"
            className="input-field w-52"
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
        </GroupRow>
        <GroupRow label="正文时长">
          <select aria-label="正文时长" className="input-field w-32" value={effectiveDurationSec} onChange={(event) => setDurationSec(Number(event.target.value))}>
            {durations.map((value) => (
              <option key={value} value={value}>{value} 秒</option>
            ))}
          </select>
        </GroupRow>
        <GroupRow label="画幅">
          <select aria-label="画幅" className="input-field w-32" value={effectiveAspectRatio} onChange={(event) => setAspectRatio(event.target.value)}>
            {ratios.map((ratio) => <option key={ratio} value={ratio}>{ratio}</option>)}
          </select>
        </GroupRow>
        <GroupRow label="生成模式">
          <select aria-label="生成模式" className="input-field w-32" value={effectiveMode} onChange={(event) => setMode(event.target.value as 'draft' | 'direct')}>
            {modes.map((value) => <option key={value} value={value}>{value === 'draft' ? '样片生成' : '直接生成'}</option>)}
          </select>
        </GroupRow>
      </GroupList>
      {option ? <p className={styles.hint}>
        {option.label} · {option.durationLabel} · 可选 {option.aspectRatios.join('、')}
      </p> : null}
      <p className={styles.hint}>
        正文从第 0 秒开始；封面、字幕、花字和 BGM 到包装阶段才加入。
      </p>
      <button
        type="button"
        className="cap cap-primary w-full"
        disabled={!ready || submitting || loading}
        onClick={() => void submit()}
        data-testid="one-click-film-generate"
      >
        {submitting ? '提交中…' : `生成 ${entries.length} 条正文`}
      </button>
      {!ready ? <p className={styles.hintWarn}>还有待确认条目：{pending.map((entry) => entry.code).join('、')}</p> : null}
      {error ? <p className={styles.hintFail} role="alert">{error}</p> : null}

      <GroupHeading>逐条核对</GroupHeading>
      <GroupList>
        {entries.map((entry) => <GroupRow key={entry.id} label={entry.code} hint={STRUCTURE_LABELS[entry.structure]}>
          <Tag tone={entry.status === 'confirmed' ? 'ok' : 'warn'}>
            {entry.status === 'confirmed' ? '确认稿' : '待确认'}
          </Tag>
        </GroupRow>)}
      </GroupList>
      {entries.some((entry) => entry.soundMode === 'tts')
        ? <NarrationPanel projectId={state.project.id} bodyDurationSec={effectiveDurationSec} />
        : null}
    </div>

    <div className={styles.generationMain}>
      <GroupHeading>创作队列</GroupHeading>
      {loading ? <div className={styles.center}><div className={styles.spinner} />读取队列…</div> : jobs.length === 0 ? (
        <EmptyState
          icon="film"
          title="还没有生成任务"
          description={ready ? '选好通道后点「生成」，每条成片会提交一个整片任务。' : '先把每条脚本确认完，才能提交整批生成。'}
        />
      ) : <div className={styles.jobList}>
        {jobs.map((job) => <div key={job.id} className={styles.jobCard}>
          <div className={styles.jobHead}>
            <b>{job.entryCode}</b>
            <Tag tone={STATUS_TONE[job.status]}>{STATUS_LABEL[job.status]}</Tag>
            <small>{provider?.model || job.model} · {job.durationSec}s · {job.aspectRatio}</small>
          </div>
          {job.videoUrl ? <video className={styles.jobVideo} src={job.videoUrl} controls preload="metadata" /> : null}
          {job.status === 'failed' ? <p className={styles.hintFail}>{job.errorMessage || '生成失败，可以单独重试。'}</p> : null}
          {job.cuts ? <p className={styles.jobCuts}>
            {job.cuts.status === 'succeeded'
              ? `切点：${job.cuts.cuts.length > 0 ? job.cuts.cuts.map((cut) => `${(cut / 1e6).toFixed(2)}s`).join('、') : '一镜到底'}`
              : job.cuts.status === 'failed'
                ? `切点识别失败（${job.cuts.errorMessage || '原因未知'}），保留整条原片，可手动加切点。`
                : '正在识别实际切点…'}
          </p> : null}
        </div>)}
      </div>}
    </div>
  </div>;
}
