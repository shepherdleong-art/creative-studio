'use client';

import { useState, useCallback } from 'react';
import { Icon } from '@/components/ui/Icon';
import type { ScriptOutput } from '@/lib/script-providers';

interface Props {
  script: ScriptOutput;
  getShotImageUrl: (shotId: string) => string | undefined;
  projectId: string;
}

export default function ScriptResultView({ script, getShotImageUrl, projectId: _projectId }: Props) {
  const [copied, setCopied] = useState(false);

  // ── Copy full script ──
  const handleCopyFullScript = useCallback(async () => {
    if (!script?.fullScript) return;
    const textToCopy = script.title ? `标题: ${script.title}\n\n${script.fullScript}` : script.fullScript;
    try {
      await navigator.clipboard.writeText(textToCopy);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = textToCopy;
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [script]);

  // ── Download TXT ──
  const handleDownloadTxt = useCallback(() => {
    if (!script) return;
    const text = [
      `# ${script.title}`,
      `平台: ${script.platform}  语气: ${script.tone}  时长: ${script.duration}`,
      '',
      '## 完整口播稿',
      '',
      script.fullScript,
      '',
      '## 分镜详情',
      '',
      ...script.shots.map((s) => {
        const shotTitle = s.title || `分镜 ${s.shotIndex} 文案`;
        return `### ${shotTitle}（分镜 ${s.shotIndex}，${s.duration}）\n标题: ${shotTitle}\n口播: ${s.voiceover}\n字幕: ${s.subtitle}\n视觉意图: ${s.visualIntent}\n`;
      }),
    ].join('\n');

    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${script.title || 'script'}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  }, [script]);

  // ── Download JSON ──
  const handleDownloadJson = useCallback(() => {
    if (!script) return;
    const blob = new Blob([JSON.stringify(script, null, 2)], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${script.title || 'script'}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, [script]);

  if (!script) return null;

  // Build selling point lookup by shotId
  const spMap = new Map<string, string>();
  if (script.sellingPointMap) {
    for (const m of script.sellingPointMap) {
      spMap.set(m.shotId, m.sellingPoint);
    }
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="text-base font-semibold text-ink">{script.title}</h3>
          <div className="mt-1 flex flex-wrap gap-3 text-xs text-ink-secondary">
            <span>平台: {script.platform}</span>
            <span>语气: {script.tone}</span>
            <span>时长: {script.duration}</span>
            <span>模版: {script.template}</span>
          </div>
        </div>
        <div className="flex shrink-0 gap-2">
          <button onClick={handleDownloadTxt} className="btn-secondary btn-sm text-xs">
            <Icon name="download" size={13} /> .txt
          </button>
          <button onClick={handleDownloadJson} className="btn-secondary btn-sm text-xs">
            <Icon name="download" size={13} /> .json
          </button>
        </div>
      </div>

      {/* Shot-by-shot cards */}
      <div className="space-y-4">
        {script.shots.map((shot) => {
          const imageUrl = getShotImageUrl(shot.shotId);
          const spTag = spMap.get(shot.shotId);

          return (
            <div
              key={shot.shotId || shot.shotIndex}
              className="overflow-hidden rounded-[18px] border border-hairline bg-surface"
            >
              <div className="flex flex-col sm:flex-row">
                {/* Left: Image */}
                <div className="flex w-full shrink-0 items-center justify-center bg-surface-subtle p-4 sm:w-[200px]">
                  {imageUrl ? (
                    <img
                      src={imageUrl}
                      alt={`分镜 ${shot.shotIndex}`}
                      className="max-h-[180px] w-full rounded-xl object-contain"
                    />
                  ) : (
                    <div className="flex h-[120px] w-full flex-col items-center justify-center rounded-xl bg-surface text-ink-tertiary">
                      <Icon name="image" size={24} />
                      <span className="mt-1 text-[0.65rem]">暂无图片</span>
                    </div>
                  )}
                </div>

                {/* Right: Script */}
                <div className="flex min-w-0 flex-1 flex-col justify-center p-4">
                  <div className="mb-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-xs font-semibold text-ink-tertiary">
                        分镜 {shot.shotIndex}
                      </span>
                      <span className="text-[0.65rem] text-ink-tertiary">{shot.duration}</span>
                      {spTag && (
                        <span className="inline-flex items-center rounded-full bg-accent-tint/10 px-2 py-px text-[0.65rem] font-medium text-accent">
                          🏷 {spTag}
                        </span>
                      )}
                    </div>
                    {shot.title && (
                      <h4 className="mt-1 text-sm font-semibold leading-snug text-ink">
                        {shot.title}
                      </h4>
                    )}
                  </div>

                  <div className="space-y-2.5">
                    <div>
                      <span className="text-[0.65rem] font-medium text-ink-tertiary">🗣 口播</span>
                      <p className="mt-0.5 text-sm leading-relaxed text-ink">{shot.voiceover}</p>
                    </div>
                    {shot.subtitle && shot.subtitle !== shot.voiceover && (
                      <div>
                        <span className="text-[0.65rem] font-medium text-ink-tertiary">📝 字幕</span>
                        <p className="mt-0.5 text-xs leading-relaxed text-ink-secondary">{shot.subtitle}</p>
                      </div>
                    )}
                    {shot.visualIntent && (
                      <div>
                        <span className="text-[0.65rem] font-medium text-ink-tertiary">👁 视觉意图</span>
                        <p className="mt-0.5 text-xs leading-relaxed text-ink-tertiary">{shot.visualIntent}</p>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Full script with copy */}
      <div>
        <div className="mb-2 flex items-center justify-between">
          <h4 className="text-sm font-semibold text-ink">完整口播稿（粘贴到剪映智能配音）</h4>
          <button
            onClick={handleCopyFullScript}
            className="btn-secondary btn-sm text-xs"
          >
            {copied ? (
              <>
                <Icon name="check" size={13} /> 已复制
              </>
            ) : (
              <>
                <Icon name="copy" size={13} /> 一键复制
              </>
            )}
          </button>
        </div>
        {script.title && (
          <div className="mb-2 rounded-[12px] bg-surface-subtle px-4 py-3">
            <div className="text-[0.65rem] font-medium text-ink-tertiary">标题</div>
            <div className="mt-0.5 text-sm font-semibold text-ink">{script.title}</div>
          </div>
        )}
        <pre className="whitespace-pre-wrap rounded-[14px] bg-surface-subtle p-4 text-sm leading-relaxed text-ink-secondary">
          {script.fullScript}
        </pre>
      </div>
    </div>
  );
}
