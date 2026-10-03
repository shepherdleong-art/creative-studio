'use client';

import { useState } from 'react';

type Evidence = { images: Array<{ filename: string; pageIndex: number; tileRef: string; imageUrl: string }>; truncated: boolean; evidenceQuote: string };

export default function SellingPointEvidence({ projectId, revisionId, pointId }: { projectId: string; revisionId: string; pointId: string }) {
  const [evidence, setEvidence] = useState<Evidence | null>(null);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  async function toggle() {
    if (loading) return;
    if (open) { setOpen(false); return; }
    setOpen(true);
    if (evidence) return;
    setLoading(true);
    setError('');
    try {
      const query = new URLSearchParams({ revisionId, pointId });
      const response = await fetch(`/api/projects/${projectId}/script-studio/library/evidence?${query}`);
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || data.error || '读取来源图失败');
      setEvidence(data);
    } catch (error) { setError(error instanceof Error ? error.message : '读取来源图失败'); }
    finally { setLoading(false); }
  }
  return <div className="mt-3">
    <button type="button" className="btn-secondary btn-sm" onClick={() => void toggle()} disabled={loading} aria-expanded={open}>
      {loading ? '正在读取来源图…' : open ? '收起来源图' : '查看来源图，手动核对'}
    </button>
    {open && <div className="mt-3 space-y-3">
      <p>AI 识别结果尚未人工复核。可对照下方图片核对小字、数值和适用配置，再通过“选择 / 排除卖点”编辑详解或排除该条。</p>
      {error && <p role="alert" className="text-fail">{error}</p>}
      {evidence?.evidenceQuote && <p className="whitespace-pre-wrap">识别摘录：{evidence.evidenceQuote}</p>}
      {evidence?.images.map((image, index) => <figure key={index}>
        <figcaption className="mb-2">第 {image.pageIndex + 1} 张 · {image.filename} · {image.tileRef}</figcaption>
        <div className="max-h-[600px] overflow-auto rounded-xl border border-hairline bg-surface">
          {/* 原像素展示，避免再次缩小小字；容器可横向和纵向滚动。 */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={image.imageUrl} alt={`${image.filename} 来源区域`} className="max-w-none" />
        </div>
      </figure>)}
      {evidence?.truncated && <p>本次显示前 6 个来源区域，其余位置见卖点的证据定位。</p>}
    </div>}
  </div>;
}
