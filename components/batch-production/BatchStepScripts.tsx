'use client';

import type { BatchPreparationResult } from '@/lib/batch-production/prepare';
import type { BatchSnapshotDetail } from '@/lib/batch-production/batch-flow';
import { BatchFrozenScriptCard, BatchScriptSelectionCard } from './BatchInputSelectionCards';

export interface BatchStepScriptsProps {
  prep: BatchPreparationResult;
  selectedScripts: Record<string, number>;
  onToggleScript: (scriptId: string, selected: boolean) => void;
  onCopyCountChange: (scriptId: string, copyCount: number) => void;
  plannedCount: number;
  outputPreset: OutputPresetLabel;
  frozen: boolean;
  frozenScriptSnapshots: BatchSnapshotDetail['scriptSnapshots'];
  busy: 'create' | 'snapshot' | 'start' | null;
  outputPlans: Array<{ id: string; seq: number }>;
  batchStatus: string;
  ttsConfigured: boolean;
  onConfirmSnapshot: () => void;
  onStartBatch: () => void;
  inputChangedWarning: boolean;
}

export interface OutputPresetLabel {
  id: string;
  label: string;
}

const BATCH_STATUS_LABELS: Record<string, string> = {
  draft: '待确认',
  running: '生产中',
  partially_completed: '部分完成',
  completed: '已完成',
  failed: '失败',
};

/**
 * 第 2 步 · 脚本与口播:每份脚本一张创作卡(勾选/份数/只读时长),
 * 下方输出设置卡(画幅只读展示、BGM 整批参数说明)与「确认整体输入 → 开始批量生产」。
 */
export default function BatchStepScripts(props: BatchStepScriptsProps) {
  const {
    prep,
    selectedScripts,
    onToggleScript,
    onCopyCountChange,
    plannedCount,
    outputPreset,
    frozen,
    frozenScriptSnapshots,
    busy,
    outputPlans,
    batchStatus,
    ttsConfigured,
    onConfirmSnapshot,
    onStartBatch,
    inputChangedWarning,
  } = props;

  const scriptCount = Object.keys(selectedScripts).length;
  const onlineAssets = prep.assets.filter(({ status }) => status === 'online').length;

  const startDisabledReason = !scriptCount
    ? '请先勾选至少一份脚本'
    : outputPlans.length === 0
      ? '请先确认整体输入'
      : batchStatus !== 'draft'
        ? '批次已开始生产'
        : !ttsConfigured
          ? '尚未配置口播配音供应商，请在设置中配置'
          : undefined;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 p-2">
      {frozen && (
        <div className="card flex flex-wrap items-center justify-between gap-4 p-5">
          <div>
            <h3 className="font-semibold text-ink">已锁定的脚本与口播</h3>
            <p className="mt-1 text-sm text-ink-secondary">
              以下正文、标题、份数与配音设置来自锁定快照，不随项目当前内容变化。时长按每份脚本自身设定，锁定后不可改。
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <span className={`rounded-full px-3 py-1 text-xs ${batchStatus === 'running' ? 'bg-accent/10 text-accent' : 'bg-surface-subtle text-ink-secondary'}`}>
              {BATCH_STATUS_LABELS[batchStatus] ?? batchStatus}
            </span>
          </div>
        </div>
      )}

      {!frozen && (
        <section aria-label="脚本与口播">
          <div className="mb-3 flex items-end justify-between gap-3">
            <div>
              <h3 className="font-semibold text-ink">脚本</h3>
              <p className="mt-1 text-sm text-ink-secondary">每份脚本是一个独立创作单元：各自份数出 N 条成片，共用同一条配音，只有画面不同。时长来自脚本自身设定，此处只读。</p>
            </div>
            <span className="text-sm text-ink-secondary">已选 {scriptCount} 份 · 目标成片 {plannedCount} 条</span>
          </div>
          {prep.scripts.length > 0 ? (
            <div className="grid gap-3 lg:grid-cols-2">
              {prep.scripts.map((script) => {
                const selected = selectedScripts[script.id] !== undefined;
                const durationSec = script.targetDurationSec ?? 15;
                return (
                  <div key={script.id} className="space-y-0">
                    <BatchScriptSelectionCard
                      script={script}
                      selected={selected}
                      copyCount={selectedScripts[script.id] ?? 1}
                      onSelectedChange={(next) => onToggleScript(script.id, next)}
                      onCopyCountChange={(copyCount) => onCopyCountChange(script.id, copyCount)}
                    />
                    <p className="mt-1 px-1 text-[11px] text-ink-tertiary">
                      目标时长 {durationSec} 秒{script.targetDurationSec === undefined || script.targetDurationSec == null ? '（默认 15 秒）' : ''}
                    </p>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="tile p-6 text-sm text-ink-secondary">暂无可用项目脚本，请先在第 3 步生成并保存脚本。</div>
          )}
        </section>
      )}

      {frozen && frozenScriptSnapshots.length > 0 && (
        <div className="grid gap-3 lg:grid-cols-2">
          {frozenScriptSnapshots.map((snapshot) => <BatchFrozenScriptCard key={snapshot.id} snapshot={snapshot} />)}
        </div>
      )}

      {!frozen && (
        <section className="card space-y-4 p-5" aria-label="输出设置与开始">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <h3 className="font-semibold text-ink">输出设置</h3>
              <p className="mt-1 text-sm text-ink-secondary">
                画幅 {outputPreset.label}（顶栏统一设置）；BGM 音量 -18dB、淡入 1.0s、淡出 1.5s（整批统一）。
                时长不提供修改 —— 脚本在第 3 步生成时已按档位约束字数。
              </p>
              {inputChangedWarning && (
                <p className="mt-1 text-xs text-warn">输入已修改，重新确认后才会覆盖当前批次版本。</p>
              )}
            </div>
            <div className="flex flex-wrap gap-2">
              <button type="button" className="btn-secondary" disabled={busy !== null} onClick={onConfirmSnapshot}>
                {busy === 'snapshot' ? '确认中…' : '确认整体输入'}
              </button>
              <button
                type="button"
                className="btn-primary"
                disabled={busy !== null || Boolean(startDisabledReason)}
                onClick={onStartBatch}
              >{busy === 'start' ? '启动中…' : '开始批量生产'}</button>
            </div>
          </div>
          {startDisabledReason && (
            <p className="text-xs text-warn">
              暂时无法开始：{startDisabledReason}
              {onlineAssets === 0 && '；当前项目没有在线素材。'}
            </p>
          )}
          {scriptCount > 0 && (
            <p className="text-xs text-ink-tertiary">
              确认信息：{scriptCount} 份脚本 × 各自份数 = {plannedCount} 条成片，{onlineAssets} 条在线素材，画幅 {outputPreset.label}。
              点击开始后本次设置即锁定，后续修改项目内容不影响本批次。
            </p>
          )}
        </section>
      )}
    </div>
  );
}
