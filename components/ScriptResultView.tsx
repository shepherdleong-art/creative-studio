'use client';
/* eslint-disable @next/next/no-img-element -- V2 compatibility displays local API image URLs. */

import { useCallback, useState } from 'react';
import { Icon } from '@/components/ui/Icon';
import type { ScriptOutput, ScriptOutputV3, StoredScriptOutput } from '@/lib/script-providers';

interface Props {
  script: StoredScriptOutput;
  getShotImageUrl: (shotId: string) => string | undefined;
}

async function copyText(value: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(value);
  } catch {
    const textarea = document.createElement('textarea');
    textarea.value = value;
    textarea.style.position = 'fixed';
    textarea.style.left = '-9999px';
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand('copy');
    document.body.removeChild(textarea);
  }
}

function downloadText(filename: string, content: string, type: string): void {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function buildV3SubtitleCopy(script: ScriptOutputV3): string {
  return [
    `脚本名称：${script.title}`,
    `封面主标题：${script.coverTitleParts.primary}`,
    `封面副标题：${script.coverTitleParts.secondary}`,
    '',
    script.fullSubtitle,
  ].join('\n');
}

function buildV3Txt(script: ScriptOutputV3): string {
  return [
    `# ${script.title}`,
    '',
    `平台：${script.platform}`,
    `语气：${script.tone}`,
    `模板：${script.template}`,
    `目标总时长：${script.targetDurationSec} 秒`,
    `预计口播时长：${script.estimatedNarrationDurationSec.toFixed(2)} 秒`,
    `内容字符数：${script.contentCharacterCount}`,
    '',
    `封面主标题：${script.coverTitleParts.primary}`,
    `封面副标题：${script.coverTitleParts.secondary}`,
    '',
    '## 配音稿（保留自然标点）',
    script.fullScript,
    '',
    '## 字幕稿（无语言标点）',
    script.fullSubtitle,
    '',
    ...(script.sellingPointUsage?.length ? [
      '## 卖点采用情况',
      ...script.sellingPointUsage.map((usage) => (
        `${usage.status === 'used' ? '已采用' : usage.status === 'omitted' ? '未写入正文' : '图片暂不支持'}：${usage.title}｜${usage.reason}`
      )),
      '',
    ] : []),
    '## 分段',
    ...script.segments.map((segment, index) => [
      `### 第 ${index + 1} 段`,
      `口播：${segment.narration}`,
      `字幕：${segment.subtitle}`,
      `使用卖点：${segment.sellingPointRefs.join('、') || '—'}`,
      `画面意图：${segment.visualIntent}`,
      `画面关键词：${segment.visualKeywords.join('、') || '—'}`,
      '',
    ].join('\n')),
  ].join('\n');
}

export default function ScriptResultView({ script, getShotImageUrl }: Props) {
  const [copied, setCopied] = useState<'subtitle' | 'narration' | null>(null);

  const handleCopy = useCallback(async (kind: 'subtitle' | 'narration') => {
    const content = script.version === 3
      ? kind === 'subtitle' ? buildV3SubtitleCopy(script) : script.fullScript
      : `${script.title ? `标题: ${script.title}\n\n` : ''}${script.fullScript}`;
    await copyText(content);
    setCopied(kind);
    window.setTimeout(() => setCopied(null), 2000);
  }, [script]);

  const handleDownloadTxt = useCallback(() => {
    const text = script.version === 3
      ? buildV3Txt(script)
      : [
          `# ${script.title}`,
          `平台: ${script.platform}  语气: ${script.tone}  时长: ${script.targetDurationSec}秒`,
          '',
          '## 完整口播稿',
          script.fullScript,
          '',
          '## 分段',
          ...script.segments.map((segment, index) => (
            `### 第 ${index + 1} 段\n口播: ${segment.narration}\n字幕: ${segment.subtitle}\n画面理由: ${segment.rationale}\n`
          )),
        ].join('\n');
    downloadText(`${script.title || 'script'}.txt`, text, 'text/plain;charset=utf-8');
  }, [script]);

  const handleDownloadJson = useCallback(() => {
    downloadText(
      `${script.title || 'script'}.json`,
      JSON.stringify(script, null, 2),
      'application/json;charset=utf-8',
    );
  }, [script]);

  if (script.version === 3) {
    return (
      <div className="space-y-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="text-[0.7rem] text-ink-tertiary">脚本名称</div>
            <h3 className="text-base font-semibold text-ink">{script.title}</h3>
            <div className="mt-2 flex flex-wrap gap-2 text-xs text-ink-secondary">
              <span>{script.platform}</span><span>·</span><span>{script.tone}</span><span>·</span>
              <span>{script.template}</span><span>·</span><span>{script.targetDurationSec} 秒总时长</span>
            </div>
          </div>
          <div className="flex shrink-0 flex-wrap justify-end gap-2">
            <button onClick={() => void handleCopy('subtitle')} className="btn-primary btn-sm text-xs">
              <Icon name={copied === 'subtitle' ? 'check' : 'copy'} size={13} />
              {copied === 'subtitle' ? '已复制' : '复制字幕稿'}
            </button>
            <button onClick={() => void handleCopy('narration')} className="btn-secondary btn-sm text-xs">
              <Icon name={copied === 'narration' ? 'check' : 'copy'} size={13} /> 复制配音稿
            </button>
            <button onClick={handleDownloadTxt} className="btn-secondary btn-sm text-xs"><Icon name="download" size={13} /> .txt</button>
            <button onClick={handleDownloadJson} className="btn-secondary btn-sm text-xs"><Icon name="download" size={13} /> .json</button>
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="rounded-[14px] border border-hairline bg-surface-subtle p-4">
            <div className="text-[0.7rem] text-ink-tertiary">封面主标题</div>
            <div className="mt-1 text-lg font-semibold text-ink">{script.coverTitleParts.primary}</div>
          </div>
          <div className="rounded-[14px] border border-hairline bg-surface-subtle p-4">
            <div className="text-[0.7rem] text-ink-tertiary">封面副标题</div>
            <div className="mt-1 text-lg font-semibold text-ink">{script.coverTitleParts.secondary}</div>
          </div>
        </div>
        {script.coverTitleParts.source !== 'model' && (
          <p className="rounded-lg bg-warn-tint px-3 py-2 text-xs text-warn">主副标题由系统拆分或兜底生成，建议检查后再进入智能混剪。</p>
        )}

        <div className="flex flex-wrap gap-3 rounded-[14px] border border-hairline p-3 text-xs text-ink-secondary">
          <span className="font-medium text-ok">时长合格</span>
          <span>内容字符 {script.contentCharacterCount}</span>
          <span>预计正文 {script.estimatedNarrationDurationSec.toFixed(2)} 秒</span>
          <span>正文预算 {script.targetNarrationDurationSec.toFixed(2)} 秒</span>
        </div>

        {script.sellingPointUsage && script.sellingPointUsage.length > 0 && (
          <div>
            <h4 className="mb-2 text-sm font-semibold text-ink">卖点采用情况</h4>
            <div className="space-y-2">
              {script.sellingPointUsage.map((usage) => (
                <div key={usage.sellingPointId} className="rounded-[14px] border border-hairline p-3">
                  <div className="flex items-center gap-2">
                    <span className={`rounded-full px-2 py-0.5 text-[0.65rem] font-semibold ${
                      usage.status === 'used' ? 'bg-ok-tint text-ok' : 'bg-warn-tint text-warn'
                    }`}>
                      {usage.status === 'used' ? '已采用' : usage.status === 'omitted' ? '未写入正文' : '图片暂不支持'}
                    </span>
                    <span className="text-sm font-medium text-ink">{usage.title}</span>
                  </div>
                  <p className="mt-1 text-xs leading-relaxed text-ink-secondary">{usage.reason}</p>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="space-y-3">
          {script.segments.map((segment, index) => (
            <div key={segment.id} className="rounded-[14px] border border-hairline p-4">
              <div className="text-xs text-ink-tertiary">第 {index + 1} 段 · 无标点字幕</div>
              <p className="mt-1 text-sm font-medium text-ink">{segment.subtitle}</p>
              <details className="mt-2 text-xs text-ink-secondary">
                <summary className="cursor-pointer">查看带标点口播</summary>
                <p className="mt-1 leading-relaxed">{segment.narration}</p>
              </details>
              <div className="mt-2 grid gap-1 text-xs text-ink-tertiary sm:grid-cols-2">
                <span>卖点：{segment.sellingPointRefs.join('、') || '—'}</span>
                <span>画面意图：{segment.visualIntent}</span>
                <span className="sm:col-span-2">关键词：{segment.visualKeywords.join('、') || '—'}</span>
              </div>
            </div>
          ))}
        </div>

        <div>
          <h4 className="mb-2 text-sm font-semibold text-ink">完整字幕稿</h4>
          <pre className="whitespace-pre-wrap rounded-[14px] bg-surface-subtle p-4 text-sm leading-relaxed text-ink-secondary">{script.fullSubtitle}</pre>
        </div>
        <details>
          <summary className="cursor-pointer text-sm font-semibold text-ink">完整配音稿（保留自然标点）</summary>
          <pre className="mt-2 whitespace-pre-wrap rounded-[14px] bg-surface-subtle p-4 text-sm leading-relaxed text-ink-secondary">{script.fullScript}</pre>
        </details>
      </div>
    );
  }

  return <LegacyScriptResult script={script} getShotImageUrl={getShotImageUrl} onCopy={() => void handleCopy('narration')} copied={copied != null} onDownloadTxt={handleDownloadTxt} onDownloadJson={handleDownloadJson} />;
}

function LegacyScriptResult({
  script,
  getShotImageUrl,
  onCopy,
  copied,
  onDownloadTxt,
  onDownloadJson,
}: {
  script: ScriptOutput;
  getShotImageUrl: Props['getShotImageUrl'];
  onCopy: () => void;
  copied: boolean;
  onDownloadTxt: () => void;
  onDownloadJson: () => void;
}) {
  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div><h3 className="text-base font-semibold text-ink">{script.title}</h3><p className="mt-1 text-xs text-ink-secondary">历史 V2 脚本 · {script.targetDurationSec} 秒</p></div>
        <div className="flex gap-2">
          <button onClick={onDownloadTxt} className="btn-secondary btn-sm text-xs"><Icon name="download" size={13} /> .txt</button>
          <button onClick={onDownloadJson} className="btn-secondary btn-sm text-xs"><Icon name="download" size={13} /> .json</button>
        </div>
      </div>
      <div className="space-y-3">
        {script.segments.map((segment, index) => {
          const imageUrl = getShotImageUrl(segment.shotId);
          return (
            <div key={segment.shotId} className="flex gap-3 rounded border border-hairline p-3">
              {imageUrl ? <img src={imageUrl} alt={`第 ${index + 1} 段画面`} className="h-20 w-20 shrink-0 rounded object-cover" /> : <div className="h-20 w-20 shrink-0 rounded bg-surface-subtle" />}
              <div><p className="text-xs text-ink-tertiary">第 {index + 1} 段</p><p className="mt-0.5 text-sm text-ink">{segment.narration}</p>{segment.rationale && <p className="mt-1 text-xs text-ink-tertiary">画面理由：{segment.rationale}</p>}</div>
            </div>
          );
        })}
      </div>
      {script.droppedShots.length > 0 && <p className="rounded bg-surface-subtle p-3 text-xs text-ink-tertiary">未使用分镜：{script.droppedShots.map((shot) => shot.reason).join('；')}</p>}
      <div>
        <div className="mb-2 flex items-center justify-between"><h4 className="text-sm font-semibold text-ink">完整口播稿</h4><button onClick={onCopy} className="btn-secondary btn-sm text-xs"><Icon name={copied ? 'check' : 'copy'} size={13} /> {copied ? '已复制' : '复制'}</button></div>
        <pre className="whitespace-pre-wrap rounded-[14px] bg-surface-subtle p-4 text-sm leading-relaxed text-ink-secondary">{script.fullScript}</pre>
      </div>
    </div>
  );
}
