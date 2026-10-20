import type { FilmCandidate } from './types.ts';
import type { ProductionIdentityFields } from '../../project-production-identity.ts';

export interface ProductionBegin {
  requestId: string;
  root: string;
  projectId?: string;
  project?: ProductionIdentityFields & { providerId: string; model: string; scenePrompt?: string; shotPrompt?: string };
  films: Array<{ key: string; importKey: string; title: string; clips: string[] }>;
}
/** Read-only skill ledger. Only succeeded image/video results enter core tables. */
export interface ProductionTask {
  id: string;
  kind: 'scene' | 'shot' | 'video' | 'script';
  clipId?: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  providerId: string;
  model: string;
  prompt: string;
  inputFiles: string[];
  remoteTaskId?: string | null;
  outputFile?: string;
}
export interface ProductionSnapshot {
  files: Record<string, string>;
  tasks: ProductionTask[];
  sceneImage?: string;
  shots: Array<{ id: string; sourceImage: string; generatedImage?: string; selectedCandidateId?: string; candidates: FilmCandidate[] }>;
  script?: { taskId: string; narration: string };
}
export interface ProductionSync { requestId: string; expectedRevision: number; snapshot: ProductionSnapshot }
export interface ProductionRegistry {
  files: Record<string, string>;
  images: Record<string, { id: string; width: number; height: number; mime: string }>;
  jobs: Record<string, string>;
  videos: Record<string, { id: string; durationSec: number }>;
  sceneId: string | null;
}
export interface ProductionItem {
  id: string; productionId: string; filmKey: string; importKey: string; title: string;
  shotSetId: string; groupId: string; variantId: string; draftId: string;
  shotIdsJson: string; revision: number; snapshotJson: string; registryJson: string; baselineJson: string;
  bindingId: string | null; updatedAt: string;
}
export interface ProductionView {
  id: string; projectId: string; root: string;
  films: Array<{ id: string; key: string; importKey: string; title: string; shotSetId: string; groupId: string; variantId: string; revision: number; bindingId: string | null; conflict: boolean; snapshot: ProductionSnapshot; images: Record<string, string>; videos: Record<string, string> }>;
}
