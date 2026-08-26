'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { ScriptGenerationProgress } from '@/lib/script-generation-v3';
import { parseScriptStreamPreview, type StreamPreviewText } from '@/lib/script-stream-preview';

interface ScriptGenerationLiveViewProps {
  providerName: string;
  progress: ScriptGenerationProgress;
  startedAt: string;
  cancelling: boolean;
  onCancel: () => void;
  lastGenerationDurationMs?: number | null;
}

function formatElapsed(totalMs: number): string {
  const totalSec = Math.max(0, Math.floor(totalMs / 1000));
  const minutes = Math.floor(totalSec / 60);
  const seconds = totalSec % 60;
  return minutes > 0 ? `${minutes}分${seconds}秒` : `${seconds}秒`;
}

function useTypewriter(targetText: string): string {
  const [displayed, setDisplayed] = useState(targetText);
  const displayedRef = useRef(targetText);
  const initializedRef = useRef(false);

  useEffect(() => {
    if (!initializedRef.current) {
      initializedRef.current = true;
      displayedRef.current = targetText;
      setDisplayed(targetText);
      return;
    }
    const current = displayedRef.current;
    if (!targetText.startsWith(current) || targetText.length < current.length) {
      displayedRef.current = targetText;
      setDisplayed(targetText);
      return;
    }
    const speed = targetText.length - current.length > 60 ? 4 : 1;
    const timer = setInterval(() => {
      if (displayedRef.current.length >= targetText.length) {
        clearInterval(timer);
        return;
      }
      const next = targetText.slice(0, displayedRef.current.length + speed);
      displayedRef.current = next;
      setDisplayed(next);
    }, 24);
    return () => clearInterval(timer);
  }, [targetText]);

  return displayed;
}

function TypewriterText({ value }: { value: StreamPreviewText }) {
  const text = useTypewriter(value.text);
  return <>{text}{!value.done ? '▍' : ''}</>;
}

function validationMessage(
  validation: NonNullable<ScriptGenerationProgress['validation']>,
): { kind: 'ok' | 'warn'; title: string; detail?: string; summary?: string } {
  const target = validation.targetCharacterRange;
  const targetSeconds = target[1] / 4.2;
  if (validation.qualification === 'qualified') {
    return {
      kind: 'ok',
      title: `第 ${validation.attempt} 次校验通过`,
      detail: `预计口播 ${validation.estimatedNarrationDurationSec.toFixed(1)}s / 目标 ${targetSeconds.toFixed(1)}s`,
    };
  }
  if (validation.qualification === 'too_long') {
    return {
      kind: 'warn',
      title: `第 ${validation.attempt} 次校验未通过：口播偏长`,
      detail: `预计 ${validation.estimatedNarrationDurationSec.toFixed(1)}s，目标 ${targetSeconds.toFixed(1)}s，上限 ${(target[1] / 4.2).toFixed(1)}s → 已发起修正`,
    };
  }
  if (validation.qualification === 'too_short') {
    return {
      kind: 'warn',
      title: `第 ${validation.attempt} 次校验未通过：口播偏短`,
      detail: `预计 ${validation.estimatedNarrationDurationSec.toFixed(1)}s，目标 ${targetSeconds.toFixed(1)}s，下限 ${(target[0] / 4.2).toFixed(1)}s → 已发起修正`,
    };
  }
  return {
    kind: 'warn',
    title: `第 ${validation.attempt} 次校验未通过：返回格式异常`,
    detail: '正在要求模型重新输出',
  };
}

export default function ScriptGenerationLiveView({
  providerName,
  progress,
  startedAt,
  cancelling,
  onCancel,
  lastGenerationDurationMs,
}: ScriptGenerationLiveViewProps) {
  const [elapsedMs, setElapsedMs] = useState(() => Math.max(0, Date.now() - Date.parse(startedAt)));
  const [thinkingOpen, setThinkingOpen] = useState(false);

  useEffect(() => {
    const started = Date.parse(startedAt);
    const tick = () => setElapsedMs(Math.max(0, Date.now() - started));
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [startedAt]);

  const elapsedSec = Math.floor(elapsedMs / 1000);
  const preview = useMemo(() => parseScriptStreamPreview(progress.streamedContent || ''), [progress.streamedContent]);
  const hasStreamSignal = Boolean(progress.streamedContent || progress.reasoningTail || progress.reasoningChars);
  const stageLabels = [
    { key: 'preparing', label: '准备图片' },
    { key: 'generating', label: progress.attempt && progress.attempt > 1 ? `生成中 · 第 ${progress.attempt} 次` : '生成中' },
    { key: 'validating', label: '校验中' },
    { key: 'saving', label: '保存中' },
    { key: 'completed', label: '完成' },
  ] as const;

  const thoughtText = useTypewriter(progress.reasoningTail || '');
  const coverText = useTypewriter(
    preview.coverTitleParts
      ? `${preview.coverTitleParts.primary?.text || ''}${preview.coverTitleParts.primary || preview.coverTitleParts.secondary ? '｜' : ''}${preview.coverTitleParts.secondary?.text || ''}`
      : '',
  );

  return (
    <div className="mx-auto my-8 max-w-xl rounded-[20px] border border-hairline bg-surface-subtle p-5" aria-live="polite">
      <div className="mb-3 flex items-center justify-between gap-4 text-sm">
        <span className="font-medium text-ink">{providerName} 正在生成脚本</span>
        <span className="tabular-nums text-ink-tertiary">已用 {formatElapsed(elapsedMs)}</span>
      </div>

      {progress.message && (
        <p className="mb-3 text-xs text-ink-secondary">{progress.message}</p>
      )}

      <div role="status" className="mb-3 flex flex-wrap items-center gap-1.5 text-xs">
        {stageLabels.map((item, index) => {
          const active = item.key === progress.phase;
          const passed = stageLabels.findIndex((candidate) => candidate.key === progress.phase) > index;
          return (
            <span key={item.key} className="flex items-center gap-1.5">
              {index > 0 && <span className="text-ink-tertiary">→</span>}
              <span
                className={
                  active
                    ? 'rounded-full bg-accent px-2 py-0.5 font-medium text-white'
                    : passed
                      ? 'rounded-full bg-ok-tint px-2 py-0.5 text-ok'
                      : 'rounded-full bg-hairline px-2 py-0.5 text-ink-tertiary'
                }
              >
                {item.label}
              </span>
            </span>
          );
        })}
        {progress.preparedImages && (
          <span className="text-ink-tertiary">图片 {progress.preparedImages[0]}/{progress.preparedImages[1]}</span>
        )}
      </div>

      {progress.phase === 'generating' && !hasStreamSignal && elapsedSec >= 30 && (
        <p className="mb-3 text-xs text-ink-tertiary">
          推理模型在正文返回前可能有数十秒沉默，属正常现象
          {elapsedSec >= 90 ? '；推理模型通常需要 1-2 分钟' : ''}
        </p>
      )}
      {lastGenerationDurationMs != null && (
        <p className="mb-3 text-xs text-ink-tertiary">
          上次约 {formatElapsed(lastGenerationDurationMs)}
        </p>
      )}

      {progress.reasoningChars && progress.reasoningChars > 0 && progress.reasoningTail && (
        <div className="mb-3 rounded-[14px] border border-hairline bg-surface-subtle">
          <button
            type="button"
            onClick={() => setThinkingOpen((open) => !open)}
            className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-xs text-ink-secondary"
          >
            <span>
              {progress.reasoningDoneMs != null
                ? `💭 已思考 ${formatElapsed(progress.reasoningDoneMs)}`
                : `💭 思考中 · 已 ${formatElapsed(elapsedMs)}`}
              {' · '}
              <span className="tabular-nums">{progress.reasoningChars} 字</span>
            </span>
            <span aria-hidden>{thinkingOpen ? '收起' : '展开'}</span>
          </button>
          <div
            aria-hidden
            className="overflow-hidden whitespace-nowrap border-t border-hairline px-3 py-1 text-xs text-ink-tertiary"
          >
            {thoughtText}
          </div>
          {thinkingOpen && (
            <div className="max-h-48 overflow-y-auto whitespace-pre-wrap border-t border-hairline px-3 py-2 text-xs text-ink-tertiary">
              {thoughtText}
            </div>
          )}
        </div>
      )}

      {progress.validation && (
        <div className="mb-3 space-y-2">
          {(progress.history || [progress.validation]).map((validation) => {
            const message = validationMessage(validation);
            return (
              <div
                key={`${validation.attempt}-${validation.qualification}`}
                className={
                  message.kind === 'ok'
                    ? 'rounded-[14px] border border-ok/30 bg-ok-tint p-3 text-xs'
                    : 'rounded-[14px] border border-warn/30 bg-warn-tint p-3 text-xs'
                }
              >
                <p className={message.kind === 'ok' ? 'font-medium text-ok' : 'font-medium text-warn'}>
                  {message.title}
                </p>
                {message.detail && <p className="mt-1 text-ink-secondary">{message.detail}</p>}
                {validation.advisories.slice(0, 3).map((advisory, advisoryIndex) => (
                  <p key={`${validation.attempt}-${advisoryIndex}`} className="mt-1 text-ink-secondary">{advisory}</p>
                ))}
                {message.kind === 'ok' && validation.sellingPointUsage && (
                  <p className="mt-1 text-ink-secondary">
                    卖点承接：{validation.sellingPointUsage.used} 用 /{' '}
                    {validation.sellingPointUsage.omittedNoVisualSupport} 画面不足略过 /{' '}
                    {validation.sellingPointUsage.omitted} 未用
                  </p>
                )}
              </div>
            );
          })}
        </div>
      )}

      {preview.title || preview.coverTitleParts || preview.segments.length > 0 ? (
        <div className="mb-3 rounded-[14px] border border-hairline bg-surface-subtle p-3">
          {preview.title && (
            <p className="text-sm font-medium text-ink">
              <TypewriterText value={preview.title} />
            </p>
          )}
          {(preview.coverTitleParts?.primary || preview.coverTitleParts?.secondary) && (
            <p className="mt-1 text-xs text-ink-secondary">{coverText}</p>
          )}
          {preview.segments.length > 0 && (
            <div className="mt-2 space-y-2">
              {preview.segments.map((segment, index) => (
                <div key={index} className="text-xs">
                  <div className="text-ink-secondary">
                    <span className="mr-1 text-ink-tertiary">{index + 1}.</span>
                    <TypewriterText value={segment.narration} />
                  </div>
                  {segment.subtitle && (
                    <div className="mt-0.5 text-ink-tertiary">
                      <TypewriterText value={segment.subtitle} />
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      ) : null}

      <div className="mt-3 flex items-center justify-end gap-4">
        <button
          type="button"
          onClick={onCancel}
          disabled={cancelling}
          className="btn-secondary btn-sm shrink-0 text-xs"
        >
          {cancelling ? '正在取消…' : '取消生成'}
        </button>
      </div>
    </div>
  );
}
