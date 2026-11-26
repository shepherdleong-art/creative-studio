import { cleanFraming } from '../media-core/cover-title-presets.ts';
import type { CoverFraming } from '../media-core/cover-types.ts';

type FrameCover = { frame: number; shotId?: string; framing?: CoverFraming };

export type FilmCoverMedia =
  | (FrameCover & { kind: 'auto_frame'; sourceSignature: string; fallback?: boolean })
  | (FrameCover & { kind: 'video_frame' })
  | { kind: 'project_image'; assetId: string; framing?: CoverFraming }
  | { kind: 'generated_image'; assetId: string; framing?: CoverFraming };

function identifier(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= 160 && value.trim() === value ? value : undefined;
}

export function parseFilmCoverMedia(value: unknown): FilmCoverMedia | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const framing = raw.framing === undefined ? {} : { framing: cleanFraming(raw.framing) };
  if (raw.kind === 'project_image' || raw.kind === 'generated_image') {
    const assetId = identifier(raw.assetId);
    return assetId ? { kind: raw.kind, assetId, ...framing } : undefined;
  }
  if (raw.kind !== 'video_frame' && raw.kind !== 'auto_frame') return undefined;
  if (typeof raw.frame !== 'number' || !Number.isSafeInteger(raw.frame)) return undefined;
  const shotId = identifier(raw.shotId);
  const frame = { frame: Math.max(0, raw.frame), ...(shotId ? { shotId } : {}), ...framing };
  if (raw.kind === 'video_frame') return { kind: raw.kind, ...frame };
  const sourceSignature = identifier(raw.sourceSignature);
  return sourceSignature ? { kind: raw.kind, ...frame, sourceSignature, ...(raw.fallback === true ? { fallback: true } : {}) } : undefined;
}

export function resolveFilmCoverMedia(media: FilmCoverMedia | undefined, body: { frames: number; signature: string }): FilmCoverMedia {
  if (!media || (media.kind === 'auto_frame' && (media.sourceSignature !== body.signature || media.fallback))) {
    return { kind: 'auto_frame', frame: 0, sourceSignature: body.signature, fallback: true, ...(media?.framing && { framing: media.framing }) };
  }
  if (media.kind === 'auto_frame' || media.kind === 'video_frame') {
    return { ...media, frame: Math.min(media.frame, Math.max(0, body.frames - 1)) };
  }
  return media;
}
