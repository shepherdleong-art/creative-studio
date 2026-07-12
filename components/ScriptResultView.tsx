'use client';

import { useState, useCallback } from 'react';
import { Icon } from '@/components/ui/Icon';
import type { ScriptOutput } from '@/lib/script-providers';

interface Props {
  script: ScriptOutput;
  getShotImageUrl: (shotId: string) => string | undefined;
  projectId: string;
}

export default function ScriptResultView({ script, getShotImageUrl: _getShotImageUrl, projectId: _projectId }: Props) {
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
      `平台: ${script.platform}  语气: ${script.tone}  时长: ${script.targetDurationSec}秒`,
      '',
      '## 完整口播稿',
      '',
      script.fullScript,
      '',
      '## 分段',
      ...script.segments.map((s, i) => (
        `### 第 ${i + 1} 段\n口播: ${s.narration}\n字幕: ${s.subtitle}\n画面理由: ${s.rationale}\n`
      )),
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

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="text-base font-semibold text-ink">{script.title}</h3>
          <div className="mt-1 flex flex-wrap gap-3 text-xs text-ink-secondary">
            <span>平台: {script.platform}</span>
            <span>语气: {script.tone}</span>
            <span>时长: {script.targetDurationSec}秒</span>
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

      {/* Segment cards */}
      <div className="space-y-3">
        {script.segments.map((segment, i) => (
          <div key={segment.shotId} className="flex gap-3 rounded border border-hairline p-3">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={`/api/images/${segment.imageAssetId}`}
              alt={`第 ${i + 1} 段画面`}
              className="h-20 w-20 shrink-0 rounded object-cover"
            />
            <div className="min-w-0 flex-1">
              <p className="text-xs text-ink-tertiary">第 {i + 1} 段</p>
              <p className="mt-0.5 text-sm text-ink">{segment.narration}</p>
              {segment.rationale && (
                <p className="mt-1 text-xs leading-relaxed text-ink-tertiary">画面理由：{segment.rationale}</p>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* Dropped shots (backup pool) */}
      {script.droppedShots.length > 0 && (
        <div className="mt-4 rounded border border-hairline bg-surface-subtle p-3">
          <p className="text-xs font-medium text-ink-secondary">未使用的分镜（备用素材，用于替补生成失败的画面）</p>
          <ul className="mt-1 space-y-0.5">
            {script.droppedShots.map((dropped) => (
              <li key={dropped.shotId} className="text-xs text-ink-tertiary">· {dropped.reason}</li>
            ))}
          </ul>
        </div>
      )}

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
