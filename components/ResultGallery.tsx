'use client';

import { useState, useEffect, useCallback } from 'react';

interface Job {
  id: string;
  inputFilename: string;
  outputFilename?: string;
  status: string;
  outputImageId?: string;
  inputImageId?: string;
  errorMessage?: string;
  reviewMark?: string;
  prompt?: string;
  parentJobId?: string;
  revision?: number;
}

interface ImageAsset {
  id: string;
  role: string;
  filename: string;
  path: string;
  relativePath?: string;
  imageUrl?: string;
}

interface Props {
  jobs: Job[];
  images: ImageAsset[];
  onRetry: (jobId: string) => void;
  onMark: (jobId: string, mark: string) => void;
  onRegenerate: (jobId: string, prompt: string) => void;
}

export default function ResultGallery({ jobs, images, onRetry, onMark, onRegenerate }: Props) {
  const succeededJobs = jobs.filter((j) => j.status === 'succeeded' && j.outputFilename);
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const [regenOpen, setRegenOpen] = useState(false);
  const [regenPrompt, setRegenPrompt] = useState('');
  const selectedJob = selectedIndex != null ? succeededJobs[selectedIndex] : null;

  const getImageUrl = (asset: ImageAsset | undefined): string | null => {
    return asset?.imageUrl || null;
  };

  const getMark = (job: Job): string | null => {
    return job.reviewMark || null;
  };

  const goPrev = useCallback(() => {
    setSelectedIndex((i) => (i != null ? Math.max(0, i - 1) : null));
  }, []);

  const goNext = useCallback(() => {
    setSelectedIndex((i) => (i != null ? Math.min(succeededJobs.length - 1, i + 1) : null));
  }, [succeededJobs.length]);

  // Keyboard navigation
  useEffect(() => {
    if (selectedIndex == null) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSelectedIndex(null);
      if (e.key === 'ArrowLeft') goPrev();
      if (e.key === 'ArrowRight') goNext();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [selectedIndex, goPrev, goNext]);

  const handleMark = (mark: string) => {
    if (!selectedJob) return;
    onMark(selectedJob.id, mark);
  };

  const isFirst = selectedIndex === 0;
  const isLast = selectedIndex === succeededJobs.length - 1;

  return (
    <div>
      {succeededJobs.length === 0 ? (
        <div className="text-center py-12 text-gray-400">
          <div className="text-4xl mb-2">🖼️</div>
          <p>暂无成功生成的图片</p>
        </div>
      ) : (
        <>
          {/* Grid */}
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
            {succeededJobs.map((job, idx) => {
              const mark = getMark(job);
              return (
                <div
                  key={job.id}
                  onClick={() => setSelectedIndex(idx)}
                  className={`card overflow-hidden cursor-pointer group transition-all hover:ring-2 hover:ring-blue-400 ${
                    mark === 'discard' ? 'opacity-40' : ''
                  }`}
                >
                  <div className="aspect-square relative bg-gray-100">
                    <img
                      src={`/api/images/outputs/${job.outputFilename}`}
                      alt={job.inputFilename}
                      className="w-full h-full object-cover"
                    />
                    {mark && (
                      <span className={`absolute top-1 left-1 text-xs px-1.5 py-0.5 rounded ${
                        mark === 'available' ? 'bg-green-500 text-white'
                          : mark === 'rework' ? 'bg-yellow-500 text-white'
                          : 'bg-gray-500 text-white'}`}
                      >
                        {{ available: '可用', rework: '返工', discard: '废弃' }[mark]}
                      </span>
                    )}
                  </div>
                  <div className="p-2">
                    <div className="text-xs text-gray-500 truncate">{job.inputFilename}</div>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Preview modal — gallery style */}
          {selectedJob && selectedIndex != null && (
            <div
              className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4"
              onClick={() => setSelectedIndex(null)}
            >
              <div
                className="bg-white rounded-xl max-w-5xl w-full max-h-[90vh] overflow-auto"
                onClick={(e) => e.stopPropagation()}
              >
                {/* Header */}
                <div className="p-4 border-b flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <h3 className="font-medium text-sm truncate max-w-[300px]">
                      {selectedJob.inputFilename}
                    </h3>
                    <span className="text-xs text-gray-400">
                      {selectedIndex + 1} / {succeededJobs.length}
                    </span>
                  </div>
                  <button
                    onClick={() => setSelectedIndex(null)}
                    className="text-gray-400 hover:text-gray-600 text-xl leading-none"
                  >
                    ×
                  </button>
                </div>

                {/* Images with nav arrows */}
                <div className="relative">
                  <div className="p-4 grid grid-cols-2 gap-4">
                    <div>
                      <div className="text-xs text-gray-500 mb-1">原图</div>
                      {(() => {
                        const inputAsset = images.find((img) => img.id === selectedJob.inputImageId);
                        const url = getImageUrl(inputAsset);
                        return url ? (
                          <img src={url} alt="原图" className="w-full rounded-lg border" />
                        ) : (
                          <div className="text-gray-400 text-sm">原图不可用</div>
                        );
                      })()}
                    </div>
                    <div>
                      <div className="text-xs text-gray-500 mb-1">结果</div>
                      <img
                        src={`/api/images/outputs/${selectedJob.outputFilename}`}
                        alt="结果"
                        className="w-full rounded-lg border"
                      />
                    </div>
                  </div>

                  {/* Left/Right navigation arrows */}
                  {!isFirst && (
                    <button
                      onClick={goPrev}
                      className="absolute left-2 top-1/2 -translate-y-1/2 w-10 h-10 bg-black/40 hover:bg-black/60 text-white rounded-full flex items-center justify-center text-2xl transition-colors"
                      title="上一张 (←)"
                    >
                      ‹
                    </button>
                  )}
                  {!isLast && (
                    <button
                      onClick={goNext}
                      className="absolute right-2 top-1/2 -translate-y-1/2 w-10 h-10 bg-black/40 hover:bg-black/60 text-white rounded-full flex items-center justify-center text-2xl transition-colors"
                      title="下一张 (→)"
                    >
                      ›
                    </button>
                  )}
                </div>

                {/* Regenerate prompt editor */}
                {regenOpen && (
                  <div className="p-4 border-t bg-purple-50">
                    <p className="text-xs text-purple-700 mb-2">
                      为 <strong>{selectedJob.inputFilename}</strong> 创建新的生成任务。不会覆盖当前结果。
                    </p>
                    <textarea
                      value={regenPrompt}
                      onChange={(e) => setRegenPrompt(e.target.value)}
                      rows={4}
                      className="input-field font-mono text-sm mb-3"
                      placeholder="输入新的提示词..."
                    />
                    <div className="flex gap-2">
                      <button
                        onClick={() => setRegenOpen(false)}
                        className="btn-secondary btn-sm"
                      >
                        取消
                      </button>
                      <button
                        onClick={() => {
                          if (!regenPrompt.trim()) { alert('请输入提示词'); return; }
                          onRegenerate(selectedJob.id, regenPrompt.trim());
                          setRegenOpen(false);
                        }}
                        disabled={!regenPrompt.trim()}
                        className="btn-primary btn-sm"
                      >
                        创建并开始重新生成
                      </button>
                    </div>
                  </div>
                )}

                {/* Actions */}
                <div className="p-4 border-t flex gap-2 flex-wrap items-center">
                  <button onClick={goPrev} disabled={isFirst} className="btn-secondary btn-sm" title="上一张">
                    ‹ 上一张
                  </button>
                  <button onClick={goNext} disabled={isLast} className="btn-secondary btn-sm" title="下一张">
                    下一张 ›
                  </button>
                  <span className="text-gray-300 mx-1">|</span>
                  <button onClick={() => handleMark('available')} className="btn-secondary btn-sm text-green-700">
                    ✅ 可用
                  </button>
                  <button onClick={() => handleMark('rework')} className="btn-secondary btn-sm text-yellow-700">
                    🔄 待返工
                  </button>
                  <button onClick={() => handleMark('discard')} className="btn-secondary btn-sm text-red-700">
                    🗑️ 废弃
                  </button>
                  <span className="text-gray-300 mx-1">|</span>
                  <button
                    onClick={() => {
                      setRegenPrompt(selectedJob.prompt || '');
                      setRegenOpen(true);
                    }}
                    className="btn-secondary btn-sm text-purple-700"
                  >
                    🔄 重新生成
                  </button>
                  <a
                    href={`/api/images/outputs/${selectedJob.outputFilename}`}
                    download
                    className="btn-primary btn-sm ml-auto"
                  >
                    下载
                  </a>
                </div>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
