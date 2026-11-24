'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { EmptyState, GroupHeading, GroupList, GroupRow, Segmented, Tag, ToolbarButton } from '@/components/ui/Appearance';
import { Dialog } from '@/components/ui/Dialog';
import { Icon } from '@/components/ui/Icon';
import type { PackagingRecord } from '@/lib/one-click-film/packaging';
import { ONE_CLICK_FILM_TEMPLATE_IDS, ONE_CLICK_FILM_TEMPLATE_LABELS } from '@/lib/one-click-film/packaging-constants';
import type { FilmState } from './types';
import { PackagingDraftEditor, type PackagingMedia } from './PackagingDraftEditor';
import { useShotThumbnails } from './useShotThumbnails';
import styles from './one-click-film.module.css';

interface ExportRecord {
  id: string;
  entryCode: string;
  title: string;
  filename: string;
  url: string;
  checksum: string;
}

type PreviewSource = { entryCode: string; url: string; startSec: number };
type ResponseBody = {
  packaging?: PackagingRecord[];
  subtitleWarning?: string;
  subtitleWaiting?: boolean;
  record?: PackagingRecord;
  media?: PackagingMedia;
  previews?: PreviewSource[];
  bgm?: Array<{ id: string; name: string }>;
  exports?: ExportRecord[];
  failed?: Array<{ entryCode: string; reason: string }>;
  message?: string;
  error?: string;
};

function errorSummary(message: string) {
  if (/video-only\.webm/.test(message) && /permission denied/i.test(message)) return '包装临时视频写入失败，请重新确认导出。';
  if (message.startsWith('包装管线执行失败')) return '包装渲染失败，请查看错误详情。';
  return message;
}

function FilmCover({ url, startSec, label, disabled, onOpen }: {
  url?: string;
  startSec: number;
  label: string;
  disabled: boolean;
  onOpen: () => void;
}) {
  const at = Math.round((startSec + 1 / 12) * 1e6);
  const cover = useShotThumbnails(url, String(at))(at);
  return <button type="button" className={`${styles.packagingMedia} ${styles.staticFilmCover}`} aria-label={label}
    disabled={disabled} onClick={onOpen}>
    {cover ? (
      // eslint-disable-next-line @next/next/no-img-element -- 从实际成片提取的本地封面
      <img src={cover} alt="" />
    ) : <span><Icon name="image" size={24} />{url ? '封面加载中' : '暂无视频'}</span>}
  </button>;
}

const message = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);
const draftValues = (record: PackagingRecord) => JSON.stringify([record.title, record.template, record.options, record.subtitleCues, record.pointCues]);

async function readResponse(response: Response): Promise<ResponseBody> {
  const body = await response.json() as ResponseBody;
  if (!response.ok) throw new Error(body.message || body.error || '操作失败');
  return body;
}

export function PackagingStage({ state, focus, onAdjustSound }: { state: FilmState; focus?: { code: string; shotId?: string }; onAdjustSound: (code: string) => void }) {
  const base = `/api/one-click-film/${state.project.id}`;
  const [records, setRecords] = useState<PackagingRecord[]>([]);
  const [exportsList, setExportsList] = useState<ExportRecord[]>([]);
  const [previews, setPreviews] = useState<PreviewSource[]>([]);
  const [template, setTemplate] = useState<PackagingRecord['template']>('overlay-minimal');
  const [titleMode, setTitleMode] = useState<'auto' | 'shared'>('auto');
  const [title, setTitle] = useState('');
  const [cover, setCover] = useState(true);
  const [subtitles, setSubtitles] = useState(true);
  const [decoration, setDecoration] = useState(true);
  const [bgm, setBgm] = useState(true);
  const [bgmTracks, setBgmTracks] = useState<NonNullable<ResponseBody['bgm']>>([]);
  const [bgmId, setBgmId] = useState('');
  const [selected, setSelected] = useState<Record<string, number>>({});
  const [selectedExports, setSelectedExports] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [working, setWorking] = useState('');
  const [draft, setDraft] = useState<PackagingRecord | null>(null);
  const [baseline, setBaseline] = useState<PackagingRecord | null>(null);
  const [subtitleWaiting, setSubtitleWaiting] = useState('');
  const [media, setMedia] = useState<PackagingMedia | null>(null);
  const [initialShot, setInitialShot] = useState<string>();
  const [confirm, setConfirm] = useState(false);
  const closeConfirm = useCallback(() => setConfirm(false), []);
  const exportList = useRef<HTMLDivElement>(null);
  const defaults = { template, cover, subtitles, decoration, bgm, titleMode, title, bgmId };

  const load = useCallback(async () => {
    try {
      const [pack, delivery] = await Promise.all([
        fetch(`${base}/packaging`, { cache: 'no-store' }).then(readResponse),
        fetch(`${base}/exports`, { cache: 'no-store' }).then(readResponse),
      ]);
      setRecords(pack.packaging ?? []);
      setPreviews(pack.previews ?? []);
      setBgmTracks(pack.bgm ?? []);
      setExportsList(delivery.exports ?? []);
    } catch (cause) { setError(message(cause)); }
  }, [base]);
  useEffect(() => { const timer = setTimeout(() => void load(), 0); return () => clearTimeout(timer); }, [load]);

  const post = async (route: 'packaging' | 'exports', body: object) => readResponse(await fetch(`${base}/${route}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }));

  const prepare = async () => {
    setWorking('prepare');
    setError('');
    setNotice('');
    try {
      await post('packaging', { action: 'prepare', options: defaults });
      setSelected({});
      await load();
      setNotice('包装设置已应用到草稿。');
    } catch (cause) { setError(message(cause)); }
    finally { setWorking(''); }
  };

  const openEditor = useCallback(async (entryCode: string, shotId?: string, signal?: AbortSignal) => {
    setWorking(`open:${entryCode}`);
    setError('');
    setNotice('');
    try {
      const result = await fetch(`${base}/packaging`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'open', entryCode, prepareSubtitles: true }), signal }).then(readResponse);
      if (!result.record || !result.media) throw new Error('这条成片的包装草稿不可用');
      if (signal?.aborted) return;
      setBaseline(result.record);
      setDraft(result.record);
      setMedia(result.media);
      setNotice(result.subtitleWarning || '');
      setSubtitleWaiting(result.subtitleWaiting ? entryCode : '');
      setInitialShot(shotId);
    } catch (cause) { if (!signal?.aborted) setError(message(cause)); }
    finally { if (!signal?.aborted) setWorking(''); }
  }, [base]);

  useEffect(() => {
    if (!focus) return;
    const abort = new AbortController();
    const timer = setTimeout(() => void openEditor(focus.code, focus.shotId, abort.signal), 0);
    return () => { clearTimeout(timer); abort.abort(); };
  }, [openEditor, focus]);

  const canPrepareSubtitles = Boolean(draft && baseline && draft.entryCode === subtitleWaiting && draft.options.subtitles
    && draftValues(draft) === draftValues(baseline));
  const subtitleRevision = draft?.revision;
  useEffect(() => {
    if (!canPrepareSubtitles || working) return;
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const check = async () => {
      try {
        const result = await fetch(`${base}/packaging`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: abort.signal,
          body: JSON.stringify({ action: 'recognize-subtitles', entryCode: subtitleWaiting, revision: subtitleRevision }) }).then(readResponse);
        if (abort.signal.aborted) return;
        if (result.subtitleWaiting) { timer = setTimeout(() => void check(), 5000); return; }
        const updated = result.packaging?.find(item => item.entryCode === subtitleWaiting);
        if (!updated) throw new Error('未能读取字幕识别结果');
        setRecords(result.packaging!);
        setBaseline(updated);
        setDraft(updated);
        setSelected(current => Object.hasOwn(current, updated.entryCode) ? { ...current, [updated.entryCode]: updated.revision } : current);
        setSubtitleWaiting('');
        setNotice(updated.subtitleCues.length ? '口播字幕已对时。' : '未识别到口播。');
      } catch (cause) {
        if (abort.signal.aborted) return;
        setSubtitleWaiting('');
        setNotice('');
        setError(message(cause));
      }
    };
    timer = setTimeout(() => void check(), 4000);
    return () => { clearTimeout(timer); abort.abort(); };
  }, [base, canPrepareSubtitles, subtitleRevision, subtitleWaiting, working]);

  const refreshSequence = useRef(0);
  const activeCode = draft?.entryCode;
  const refreshReview = useCallback(async () => {
    if (!activeCode) return;
    const sequence = ++refreshSequence.current;
    const result = await fetch(`${base}/packaging`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'open', entryCode: activeCode }) }).then(readResponse);
    if (sequence !== refreshSequence.current) return;
    if (!result.media || !result.record) throw new Error('无法刷新审片预览');
    const refreshedMedia = result.media;
    setMedia(current => current?.review.entryCode === activeCode ? refreshedMedia : current);
    const { canExport, reason, subtitlesPrepared } = result.record;
    setDraft(current => current?.entryCode === activeCode ? { ...current, canExport, reason, subtitlesPrepared } : current);
  }, [activeCode, base]);

  const save = async (record: PackagingRecord) => {
    if (baseline && draftValues(baseline) === draftValues(record)) return record;
    const changedSubtitles = JSON.stringify(record.subtitleCues) !== JSON.stringify(baseline?.subtitleCues);
    const result = await post('packaging', {
      action: 'edit', entryCode: record.entryCode, revision: record.revision, title: record.title,
      template: record.template, options: { ...record.options, titleFont: record.options.titleFont ?? null,
        subtitleFont: record.options.subtitleFont ?? null, pointFont: record.options.pointFont ?? null, bgmId: record.options.bgmId ?? null }, pointCues: record.pointCues,
      subtitleCues: changedSubtitles ? record.subtitleCues : undefined,
    });
    const updated = result.packaging?.find((item) => item.entryCode === record.entryCode);
    if (!updated) throw new Error('未能读取已保存的包装草稿');
    setRecords(result.packaging!);
    setBaseline(updated);
    setDraft(updated);
    setSelected((current) => Object.hasOwn(current, updated.entryCode)
      ? { ...current, [updated.entryCode]: updated.revision } : current);
    return updated;
  };

  const finishEditing = async (action: 'back' | 'save' | 'select' | 'approve' | 'sound') => {
    if (!draft || working) return;
    setError('');
    setNotice('');
    setWorking('save');
    try {
      const record = await save(draft);
      if (action === 'sound') { onAdjustSound(record.entryCode); return; }
      if (action === 'approve' && media) {
        await fetch(`${base}/review`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'approve', jobId: media.review.jobId, sourceSignature: media.signature, packagingRevision: record.revision }) }).then(readResponse);
        await refreshReview();
        setNotice('已通过审片。');
        return;
      }
      if (action === 'select') {
        if (!record.canExport) throw new Error(record.reason || '请先完成审片与复核');
        setSelected((current) => ({ ...current, [record.entryCode]: record.revision }));
      }
      if (action !== 'save') {
        setDraft(null);
        setMedia(null);
        setBaseline(null);
        await load();
      } else setNotice('已保存草稿。');
    } catch (cause) { setError(message(cause)); }
    finally { setWorking(''); }
  };

  const recognize = async () => {
    if (!draft || working) return;
    setWorking('subtitles');
    setError('');
    setNotice('');
    try {
      const record = await save(draft);
      const result = await post('packaging', { action: 'recognize-subtitles', entryCode: record.entryCode, revision: record.revision });
      if (result.subtitleWaiting) {
        setSubtitleWaiting(record.entryCode);
        setNotice('口播识别正在等待名额，空出后自动对时。');
        return;
      }
      const updated = result.packaging?.find((item) => item.entryCode === record.entryCode);
      if (!updated) throw new Error('未能读取字幕识别结果');
      setDraft(updated);
      setBaseline(updated);
      setSubtitleWaiting('');
      setRecords(result.packaging!);
      setSelected((current) => Object.hasOwn(current, updated.entryCode)
        ? { ...current, [updated.entryCode]: updated.revision } : current);
      setNotice(updated.subtitleCues.length ? '口播字幕已识别。' : '未识别到口播。');
    } catch (cause) { setError(message(cause)); }
    finally { setWorking(''); }
  };

  const exportNow = async () => {
    closeConfirm();
    setWorking('export');
    setError('');
    setNotice('');
    const codes = Object.keys(selected);
    try {
      const result = await post('exports', { codes, revisions: selected });
      if (result.failed?.length) setError(result.failed.map((item) => `${item.entryCode} ${errorSummary(item.reason)}`).join('。'));
      const failed = new Set(result.failed?.map((item) => item.entryCode));
      setSelected(Object.fromEntries(codes.filter((code) => failed.has(code)).map((code) => [code, selected[code]])));
      await load();
      if (codes.some((code) => !failed.has(code))) exportList.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (cause) { setError(message(cause)); }
    finally { setWorking(''); }
  };

  const downloadZip = async () => {
    try {
      const response = await fetch(`${base}/exports/zip`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: selectedExports }),
      });
      if (!response.ok) await readResponse(response);
      const url = URL.createObjectURL(await response.blob());
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `one-click-film-${state.project.id.slice(0, 8)}.zip`;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (cause) { setError(message(cause)); }
  };

  const busy = Boolean(working);
  if (draft && media) return <div className={styles.draftWorkspace}>
    <div className={styles.draftToolbar}>
      <ToolbarButton icon="chevron-left" disabled={busy} onClick={() => void finishEditing('back')}>返回成片卡片</ToolbarButton>
      <b>{draft.entryCode} · {draft.title}</b>
      <ToolbarButton disabled={busy} onClick={() => void finishEditing('save')}>{working === 'save' ? '保存中…' : '保存草稿'}</ToolbarButton>
      <ToolbarButton variant="primary" disabled={busy || media.review.approved} onClick={() => void finishEditing('approve')}
        data-testid="one-click-film-approve">{media.review.approved ? '已通过审片' : '标记审片通过'}</ToolbarButton>
      {Object.hasOwn(selected, draft.entryCode)
        ? <ToolbarButton disabled={busy} onClick={() => setSelected((current) => Object.fromEntries(Object.entries(current)
          .filter(([code]) => code !== draft.entryCode)))}>移出导出选择</ToolbarButton>
        : <ToolbarButton variant="primary" disabled={busy || !draft.canExport}
          onClick={() => void finishEditing('select')}>选入导出</ToolbarButton>}
    </div>
    {!draft.canExport ? <p className={styles.hintWarn}>{draft.reason || '待审片复核'}</p> : null}
    {notice ? <p className={styles.hint} role="status">{notice}</p> : null}
    {error ? <p className={styles.hintFail} role="alert">{error}</p> : null}
    <PackagingDraftEditor key={media.review.jobId} projectId={state.project.id} images={state.images}
      entry={state.entries.find(entry => entry.code === draft.entryCode)!} initialShot={initialShot}
      onRefresh={refreshReview} onAdjustSound={() => void finishEditing('sound')}
      draft={draft} media={media} tracks={bgmTracks} busy={busy} onChange={setDraft} onRecognize={() => void recognize()} />
  </div>;

  const exportCount = Object.keys(selected).length;
  return <div className={styles.packaging}>
    <div className={styles.packagingSide}>
      <GroupHeading>包装设置</GroupHeading>
      <GroupList>
        <GroupRow label="模板"><select aria-label="包装模板" className="input-field" value={template}
          onChange={(event) => setTemplate(event.target.value as PackagingRecord['template'])}>
          {ONE_CLICK_FILM_TEMPLATE_IDS.map((id) => <option key={id} value={id}>{ONE_CLICK_FILM_TEMPLATE_LABELS[id]}</option>)}
        </select></GroupRow>
        <GroupRow label="标题" stacked>
          <Segmented value={titleMode} label="标题规则" size="small" onChange={setTitleMode}
            options={[{ value: 'auto', label: '逐条标题' }, { value: 'shared', label: '统一标题' }]} />
          {titleMode === 'shared' ? <input className="input-field mt-2" value={title} onChange={(event) => setTitle(event.target.value)} aria-label="统一标题" /> : null}
        </GroupRow>
        <GroupRow label="封面"><input type="checkbox" checked={cover} onChange={(event) => setCover(event.target.checked)} aria-label="启用封面" /></GroupRow>
        <GroupRow label="口播字幕"><input type="checkbox" checked={subtitles} onChange={(event) => setSubtitles(event.target.checked)} aria-label="启用口播字幕" /></GroupRow>
        <GroupRow label="花字"><input type="checkbox" checked={decoration} onChange={(event) => setDecoration(event.target.checked)} aria-label="启用花字" /></GroupRow>
        <GroupRow label="BGM"><input type="checkbox" checked={bgm} onChange={(event) => setBgm(event.target.checked)} aria-label="启用 BGM" /></GroupRow>
        {bgm ? <GroupRow label="配乐"><select aria-label="批量配乐" className="input-field" value={bgmId} onChange={(event) => setBgmId(event.target.value)}>
          <option value="">曲库默认</option>{bgmTracks.map((track) => <option key={track.id} value={track.id}>{track.name}</option>)}
        </select></GroupRow> : null}
      </GroupList>
      <button type="button" className="cap cap-primary" disabled={busy || !previews.length} onClick={() => void prepare()}
        data-testid="one-click-film-package">{working === 'prepare' ? '应用中…' : '应用设置到全部草稿'}</button>
      {notice ? <p className={styles.hint} role="status">{notice}</p> : null}
      {error ? <p className={styles.hintFail} role="alert">{error}</p> : null}
    </div>
    <div className={styles.packagingMain}>
      <GroupHeading action={<div className={styles.footActions}>
        <ToolbarButton disabled={busy || !records.some((record) => record.canExport)} onClick={() =>
          setSelected(Object.fromEntries(records.filter((record) => record.canExport).map((record) => [record.entryCode, record.revision])))}>
          全选可导出成片
        </ToolbarButton>
        <button type="button" className="cap cap-primary" disabled={busy || exportCount === 0}
        data-testid="one-click-film-export" onClick={() => setConfirm(true)}>
        {working === 'export' ? '渲染导出中…' : `渲染并导出所选 ${exportCount} 条`}
      </button></div>}>成片卡片</GroupHeading>
      {state.entries.length === 0 ? <EmptyState icon="film" title="还没有成片" /> : <div className={styles.packagingList}>
        {state.entries.map((entry) => {
          const record = records.find((item) => item.entryCode === entry.code);
          const preview = previews.find((item) => item.entryCode === entry.code);
          const failed = record?.status === 'failed';
          return <article key={entry.id} className={styles.packagingCard}>
            <FilmCover url={record?.videoUrl || preview?.url} startSec={record?.videoUrl ? 0 : preview?.startSec ?? 0}
              label={`打开 ${entry.code} 预览与编辑`} disabled={busy || !preview} onOpen={() => void openEditor(entry.code)} />
            <div className={styles.packagingHead}>
              <b>{entry.code}</b>
              <Tag tone={record?.ready ? 'ok' : failed && record?.canExport ? 'fail' : 'idle'}>
                {Object.hasOwn(selected, entry.code) ? '已选导出' : record?.ready ? '已渲染' :
                  record && !record.canExport ? '待复核' : failed ? '渲染失败' : '草稿'}
              </Tag>
            </div>
            <p className={styles.packagingTitle} title={record?.title || entry.title}>{record?.title || entry.title || entry.code}</p>
            {record && !record.canExport ? <p className={styles.hintWarn}>{record.reason}</p> : null}
            {record?.errorMessage && record.canExport ? <details className={styles.packagingErrorDetail}>
              <summary>{errorSummary(record.errorMessage)}</summary><p>{record.errorMessage}</p>
            </details> : null}
            <div className={styles.packagingCardActions}>
              <button type="button" className="cap" disabled={busy || !preview} onClick={() => void openEditor(entry.code)}>
                {working === `open:${entry.code}` ? '打开中…' : '预览与编辑'}
              </button>
            </div>
          </article>;
        })}
      </div>}
      <div ref={exportList}><GroupHeading>已导出成片</GroupHeading></div>
      {exportsList.length === 0 ? <EmptyState icon="download" title="还没有导出记录" /> : <>
        <div className={styles.exportList}>
          {exportsList.map((record) => <div key={record.id} className={styles.exportCard}>
            <div className={styles.packagingMedia}><video className={styles.cardVideo} src={record.url}
              aria-label={`${record.entryCode} 导出预览`} controls playsInline preload="metadata" /></div>
            <div className={styles.exportHead}><b>{record.entryCode}</b><small>{record.title}</small></div>
            <label className={styles.packagingSelect}>
              <input type="checkbox" checked={selectedExports.includes(record.id)} aria-label={`选择 ${record.filename}`}
                onChange={(event) => setSelectedExports((current) => event.target.checked ? [...current, record.id] : current.filter((id) => id !== record.id))} />
              选入 ZIP
            </label>
            <div className={styles.exportActions}><a className="cap" href={record.url} download={record.filename}>下载 MP4</a></div>
          </div>)}
        </div>
        <button type="button" className="cap" disabled={selectedExports.length === 0} onClick={() => void downloadZip()}>
          下载所选 {selectedExports.length} 条为 ZIP
        </button>
      </>}
    </div>
    <Dialog open={confirm} title={`确认渲染并导出 ${exportCount} 条成片`} onClose={closeConfirm}
      footer={<div className={styles.inlineActions}>
        <ToolbarButton onClick={closeConfirm}>取消</ToolbarButton>
        <ToolbarButton variant="primary" onClick={() => void exportNow()}>确认渲染并导出</ToolbarButton>
      </div>} />
  </div>;
}
