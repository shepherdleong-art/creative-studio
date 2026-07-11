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

export default function ArrangementEditor({ draft, onDraft, onConflict, onError }: {
  draft: ReviewDraft;
  onDraft: (draft: ReviewDraft) => void;
  onConflict: (message: string) => void;
  onError: (message: string) => void;
}) {
  const [editingBeatId, setEditingBeatId] = useState<string | null>(null);
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
