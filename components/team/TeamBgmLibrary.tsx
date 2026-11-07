'use client';
import { useState, type FormEvent, type InputHTMLAttributes } from 'react';
import { teamWrite } from './client';
import { StatusDot, ToolbarButton } from '@/components/ui/Appearance';

const directoryAttributes = { webkitdirectory: '', directory: '' } as InputHTMLAttributes<HTMLInputElement>;
const audioFilename = /\.(mp3|wav|m4a|aac|flac|ogg)$/i;
export default function TeamBgmLibrary({ onUploaded }: { onUploaded: () => void }) {
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
        const body = await response.json() as { imported?: unknown[]; reused?: unknown[]; errors?: Array<{ message: string }>; message?: string };
        if (!response.ok) throw new Error(body.errors?.map(item => item.message).join('；') || body.message || '上传失败');
        successful += (body.imported?.length ?? 0) + (body.reused?.length ?? 0);
        errors.push(...(body.errors ?? []).map(item => item.message));
      } catch (e) { errors.push(`${name}：${e instanceof Error ? e.message : '上传失败'}`); }
    }
    setNotice(successful ? `${successful} 首音乐已加入公共 BGM 库，成员现在可以选用。` : '没有上传成功的音乐。');
    setError(errors.slice(0, 20).join('；') + (errors.length > 20 ? `；共 ${errors.length} 项失败，请分批重试。` : '')); setProgress(''); setBusy(false); setFiles([]); form.reset();
    onUploaded();
  }
  return <div>
    <p className="mt-2 text-[13px] leading-6 text-ink-secondary">从电脑选择音乐，上传后自动发布给团队。支持 MP3、WAV、M4A、AAC、FLAC、OGG。</p>
    <form onSubmit={event => void upload(event)} className="mt-4 flex flex-wrap items-end gap-4">
      <label className="min-w-0 flex-1"><span className="label">选择音乐文件（可多选）</span>
        <input aria-label="选择 BGM 音乐" className="input-field" type="file" accept=".mp3,.wav,.m4a,.aac,.flac,.ogg" multiple disabled={busy} onChange={event => selectFiles(event.target.files)} />
      </label>
      <label className="min-w-0 flex-1"><span className="label">选择音乐文件夹（含子文件夹）</span>
        <input aria-label="选择 BGM 文件夹" className="input-field" type="file" {...directoryAttributes} multiple disabled={busy} onChange={event => selectFiles(event.target.files)} />
      </label>
      <ToolbarButton type="submit" variant="primary" disabled={busy || !files.length}>{busy ? '正在处理…' : '上传并发布 BGM'}</ToolbarButton>
    </form>
    <p className="mt-2 text-[12px] text-ink-tertiary">可直接选择共享盘音乐库文件夹，自动包含子文件夹中的音频。逐首上传，每首不超过 60 MB；非音频自动跳过，相同文件自动复用。上传期间请保持页面打开。</p>
    {progress && <p role="status" className="mt-3 flex items-center gap-2 text-[13px] text-ink-secondary"><StatusDot tone="run" />{progress}</p>}
    {notice && <p role="status" className="mt-3 flex items-center gap-2 text-[13px] text-ok"><StatusDot tone="ok" />{notice}</p>}
    {error && <p role="alert" className="mt-3 text-[13px] text-fail">{error}</p>}
  </div>;
}
