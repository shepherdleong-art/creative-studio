import type { RenderSpec } from '../../film-render/types.ts';
import type { VideoTimeline, ExportTargetView } from '../types.ts';

export interface FilmCandidate {
  id: string; file: string; sourceImage: string; generatedImage: string;
  providerId: string; model: string; prompt: string; providerTaskId?: string | null;
  provenance: { imageProvider: string; imageModel: string; imagePrompt: string; imageTaskId?: string | null };
  approvedRangeSec: [number, number];
}
export interface FilmImportManifest {
  schemaVersion: 1; importKey: string; projectId: string; root: string;
  title: string; sceneImage: string; sceneProvenance: Record<string, string | null>;
  specFile: string; renderManifestFile: string;
  files: Record<string, string>;
  shots: Array<{ id: string; selectedCandidateId: string; candidates: FilmCandidate[] }>;
  delivery: { directory: string; baseName: string };
}
export interface RegisteredCandidate {
  videoJobId: string; shotId: string; clipId: string; file: string;
  fingerprint: string; durationSec: number; approvedRangeSec: [number, number];
}
export interface FilmBinding {
  id: string; importKey: string; importHash: string; projectId: string; shotSetId: string;
  groupId: string; variantId: string; specJson: string; candidatesJson: string; manifestJson: string;
  inputHashesJson: string; managedRootRelative: string; deliveryDir: string; baseName: string;
  deliveryVersion: number; deliveredRevision: number; previewRevision: number;
  reviewToken: string; createdAt: string;
}
export interface FilmRenderSnapshot {
  renderer: 'reassembled-film/1'; bindingId: string; mode: 'preview' | 'deliver';
  groupRevision: number; variantRevision: number; variant: { id: string; timeline: VideoTimeline };
  spec: RenderSpec; inputHashes: Record<string, string>; templateHashes: unknown;
  deliveryVersion: number | null;
  exportIdentity: { taskName: string; productCode: string; taskDate: string };
  exportTarget: ExportTargetView;
}
export interface ReassembledFilmView {
  id: string; baseName: string; template: string; deliveryDirectory: string; deliveryVersion: number;
  deliveredRevision: number; previewRevision: number;
  reviewUrl: string; candidates: Array<{ videoJobId: string; clipId: string; approvedRangeSec: [number, number] }>;
}
