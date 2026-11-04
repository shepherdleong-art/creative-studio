'use client';
import { useCallback, useEffect, useState, type FormEvent, type InputHTMLAttributes } from 'react';
import { teamError, teamWrite } from './client';

type Track = { id: string; filename: string; durationUs: number; published: boolean };
const directoryAttributes = { webkitdirectory: '', directory: '' } as InputHTMLAttributes<HTMLInputElement>;
const audioFilename = /\.(mp3|wav|m4a|aac|flac|ogg)$/i;
export default function TeamBgmLibrary() {
  const [tracks, setTracks] = useState<Track[]>([]);
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  function selectFiles(selected: FileList | null) {
    const all = Array.from(selected ?? []);
    const audio = all.filter(file => audioFilename.test(file.name));
    setFiles(audio); setError('');
    setNotice(`已选择 ${audio.length} 首音乐${all.length > audio.length ? `，已跳过 ${all.length - audio.length} 个非音频文件` : ''}。`);
  }
  const refresh = useCallback(async () => {
    const response = await fetch('/api/team/public-resources/bgm', { cache: 'no-store' });
    if (!response.ok) throw new Error(await teamError(response, 'BGM 库读取失败'));
    const body = await response.json() as { tracks: Track[] }; setTracks(body.tracks);
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    void fetch('/api/team/public-resources/bgm', { cache: 'no-store', signal: controller.signal })
      .then(async response => {
        if (!response.ok) throw new Error(await teamError(response, 'BGM 库读取失败'));
        return response.json() as Promise<{ tracks: Track[] }>;
      })
      .then(body => { if (!controller.signal.aborted) setTracks(body.tracks); })
      .catch(e => { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : 'BGM 库读取失败'); });
    return () => controller.abort();
  }, []);
  async function upload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    if (!files.length) return;
    setBusy(true); setError(''); setNotice('');
    const errors: string[] = []; let successful = 0;
    for (let index = 0; index < files.length; index++) {
      const file = files[index];
      const name = file.webkitRelativePath || file.name;
      setProgress(`正在上传 ${index + 1}/${files.length}（已成功 ${successful} 首）：${name}`);
      try {
        if (file.size > 60 * 1024 * 1024) throw new Error('超过每首 60 MB 上限，已跳过');
        const data = new FormData(); data.append('files', file);
        const response = await teamWrite('/api/team/public-resources/bgm', { method: 'POST', body: data });
        const body = await response.json() as { tracks?: Track[]; imported?: unknown[]; reused?: unknown[]; errors?: Array<{ message: string }>; message?: string };
        if (!response.ok) throw new Error(body.errors?.map(item => item.message).join('；') || body.message || '上传失败');
        successful += (body.imported?.length ?? 0) + (body.reused?.length ?? 0);
        if (body.tracks) setTracks(body.tracks);
        errors.push(...(body.errors ?? []).map(item => item.message));
      } catch (e) { errors.push(`${name}：${e instanceof Error ? e.message : '上传失败'}`); }
    }
    setNotice(successful ? `${successful} 首音乐已加入公共 BGM 库，成员现在可以选用。` : '没有上传成功的音乐。');
    setError(errors.slice(0, 20).join('；') + (errors.length > 20 ? `；共 ${errors.length} 项失败，请分批重试。` : '')); setProgress(''); setBusy(false); setFiles([]); form.reset();
    await refresh().catch(() => undefined);
  }
  async function publish(track: Track) {
    setBusy(true); setError('');
    try {
      const response = await teamWrite('/api/team/public-resources', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ resourceType: 'bgm', resourceId: track.id }) });
      if (!response.ok) throw new Error(await teamError(response, '发布失败'));
      await refresh(); setNotice(`${track.filename} 已发布到公共 BGM 库。`);
    } catch (e) { setError(e instanceof Error ? e.message : '发布失败'); }
    finally { setBusy(false); }
  }
  return <section className="card p-6" aria-labelledby="public-bgm-heading">
    <h2 id="public-bgm-heading" className="text-lg font-semibold text-ink">公共 BGM 音乐库</h2>
    <p className="mt-2 text-sm leading-6 text-ink-secondary">从电脑选择音乐，上传后自动发布给团队。支持 MP3、WAV、M4A、AAC、FLAC、OGG。</p>
    <form onSubmit={event => void upload(event)} className="mt-5 flex flex-wrap items-end gap-4">
      <label className="min-w-0 flex-1"><span className="label">选择音乐文件（可多选）</span>
        <input aria-label="选择 BGM 音乐" className="input-field" type="file" accept=".mp3,.wav,.m4a,.aac,.flac,.ogg" multiple disabled={busy} onChange={event => selectFiles(event.target.files)} />
      </label>
      <label className="min-w-0 flex-1"><span className="label">选择音乐文件夹（含子文件夹）</span>
        <input aria-label="选择 BGM 文件夹" className="input-field" type="file" {...directoryAttributes} multiple disabled={busy} onChange={event => selectFiles(event.target.files)} />
      </label>
      <button className="btn-primary" type="submit" disabled={busy || !files.length}>{busy ? '正在处理…' : '上传并发布 BGM'}</button>
    </form>
    <p className="mt-2 text-xs text-ink-tertiary">可直接选择共享盘音乐库文件夹，自动包含子文件夹中的音频。逐首上传，每首不超过 60 MB；非音频自动跳过，相同文件自动复用。上传期间请保持页面打开。</p>
    {progress && <p role="status" className="mt-4 text-sm text-ink-secondary">{progress}</p>}
    {notice && <p role="status" className="mt-4 text-sm text-ok">{notice}</p>}
    {error && <p role="alert" className="mt-4 text-sm text-fail">{error}</p>}
    <p className="mt-6 text-xs text-ink-tertiary">共 {tracks.length} 首音乐 · 在列表内上下滚动浏览</p>
    <div className="mt-2 max-h-[480px] overflow-y-auto overscroll-contain divide-y divide-hairline pr-2 [scrollbar-gutter:stable]" role="region" aria-label="公共 BGM 音乐列表" tabIndex={0}>
      {tracks.map(track => <div key={track.id} className="flex flex-wrap items-center justify-between gap-4 py-4">
        <div className="min-w-0 flex-1"><p className="break-all font-medium text-ink">{track.filename}</p>
          <p className="mt-1 text-xs text-ink-tertiary">{Math.floor(track.durationUs / 60_000_000)}:{String(Math.floor(track.durationUs / 1_000_000) % 60).padStart(2, '0')} · {track.published ? '团队公共' : '尚未发布'}</p>
        </div>
        <audio controls preload="none" aria-label={`试听 ${track.filename}`} src={`/api/final-edit-bgm/${encodeURIComponent(track.id)}/file`} className="h-9 max-w-full" />
        {!track.published && <button className="btn-secondary btn-sm" disabled={busy} onClick={() => void publish(track)}>发布给团队</button>}
      </div>)}
      {!tracks.length && <p className="py-6 text-sm text-ink-tertiary">还没有音乐，从上方选择文件即可上传。</p>}
    </div>
  </section>;
}
