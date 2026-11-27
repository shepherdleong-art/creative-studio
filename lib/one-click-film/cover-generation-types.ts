import type { OneClickFilmTemplateId } from './packaging-constants.ts';

export const MAX_FILM_COVER_REFERENCES = 6;
export const MAX_FILM_COVER_PREFERENCE_LENGTH = 200;

export const FILM_COVER_TITLE_CLEARANCE: Record<OneClickFilmTemplateId, string> = {
  'overlay-poster': '顶部 30% 留白，尤其保持左上主标题和右上副标题区域背景干净。',
  'overlay-journal': '顶部 28% 留白，为左上和中上手账标题保留干净的背景。',
  'overlay-minimal': '顶部约 30% 留白，左上主副标题区域保持平整且低对比。',
  'overlay-variety': '顶部 36% 留白，为综艺模板的顶部横条和两行标题保留干净的背景。',
};

export interface FilmCoverGenerationConfig {
  enabled: boolean;
  reason?: string;
  maxReferences: number;
  channels: { id: string; name: string; model: string }[];
}

export interface FilmCoverCandidate {
  id: string;
  entryCode: string;
  status: 'queued' | 'running' | 'ready' | 'failed';
  channel: string;
  message: string | null;
  submissionUnconfirmed?: boolean;
  createdAt: string;
  imageUrl?: string;
  thumbnailUrl?: string;
}
