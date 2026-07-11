'use client';

export interface ReviewClip {
  clipId: string;
  shotIndex: number;
  sourceImagePath: string;
  visualDescription: string;
}

function imageUrl(sourceImagePath: string): string {
  const marker = '/storage/';
  const index = sourceImagePath.lastIndexOf(marker);
  return index >= 0 ? `/api/images/${sourceImagePath.slice(index + marker.length).split('/').map(encodeURIComponent).join('/')}` : '';
}

export default function ClipPicker({ clips, selectedClipId, unavailableClipIds, onSelect }: {
  clips: ReviewClip[];
  selectedClipId: string | null;
  unavailableClipIds: string[];
  onSelect: (clipId: string) => void;
}) {
  const unavailable = new Set(unavailableClipIds);
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
      {clips.map((clip) => {
        const selected = clip.clipId === selectedClipId;
        const disabled = unavailable.has(clip.clipId) && !selected;
        const thumbnail = imageUrl(clip.sourceImagePath);
        return (
          <button
            key={clip.clipId}
            type="button"
            disabled={disabled}
            onClick={() => onSelect(clip.clipId)}
            className={`overflow-hidden rounded border p-1 text-left text-xs ${selected ? 'border-accent ring-1 ring-accent' : 'border-hairline'} ${disabled ? 'cursor-not-allowed opacity-40' : ''}`}
          >
            {thumbnail ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={thumbnail} alt={`画面素材 ${clip.shotIndex + 1}`} className="aspect-video w-full rounded object-cover" />
            ) : <div className="flex aspect-video items-center justify-center rounded bg-surface-subtle text-ink-tertiary">画面素材</div>}
            <p className="mt-1 line-clamp-2">#{clip.shotIndex + 1} {clip.visualDescription || '尚未生成画面描述'}</p>
          </button>
        );
      })}
    </div>
  );
}
