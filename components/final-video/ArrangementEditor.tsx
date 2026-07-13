'use client';

import { useMemo, useState } from 'react';
import ClipPicker, { type ReviewClip } from './ClipPicker';
import NarrationTimeline, { type ReviewBeat, type TimelineAssignment, type TimelineGap } from './NarrationTimeline';

export interface ReviewDraft {
  id: string;
  revision: number;
  narrationBeats: Array<ReviewBeat>;
  clipPool: Array<ReviewClip>;
  arrangement: { assignments: TimelineAssignment[]; gaps: TimelineGap[] };
}

function assignmentForBeat(draft: ReviewDraft, beatId: string) {
  return draft.arrangement.assignments.find((assignment) => assignment.beatIds.includes(beatId));
}

export default function ArrangementEditor(props: {
  draft: ReviewDraft;
  onDraft: (draft: ReviewDraft) => void;
  onConflict: (message: string) => void;
  onError: (message: string) => void;
  mode?: 'narration' | 'bgm-only';
  selectedClipIds?: string[];
  targetDurationSec?: number;
  onSelectedClipIds?: (clipIds: string[]) => Promise<void>;
}) {
  const {
    draft, onDraft, onConflict, onError,
    mode = 'narration', selectedClipIds = [], targetDurationSec = 0, onSelectedClipIds,
  } = props;
  const [editingBeatId, setEditingBeatId] = useState<string | null>(null);
  const [savingSelection, setSavingSelection] = useState(false);
  const orderedAssignments = useMemo(() => [...draft.arrangement.assignments].sort((left, right) => {
    const leftIndex = Math.min(...left.beatIds.map((beatId) => draft.narrationBeats.find((beat) => beat.beatId === beatId)?.index ?? Infinity));
    const rightIndex = Math.min(...right.beatIds.map((beatId) => draft.narrationBeats.find((beat) => beat.beatId === beatId)?.index ?? Infinity));
    return leftIndex - rightIndex;
  }), [draft]);

  const patchArrangement = async (arrangement: ReviewDraft['arrangement']) => {
    onError('');
    const response = await fetch(`/api/final-video-drafts/${draft.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ revision: draft.revision, arrangement }),
    });
    const data = await response.json().catch(() => ({}));
    if (response.status === 409) {
      const current = await fetch(`/api/final-video-drafts/${draft.id}`).then((result) => result.json()).catch(() => ({}));
      if (current.draft) onDraft(current.draft as ReviewDraft);
      onConflict('草稿已更新，请确认最新编排后重试。');
      return;
    }
    if (!response.ok) { onError(data.error || '更新编排失败'); return; }
    onDraft(data.draft as ReviewDraft);
    setEditingBeatId(null);
  };

  const chooseClip = async (clipId: string) => {
    if (!editingBeatId) return;
    const existing = assignmentForBeat(draft, editingBeatId);
    if (existing) {
      await patchArrangement({ ...draft.arrangement, assignments: draft.arrangement.assignments.map((assignment) => assignment.assignmentId === existing.assignmentId ? { ...assignment, clipId } : assignment) });
      return;
    }
    const beat = draft.narrationBeats.find((item) => item.beatId === editingBeatId);
    if (!beat) return;
    const next = { assignmentId: `manual-${beat.beatId}`, clipId, beatIds: [beat.beatId] };
    const assignments = [...draft.arrangement.assignments, next].sort((left, right) => {
      const first = (assignment: TimelineAssignment) => Math.min(...assignment.beatIds.map((beatId) => draft.narrationBeats.find((item) => item.beatId === beatId)?.index ?? Infinity));
      return first(left) - first(right);
    });
    await patchArrangement({ assignments, gaps: draft.arrangement.gaps.filter((gap) => gap.beatId !== editingBeatId) });
  };

  const swapWithNeighbor = async (assignmentId: string, direction: -1 | 1) => {
    const index = orderedAssignments.findIndex((assignment) => assignment.assignmentId === assignmentId);
    const neighbor = orderedAssignments[index + direction];
    if (!neighbor) return;
    // Keep beat ordering valid while reordering which clip is assigned to adjacent time slots.
    await patchArrangement({ ...draft.arrangement, assignments: draft.arrangement.assignments.map((assignment) => {
      if (assignment.assignmentId === assignmentId) return { ...assignment, clipId: neighbor.clipId };
      if (assignment.assignmentId === neighbor.assignmentId) return { ...assignment, clipId: orderedAssignments[index].clipId };
      return assignment;
    }) });
  };

  const editingAssignment = editingBeatId ? assignmentForBeat(draft, editingBeatId) : undefined;
  const unavailableClipIds = draft.arrangement.assignments.filter((assignment) => assignment.assignmentId !== editingAssignment?.assignmentId).map((assignment) => assignment.clipId);
  const saveSelectedClipIds = async (next: string[]) => {
    if (!onSelectedClipIds || savingSelection) return;
    setSavingSelection(true);
    try { await onSelectedClipIds(next); } finally { setSavingSelection(false); }
  };
  const toggleClip = (clipId: string) => {
    const next = selectedClipIds.includes(clipId)
      ? selectedClipIds.filter((id) => id !== clipId)
      : [...selectedClipIds, clipId];
    void saveSelectedClipIds(next);
  };
  const moveSelectedClip = (clipId: string, direction: -1 | 1) => {
    const index = selectedClipIds.indexOf(clipId);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= selectedClipIds.length) return;
    const next = [...selectedClipIds];
    [next[index], next[target]] = [next[target], next[index]];
    void saveSelectedClipIds(next);
  };

  if (mode === 'bgm-only') {
    return (
      <section className="space-y-3 rounded-lg border border-hairline p-4">
        <div><h3 className="text-sm font-medium">选择 BGM 画面</h3><p className="mt-1 text-xs text-ink-tertiary">目标时长 {targetDurationSec} 秒（含片头）。按下方选择顺序播放，每条正常画面最多 4 秒。</p></div>
        <div className="space-y-2">
          {draft.clipPool.map((clip) => {
            const index = selectedClipIds.indexOf(clip.clipId);
            const selected = index >= 0;
            return <div key={clip.clipId} className="flex flex-wrap items-center gap-2 rounded border border-hairline p-2 text-xs">
              <label className="flex min-w-0 flex-1 items-center gap-2"><input type="checkbox" checked={selected} disabled={savingSelection} onChange={() => toggleClip(clip.clipId)} /><span className="truncate">#{clip.shotIndex + 1} 视频画面</span></label>
              {selected && <><span className="text-ink-tertiary">第 {index + 1} 条</span><button type="button" disabled={savingSelection || index === 0} onClick={() => moveSelectedClip(clip.clipId, -1)} className="btn-secondary btn-sm">上移</button><button type="button" disabled={savingSelection || index === selectedClipIds.length - 1} onClick={() => moveSelectedClip(clip.clipId, 1)} className="btn-secondary btn-sm">下移</button></>}
            </div>;
          })}
        </div>
        {draft.clipPool.length === 0 && <p className="text-xs text-ink-tertiary">当前分镜组还没有成功生成的视频素材。</p>}
      </section>
    );
  }

  return (
    <section className="space-y-3 rounded-lg border border-hairline p-4">
      <div><h3 className="text-sm font-medium">审核编排</h3><p className="mt-1 text-xs text-ink-tertiary">每一句口播都是独立画面操作单位；红色项需要分配画面。</p></div>
      <NarrationTimeline beats={draft.narrationBeats} assignments={draft.arrangement.assignments} gaps={draft.arrangement.gaps} clips={draft.clipPool} />
      <div className="space-y-2">
        {[...draft.narrationBeats].sort((a, b) => a.index - b.index).map((beat) => {
          const assignment = assignmentForBeat(draft, beat.beatId);
          const gap = draft.arrangement.gaps.find((item) => item.beatId === beat.beatId);
          return <div key={beat.beatId} className="flex flex-wrap items-center gap-2 text-xs">
            <span className="min-w-0 flex-1 truncate">#{beat.index + 1} {assignment ? '已分配画面' : `视觉缺口：${gap?.reason || '未分配'}`}</span>
            <button type="button" onClick={() => setEditingBeatId(beat.beatId)} className="btn-secondary btn-sm">{assignment ? '换片' : '分配画面'}</button>
            {assignment && <><button type="button" onClick={() => void swapWithNeighbor(assignment.assignmentId, -1)} disabled={orderedAssignments[0]?.assignmentId === assignment.assignmentId} className="btn-secondary btn-sm">上移</button><button type="button" onClick={() => void swapWithNeighbor(assignment.assignmentId, 1)} disabled={orderedAssignments.at(-1)?.assignmentId === assignment.assignmentId} className="btn-secondary btn-sm">下移</button></>}
          </div>;
        })}
      </div>
      {editingBeatId && <div className="rounded border border-hairline p-3"><p className="mb-2 text-xs">选择替换画面素材</p><ClipPicker clips={draft.clipPool} selectedClipId={editingAssignment?.clipId ?? null} unavailableClipIds={unavailableClipIds} onSelect={(clipId) => void chooseClip(clipId)} /></div>}
    </section>
  );
}
