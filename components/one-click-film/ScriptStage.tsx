'use client';

import { useState } from 'react';
import { EmptyState, Tag, ToolbarButton } from '@/components/ui/Appearance';
import {
  formatModelLabel,
  inferModelFromContext,
  MODEL_CUSTOM_LIMIT,
  MODEL_PRESET_LABELS,
  MODEL_PRESETS,
  ONE_CLICK_FILM_MAX_ENTRIES,
  ONE_CLICK_FILM_MIN_ENTRIES,
  SCRIPT_TITLE_LIMIT,
  SOUND_LABELS,
  SOUND_MODES,
  STRUCTURE_LABELS,
  STORY_STRUCTURES,
  structureAt,
  type ModelPreset,
  type SoundMode,
  type StoryStructure,
  type StructurePlanMode,
} from '@/lib/one-click-film/contract';
import type { FilmEntry, FilmState } from './types';
import { NarrationPanel } from './NarrationPanel';
import styles from './one-click-film.module.css';

type ScriptDraft = Pick<FilmEntry, 'title' | 'outline' | 'narration' | 'promptText' | 'modelPreset' | 'modelCustom'>;

function savedStructureMode(entries: FilmEntry[]): StructurePlanMode {
  const first = entries[0];
  if (!first) return 'auto';
  return entries.every(entry => entry.structureSource === first.structureSource
    && (entry.structureSource !== 'batch' || entry.structure === first.structure)) ? first.structureSource : 'individual';
}

function savedChoices(entries: FilmEntry[]): Array<StoryStructure | 'auto'> {
  return entries.map(entry => entry.structureSource === 'auto' ? 'auto' : entry.structure);
}

function ScriptText({ script }: { script: ScriptDraft }) {
  return <div className={styles.savedScript}>
    {([['outline', '内容大纲'], ['narration', '口播文案'], ['promptText', '分镜提示词']] as const)
      .map(([field, label]) => script[field] ? <section key={field}><b>{label}</b><p>{script[field]}</p></section> : null)}
  </div>;
}

type ScriptSnapshot = ScriptDraft & { id: string; revisionNumber: number; createdAt: string };

function ScriptHistory({ projectId, code, onUse }: { projectId: string; code: string; onUse: (script: ScriptDraft) => void }) {
  const [records, setRecords] = useState<ScriptSnapshot[] | null>(null);
  const [error, setError] = useState('');
  const load = async () => {
    setError('');
    try {
      const response = await fetch(`/api/one-click-film/${projectId}/scripts?history=${encodeURIComponent(code)}`);
      if (!response.ok) throw new Error('读取历史稿件失败，请重新展开重试。');
      const data = await response.json() as { revisions: ScriptSnapshot[] };
      setRecords(data.revisions);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };
  return <details className={styles.scriptArchive} onToggle={event => {
    if (event.target === event.currentTarget && event.currentTarget.open) void load();
  }}>
    <summary>历史稿件</summary>
    {error ? <p role="alert">{error}</p> : !records ? <p>读取中…</p> : records.length ? records.map(record =>
      <details key={record.id}>
        <summary>记录 {record.revisionNumber} · {record.title || '未命名脚本'} · {new Date(record.createdAt).toLocaleString('zh-CN')}</summary>
        <ScriptText script={record} />
        <button type="button" className="cap" onClick={() => onUse(record)}>载入编辑区</button>
      </details>) : <p>还没有历史稿件。</p>}
  </details>;
}

/**
 * 第二步 · 生成脚本：整批设置（数量、结构、出镜人物、声音）与逐条编辑分开。
 * 「重新生成本条」在本条卡片内（支持单独换人物重写），「重新生成全部」在整批设置区。
 */
export function ScriptStage({
  state,
  busy,
  onReload,
  focusCode,
  onContinue,
  onBack,
}: {
  state: FilmState;
  busy: boolean;
  onReload: () => Promise<void>;
  focusCode?: string;
  onContinue?: () => void;
  onBack: () => void;
}) {
  const analysis = state.analysis;
  const entries = state.entries;
  const batchDefaultEntry = entries.find((entry) => entry.modelSource !== 'individual') ?? entries[0];
  const [count, setCount] = useState(entries.length || 2);
  const retired = state.retiredEntries ?? [];
  const [structureMode, setStructureMode] = useState<StructurePlanMode>(() => savedStructureMode(entries));
  const [batchStructure, setBatchStructure] = useState<StoryStructure>(entries[0]?.structure ?? 'scene');
  const [individualEdits, setIndividualEdits] = useState<Array<StoryStructure | 'auto'>>(() =>
    savedChoices([...entries, ...retired]));
  const [soundMode, setSoundMode] = useState<SoundMode>(entries[0]?.soundMode ?? 'native');
  const [modelPreset, setModelPreset] = useState<ModelPreset>(batchDefaultEntry?.modelPreset ?? 'auto');
  const [modelCustom, setModelCustom] = useState(batchDefaultEntry?.modelCustom ?? '');
  const [batchModelEdited, setBatchModelEdited] = useState(false);
  const [activeCode, setActiveCode] = useState(focusCode ?? entries[0]?.code ?? '');
  const [error, setError] = useState('');
  const [working, setWorking] = useState('');
  const [edits, setEdits] = useState<(ScriptDraft & { key: string }) | null>(null);
  const [expanded, setExpanded] = useState(false);

  const active = entries.find((entry) => entry.code === activeCode) ?? entries[0] ?? null;
  const individual = Array.from({ length: count }, (_, index) => individualEdits[index] ?? 'auto');
  const resolvedAutoModel = inferModelFromContext({
    suggestedModel: analysis?.suggestedModel,
    product: analysis?.confirmedProductName || analysis?.productName,
    appearance: analysis?.appearance,
    sceneClues: analysis?.sceneClues,
    points: analysis?.points.filter((point) => point.selected).map((point) => point.text) ?? [],
  });
  // 草稿以「条目 + 版本 + 人物」为键：切换条目或重新生成后自动回到该版本原文，无需 effect 同步。
  const draftKey = active
    ? `${active.id}:${active.scriptRevision}:${active.status}:${active.modelPreset}:${active.modelCustom}`
    : '';
  const draft: ScriptDraft = edits?.key === draftKey
    ? {
        title: edits.title,
        outline: edits.outline,
        narration: edits.narration,
        promptText: edits.promptText,
        modelPreset: edits.modelPreset,
        modelCustom: edits.modelCustom,
      }
    : {
        title: active?.title ?? '',
        outline: active?.outline ?? '',
        narration: active?.narration ?? '',
        promptText: active?.promptText ?? '',
        modelPreset: active?.modelPreset ?? 'auto',
        modelCustom: active?.modelCustom ?? '',
      };
  const setDraft = (updater: (current: ScriptDraft) => ScriptDraft) => {
    setEdits({ key: draftKey, ...updater(draft) });
  };

  if (!analysis?.confirmedAt) {
    return <div className={styles.stage}>
      <div className={styles.stageBody}>
        <EmptyState
          icon="sparkle"
          title="先确认素材分析"
          description="产品名称与选用的卖点确认后，才能生成脚本。"
        />
      </div>
    </div>;
  }

  const post = async (path: string, body: Record<string, unknown>) => {
    setError('');
    const response = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const payload = await response.json() as { entries?: FilmEntry[]; message?: string; error?: string };
    if (!response.ok) throw new Error(payload.message || payload.error || '操作失败');
    await onReload();
    return payload;
  };

  const applyPlan = async () => {
    if (modelPreset === 'custom' && !modelCustom.trim()) {
      setError('选择自定义出镜人物时，请先填写人物描述。');
      return;
    }
    setWorking('apply');
    try {
      await savePendingEdits();
      await post(`/api/one-click-film/${state.project.id}/scripts`, {
        action: 'apply',
        count,
        plan: structureMode === 'auto'
          ? { mode: 'auto' }
          : structureMode === 'batch'
            ? { mode: 'batch', structure: batchStructure }
            : { mode: 'individual', choices: individual },
        soundMode,
        modelPreset,
        modelCustom: modelPreset === 'custom' ? modelCustom.trim() : '',
        preserveIndividualModel: !batchModelEdited,
      });
      setBatchModelEdited(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setWorking('');
    }
  };

  const entryAction = async (entry: FilmEntry, action: 'save' | 'confirm' | 'redraft', patch?: Record<string, unknown>) => {
    const nextPreset = (patch?.modelPreset ?? entry.modelPreset) as ModelPreset;
    const nextCustom = typeof patch?.modelCustom === 'string' ? patch.modelCustom : entry.modelCustom;
    if (nextPreset === 'custom' && !nextCustom.trim()) {
      setError('选择自定义出镜人物时，请先填写本条人物描述。');
      return;
    }
    setWorking(`${action}:${entry.code}`);
    try {
      if (action === 'redraft') await savePendingEdits();
      await post(`/api/one-click-film/${state.project.id}/scripts/${entry.code}`, { action, revision: entry.scriptRevision, ...(patch ?? {}) });
      setEdits(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setWorking('');
    }
  };

  const redraftAll = async () => {
    setWorking('redraft-all');
    try {
      await savePendingEdits();
      await post(`/api/one-click-film/${state.project.id}/scripts`, { action: 'redraft-all' });
    } catch (cause) {
      await onReload();
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setWorking('');
    }
  };

  const savePendingEdits = async () => {
    if (active && edits?.key === draftKey && (Object.keys(draft) as Array<keyof ScriptDraft>).some(key => draft[key] !== active[key])) {
      await post(`/api/one-click-film/${state.project.id}/scripts/${active.code}`, { action: 'save', ...draft });
    }
  };

  const restore = async (entry: FilmEntry) => {
    setWorking('restore');
    try {
      const { entries: restored } = await post(`/api/one-click-film/${state.project.id}/scripts`,
        { action: 'restore-retired', code: entry.code });
      if (restored?.length) {
        setCount(restored.length);
        setStructureMode(savedStructureMode(restored));
        setBatchStructure(restored[0].structure);
        setIndividualEdits(savedChoices([...restored, ...retired.filter(item => item.ordinal > entry.ordinal)]));
        setSoundMode(restored[0].soundMode);
        if (edits?.key !== draftKey) setActiveCode(entry.code);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setWorking('');
    }
  };

  const confirmedCount = entries.filter((entry) => entry.status === 'confirmed').length;
  const ttsEntries = entries.filter((entry) => entry.soundMode === 'tts');
  const selectedPoints = analysis.points.filter((point) => point.selected).length;

  return <div className={styles.scriptStage}>
    <header className={styles.stageTitle}>
      <div>
        <h2>生成脚本</h2>
        <p className={styles.hint}>{analysis.confirmedProductName || analysis.productName} · 已采用 {selectedPoints} 项卖点</p>
      </div>
      <div className={styles.inlineActions}>
        <ToolbarButton icon="chevron-left" onClick={onBack}>返回分析内容</ToolbarButton>
        <ToolbarButton icon="chevron-right" variant="primary" disabled={entries.length === 0 || confirmedCount !== entries.length || Boolean(working)}
          onClick={onContinue}>继续生成视频</ToolbarButton>
      </div>
    </header>

    <section className={styles.scriptSettings} aria-labelledby="film-script-settings">
      <h3 id="film-script-settings" className={styles.panelHeading}>脚本设置</h3>
      <div className={styles.scriptFields}>
        <label className={styles.field}>
          <span>视频结构</span>
          <select className="input-field" aria-label="视频结构" value={structureMode}
            onChange={(event) => setStructureMode(event.target.value as StructurePlanMode)}>
            <option value="auto">自动搭配</option>
            <option value="batch">整批指定</option>
            <option value="individual">逐条指定</option>
          </select>
        </label>
        <label className={styles.field}>
          <span>出镜人物</span>
          <select
            className="input-field"
            aria-label="出镜人物"
            value={modelPreset}
            onChange={(event) => {
              setModelPreset(event.target.value as ModelPreset);
              setBatchModelEdited(true);
            }}
          >
            {MODEL_PRESETS.map((preset) => (
              <option key={preset} value={preset}>
                {preset === 'auto'
                  ? formatModelLabel({ preset: 'auto' }, resolvedAutoModel)
                  : MODEL_PRESET_LABELS[preset]}
              </option>
            ))}
          </select>
        </label>
        <label className={styles.field}>
          <span>配音方式</span>
          <select className="input-field" aria-label="配音方式" value={soundMode}
            onChange={(event) => setSoundMode(event.target.value as SoundMode)}>
            {SOUND_MODES.map((mode) => <option key={mode} value={mode}>{SOUND_LABELS[mode]}</option>)}
          </select>
        </label>
        <label className={styles.field}>
          <span>成片数量</span>
          <select className="input-field" aria-label="成片数量" value={count} onChange={(event) => setCount(Number(event.target.value))}>
            {Array.from({ length: ONE_CLICK_FILM_MAX_ENTRIES - ONE_CLICK_FILM_MIN_ENTRIES + 1 }, (_, index) => index + ONE_CLICK_FILM_MIN_ENTRIES)
              .map((value) => <option key={value} value={value}>{value} 条</option>)}
          </select>
        </label>
        {structureMode === 'batch' ? <label className={styles.field}>
          <span>整批结构</span>
          <select className="input-field" aria-label="整批结构" value={batchStructure}
            onChange={(event) => setBatchStructure(event.target.value as StoryStructure)}>
            {STORY_STRUCTURES.map((structure) => <option key={structure} value={structure}>{STRUCTURE_LABELS[structure]}</option>)}
          </select>
        </label> : null}
      </div>

      {modelPreset === 'custom' ? <label className={styles.field}>
        <span>自定义出镜人物描述</span>
        <input
          className="input-field"
          aria-label="自定义出镜人物描述"
          maxLength={MODEL_CUSTOM_LIMIT}
          value={modelCustom}
          placeholder="例如：5岁小女孩，穿米色家居服"
          onChange={(event) => {
            setModelCustom(event.target.value);
            setBatchModelEdited(true);
          }}
        />
      </label> : null}

      {structureMode === 'individual' ? <div className={styles.individualList} role="group" aria-label="逐条视频结构">
        {Array.from({ length: count }, (_, index) => (
          <label key={index} className={styles.individualRow}>
            <span>F{String(index + 1).padStart(2, '0')}</span>
            <select
              className="input-field"
              aria-label={`F${String(index + 1).padStart(2, '0')} 结构`}
              value={individual[index] ?? 'auto'}
              onChange={(event) => setIndividualEdits((current) => {
                const next = [...current];
                next[index] = event.target.value as StoryStructure | 'auto';
                return next;
              })}
            >
              <option value="auto">自动</option>
              {STORY_STRUCTURES.map((structure) => (
                <option key={structure} value={structure}>{STRUCTURE_LABELS[structure]}</option>
              ))}
            </select>
          </label>
        ))}
      </div> : null}
      <div className={styles.scriptSettingsFoot}>
        {entries.length > 0 ? <p className={styles.hint}>{count < entries.length
          ? `应用后，${entries.slice(count).map(entry => entry.code).join('、')} 将移出本批，原稿仍可查看。`
          : '重新生成会保留旧稿，可在每条脚本的「历史稿件」中查看。'}</p> : null}
        <div className={styles.inlineActions}>
          {entries.length > 0 ? <ToolbarButton icon="retry" disabled={busy || Boolean(working)} onClick={() => void redraftAll()}>
            {working === 'redraft-all' ? '重写中…' : '重新生成全部'}
          </ToolbarButton> : null}
          <ToolbarButton icon="sparkle" variant="primary" disabled={busy || Boolean(working)} onClick={() => void applyPlan()}>
            {working === 'apply' ? '生成中…' : '应用设置并生成脚本'}
          </ToolbarButton>
        </div>
      </div>
    </section>
    {error ? <p className={styles.hintFail} role="alert">{error}</p> : null}

    {active ? <div className={styles.scriptDrafts}>
      <nav className={styles.scriptMain} aria-label="本批脚本">
        <div className={styles.scriptListHead}>
          <h3 className={styles.panelHeading}>本批脚本</h3>
          <small className="tnum">{confirmedCount} / {entries.length} 已确认</small>
        </div>
        <div className={styles.scriptList}>
          {entries.map((entry) => <button
            key={entry.id}
            type="button"
            className={styles.scriptItem}
            aria-current={entry.code === active?.code}
            onClick={() => setActiveCode(entry.code)}
          >
            <b>{entry.code}</b>
            <span title={`${STRUCTURE_LABELS[entry.structure]} · ${formatModelLabel({ preset: entry.modelPreset, custom: entry.modelCustom }, resolvedAutoModel)}`}>
              {STRUCTURE_LABELS[entry.structure]} · {formatModelLabel({ preset: entry.modelPreset, custom: entry.modelCustom }, resolvedAutoModel)}
            </span>
            <Tag tone={entry.status === 'confirmed' ? 'ok' : entry.status === 'draft' ? 'run' : 'warn'}>
              {entry.status === 'confirmed' ? '已确认' : entry.status === 'draft' ? '草稿' : '待确认'}
            </Tag>
          </button>)}
        </div>
        {retired.length > 0 ? <details className={styles.scriptArchive}>
          <summary>已移出本批（{retired.length} 条）</summary>
          {retired.map(entry => <details key={entry.id}>
            <summary>{entry.code} · {entry.title}</summary>
            <p className={styles.hint}>恢复后本批共 {entry.ordinal} 条，沿用各条原稿。</p>
            <button type="button" className="cap" disabled={busy || Boolean(working)}
              onClick={() => void restore(entry)}>恢复原稿到本批</button>
            <ScriptText script={entry} />
          </details>)}
        </details> : null}
      </nav>
      <section className={styles.scriptEditor} aria-label={`${active.code} 脚本编辑`}>
        <div className={styles.editorHead}>
          <b>{active.code} · {STRUCTURE_LABELS[active.structure]}</b>
          <Tag tone={active.status === 'confirmed' ? 'ok' : active.status === 'draft' ? 'run' : 'warn'}>
            {active.status === 'confirmed' ? '已确认' : active.status === 'draft' ? '草稿' : '待确认'}
          </Tag>
          <small>{SOUND_LABELS[active.soundMode]} · 第 {active.scriptRevision + 1} 版</small>
        </div>
        <div className={styles.entryModelRow}>
          <label className={styles.field}>
            <span>出镜人物（本条）</span>
            <select
              className="input-field"
              aria-label="本条出镜人物"
              value={draft.modelPreset}
              onChange={(event) => {
                const nextPreset = event.target.value as ModelPreset;
                setDraft((current) => ({
                  ...current,
                  modelPreset: nextPreset,
                  modelCustom: nextPreset === 'custom' ? current.modelCustom : '',
                }));
              }}
            >
              {MODEL_PRESETS.map((preset) => (
                <option key={preset} value={preset}>
                  {preset === 'auto'
                    ? formatModelLabel({ preset: 'auto' }, resolvedAutoModel)
                    : MODEL_PRESET_LABELS[preset]}
                </option>
              ))}
            </select>
          </label>
          {draft.modelPreset === 'custom' ? <label className={styles.field}>
            <span>自定义人物描述</span>
            <input
              className="input-field"
              aria-label="本条自定义出镜人物"
              maxLength={MODEL_CUSTOM_LIMIT}
              value={draft.modelCustom}
              placeholder="例如：5岁小女孩，穿米色家居服"
              onChange={(event) => setDraft((current) => ({ ...current, modelCustom: event.target.value }))}
            />
          </label> : null}
        </div>
        {(draft.modelPreset !== active.modelPreset || draft.modelCustom.trim() !== active.modelCustom) ? (
          <p className={styles.hint}>
            已切换本条出镜人物：点「重新生成本条」将按新人物重写大纲、口播与分镜；直接「保存草稿 / 确认本条」会同步更新分镜提示词中的人物设定。
          </p>
        ) : null}
        <label className={styles.field}>
          <span>成片标题</span>
          <input className="input-field" maxLength={SCRIPT_TITLE_LIMIT} value={draft.title}
            onChange={(event) => setDraft((current) => ({ ...current, title: event.target.value }))} />
        </label>
        <label className={styles.field}>
          <span>内容大纲</span>
          <textarea className="input-field" rows={3} value={draft.outline} onChange={(event) => setDraft((current) => ({ ...current, outline: event.target.value }))} />
        </label>
        <label className={styles.field}>
          <span>口播文案</span>
          <textarea className="input-field" rows={4} value={draft.narration} onChange={(event) => setDraft((current) => ({ ...current, narration: event.target.value }))} />
        </label>
        <div className={styles.scriptPrompt}>
          <div className={styles.fieldHead}>
            <h3 className={styles.panelHeading}>分镜提示词</h3>
            <button type="button" className="cap" onClick={() => setExpanded((value) => !value)}>
              {expanded ? '收起' : '查看与编辑'}
            </button>
          </div>
          {expanded ? <textarea className="input-field" aria-label="分镜提示词全文" rows={12} value={draft.promptText}
            onChange={(event) => setDraft((current) => ({ ...current, promptText: event.target.value }))} /> : null}
        </div>
        <div className={styles.editorActions}>
          <button type="button" className="cap" disabled={Boolean(working)} onClick={() => setEdits(null)}>
            取消编辑
          </button>
          <button type="button" className="cap" disabled={Boolean(working)} onClick={() => void entryAction(active, 'save', draft)}>
            {working === `save:${active.code}` ? '保存中…' : '保存草稿'}
          </button>
          <button
            type="button"
            className="cap"
            disabled={Boolean(working)}
            onClick={() => void entryAction(active, 'redraft', {
              modelPreset: draft.modelPreset,
              modelCustom: draft.modelPreset === 'custom' ? draft.modelCustom.trim() : '',
            })}
          >
            {working === `redraft:${active.code}` ? '重写中…' : '重新生成本条'}
          </button>
          <button type="button" className="cap cap-primary" disabled={Boolean(working)} onClick={() => void entryAction(active, 'confirm', draft)}>
            {working === `confirm:${active.code}` ? '确认中…' : '确认本条'}
          </button>
        </div>
        <ScriptHistory key={draftKey} projectId={state.project.id} code={active.code}
          onUse={record => setDraft(() => ({ ...record, title: record.title || active.title }))} />
      </section>
    </div> : <EmptyState icon="logs" title="还没有脚本" description="应用上方设置后，可逐条编辑大纲、口播和分镜提示词。" />}
    {ttsEntries.length ? <section className={styles.scriptSettings} aria-label="统一旁白">
      <NarrationPanel projectId={state.project.id} bodyDurationSec={active?.promptDurationSec ?? 15}
        entries={ttsEntries} onConfigured={onReload} />
    </section> : null}
  </div>;
}

/** 整批进度：生成视频入口据此拦住待确认条目。 */
export function scriptProgress(entries: FilmEntry[]): { confirmed: number; pending: string[] } {
  return {
    confirmed: entries.filter((entry) => entry.status === 'confirmed').length,
    pending: entries.filter((entry) => entry.status !== 'confirmed').map((entry) => entry.code),
  };
}

export function nextStructure(plan: { mode: StructurePlanMode; structure?: StoryStructure }, index: number): StoryStructure {
  return structureAt({
    mode: plan.mode,
    structure: plan.structure,
    choices: plan.mode === 'individual' ? [] : undefined,
  }, index);
}
