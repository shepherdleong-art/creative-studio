'use client';

import { useState } from 'react';
import { EmptyState, GroupHeading, GroupList, GroupRow, Segmented, Tag } from '@/components/ui/Appearance';
import {
  ONE_CLICK_FILM_MAX_ENTRIES,
  ONE_CLICK_FILM_MIN_ENTRIES,
  SOUND_LABELS,
  SOUND_MODES,
  STRUCTURE_LABELS,
  STORY_STRUCTURES,
  structureAt,
  type SoundMode,
  type StoryStructure,
  type StructurePlanMode,
} from '@/lib/one-click-film/contract';
import type { FilmEntry, FilmState } from './types';
import styles from './one-click-film.module.css';

/**
 * 第二步 · 生成脚本：整批设置（数量、结构、声音）与逐条编辑分开。
 * 「重新生成本条」在本条卡片内，「重新生成全部」在整批设置区。
 */
export function ScriptStage({
  state,
  busy,
  onReload,
}: {
  state: FilmState;
  busy: boolean;
  onReload: () => Promise<void>;
}) {
  const analysis = state.analysis;
  const entries = state.entries;
  const [count, setCount] = useState(entries.length || 2);
  const [structureMode, setStructureMode] = useState<StructurePlanMode>('auto');
  const [batchStructure, setBatchStructure] = useState<StoryStructure>('scene');
  const [individualEdits, setIndividualEdits] = useState<Array<StoryStructure | 'auto'>>([]);
  const [soundMode, setSoundMode] = useState<SoundMode>('native');
  const [activeCode, setActiveCode] = useState(entries[0]?.code ?? '');
  const [error, setError] = useState('');
  const [working, setWorking] = useState('');
  const [edits, setEdits] = useState<{ key: string; outline: string; narration: string; promptText: string } | null>(null);
  const [expanded, setExpanded] = useState(false);

  const active = entries.find((entry) => entry.code === activeCode) ?? entries[0] ?? null;
  const individual = Array.from({ length: count }, (_, index) => individualEdits[index] ?? 'auto');
  // 草稿以「条目 + 版本」为键：切换条目或重新生成后自动回到该版本原文，无需 effect 同步。
  const draftKey = active ? `${active.id}:${active.scriptRevision}:${active.status}` : '';
  const draft = edits?.key === draftKey
    ? { outline: edits.outline, narration: edits.narration, promptText: edits.promptText }
    : { outline: active?.outline ?? '', narration: active?.narration ?? '', promptText: active?.promptText ?? '' };
  const setDraft = (
    updater: { outline: string; narration: string; promptText: string }
      | ((current: { outline: string; narration: string; promptText: string }) => { outline: string; narration: string; promptText: string }),
  ) => {
    const next = typeof updater === 'function' ? updater(draft) : updater;
    setEdits({ key: draftKey, ...next });
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
    const payload = await response.json() as { message?: string; error?: string };
    if (!response.ok) throw new Error(payload.message || payload.error || '操作失败');
    await onReload();
    return payload;
  };

  const applyPlan = async () => {
    setWorking('apply');
    try {
      await post(`/api/one-click-film/${state.project.id}/scripts`, {
        action: 'apply',
        count,
        plan: structureMode === 'auto'
          ? { mode: 'auto' }
          : structureMode === 'batch'
            ? { mode: 'batch', structure: batchStructure }
            : { mode: 'individual', choices: individual },
        soundMode,
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setWorking('');
    }
  };

  const entryAction = async (entry: FilmEntry, action: 'save' | 'confirm' | 'redraft', patch?: Record<string, unknown>) => {
    setWorking(`${action}:${entry.code}`);
    try {
      await post(`/api/one-click-film/${state.project.id}/scripts/${entry.code}`, { action, ...(patch ?? {}) });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setWorking('');
    }
  };

  const redraftAll = async () => {
    setWorking('redraft-all');
    try {
      await post(`/api/one-click-film/${state.project.id}/scripts`, { action: 'redraft-all' });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setWorking('');
    }
  };

  const confirmedCount = entries.filter((entry) => entry.status === 'confirmed').length;
  const pending = entries.filter((entry) => entry.status !== 'confirmed');

  return <div className={styles.scriptStage}>
    <div className={styles.scriptSide}>
      <GroupHeading>整批设置</GroupHeading>
      <GroupList>
        <GroupRow label="成片数量" hint={`${ONE_CLICK_FILM_MIN_ENTRIES}–${ONE_CLICK_FILM_MAX_ENTRIES} 条`}>
          <select
            aria-label="成片数量"
            className="input-field w-24"
            value={count}
            onChange={(event) => setCount(Number(event.target.value))}
          >
            {Array.from({ length: ONE_CLICK_FILM_MAX_ENTRIES }, (_, index) => index + 1).map((value) => (
              <option key={value} value={value}>{value} 条</option>
            ))}
          </select>
        </GroupRow>
        <GroupRow label="结构" stacked>
          <Segmented<StructurePlanMode>
            value={structureMode}
            onChange={setStructureMode}
            label="结构搭配方式"
            size="small"
            options={[
              { value: 'auto', label: '自动搭配' },
              { value: 'batch', label: '整批指定' },
              { value: 'individual', label: '逐条指定' },
            ]}
          />
          {structureMode === 'batch' ? <select
            aria-label="整批结构"
            className="input-field mt-2"
            value={batchStructure}
            onChange={(event) => setBatchStructure(event.target.value as StoryStructure)}
          >
            {STORY_STRUCTURES.map((structure) => (
              <option key={structure} value={structure}>{STRUCTURE_LABELS[structure]}</option>
            ))}
          </select> : null}
        </GroupRow>
        <GroupRow label="声音" stacked>
          <Segmented<SoundMode>
            value={soundMode}
            onChange={setSoundMode}
            label="配音方式"
            size="small"
            options={SOUND_MODES.map((mode) => ({ value: mode, label: SOUND_LABELS[mode] }))}
          />
        </GroupRow>
      </GroupList>

      {structureMode === 'individual' ? <div className={styles.individualList}>
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

      <button type="button" className="cap cap-primary w-full" disabled={busy || Boolean(working)} onClick={() => void applyPlan()}>
        {working === 'apply' ? '应用中…' : '应用设置并生成脚本'}
      </button>
      <button type="button" className="cap w-full" disabled={busy || Boolean(working) || entries.length === 0} onClick={() => void redraftAll()}>
        {working === 'redraft-all' ? '重写中…' : '重新生成全部'}
      </button>
      <p className={styles.hint}>
        应用数量或结构时，仍适用的条目会沿用自己的手稿、配音和确认记录。
      </p>
    </div>

    <div className={styles.scriptMain}>
      <div className={styles.scriptListHead}>
        <b>脚本 · 已确认 {confirmedCount}/{entries.length}</b>
        <small>{pending.length > 0 ? `还有 ${pending.map((entry) => entry.code).join('、')} 待确认` : '全部确认，可以继续生成视频'}</small>
      </div>
      {entries.length === 0 ? <EmptyState icon="sparkle" title="还没有脚本" description="在上方设定数量与结构，然后应用设置。" /> : (
        <div className={styles.scriptList}>
          {entries.map((entry) => <button
            key={entry.id}
            type="button"
            className={styles.scriptItem}
            aria-current={entry.code === active?.code}
            onClick={() => setActiveCode(entry.code)}
          >
            <b>{entry.code}</b>
            <span>{STRUCTURE_LABELS[entry.structure]}</span>
            <Tag tone={entry.status === 'confirmed' ? 'ok' : entry.status === 'draft' ? 'run' : 'warn'}>
              {entry.status === 'confirmed' ? '已确认' : entry.status === 'draft' ? '草稿' : '待确认'}
            </Tag>
          </button>)}
        </div>
      )}
    </div>

    <div className={styles.scriptEditor}>
      {!active ? <EmptyState icon="logs" title="选中一条脚本" description="左侧列表里点 F01 或 F02 查看大纲、口播和分镜全文。" /> : <>
        <div className={styles.editorHead}>
          <b>{active.code} · {STRUCTURE_LABELS[active.structure]}</b>
          <Tag tone={active.status === 'confirmed' ? 'ok' : active.status === 'draft' ? 'run' : 'warn'}>
            {active.status === 'confirmed' ? '已确认' : active.status === 'draft' ? '草稿' : '待确认'}
          </Tag>
          <small>{SOUND_LABELS[active.soundMode]} · 第 {active.scriptRevision + 1} 版</small>
        </div>
        <label className={styles.field}>
          <span>大纲</span>
          <textarea className="input-field" rows={3} value={draft.outline} onChange={(event) => setDraft((current) => ({ ...current, outline: event.target.value }))} />
        </label>
        <label className={styles.field}>
          <span>口播</span>
          <textarea className="input-field" rows={4} value={draft.narration} onChange={(event) => setDraft((current) => ({ ...current, narration: event.target.value }))} />
        </label>
        <div className={styles.field}>
          <div className={styles.fieldHead}>
            <span>分镜提示词全文</span>
            <button type="button" className="cap" onClick={() => setExpanded((value) => !value)}>
              {expanded ? '收起' : '查看与编辑'}
            </button>
          </div>
          {expanded ? <textarea className="input-field" rows={14} value={draft.promptText} onChange={(event) => setDraft((current) => ({ ...current, promptText: event.target.value }))} /> : (
            <pre className={styles.promptPreview}>{draft.promptText}</pre>
          )}
        </div>
        {error ? <p className={styles.hintFail} role="alert">{error}</p> : null}
        <div className={styles.editorActions}>
          <button type="button" className="cap" disabled={Boolean(working)} onClick={() => setDraft({ outline: active.outline, narration: active.narration, promptText: active.promptText })}>
            取消编辑
          </button>
          <button type="button" className="cap" disabled={Boolean(working)} onClick={() => void entryAction(active, 'save', draft)}>
            {working === `save:${active.code}` ? '保存中…' : '保存草稿'}
          </button>
          <button type="button" className="cap" disabled={Boolean(working)} onClick={() => void entryAction(active, 'redraft')}>
            {working === `redraft:${active.code}` ? '重写中…' : '重新生成本条'}
          </button>
          <button type="button" className="cap cap-primary" disabled={Boolean(working)} onClick={() => void entryAction(active, 'confirm', draft)}>
            {working === `confirm:${active.code}` ? '确认中…' : '确认本条'}
          </button>
        </div>
      </>}
    </div>
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
