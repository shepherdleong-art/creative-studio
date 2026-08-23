'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '@/components/ui/Icon';
import BatchProductionProgressCard, { type BatchProgressView } from './BatchProductionProgressCard';
import type { BatchPreparationResult } from '@/lib/batch-production/prepare';
import type { BatchSnapshotDetail } from '@/lib/batch-production/batch-flow';
import { defaultTextStyle } from '@/lib/final-edit/domain';
// 纯字符串模块(无 sharp/fs 依赖),与渲染端封面合成共用同一份 SVG 构造。
import { textStyleToSvgElements } from '@/lib/final-edit/title-svg';
import {
  OUTPUT_PRESETS,
  type CoverFraming,
  type CoverPresetV2,
  type OutputPresetId,
  type TextStyle,
} from '@/lib/final-edit/types';
import { BatchFrozenScriptCard } from './BatchInputSelectionCards';
import { BatchScriptImportDialog, type ManualScriptDraft } from './BatchScriptImportDialog';

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

/** 封面标题设置草稿:与 defaultsJson 写入形状一致(样式已按当前画幅解析)。 */
export interface BatchCoverTitleDraft {
  mode: 'none' | 'preset' | 'custom';
  presetId: string | null;
  styles: { primary: TextStyle; secondary: TextStyle } | null;
  framing: CoverFraming | null;
}

export interface CoverPresetView extends CoverPresetV2 {
  id: string;
  name: string;
  createdAt?: string;
  updatedAt?: string;
}

async function readJson<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = typeof body.message === 'string' ? body.message : `HTTP ${response.status}`;
    throw new Error(message);
  }
  return body as T;
}

/** 开跑后滚进视野的进度卡锚点。容器按 id 找它，避免跨组件传 ref。 */
export const BATCH_PROGRESS_ANCHOR_ID = 'batch-production-progress';

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
  /** 封面标题设置(容器持有草稿,写入 defaultsJson) */
  coverTitle: BatchCoverTitleDraft;
  onCoverTitleChange: (draft: BatchCoverTitleDraft) => void;
  onConfirmSnapshot: () => void;
  onStartBatch: () => void;
  /** 手动脚本导入/编辑/删除后通知容器刷新准备区(容器决定是否强制重新确认) */
  onScriptCreated: () => void;
  onScriptUpdated: (scriptId: string) => void;
  onScriptDeleted: (scriptId: string) => void;
  inputChangedWarning: boolean;
  /** 开跑后的分阶段进度;未开跑时为 null。渲染在本步内容栈末尾(BGM 之下),
      点开跑后由容器滚进视野——置顶会落在「开始」按钮的视线之外。 */
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
    coverTitle,
    onCoverTitleChange,
    onConfirmSnapshot,
    onStartBatch,
    onScriptCreated,
    onScriptUpdated,
    onScriptDeleted,
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
  const [coverPresets, setCoverPresets] = useState<CoverPresetView[]>([]);
  const [systemFonts, setSystemFonts] = useState<string[]>(['PingFang SC']);
  const [presetName, setPresetName] = useState('');
  const [coverTitleError, setCoverTitleError] = useState('');
  // 手动脚本导入/编辑弹窗与删除进行中状态。
  const [scriptDialogOpen, setScriptDialogOpen] = useState(false);
  const [editingScript, setEditingScript] = useState<ManualScriptDraft | null>(null);
  const [deletingScriptId, setDeletingScriptId] = useState<string | null>(null);
  const [scriptActionError, setScriptActionError] = useState('');

  // 封面标题预设与系统字体来自全局(与单条共用),一次拉取,失败不阻塞其他输入。
  useEffect(() => {
    void Promise.all([
      fetch('/api/system-fonts').then((response) => response.json()),
      fetch('/api/final-edit/title-presets').then((response) => readJson<CoverPresetView[]>(response)),
    ]).then(([fontBody, presetBody]) => {
      const values = Array.isArray(fontBody) ? fontBody : fontBody.fonts;
      if (Array.isArray(values)) {
        setSystemFonts([...new Set(['PingFang SC', ...values.map((item) => typeof item === 'string' ? item : item.family).filter(Boolean)])]);
      }
      setCoverPresets(presetBody);
    }).catch((error) => setCoverTitleError(error instanceof Error ? error.message : String(error)));
  }, []);

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

  async function deleteManualScript(script: BatchPreparationResult['scripts'][number]): Promise<void> {
    const title = script.title || '未命名脚本';
    const selected = selectedScripts[script.id] !== undefined;
    // 已勾选的脚本删除后会改变批次输入,必须二次确认并说明后果。
    const message = selected
      ? `确定删除手动脚本「${title}」吗？该脚本已在本批次选中，删除后需要重新确认输入。`
      : `确定删除手动脚本「${title}」吗？`;
    if (!confirm(message)) return;
    setDeletingScriptId(script.id);
    setScriptActionError('');
    try {
      await readJson<unknown>(await fetch(
        `/api/batch-production/scripts/${encodeURIComponent(script.id)}?projectId=${encodeURIComponent(prep.project.id)}`,
        { method: 'DELETE' },
      ));
      onScriptDeleted(script.id);
    } catch (deleteError) {
      setScriptActionError(deleteError instanceof Error ? deleteError.message : '脚本删除失败');
    } finally {
      setDeletingScriptId(null);
    }
  }

  function openEditScriptDialog(script: BatchPreparationResult['scripts'][number]): void {
    setScriptActionError('');
    setEditingScript({
      id: script.id,
      title: script.title,
      bodyText: script.bodyText,
      targetDurationSec: script.targetDurationSec ?? 15,
    });
    setScriptDialogOpen(true);
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
                className="h-9 min-w-44 rounded-xl border border-hairline bg-surface px-3 text-sm text-ink"
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
                className={`relative cursor-pointer rounded-xl border p-2 text-center transition ${item.id === effectiveVoice ? 'border-accent bg-accent/5' : 'border-hairline bg-surface'}`}
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
              className="h-8 min-w-40 flex-1 rounded-xl border border-hairline bg-surface px-3 text-xs text-ink"
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


  const coverPresetId = outputPreset.id.replace(':', 'x') as OutputPresetId;

  /**
   * 封面标题草稿更新:进入「使用预设/自定义」时补齐已解析的当前画幅样式与
   * 默认 framing,保证 defaultsJson 始终是稳定完整形状(不选也为 none + null)。
   */
  function updateCoverTitle(patch: Partial<BatchCoverTitleDraft>): void {
    const next: BatchCoverTitleDraft = {
      mode: patch.mode ?? coverTitle.mode,
      presetId: patch.presetId !== undefined ? patch.presetId : coverTitle.presetId,
      styles: patch.styles !== undefined ? patch.styles : coverTitle.styles,
      framing: patch.framing !== undefined ? patch.framing : coverTitle.framing,
    };
    if (next.mode === 'preset' || next.mode === 'custom') {
      if (!next.styles) {
        next.styles = {
          primary: defaultTextStyle('coverPrimary', OUTPUT_PRESETS[coverPresetId].width),
          secondary: defaultTextStyle('coverSecondary', OUTPUT_PRESETS[coverPresetId].width),
        };
      }
      if (!next.framing) next.framing = { scale: 1, offsetX: 0, offsetY: 0 };
    }
    onCoverTitleChange(next);
  }

  function updateCoverStyle(kind: 'primary' | 'secondary', patch: Partial<TextStyle>): void {
    if (!coverTitle.styles) return;
    onCoverTitleChange({
      ...coverTitle,
      styles: { ...coverTitle.styles, [kind]: { ...coverTitle.styles[kind], ...patch } },
    });
  }

  function applyCoverPreset(preset: CoverPresetView): void {
    const value = preset.stylesByPreset[coverPresetId];
    if (!value) return;
    updateCoverTitle({
      mode: 'preset',
      presetId: preset.id,
      styles: { primary: value.primary, secondary: value.secondary },
      framing: { ...value.framing },
    });
  }

  async function saveCoverPreset(): Promise<void> {
    const name = presetName.trim();
    if (!name) {
      setCoverTitleError('请输入预设名称。');
      return;
    }
    if (!coverTitle.styles) {
      setCoverTitleError('请先选择「使用预设」或「自定义」并调整样式，再保存为新预设。');
      return;
    }
    setCoverTitleError('');
    try {
      // 当前画幅写当前样式,其余比例用默认样式补齐,满足 CoverPresetV2 三比例形状。
      const stylesByPreset = Object.fromEntries((Object.keys(OUTPUT_PRESETS) as OutputPresetId[]).map((preset) => [
        preset,
        {
          primary: preset === coverPresetId
            ? coverTitle.styles!.primary
            : defaultTextStyle('coverPrimary', OUTPUT_PRESETS[preset].width),
          secondary: preset === coverPresetId
            ? coverTitle.styles!.secondary
            : defaultTextStyle('coverSecondary', OUTPUT_PRESETS[preset].width),
          framing: preset === coverPresetId
            ? { ...(coverTitle.framing ?? { scale: 1, offsetX: 0, offsetY: 0 }) }
            : { scale: 1, offsetX: 0, offsetY: 0 },
        },
      ])) as CoverPresetV2['stylesByPreset'];
      const created = await readJson<CoverPresetView>(await fetch('/api/final-edit/title-presets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, version: 2, stylesByPreset }),
      }));
      setCoverPresets((items) => [...items, created]);
      setPresetName('');
    } catch (error) {
      setCoverTitleError(error instanceof Error ? error.message : '预设保存失败');
    }
  }

  async function deleteCoverPreset(presetId: string): Promise<void> {
    setCoverTitleError('');
    try {
      const response = await fetch(`/api/final-edit/title-presets/${encodeURIComponent(presetId)}`, { method: 'DELETE' });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.message || body.error || '预设删除失败');
      }
      setCoverPresets((items) => items.filter((item) => item.id !== presetId));
    } catch (error) {
      setCoverTitleError(error instanceof Error ? error.message : '预设删除失败');
    }
  }

  function renderCoverTextStyleEditor(kind: 'primary' | 'secondary', style: TextStyle) {
    // min-w-0:grid 子项默认 min-width:auto,内容比列宽长时会顶破列宽,
    // 表现为标签竖排折行、相邻控件互相重叠。
    const smallInput = 'h-7 w-full min-w-0 rounded-lg border border-hairline bg-surface px-2 text-xs text-ink';
    const smallColor = 'h-7 w-10 shrink-0 rounded border border-hairline bg-surface p-0.5';
    return (
      <div className="rounded-xl bg-surface-subtle p-3">
        <p className="mb-1.5 text-xs font-medium text-ink">{kind === 'primary' ? '主标题样式' : '副标题样式'}</p>
        <div className="grid grid-cols-2 gap-x-3 gap-y-1.5">
          <label className="flex min-w-0 flex-col gap-0.5">
            <span className="text-[11px] text-ink-tertiary">字体</span>
            <select
              aria-label={`${kind === 'primary' ? '主标题' : '副标题'}字体`}
              value={style.fontFamily}
              disabled={frozen}
              onChange={(event) => updateCoverStyle(kind, { fontFamily: event.target.value })}
              className={smallInput}
            >
              {systemFonts.map((font) => <option key={font} value={font}>{font}</option>)}
            </select>
          </label>
          <label className="flex min-w-0 flex-col gap-0.5">
            <span className="text-[11px] text-ink-tertiary">字号</span>
            <input
              type="number"
              min={8}
              max={400}
              aria-label={`${kind === 'primary' ? '主标题' : '副标题'}字号`}
              value={style.fontSizePx}
              disabled={frozen}
              onChange={(event) => updateCoverStyle(kind, { fontSizePx: Math.max(8, Number.parseInt(event.target.value, 10) || 8) })}
              className={smallInput}
            />
          </label>
          <label className="flex min-w-0 flex-col gap-0.5">
            <span className="text-[11px] text-ink-tertiary">颜色</span>
            <span className="flex min-w-0 items-center gap-1.5">
              <input
                type="color"
                aria-label={`${kind === 'primary' ? '主标题' : '副标题'}颜色`}
                value={style.color}
                disabled={frozen}
                onChange={(event) => updateCoverStyle(kind, { color: event.target.value })}
                className={smallColor}
              />
              <span className="truncate text-[11px] tabular-nums text-ink-tertiary">{style.color}</span>
            </span>
          </label>
          <label className="flex items-end gap-2 pb-1.5">
            <span className="flex items-center gap-1.5 text-xs text-ink-secondary">
              <input
                type="checkbox"
                aria-label={`${kind === 'primary' ? '主标题' : '副标题'}斜体`}
                checked={style.italic}
                disabled={frozen}
                onChange={(event) => updateCoverStyle(kind, { italic: event.target.checked })}
                className="h-3.5 w-3.5 accent-[var(--color-accent)]"
              />
              斜体
            </span>
          </label>
          {/* 描边是 4 个控件的一行(开关+标签+颜色+宽度),占满整行才不会把
              「描边」二字挤成竖排、并把相邻格子的滑块顶歪。 */}
          <label className="col-span-2 flex min-w-0 flex-col gap-0.5">
            <span className="flex min-w-0 items-center justify-between gap-2 text-[11px] text-ink-tertiary">
              <span className="flex shrink-0 items-center gap-1.5 whitespace-nowrap">
                <input
                  type="checkbox"
                  aria-label={`${kind === 'primary' ? '主标题' : '副标题'}描边`}
                  checked={style.stroke.enabled}
                  disabled={frozen}
                  onChange={(event) => updateCoverStyle(kind, { stroke: { ...style.stroke, enabled: event.target.checked } })}
                  className="h-3.5 w-3.5 accent-[var(--color-accent)]"
                />
                描边
              </span>
              <span className="flex shrink-0 items-center gap-1">
                <input
                  type="color"
                  aria-label={`${kind === 'primary' ? '主标题' : '副标题'}描边颜色`}
                  value={style.stroke.color}
                  disabled={frozen || !style.stroke.enabled}
                  onChange={(event) => updateCoverStyle(kind, { stroke: { ...style.stroke, color: event.target.value } })}
                  className={smallColor}
                />
                <input
                  type="number"
                  min={0}
                  max={40}
                  aria-label={`${kind === 'primary' ? '主标题' : '副标题'}描边宽度`}
                  value={style.stroke.widthPx}
                  disabled={frozen || !style.stroke.enabled}
                  onChange={(event) => updateCoverStyle(kind, { stroke: { ...style.stroke, widthPx: Math.max(0, Number.parseInt(event.target.value, 10) || 0) } })}
                  className="h-7 w-14 shrink-0 rounded-lg border border-hairline bg-surface px-2 text-xs text-ink"
                />
              </span>
            </span>
          </label>
          <label className="col-span-2 flex min-w-0 flex-col gap-0.5">
            <span className="flex items-center justify-between text-[11px] text-ink-tertiary">
              <span>纵向位置</span>
              <span className="tabular-nums">{Math.round(style.y * 100)}%</span>
            </span>
            <input
              type="range"
              min={0}
              max={100}
              aria-label={`${kind === 'primary' ? '主标题' : '副标题'}纵向位置`}
              value={Math.round(style.y * 100)}
              disabled={frozen}
              onChange={(event) => updateCoverStyle(kind, { y: Number(event.target.value) / 100 })}
              className="w-full accent-[var(--color-accent)]"
            />
          </label>
        </div>
      </div>
    );
  }

  /** 封面标题卡:统一选择预设/自定义样式,批量成片共用;冻结后整卡只读。 */
  function renderCoverTitleSection() {
    const hasTitle = coverTitle.mode !== 'none' && coverTitle.styles !== null;
    const coverStyles = coverTitle.styles;
    const previewSource = frozen
      ? frozenScriptSnapshots[0]?.coverTitle
      : prep.scripts.find((script) => selectedScripts[script.id] !== undefined)?.coverTitle;
    const primaryText = previewSource?.primary?.trim() || '示例主标题';
    const secondaryText = previewSource?.secondary?.trim() || '示例副标题';
    const preset = coverPresets.find((item) => item.id === coverTitle.presetId);
    // 预览与成片同构:viewBox 用真实输出尺寸,字号/描边/纵向位置全部按输出
    // 像素写,缩放交给浏览器——不需要任何预览缩放系数。文字层复用渲染端那份
    // textStyleToSvgElements(paint-order="stroke fill",描边在填充之下),
    // 而不是 CSS WebkitTextStroke(描边压在填充之上,小字号下会吃掉填充色)。
    const previewSize = OUTPUT_PRESETS[coverPresetId] ?? OUTPUT_PRESETS['3x4'];
    const previewTitleSvg = [
      primaryText ? textStyleToSvgElements(coverStyles?.primary ?? defaultTextStyle('coverPrimary', previewSize.width), primaryText, previewSize) : '',
      secondaryText ? textStyleToSvgElements(coverStyles?.secondary ?? defaultTextStyle('coverSecondary', previewSize.width), secondaryText, previewSize) : '',
    ].join('');

    return (
      <section className={`card space-y-3 p-5 ${frozen ? 'border-accent/30' : ''}`} aria-label="封面标题">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-center gap-2">
            <Icon name="text" size={15} />
            <h3 className="font-semibold text-ink">封面标题</h3>
            {frozen && <span className="rounded-full bg-surface-subtle px-2.5 py-0.5 text-[11px] text-ink-tertiary">已锁定</span>}
          </div>
          <label className="flex items-center gap-2">
            <span className="text-xs text-ink-secondary">模式</span>
            <select
              aria-label="封面标题模式"
              value={coverTitle.mode}
              disabled={frozen}
              onChange={(event) => updateCoverTitle({ mode: event.target.value as BatchCoverTitleDraft['mode'] })}
              className="h-8 rounded-xl border border-hairline bg-surface px-3 text-xs text-ink"
            >
              <option value="none">无标题</option>
              <option value="preset">使用预设</option>
              <option value="custom">自定义</option>
            </select>
          </label>
        </div>

        <p className="text-xs text-ink-tertiary">
          标题文字来自各脚本的封面标题（第 3 步生成），此处统一控制样式与位置；确认整体输入后随版本冻结，改样式会形成批次新版本。
        </p>

        {hasTitle && coverStyles && (
          <div className="flex flex-wrap gap-4">
            {/* 两个样式编辑器竖排:再切一次两列会让每个字段只剩约 95px,
                标签折行、控件互相重叠。宽度让给字段本身。 */}
            <div className="grid min-w-64 flex-1 gap-2.5">
              {renderCoverTextStyleEditor('primary', coverStyles.primary)}
              {renderCoverTextStyleEditor('secondary', coverStyles.secondary)}
            </div>
            <div className="flex min-w-56 flex-1 flex-col gap-2">
              <div
                className="relative w-full overflow-hidden rounded-xl bg-gradient-to-br from-slate-600 via-slate-700 to-slate-900"
                style={{ aspectRatio: `${previewSize.width} / ${previewSize.height}`, maxHeight: 260 }}
              >
                <svg
                  viewBox={`0 0 ${previewSize.width} ${previewSize.height}`}
                  xmlns="http://www.w3.org/2000/svg"
                  role="img"
                  aria-label="封面标题预览"
                  className="absolute inset-0 h-full w-full"
                  // 内容由 textStyleToSvgElements 生成,文本与属性都过 escapeXml。
                  dangerouslySetInnerHTML={{ __html: previewTitleSvg }}
                />
              </div>
              <p className="text-[11px] text-ink-tertiary">
                预览按成片尺寸等比缩放，样式与合成一致（底图为示意色块）；<span className="text-ink-secondary">{frozen ? '当前快照' : '第一份已选脚本'}</span>的标题：{primaryText} / {secondaryText}
              </p>
            </div>
          </div>
        )}

        {coverTitle.mode === 'preset' && (
          <div className="space-y-2">
            <label className="flex items-center gap-2">
              <span className="text-xs text-ink-secondary">预设</span>
              <select
                aria-label="选择封面标题预设"
                value={coverTitle.presetId ?? ''}
                disabled={frozen}
                onChange={(event) => {
                  const chosen = coverPresets.find((item) => item.id === event.target.value);
                  if (chosen) applyCoverPreset(chosen);
                }}
                className="h-8 min-w-52 rounded-xl border border-hairline bg-surface px-3 text-xs text-ink"
              >
                <option value="">{coverPresets.length === 0 ? '暂无预设' : '选择一个预设…'}</option>
                {coverPresets.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
              </select>
              {coverTitle.presetId && (
                <span className="text-[11px] text-ink-tertiary">已应用「{preset?.name ?? '已删除的预设'}」</span>
              )}
            </label>
            {coverPresets.length === 0 && (
              <p className="text-xs text-ink-tertiary">还没有保存的预设 —— 可在「自定义」下调整后点「存为预设」。</p>
            )}
          </div>
        )}

        {!frozen && (
          <div className="space-y-2 border-t border-hairline pt-3">
            <div className="flex flex-wrap items-center gap-2">
              <input
                type="text"
                aria-label="新预设名称"
                value={presetName}
                onChange={(event) => setPresetName(event.target.value)}
                onKeyDown={(event) => { if (event.key === 'Enter') void saveCoverPreset(); }}
                placeholder="把当前样式存为预设…"
                className="h-8 min-w-48 flex-1 rounded-xl border border-hairline bg-surface px-3 text-xs text-ink"
              />
              <button type="button" className="btn-secondary h-8 px-3 text-xs" disabled={!hasTitle} onClick={() => void saveCoverPreset()}>
                存为预设
              </button>
            </div>
            {coverPresets.length > 0 && (
              <ul className="flex flex-wrap gap-1.5">
                {coverPresets.map((item) => (
                  <li key={item.id} className="flex items-center gap-1 rounded-full bg-surface-subtle py-1 pl-3 pr-1 text-xs text-ink-secondary">
                    <button
                      type="button"
                      className="underline-offset-2 hover:text-accent hover:underline"
                      onClick={() => applyCoverPreset(item)}
                    >{item.name}</button>
                    <button
                      type="button"
                      aria-label={`删除预设 ${item.name}`}
                      className="grid h-5 w-5 place-items-center rounded-full text-ink-tertiary hover:bg-fail/10 hover:text-fail"
                      onClick={() => void deleteCoverPreset(item.id)}
                    ><Icon name="close" size={10} /></button>
                  </li>
                ))}
              </ul>
            )}
            {coverTitleError && <p className="text-xs text-fail">{coverTitleError}</p>}
          </div>
        )}
      </section>
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
            <div className="flex shrink-0 flex-wrap items-center justify-end gap-3">
              <button
                type="button"
                className="btn-secondary h-8 px-3 text-xs"
                aria-label="导入自定义脚本"
                onClick={() => { setScriptActionError(''); setEditingScript(null); setScriptDialogOpen(true); }}
              >+ 导入自定义脚本</button>
              <span className="text-sm text-ink-secondary">已选 {scriptCount} 份 · 目标成片 {plannedCount} 条</span>
            </div>
          </div>
          {scriptActionError && <p className="mb-3 text-xs text-fail" role="alert">{scriptActionError}</p>}
          {prep.scripts.length > 0 ? (
            <div className="grid gap-3 lg:grid-cols-2">
              {prep.scripts.map((script) => {
                const selected = selectedScripts[script.id] !== undefined;
                const durationSec = script.targetDurationSec ?? 15;
                const title = script.title || '未命名脚本';
                return selected ? (
                  <article key={script.id} className={`rounded-2xl border bg-surface p-4 shadow-sm ${selected ? 'border-accent ring-2 ring-accent/10' : 'border-hairline'}`}>
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
                            {script.manual && (
                              <span className="rounded-full bg-accent/10 px-2 py-1 text-[11px] text-accent">手动</span>
                            )}
                            <span className="rounded-full bg-surface-subtle px-2 py-1 text-[11px] text-ink-secondary">V{script.sourceVersion}</span>
                            <span className="rounded-full bg-surface-subtle px-2 py-1 text-[11px] text-ink-secondary">
                              {durationSec} 秒{durationSec === 15 && !script.targetDurationSec ? '（默认 15 秒）' : ''}
                            </span>
                            {script.manual && (
                              <>
                                <button
                                  type="button"
                                  className="text-xs text-accent underline"
                                  aria-label={`编辑手动脚本 ${title}`}
                                  onClick={() => openEditScriptDialog(script)}
                                >编辑</button>
                                <button
                                  type="button"
                                  className="text-xs text-fail underline"
                                  aria-label={`删除手动脚本 ${title}`}
                                  disabled={deletingScriptId === script.id}
                                  onClick={() => void deleteManualScript(script)}
                                >{deletingScriptId === script.id ? '删除中…' : '删除'}</button>
                              </>
                            )}
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
                            className="w-20 rounded-lg border border-hairline bg-surface px-2 py-1 text-right text-ink"
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
                    className="flex items-center gap-3 rounded-2xl border border-hairline bg-surface px-4 py-3 text-left shadow-sm transition hover:border-accent/40"
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

      {renderBgmSection()}

      {renderCoverTitleSection()}

      {!frozen && (
        <section className="card space-y-4 p-5" aria-label="输出设置与开始">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <h3 className="font-semibold text-ink">输出设置</h3>
              <p className="mt-1 text-sm text-ink-secondary">
                画幅 {outputPreset.label}（顶栏统一设置）；背景音乐在上方卡片中设置。时长不提供修改 —— 脚本在第 3 步生成时已按档位约束字数。
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
      {/* 进度卡放在本步最末:BGM 是开跑前的输入,必须排在进度之上。
          id 是容器点开跑后滚进视野的锚点(见 BatchPreparationPanel 的
          scrollToProgressRef)——置顶会落在「开始」按钮的视线之外。 */}
      {progress && (
        <div id={BATCH_PROGRESS_ANCHOR_ID}>
          <BatchProductionProgressCard progress={progress} variant="full" />
        </div>
      )}
      <BatchScriptImportDialog
        open={scriptDialogOpen}
        projectId={prep.project.id}
        editScript={editingScript}
        onClose={() => setScriptDialogOpen(false)}
        onCreated={() => { setScriptDialogOpen(false); onScriptCreated(); }}
        onUpdated={(scriptId) => { setScriptDialogOpen(false); onScriptUpdated(scriptId); }}
      />
    </div>
  );
}
