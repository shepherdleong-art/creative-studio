'use client';

import { useMemo, useRef, useState } from 'react';
import { Icon } from '@/components/ui/Icon';
import type { BatchPreparationResult } from '@/lib/batch-production/prepare';
import type { BatchSnapshotDetail } from '@/lib/batch-production/batch-flow';
import { BatchFrozenScriptCard } from './BatchInputSelectionCards';

export interface BatchTtsProviderView {
  id: string;
  name: string;
  model: string;
  configured: boolean;
  voices: Array<{ id: string; label: string }>;
}

export interface BatchBgmParamsDraft {
  gainDb: number;
  fadeInSec: number;
  fadeOutSec: number;
}

export interface BatchBgmTrackView {
  id: string;
  relativePath: string;
  filename: string;
  durationUs: number;
}

export interface BatchMusicSelectionDraft {
  mode: 'auto' | 'manual';
  trackIds: string[];
}

export interface BatchProgressView {
  overallPercent: number;
  elapsedSec: number;
  stages: Array<{
    label: string;
    status: 'waiting' | 'running' | 'done' | 'failed';
    detail?: string;
    percent?: number;
  }>;
}

export interface BatchStepScriptsProps {
  prep: BatchPreparationResult;
  selectedScripts: Record<string, number>;
  onToggleScript: (scriptId: string, selected: boolean) => void;
  onCopyCountChange: (scriptId: string, copyCount: number) => void;
  plannedCount: number;
  outputPreset: OutputPresetLabel;
  frozen: boolean;
  frozenScriptSnapshots: BatchSnapshotDetail['scriptSnapshots'];
  busy: 'create' | 'snapshot' | 'start' | null;
  outputPlans: Array<{ id: string; seq: number }>;
  batchStatus: string;
  ttsConfigured: boolean;
  ttsProviders: BatchTtsProviderView[];
  bgmParams: BatchBgmParamsDraft;
  bgmLibrary: BatchBgmTrackView[];
  bgmRescanning: boolean;
  bgmSelection: BatchMusicSelectionDraft;
  onBgmParamsChange: (params: BatchBgmParamsDraft) => void;
  onRescanBgm: () => void;
  onBgmSelectionChange: (selection: BatchMusicSelectionDraft) => void;
  /** 配音配置变化时通知容器标记输入已修改 */
  onNarrationConfigTouched: () => void;
  onConfirmSnapshot: () => void;
  onStartBatch: () => void;
  inputChangedWarning: boolean;
  /** 开跑后的分阶段进度(锁定→配画面→口播→渲染→封面);未开跑时为 null */
  progress: BatchProgressView | null;
}

export interface OutputPresetLabel {
  id: string;
  label: string;
}

const BATCH_STATUS_LABELS: Record<string, string> = {
  draft: '待确认',
  running: '生产中',
  partially_completed: '部分完成',
  completed: '已完成',
  failed: '失败',
};

const FEATURED_VOICE_COUNT = 6;

interface NarrationConfigDraft {
  providerId: string;
  voice: string;
  speed: number;
}

function defaultConfigFor(provider: BatchTtsProviderView | undefined): NarrationConfigDraft | null {
  if (!provider || !provider.configured) return null;
  return { providerId: provider.id, voice: provider.voices[0]?.id ?? '', speed: 1 };
}

/**
 * 第 2 步 · 脚本与口播:每份脚本一张创作卡(勾选/份数/只读时长/配音配置),
 * 未勾选的脚本折叠;下方输出设置卡(画幅只读、BGM 音量/淡入/淡出整批统一)
 * 与「确认整体输入 → 开始批量生产」。
 */
export default function BatchStepScripts(props: BatchStepScriptsProps) {
  const {
    prep,
    selectedScripts,
    onToggleScript,
    onCopyCountChange,
    plannedCount,
    outputPreset,
    frozen,
    frozenScriptSnapshots,
    busy,
    outputPlans,
    batchStatus,
    ttsConfigured,
    ttsProviders,
    bgmParams,
    bgmLibrary,
    bgmRescanning,
    bgmSelection,
    onBgmParamsChange,
    onRescanBgm,
    onBgmSelectionChange,
    onNarrationConfigTouched,
    onConfirmSnapshot,
    onStartBatch,
    inputChangedWarning,
    progress,
  } = props;

  const configuredProvider = useMemo(
    () => ttsProviders.find((provider) => provider.configured) ?? ttsProviders[0],
    [ttsProviders],
  );
  const [configs, setConfigs] = useState<Record<string, NarrationConfigDraft>>(() => {
    // 仅从脚本已存储的配置初始化;未存储的脚本不占 state,
    // 渲染时按第一个已配置供应商回落(与执行器默认行为一致)。
    const result: Record<string, NarrationConfigDraft> = {};
    for (const script of prep.scripts) {
      const stored = script.narrationConfig;
      if (stored && typeof stored.providerId === 'string' && typeof stored.voice === 'string') {
        result[script.id] = {
          providerId: stored.providerId,
          voice: stored.voice,
          speed: typeof stored.speed === 'number' ? Math.min(2, Math.max(0.5, stored.speed)) : 1,
        };
      }
    }
    return result;
  });
  const [voiceQuery, setVoiceQuery] = useState<Record<string, string>>({});
  const [showAllVoices, setShowAllVoices] = useState<Record<string, boolean>>({});
  const [previewing, setPreviewing] = useState<Record<string, string | null>>({});
  const [bgmListOpen, setBgmListOpen] = useState(false);
  const [auditioningTrackId, setAuditioningTrackId] = useState<string | null>(null);
  const auditionAudioRef = useRef<HTMLAudioElement | null>(null);
  const saveQueueRef = useRef<Record<string, Promise<void>>>({});

  const scriptCount = Object.keys(selectedScripts).length;
  const onlineAssets = prep.assets.filter(({ status }) => status === 'online').length;

  const startDisabledReason = !scriptCount
    ? '请先勾选至少一份脚本'
    : outputPlans.length === 0
      ? '请先确认整体输入'
      : batchStatus !== 'draft'
        ? '批次已开始生产'
        : !ttsConfigured
          ? '尚未配置口播配音供应商，请在设置中配置'
          : bgmLibrary.length === 0
            ? '背景音乐曲库为空，请先放入音频并重新扫描'
            : undefined;

  function formatDuration(durationUs: number): string {
    const totalSec = Math.max(0, Math.round(durationUs / 1_000_000));
    const minutes = Math.floor(totalSec / 60);
    const seconds = totalSec % 60;
    return `${minutes}:${String(seconds).padStart(2, '0')}`;
  }

  function auditionBgm(trackId: string): void {
    if (auditioningTrackId === trackId) {
      auditionAudioRef.current?.pause();
      setAuditioningTrackId(null);
      return;
    }
    auditionAudioRef.current?.pause();
    const audio = new Audio(`/api/final-edit-bgm/${encodeURIComponent(trackId)}/file`);
    auditionAudioRef.current = audio;
    setAuditioningTrackId(trackId);
    audio.addEventListener('ended', () => setAuditioningTrackId(null), { once: true });
    audio.addEventListener('error', () => setAuditioningTrackId(null), { once: true });
    void audio.play();
  }

  function renderBgmSection() {
    const manualCount = bgmSelection.mode === 'manual' ? bgmSelection.trackIds.length : 0;
    const sliderRow = (label: string, ariaLabel: string, children: React.ReactNode, value: string) => (
      <div className="flex items-center gap-3">
        <span className="w-9 shrink-0 text-xs text-ink-secondary">{label}</span>
        <div className="flex min-w-0 flex-1 items-center gap-3">{children}</div>
        <span className="w-14 shrink-0 text-right text-xs tabular-nums text-ink-secondary">{value}</span>
      </div>
    );
    return (
      <section className="card space-y-4 p-5" aria-label="背景音乐">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-center gap-2">
            <Icon name="music" size={15} />
            <h3 className="font-semibold text-ink">背景音乐</h3>
            <span className="rounded-full bg-surface-subtle px-2.5 py-0.5 text-[11px] text-ink-secondary">曲库 {bgmLibrary.length} 首</span>
          </div>
          <button type="button" className="btn-secondary h-8 px-3 text-xs" disabled={bgmRescanning} onClick={onRescanBgm}>
            {bgmRescanning ? '扫描中…' : '重新扫描'}
          </button>
        </div>
        {bgmLibrary.length === 0 ? (
          <div className="rounded-xl bg-warn/10 px-4 py-3 text-xs leading-5 text-warn">
            曲库为空 —— 请把音频文件放进 storage/bgm/ 文件夹，然后点击「重新扫描」。曲库与单条模式共用，无需导入。
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm text-ink-secondary">
                {manualCount > 0
                  ? `已指定 ${manualCount} 首 · ${plannedCount} 条成片轮流使用`
                  : `曲库 ${bgmLibrary.length} 首 · ${plannedCount} 条成片将自动分配`}
              </p>
              <button
                type="button"
                className="btn-secondary h-8 px-3 text-xs"
                onClick={() => setBgmListOpen((value) => !value)}
              >{bgmListOpen ? '收起曲目' : '曲目（可手动指定）'}</button>
            </div>
            {bgmListOpen && (
              <ul className="grid gap-1.5 sm:grid-cols-2">
                {bgmLibrary.map((track) => (
                  <li key={track.id} className="flex items-center gap-2 rounded-xl bg-surface-subtle px-3 py-2 text-xs">
                    <input
                      type="checkbox"
                      aria-label={`手动指定 ${track.filename}`}
                      checked={bgmSelection.trackIds.includes(track.id)}
                      onChange={(event) => {
                        const checked = event.target.checked;
                        const trackIds = checked
                          ? [...new Set([...bgmSelection.trackIds, track.id])]
                          : bgmSelection.trackIds.filter((id) => id !== track.id);
                        onBgmSelectionChange({ mode: trackIds.length > 0 ? 'manual' : 'auto', trackIds });
                      }}
                      className="h-3.5 w-3.5 accent-[var(--color-accent)]"
                    />
                    <span className="min-w-0 flex-1 truncate text-ink-secondary" title={track.filename}>{track.filename}</span>
                    <span className="shrink-0 tabular-nums text-ink-tertiary">{formatDuration(track.durationUs)}</span>
                    <button
                      type="button"
                      className="flex shrink-0 items-center gap-1 text-accent underline"
                      onClick={() => auditionBgm(track.id)}
                      aria-pressed={auditioningTrackId === track.id}
                    >
                      <Icon name={auditioningTrackId === track.id ? 'stop' : 'play'} size={10} />
                      {auditioningTrackId === track.id ? '停止' : '试听'}
                    </button>
                  </li>
                ))}
                {bgmSelection.mode === 'manual' && bgmSelection.trackIds.length > 0 && (
                  <li className="flex items-center gap-2 rounded-xl bg-accent/5 px-3 py-2 text-[11px] text-ink-secondary">
                    已手动指定 {bgmSelection.trackIds.length} 首，成片只在这几首之间轮流使用；取消全部勾选恢复自动分配。
                  </li>
                )}
              </ul>
            )}
          </>
        )}
        <div className="space-y-2.5 border-t border-hairline pt-4">
          {sliderRow('音量', '背景音乐音量增益', (
            <input
              type="range"
              min={-60}
              max={0}
              step={1}
              aria-label="背景音乐音量增益"
              value={bgmParams.gainDb}
              onChange={(event) => onBgmParamsChange({ ...bgmParams, gainDb: Number(event.target.value) })}
              className="min-w-0 flex-1 accent-[var(--color-accent)]"
            />
          ), `${bgmParams.gainDb} dB`)}
          {sliderRow('淡入', '背景音乐淡入', (
            <input
              type="range"
              min={0}
              max={10}
              step={0.5}
              aria-label="背景音乐淡入"
              value={bgmParams.fadeInSec}
              onChange={(event) => onBgmParamsChange({ ...bgmParams, fadeInSec: Number(event.target.value) })}
              className="min-w-0 flex-1 accent-[var(--color-accent)]"
            />
          ), `${bgmParams.fadeInSec.toFixed(1)}s`)}
          {sliderRow('淡出', '背景音乐淡出', (
            <input
              type="range"
              min={0}
              max={10}
              step={0.5}
              aria-label="背景音乐淡出"
              value={bgmParams.fadeOutSec}
              onChange={(event) => onBgmParamsChange({ ...bgmParams, fadeOutSec: Number(event.target.value) })}
              className="min-w-0 flex-1 accent-[var(--color-accent)]"
            />
          ), `${bgmParams.fadeOutSec.toFixed(1)}s`)}
        </div>
      </section>
    );
  }

  async function persistConfig(scriptId: string, config: NarrationConfigDraft): Promise<void> {
    const queued = saveQueueRef.current[scriptId] ?? Promise.resolve();
    const save = async () => {
      const response = await fetch(
        `/api/batch-production/scripts/${encodeURIComponent(scriptId)}/narration-config?projectId=${encodeURIComponent(props.prep.project.id)}`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(config),
        },
      );
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.message || body.error || '配音配置保存失败');
      }
    };
    const next = queued.then(save, save);
    saveQueueRef.current[scriptId] = next.catch(() => undefined);
    await next;
  }

  function updateConfig(scriptId: string, patch: Partial<NarrationConfigDraft>): void {
    const current = configs[scriptId] ?? defaultConfigFor(configuredProvider);
    if (!current) return;
    const next = { ...current, ...patch };
    setConfigs((all) => ({ ...all, [scriptId]: next }));
    onNarrationConfigTouched();
    void persistConfig(scriptId, next).catch(() => undefined);
  }

  function applyConfigToAllScripts(source: NarrationConfigDraft): void {
    setConfigs((all) => {
      const next = { ...all };
      for (const script of prep.scripts) {
        next[script.id] = { ...source };
      }
      return next;
    });
    onNarrationConfigTouched();
    for (const script of prep.scripts) {
      void persistConfig(script.id, { ...source }).catch(() => undefined);
    }
  }

  async function auditionVoice(scriptId: string, providerId: string, voice: string, speed: number): Promise<void> {
    if (previewing[scriptId]) return;
    setPreviewing((current) => ({ ...current, [scriptId]: voice }));
    try {
      const response = await fetch(`/api/providers/tts/${encodeURIComponent(providerId)}/preview`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ voice, speed }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.message || body.error || '音色试听失败');
      }
      const url = URL.createObjectURL(await response.blob());
      const audio = new Audio(url);
      const release = () => URL.revokeObjectURL(url);
      audio.addEventListener('ended', release, { once: true });
      audio.addEventListener('error', release, { once: true });
      await audio.play();
    } catch (error) {
      console.warn('音色试听失败', error);
    } finally {
      setPreviewing((current) => ({ ...current, [scriptId]: null }));
    }
  }

  function renderNarrationConfig(scriptId: string) {
    const config = configs[scriptId] ?? defaultConfigFor(configuredProvider);
    if (!config) {
      return (
        <p className="text-xs text-warn">尚未配置口播配音供应商，请先在设置中启用并配置后再选择音色。</p>
      );
    }
    const provider = ttsProviders.find((item) => item.id === config.providerId);
    const allVoices = provider?.voices ?? [];
    const effectiveVoice = allVoices.some((item) => item.id === config.voice) ? config.voice : allVoices[0]?.id ?? '';
    const query = (voiceQuery[scriptId] ?? '').trim().toLocaleLowerCase();
    const filtered = query
      ? allVoices.filter((item) => item.label.toLocaleLowerCase().includes(query) || item.id.toLocaleLowerCase().includes(query))
      : showAllVoices[scriptId]
        ? allVoices
        : allVoices.slice(0, FEATURED_VOICE_COUNT);
    const selectedVoice = allVoices.find((item) => item.id === effectiveVoice);

    return (
      <div className="space-y-3 border-t border-hairline pt-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 flex-wrap items-center gap-3">
            <label className="text-sm text-ink-secondary">
              <span className="mb-1 block">配音服务商</span>
              <select
                aria-label={`${scriptId} 配音服务商`}
                value={config.providerId}
                onChange={(event) => updateConfig(scriptId, { providerId: event.target.value, voice: ttsProviders.find((item) => item.id === event.target.value)?.voices[0]?.id ?? '' })}
                className="h-9 min-w-44 rounded-xl border border-hairline bg-white px-3 text-sm text-ink"
              >
                {ttsProviders.filter((item) => item.configured || item.id === config.providerId).map((item) => (
                  <option key={item.id} value={item.id}>{item.name} · {item.model}</option>
                ))}
              </select>
            </label>
            <span className={`rounded-full px-2 py-1 text-[11px] ${provider?.configured ? 'bg-ok/10 text-ok' : 'bg-warn/10 text-warn'}`}>
              密钥{provider?.configured ? '已配置' : '未配置'}
            </span>
          </div>
          <button type="button" className="btn-secondary h-8 px-3 text-xs" onClick={() => applyConfigToAllScripts(config)}>
            应用到全部脚本
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <span className="text-xs text-ink-secondary">语速</span>
          <input
            type="range"
            min="0.5"
            max="2"
            step="0.1"
            aria-label={`${scriptId} 语速`}
            value={config.speed}
            onChange={(event) => updateConfig(scriptId, { speed: Number(event.target.value) })}
            className="w-40 accent-[var(--color-accent)]"
          />
          <span className="rounded-full bg-surface-subtle px-2 py-0.5 text-[11px] text-ink-secondary">{config.speed.toFixed(1)}x</span>
          <span className="text-[11px] text-ink-tertiary">0.5x 慢速 · 1.0x 正常 · 2.0x 快速</span>
        </div>

        <div>
          <p className="mb-2 text-xs text-ink-secondary">精选音色（点击选中，可单独试听）</p>
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 lg:grid-cols-6">
            {filtered.map((item) => (
              <div
                key={item.id}
                role="button"
                tabIndex={0}
                className={`relative cursor-pointer rounded-xl border p-2 text-center transition ${item.id === effectiveVoice ? 'border-accent bg-accent/5' : 'border-hairline bg-white'}`}
                onClick={() => updateConfig(scriptId, { voice: item.id })}
                onKeyDown={(event) => {
                  if ((event.key === 'Enter' || event.key === ' ') && !previewing[scriptId]) updateConfig(scriptId, { voice: item.id });
                }}
              >
                <div className="mx-auto grid h-8 w-8 place-items-center rounded-full bg-surface-subtle text-ink-secondary"><Icon name="mic" size={15} /></div>
                <p className="mt-1 truncate text-xs font-medium text-ink">{item.label}</p>
                <button
                  type="button"
                  className={`mt-1 inline-flex items-center gap-1 text-[11px] ${item.id === effectiveVoice ? 'text-accent' : 'text-ink-tertiary'}`}
                  disabled={Boolean(previewing[scriptId]) || !provider?.configured}
                  onClick={(event) => {
                    event.stopPropagation();
                    void auditionVoice(scriptId, config.providerId, item.id, config.speed);
                  }}
                >
                  <Icon name="play" size={9} />
                  {previewing[scriptId] === item.id ? '生成中…' : '试听'}
                </button>
              </div>
            ))}
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-3">
            <input
              type="text"
              aria-label="搜索音色"
              value={voiceQuery[scriptId] ?? ''}
              onChange={(event) => setVoiceQuery((current) => ({ ...current, [scriptId]: event.target.value }))}
              placeholder="搜索更多音色（名称或 ID）"
              className="h-8 min-w-40 flex-1 rounded-xl border border-hairline bg-white px-3 text-xs text-ink"
            />
            {allVoices.length > FEATURED_VOICE_COUNT && !query && (
              <button type="button" className="text-xs text-accent underline" onClick={() => setShowAllVoices((current) => ({ ...current, [scriptId]: !current[scriptId] }))}>
                {showAllVoices[scriptId] ? '收起音色' : `查看全部 ${allVoices.length} 个音色`}
              </button>
            )}
            <span className="text-[11px] text-ink-tertiary">当前选中：{selectedVoice?.label ?? '未选择'}</span>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-0 flex-1 space-y-4 p-2">
      {frozen && (
        <div className="card flex flex-wrap items-center justify-between gap-4 p-5">
          <div>
            <h3 className="font-semibold text-ink">已锁定的脚本与口播</h3>
            <p className="mt-1 text-sm text-ink-secondary">
              以下正文、标题、份数与配音设置来自锁定快照，不随项目当前内容变化。时长按每份脚本自身设定，锁定后不可改。
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <span className={`rounded-full px-3 py-1 text-xs ${batchStatus === 'running' ? 'bg-accent/10 text-accent' : 'bg-surface-subtle text-ink-secondary'}`}>
              {BATCH_STATUS_LABELS[batchStatus] ?? batchStatus}
            </span>
          </div>
        </div>
      )}

      {!frozen && (
        <section aria-label="脚本与口播">
          <div className="mb-3 flex items-end justify-between gap-3">
            <div>
              <h3 className="font-semibold text-ink">脚本</h3>
              <p className="mt-1 text-sm text-ink-secondary">每份脚本是一个独立创作单元：各自份数出 N 条成片，共用同一条配音，只有画面不同。时长来自脚本自身设定，此处只读。</p>
            </div>
            <span className="text-sm text-ink-secondary">已选 {scriptCount} 份 · 目标成片 {plannedCount} 条</span>
          </div>
          {prep.scripts.length > 0 ? (
            <div className="grid gap-3 lg:grid-cols-2">
              {prep.scripts.map((script) => {
                const selected = selectedScripts[script.id] !== undefined;
                const durationSec = script.targetDurationSec ?? 15;
                const title = script.title || '未命名脚本';
                return selected ? (
                  <article key={script.id} className={`rounded-2xl border bg-white p-4 shadow-sm ${selected ? 'border-accent ring-2 ring-accent/10' : 'border-hairline'}`}>
                    <div className="flex items-start gap-3">
                      <input
                        type="checkbox"
                        aria-label={`选择脚本 ${title}`}
                        checked={selected}
                        onChange={(event) => onToggleScript(script.id, event.target.checked)}
                        className="mt-1 h-4 w-4 accent-[var(--color-accent)]"
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-start justify-between gap-3">
                          <div className="min-w-0">
                            <p className="text-xs font-medium text-accent">{script.coverTitle.primary || '项目脚本'}</p>
                            <h4 className="mt-1 font-semibold text-ink">{title}</h4>
                          </div>
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="rounded-full bg-surface-subtle px-2 py-1 text-[11px] text-ink-secondary">V{script.sourceVersion}</span>
                            <span className="rounded-full bg-surface-subtle px-2 py-1 text-[11px] text-ink-secondary">
                              {durationSec} 秒{durationSec === 15 && !script.targetDurationSec ? '（默认 15 秒）' : ''}
                            </span>
                          </div>
                        </div>
                        <p className="mt-2 line-clamp-2 whitespace-pre-wrap text-sm leading-6 text-ink-secondary">{script.bodyText}</p>
                        <label className="mt-3 flex items-center justify-between gap-3 rounded-xl bg-surface-subtle px-3 py-2 text-sm text-ink-secondary">
                          <span>生成份数</span>
                          <input
                            type="number"
                            min={1}
                            max={99}
                            step={1}
                            aria-label={`${title} 生成份数`}
                            value={selectedScripts[script.id] ?? 1}
                            onChange={(event) => onCopyCountChange(script.id, Math.max(1, Number.parseInt(event.target.value, 10) || 1))}
                            className="w-20 rounded-lg border border-hairline bg-white px-2 py-1 text-right text-ink"
                          />
                        </label>
                        {renderNarrationConfig(script.id)}
                      </div>
                    </div>
                  </article>
                ) : (
                  <button
                    key={script.id}
                    type="button"
                    className="flex items-center gap-3 rounded-2xl border border-hairline bg-white px-4 py-3 text-left shadow-sm transition hover:border-accent/40"
                    onClick={() => onToggleScript(script.id, true)}
                  >
                    <input
                      type="checkbox"
                      aria-label={`选择脚本 ${title}`}
                      checked={false}
                      readOnly
                      className="h-4 w-4 accent-[var(--color-accent)]"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-ink">{title}</span>
                      <span className="mt-0.5 block text-[11px] text-ink-tertiary">
                        {durationSec} 秒 · {script.sourceVersion ? `V${script.sourceVersion}` : '项目脚本'}
                        {configs[script.id] ? ' · 已配置配音' : ''}
                      </span>
                    </span>
                    <span className="text-xs text-accent">展开</span>
                  </button>
                );
              })}
            </div>
          ) : (
            <div className="tile p-6 text-sm text-ink-secondary">暂无可用项目脚本，请先在第 3 步生成并保存脚本。</div>
          )}
        </section>
      )}

      {frozen && frozenScriptSnapshots.length > 0 && (
        <div className="grid gap-3 lg:grid-cols-2">
          {frozenScriptSnapshots.map((snapshot) => <BatchFrozenScriptCard key={snapshot.id} snapshot={snapshot} />)}
        </div>
      )}

      {progress && (
        <section className="card space-y-3 p-5" aria-label="批量生产进度">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="font-semibold text-ink">生产进度</h3>
              <p className="mt-1 text-xs text-ink-secondary">
                已用时 {Math.floor(progress.elapsedSec / 60)} 分 {progress.elapsedSec % 60} 秒 · 刷新页面不丢失进度
              </p>
            </div>
            <div className="w-40">
              <div className="h-2 overflow-hidden rounded-full bg-surface-subtle" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress.overallPercent * 100)}>
                <div className="h-full rounded-full bg-accent transition-all" style={{ width: `${Math.round(progress.overallPercent * 100)}%` }} />
              </div>
              <p className="mt-1 text-right text-[11px] text-ink-tertiary">{Math.round(progress.overallPercent * 100)}%</p>
            </div>
          </div>
          <ul className="space-y-1.5">
            {progress.stages.map((stage) => (
              <li key={stage.label} className="flex items-center gap-3 rounded-xl bg-surface-subtle px-3 py-2 text-xs">
                <span className={`grid h-5 w-5 shrink-0 place-items-center rounded-full text-[10px] font-semibold ${
                  stage.status === 'done' ? 'bg-ok/15 text-ok'
                    : stage.status === 'failed' ? 'bg-fail/15 text-fail'
                      : stage.status === 'running' ? 'bg-accent text-white'
                        : 'bg-surface-subtle text-ink-tertiary'
                }`}>
                  {stage.status === 'done' ? '✓' : stage.status === 'failed' ? '!' : ''}
                </span>
                <span className={`flex-1 font-medium ${stage.status === 'running' ? 'text-accent' : stage.status === 'failed' ? 'text-fail' : stage.status === 'waiting' ? 'text-ink-tertiary' : 'text-ink'}`}>
                  {stage.label}
                </span>
                {typeof stage.percent === 'number' && stage.status === 'running' && (
                  <span className="shrink-0 text-ink-tertiary">{Math.round(stage.percent * 100)}%</span>
                )}
                <span className={`shrink-0 ${stage.status === 'failed' ? 'text-fail' : stage.status === 'waiting' ? 'text-ink-tertiary' : 'text-ink-secondary'}`}>
                  {stage.status === 'waiting' ? '等待' : stage.status === 'failed' ? '失败' : stage.status === 'running' ? '进行中' : '已完成'}
                  {stage.detail ? ` · ${stage.detail}` : ''}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {!frozen && (
        <section className="card space-y-4 p-5" aria-label="输出设置与开始">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <h3 className="font-semibold text-ink">输出设置</h3>
              <p className="mt-1 text-sm text-ink-secondary">
                画幅 {outputPreset.label}（顶栏统一设置）；背景音乐在下方卡片中设置。时长不提供修改 —— 脚本在第 3 步生成时已按档位约束字数。
              </p>
              {inputChangedWarning && (
                <p className="mt-1 text-xs text-warn">输入已修改，重新确认后才会覆盖当前批次版本。</p>
              )}
            </div>
            <div className="flex flex-col items-end gap-2">
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  className={`btn-secondary ${startDisabledReason === '请先确认整体输入' ? 'btn-callout' : ''}`}
                  disabled={busy !== null}
                  onClick={onConfirmSnapshot}
                >
                  {busy === 'snapshot' ? '确认中…' : '确认整体输入'}
                </button>
                <button
                  type="button"
                  className="btn-primary"
                  disabled={busy !== null || Boolean(startDisabledReason)}
                  onClick={onStartBatch}
                >{busy === 'start' ? '启动中…' : '开始批量生产'}</button>
              </div>
              {startDisabledReason && (
                <p className="max-w-80 text-right text-xs leading-5 text-warn">
                  {startDisabledReason === '请先确认整体输入' ? '还差一步：请先点击「确认整体输入」' : `暂时无法开始：${startDisabledReason}`}
                  {onlineAssets === 0 && '；当前项目没有在线素材。'}
                </p>
              )}
            </div>
          </div>
          {scriptCount > 0 && (
            <p className="text-xs text-ink-tertiary">
              确认信息：{scriptCount} 份脚本 × 各自份数 = {plannedCount} 条成片，{onlineAssets} 条在线素材，画幅 {outputPreset.label}。
              点击开始后本次设置即锁定，后续修改项目内容不影响本批次。
            </p>
          )}
        </section>
      )}
      {renderBgmSection()}
    </div>
  );
}
