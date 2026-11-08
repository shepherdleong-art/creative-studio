'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { teamError } from './client';
import { StatusDot, Tag, ToolbarButton } from '@/components/ui/Appearance';

type Candidate = {
  candidateId: string;
  status: 'ready' | 'rejected';
  release: { releaseId: string; packageSha256: string };
  target: { appVersion: string; dataSchemaVersion: number };
  originalName: string;
  compatibility: { compatible: boolean; message: string };
  checks: Record<string, boolean>;
  failure?: { message: string };
};
type Failure = { uploadId: string; message: string; createdAt: string };
type Preview = {
  current: { appVersion: string; dataSchemaVersion: number; releaseId?: string };
  candidates: Candidate[];
  failures: Failure[];
};

export default function TeamReleaseUpload() {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [phase, setPhase] = useState<'idle' | 'uploading' | 'validating' | 'done'>('idle');
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const refresh = useCallback(async () => {
    const response = await fetch('/api/team/release-candidates', { cache: 'no-store' });
    if (!response.ok) throw new Error(await teamError(response, '无法读取版本预览'));
    return await response.json() as Preview;
  }, []);
  useEffect(() => {
    void refresh().then(setPreview).catch((reason) => setError(reason instanceof Error ? reason.message : '版本预览读取失败'));
  }, [refresh]);

  async function upload() {
    if (!file || phase === 'uploading' || phase === 'validating') return;
    setError(''); setPhase('uploading'); setProgress(0);
    try {
      const csrf = await fetch('/api/team/auth/csrf', { cache: 'no-store', credentials: 'same-origin' });
      if (!csrf.ok) throw new Error('无法建立安全上传会话');
      const { csrfToken } = await csrf.json();
      const candidate = await new Promise<Candidate>((resolve, reject) => {
        const request = new XMLHttpRequest();
        request.open('POST', '/api/team/release-candidates');
        request.setRequestHeader('Content-Type', 'application/zip');
        request.setRequestHeader('x-csrf-token', csrfToken);
        request.upload.onprogress = (event) => {
          if (!event.lengthComputable) return;
          setProgress(Math.round(event.loaded / event.total * 100));
          if (event.loaded === event.total) setPhase('validating');
        };
        request.onerror = () => reject(new Error('上传中断，请重试；未完成上传不会成为候选版本。'));
        request.onload = async () => {
          try {
            const body = JSON.parse(request.responseText) as { candidate?: Candidate; message?: string };
            if (request.status !== 201 || !body.candidate || body.candidate.status !== 'ready') {
              reject(new Error(body.message ?? '发布包未通过完整性或兼容性校验'));
              return;
            }
            resolve(body.candidate);
          } catch { reject(new Error('服务器没有返回可验证的候选结果')); }
        };
        request.send(file);
      });
      setPhase('done');
      setFile(null);
      if (inputRef.current) inputRef.current.value = '';
      setPreview(await refresh());
      if (!candidate.compatibility.compatible) throw new Error('候选版本不兼容');
    } catch (reason) {
      setPhase('idle');
      setError(reason instanceof Error ? reason.message : '发布包准备失败');
      await refresh().then(setPreview).catch(() => undefined);
    }
  }

  return <section className="card p-5" aria-label="服务器升级包准备">
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div>
        <h2 className="text-[15px] font-semibold text-ink">上传服务器升级包</h2>
        <p className="mt-1.5 max-w-2xl text-[13px] leading-6 text-ink-secondary">选择受控 Windows 服务器发布 ZIP。完整清单、逐文件内容哈希、发布信任、运行时锁和版本兼容性全部通过后才会保存为候选。</p>
      </div>
      <Tag tone="idle">只准备 · 不执行升级</Tag>
    </div>
    {preview && <div className="mt-4 grid gap-3 sm:grid-cols-2">
      <div className="rounded-[11px] border border-hairline p-4"><p className="text-[12px] text-ink-tertiary">当前运行版本</p><p className="tnum mt-1 text-[15px] font-semibold text-ink">{preview.current.appVersion}</p><p className="tnum mt-1 text-[12px] text-ink-secondary">数据结构 {preview.current.dataSchemaVersion} · {preview.current.releaseId}</p></div>
      <div className="rounded-[11px] border border-hairline p-4"><p className="text-[12px] text-ink-tertiary">准备后目标版本</p><p className="tnum mt-1 text-[15px] font-semibold text-ink">{preview.candidates.find((item) => item.status === 'ready')?.target.appVersion ?? '尚未选择'}</p><p className="mt-1 text-[12px] text-ink-secondary">准备过程不会改变当前运行版本</p></div>
    </div>}
    <div className="mt-4 flex flex-wrap items-center gap-3">
      <input ref={inputRef} type="file" accept=".zip,application/zip" aria-label="选择服务器升级包" className="max-w-full text-[13px] text-ink-secondary file:mr-3 file:rounded-[var(--radius-control)] file:border-0 file:bg-group file:px-4 file:py-2 file:text-ink" disabled={phase === 'uploading' || phase === 'validating'} onChange={(event) => { setFile(event.target.files?.[0] ?? null); setError(''); }} />
      <ToolbarButton variant="primary" disabled={!file || phase === 'uploading' || phase === 'validating'} onClick={() => void upload()}>上传并校验</ToolbarButton>
    </div>
    {(phase === 'uploading' || phase === 'validating') && <div className="mt-3" role="status">
      <div className="flex justify-between text-[12px] text-ink-secondary"><span>{phase === 'uploading' ? '正在上传至受管暂存区' : '上传完成，正在校验发布清单与兼容性'}</span><span className="tnum">{phase === 'uploading' ? `${progress}%` : '请稍候'}</span></div>
      <progress className="mt-2 h-2 w-full" aria-label="上传进度" value={phase === 'uploading' ? progress : undefined} max={100} />
    </div>}
    {phase === 'done' && <p role="status" className="mt-3 flex items-center gap-2 text-[13px] text-ok"><StatusDot tone="ok" />候选包已准备完成；尚未执行升级，当前运行版本不变。</p>}
    {error && <p role="alert" className="mt-3 text-[13px] leading-6 text-fail">{error}</p>}
    {preview && preview.candidates.length > 0 && <div className="mt-5 space-y-3">
      <h3 className="text-[13px] font-semibold text-ink">已保存的候选版本</h3>
      {preview.candidates.map((candidate) => <article key={candidate.candidateId} className="rounded-[11px] border border-hairline p-4">
        <div className="flex flex-wrap items-center justify-between gap-2"><strong className="text-[13px] text-ink">{candidate.release.releaseId} · {candidate.target.appVersion}</strong><Tag tone={candidate.status === 'ready' ? 'ok' : 'fail'}>{candidate.status === 'ready' ? '校验通过，可供后续升级复核' : '不可用于升级'}</Tag></div>
        <p className="mt-2 text-[12px] leading-5 text-ink-secondary">{candidate.compatibility.message}</p>
        <dl className="mt-2.5 grid grid-cols-2 gap-2 text-[12px] text-ink-secondary sm:grid-cols-3">
          <div><dt>完整清单</dt><dd className="mt-1 text-ink">{candidate.checks.manifestComplete ? '已核验' : '未通过'}</dd></div>
          <div><dt>内容哈希与信任</dt><dd className="mt-1 text-ink">{candidate.checks.contentHashes && candidate.checks.trustedDistribution && candidate.checks.runtimeLocks ? '已核验' : '未通过'}</dd></div>
          <div><dt>应用／数据兼容</dt><dd className="mt-1 text-ink">{candidate.checks.compatibility ? '兼容' : '不兼容'}</dd></div>
        </dl>
        {candidate.failure && <p className="mt-2 text-[12px] text-fail">{candidate.failure.message}</p>}
        <p className="mt-2.5 break-all font-mono text-[11px] text-ink-tertiary">候选身份：{candidate.candidateId}</p>
      </article>)}
    </div>}
    {preview && preview.failures.length > 0 && <div className="mt-4"><h3 className="text-[13px] font-semibold text-ink">最近失败的上传</h3><ul className="mt-2 space-y-2 text-[12px] leading-5 text-ink-secondary">{preview.failures.slice(0, 5).map((failure) => <li key={failure.uploadId}>{new Date(failure.createdAt).toLocaleString('zh-CN')} · {failure.message}</li>)}</ul></div>}
  </section>;
}
