'use client';

export interface ReviewBeat { beatId: string; index: number; text: string; durationSec: number }
export interface TimelineAssignment { assignmentId: string; clipId: string; beatIds: string[] }
export interface TimelineGap { beatId: string; reason: string }
export interface TimelineClip { clipId: string; shotIndex: number; visualDescription: string; sourceImagePath: string }

function thumbnailUrl(sourceImagePath: string): string {
  const marker = '/storage/';
  const index = sourceImagePath.lastIndexOf(marker);
  return index >= 0 ? `/api/images/${sourceImagePath.slice(index + marker.length).split('/').map(encodeURIComponent).join('/')}` : '';
}

export default function NarrationTimeline({ beats, assignments, gaps, clips }: {
  beats: ReviewBeat[];
  assignments: TimelineAssignment[];
  gaps: TimelineGap[];
  clips: TimelineClip[];
}) {
  const assignmentByBeat = new Map(assignments.flatMap((assignment) => assignment.beatIds.map((beatId) => [beatId, assignment] as const)));
  const gapByBeat = new Map(gaps.map((gap) => [gap.beatId, gap]));
  const clipById = new Map(clips.map((clip) => [clip.clipId, clip]));
  return (
    <div className="space-y-2">
      {[...beats].sort((a, b) => a.index - b.index).map((beat) => {
        const assignment = assignmentByBeat.get(beat.beatId);
        const gap = gapByBeat.get(beat.beatId);
        const clip = assignment ? clipById.get(assignment.clipId) : undefined;
        const thumbnail = clip ? thumbnailUrl(clip.sourceImagePath) : '';
        return (
          <div key={beat.beatId} className={`rounded border p-2 text-xs ${gap ? 'border-red-500 bg-red-50 text-red-700' : 'border-hairline'}`}>
            <div className="flex items-start justify-between gap-3"><span className="text-ink-secondary">{beat.text}</span><span className="shrink-0 text-ink-tertiary">{beat.durationSec.toFixed(1)}s</span></div>
            {gap ? <p className="mt-1 font-medium">视觉缺口：{gap.reason}</p> : <div className="mt-1 flex items-center gap-2 text-ink-tertiary">{thumbnail && <>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={thumbnail} alt={`画面 #${(clip?.shotIndex ?? -1) + 1}`} className="h-10 w-16 rounded object-cover" />
              <p>画面 #{(clip?.shotIndex ?? -1) + 1} · {clip?.visualDescription || '尚未描述'}</p>
            </>}{!thumbnail && <p>画面 #{(clip?.shotIndex ?? -1) + 1} · {clip?.visualDescription || '尚未描述'}</p>}</div>}
          </div>
        );
      })}
    </div>
  );
}
