'use client';

import { useCallback, useEffect, useState } from 'react';
import { EmptyState, GroupHeading, GroupList, GroupRow, Segmented, Tag } from '@/components/ui/Appearance';
import type { FilmState } from './types';
import {
  ONE_CLICK_FILM_TEMPLATE_IDS,
  ONE_CLICK_FILM_TEMPLATE_LABELS,
} from '@/lib/one-click-film/packaging-constants';
import styles from './one-click-film.module.css';

interface PackagingRecord {
  id: string;
  entryCode: string;
  status: 'pending' | 'ready' | 'failed';
  template: keyof typeof ONE_CLICK_FILM_TEMPLATE_LABELS;
  title: string;
  revision: number;
  ready: boolean;
  reason: string | null;
  errorMessage: string | null;
  subtitleCues: Array<{ id: string; text: string; startSec: number; endSec: number }>;
  pointCues: Array<{ id: string; text: string; startSec: number; endSec: number }>;
}

interface ExportRecord {
  id: string;
  entryCode: string;
  title: string;
  filename: string;
  url: string;
  checksum: string;
  createdAt: string;
}

interface Eligibility {
  entryCode: string;
  eligible: boolean;
  reason: string;
}

/**
 * 第五步 · 批量包装与导出：统一设置模板、标题规则、封面、字幕、花字与 BGM，
 * 一键处理合格条目；然后全选或逐条导出，在总览里预览、下载单条或 ZIP。
 */
export function PackagingStage({ state }: { state: FilmState }) {
  const [packaging, setPackaging] = useState<PackagingRecord[]>([]);
  const [exportsList, setExportsList] = useState<ExportRecord[]>([]);
  const [eligibility, setEligibility] = useState<Eligibility[]>([]);
  const [template, setTemplate] = useState<keyof typeof ONE_CLICK_FILM_TEMPLATE_LABELS>('overlay-minimal');
  const [titleMode, setTitleMode] = useState<'auto' | 'shared'>('auto');
  const [title, setTitle] = useState('');
  const [cover, setCover] = useState(true);
  const [subtitles, setSubtitles] = useState(true);
  const [decoration, setDecoration] = useState(true);
  const [bgm, setBgm] = useState(true);
  const [selected, setSelected] = useState<string[]>([]);
  const [selectedExports, setSelectedExports] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [working, setWorking] = useState('');
  const [editing, setEditing] = useState('');
  const [editTitle, setEditTitle] = useState('');
  const [editDecoStart, setEditDecoStart] = useState('0');

  const load = useCallback(async () => {
    try {
      const [packagingResponse, exportsResponse] = await Promise.all([
        fetch(`/api/one-click-film/${state.project.id}/packaging`, { cache: 'no-store' }),
        fetch(`/api/one-click-film/${state.project.id}/exports`, { cache: 'no-store' }),
      ]);
      const packagingBody = await packagingResponse.json() as { packaging?: PackagingRecord[] };
      const exportsBody = await exportsResponse.json() as { exports?: ExportRecord[]; eligibility?: Eligibility[] };
      setPackaging(packagingBody.packaging ?? []);
      setExportsList(exportsBody.exports ?? []);
      setEligibility(exportsBody.eligibility ?? []);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [state.project.id]);

  useEffect(() => {
    const timer = setTimeout(() => { void load(); }, 0);
    return () => clearTimeout(timer);
  }, [load]);

  const post = async (path: string, body: Record<string, unknown>) => {
    setError('');
    const response = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const payload = await response.json() as { message?: string; error?: string };
    if (!response.ok) throw new Error(payload.message || payload.error || '操作失败');
    await load();
    return payload;
  };

  const prepare = async () => {
    setWorking('prepare');
    try {
      await post(`/api/one-click-film/${state.project.id}/packaging`, {
        action: 'prepare',
        options: { template, cover, subtitles, decoration, bgm, titleMode, title },
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setWorking('');
    }
  };

  const exportNow = async () => {
    setWorking('export');
    try {
      await post(`/api/one-click-film/${state.project.id}/exports`, {
        all: selected.length === 0,
        codes: selected.length > 0 ? selected : undefined,
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setWorking('');
    }
  };

  const downloadZip = async () => {
    setError('');
    const response = await fetch(`/api/one-click-film/${state.project.id}/exports/zip`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: selectedExports }),
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({})) as { message?: string; error?: string };
      setError(payload.message || payload.error || '打包下载失败');
      return;
    }
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `one-click-film-${state.project.id.slice(0, 8)}.zip`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const openEditor = (record: PackagingRecord) => {
    setEditing(record.entryCode);
    setEditTitle(record.title);
    setEditDecoStart(String(record.pointCues[0]?.startSec ?? 0));
  };

  const saveEdit = async (record: PackagingRecord) => {
    setWorking(`edit:${record.entryCode}`);
    setError('');
    try {
      const startSec = Math.max(0, Number(editDecoStart) || 0);
      const current = record.pointCues[0];
      const pointCues = current
        ? [{ ...current, startSec, endSec: Math.max(startSec + 0.5, current.endSec) }]
        : [];
      await post(`/api/one-click-film/${state.project.id}/packaging`, {
        action: 'edit',
        entryCode: record.entryCode,
        title: editTitle,
        pointCues,
      });
      setEditing('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setWorking('');
    }
  };

  const eligibleCount = eligibility.filter((item) => item.eligible).length;

  return <div className={styles.packaging}>
    <div className={styles.packagingSide}>
      <GroupHeading>包装设置</GroupHeading>
      <GroupList>
        <GroupRow label="模板">
          <select aria-label="包装模板" className="input-field w-40" value={template} onChange={(event) => setTemplate(event.target.value as keyof typeof ONE_CLICK_FILM_TEMPLATE_LABELS)}>
            {ONE_CLICK_FILM_TEMPLATE_IDS.map((id) => <option key={id} value={id}>{ONE_CLICK_FILM_TEMPLATE_LABELS[id]}</option>)}
          </select>
        </GroupRow>
        <GroupRow label="标题" stacked>
          <Segmented<'auto' | 'shared'>
            value={titleMode}
            onChange={setTitleMode}
            label="标题规则"
            size="small"
            options={[{ value: 'auto', label: '逐条标题' }, { value: 'shared', label: '统一标题' }]}
          />
          {titleMode === 'shared' ? <input className="input-field mt-2" value={title} onChange={(event) => setTitle(event.target.value)} placeholder="统一标题" aria-label="统一标题" /> : null}
        </GroupRow>
        <GroupRow label="封面"><input type="checkbox" checked={cover} onChange={(event) => setCover(event.target.checked)} aria-label="启用封面" /></GroupRow>
        <GroupRow label="口播字幕"><input type="checkbox" checked={subtitles} onChange={(event) => setSubtitles(event.target.checked)} aria-label="启用口播字幕" /></GroupRow>
        <GroupRow label="花字"><input type="checkbox" checked={decoration} onChange={(event) => setDecoration(event.target.checked)} aria-label="启用花字" /></GroupRow>
        <GroupRow label="BGM"><input type="checkbox" checked={bgm} onChange={(event) => setBgm(event.target.checked)} aria-label="启用 BGM" /></GroupRow>
      </GroupList>
      <p className={styles.hint}>
        24 fps 下正文 360 帧；启用封面在片头加 20 帧，共 380 帧。字幕与花字随正文顺延一次。
      </p>
      <button type="button" className="cap cap-primary w-full" disabled={Boolean(working)} onClick={() => void prepare()} data-testid="one-click-film-package">
        {working === 'prepare' ? '包装中…' : '一键包装全部'}
      </button>
      {error ? <p className={styles.hintFail} role="alert">{error}</p> : null}
    </div>

    <div className={styles.packagingMain}>
      <GroupHeading action={<small className={styles.hint}>{eligibleCount}/{eligibility.length} 条合格</small>}>成片卡片</GroupHeading>
      {state.entries.length === 0 ? <EmptyState icon="film" title="还没有成片" description="先在前面几步完成脚本、生成与审片。" /> : <div className={styles.packagingList}>
        {state.entries.map((entry) => {
          const record = packaging.find((item) => item.entryCode === entry.code);
          const status = eligibility.find((item) => item.entryCode === entry.code);
          return <div key={entry.id} className={styles.packagingCard}>
            <div className={styles.packagingHead}>
              <b>{entry.code}</b>
              <Tag tone={record?.ready ? 'ok' : status?.eligible ? 'warn' : 'idle'}>
                {record?.ready ? '已包装' : status?.eligible ? '待包装' : status?.reason || '未就绪'}
              </Tag>
              {record ? <small>v{record.revision} · {ONE_CLICK_FILM_TEMPLATE_LABELS[record.template]}</small> : null}
              <label className={styles.packagingSelect}>
                <input
                  type="checkbox"
                  checked={selected.includes(entry.code)}
                  onChange={(event) => setSelected((current) => (
                    event.target.checked ? [...current, entry.code] : current.filter((code) => code !== entry.code)
                  ))}
                  aria-label={`选择 ${entry.code} 导出`}
                />
                选择导出
              </label>
            </div>
            {record?.title ? <p className={styles.packagingTitle}>{record.title}</p> : null}
            {record?.errorMessage ? <p className={styles.hintFail}>{record.errorMessage}</p> : null}
            {record && record.subtitleCues.length > 0 ? <p className={styles.hint}>
              字幕 {record.subtitleCues.length} 条 · 首条 {record.subtitleCues[0]!.startSec.toFixed(2)}s
              {cover ? `（成片 ${(record.subtitleCues[0]!.startSec + 20 / 24).toFixed(2)}s）` : ''}
            </p> : null}
            {record ? (editing === record.entryCode ? <div className={styles.editBox}>
              <input
                className="input-field"
                value={editTitle}
                onChange={(event) => setEditTitle(event.target.value)}
                placeholder="本条标题"
                aria-label={`${record.entryCode} 标题`}
              />
              <label className={styles.editRow}>
                <span>花字起点（正文秒）</span>
                <input
                  className="input-field"
                  value={editDecoStart}
                  onChange={(event) => setEditDecoStart(event.target.value)}
                  aria-label={`${record.entryCode} 花字起点`}
                />
              </label>
              {cover ? <p className={styles.hint}>
                加封面后对应成片第 {Math.round((Math.max(0, Number(editDecoStart) || 0) + 20 / 24) * 24)} 帧
              </p> : null}
              <div className={styles.editActions}>
                <button type="button" className="cap" onClick={() => setEditing('')}>取消</button>
                <button
                  type="button"
                  className="cap cap-primary"
                  disabled={Boolean(working)}
                  onClick={() => void saveEdit(record)}
                >
                  {working === `edit:${record.entryCode}` ? '保存中…' : '保存并返回'}
                </button>
              </div>
            </div> : <button type="button" className="cap" onClick={() => openEditor(record)}>
              继续编辑
            </button>) : null}
          </div>;
        })}
      </div>}

      <GroupHeading action={<button type="button" className="cap" disabled={Boolean(working) || eligibleCount === 0} onClick={() => void exportNow()} data-testid="one-click-film-export">
        {working === 'export' ? '导出中…' : selected.length > 0 ? `导出所选 ${selected.length} 条` : '全选并导出'}
      </button>}>已导出成片</GroupHeading>
      {exportsList.length === 0 ? <EmptyState icon="download" title="还没有导出记录" description="包装完成后导出，记录会出现在这里。" /> : <div className={styles.exportList}>
        {exportsList.map((record) => <div key={record.id} className={styles.exportCard}>
          <div className={styles.exportHead}>
            <b>{record.entryCode}</b>
            <small>{record.title}</small>
            <label className={styles.packagingSelect}>
              <input
                type="checkbox"
                checked={selectedExports.includes(record.id)}
                onChange={(event) => setSelectedExports((current) => (
                  event.target.checked ? [...current, record.id] : current.filter((id) => id !== record.id)
                ))}
                aria-label={`选择 ${record.filename}`}
              />
              选入 ZIP
            </label>
          </div>
          <video className={styles.exportVideo} src={record.url} controls preload="metadata" />
          <div className={styles.exportActions}>
            <a className="cap" href={record.url} download={record.filename}>下载 MP4</a>
            <small title={record.checksum}>{record.filename}</small>
          </div>
        </div>)}
      </div>}
      <button type="button" className="cap" disabled={selectedExports.length === 0} onClick={() => void downloadZip()}>
        下载所选 {selectedExports.length} 条为 ZIP
      </button>
    </div>
  </div>;
}
