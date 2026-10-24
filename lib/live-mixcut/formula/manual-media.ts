import type Database from 'better-sqlite3';
import { BatchDomainError } from '../errors.ts';
import type { FormulaVerifiedCandidate } from './candidate-media.ts';
import type { FormulaRangeBounds } from './range-contract.ts';
import type { FormulaManualSpeechSegment } from './manual-speech.ts';

interface FormulaManualMediaBase {
  id: string; candidate: FormulaVerifiedCandidate;
  inUs: number; outUs: number; protected: FormulaRangeBounds | null;
  origin: 'manual';
}
export interface FormulaReplacedSpeechRange {
  mediaId: string; inUs: number; outUs: number; replacementInUs: number; replacementOutUs: number;
  /** Whole narration is covered by all surviving parts of this confirmed source speech. */
  narration?: { clipId: string; text: string; coverageId: string; requiredInUs: number; requiredOutUs: number; partInUs: number };
}
export type FormulaManualMediaProof = FormulaManualMediaBase & ({ version: 1; sound: 'mute' }
  | { version: 2 | 3; sound: 'source'; segments: FormulaManualSpeechSegment[]; speechConfirmed: true;
      previousText: string; replaces: FormulaReplacedSpeechRange[] });
export function readFormulaManualMedia(db: Database.Database, projectId: string, outputVersionId: string, id: string): FormulaManualMediaProof {
  const row = db.prepare('SELECT proofJson FROM live_mixcut_formula_manual_media WHERE id=? AND projectId=? AND outputVersionId=?')
    .get(id, projectId, outputVersionId) as { proofJson: string } | undefined;
  if (!row) throw new BatchDomainError('conflict', '人工素材核验记录不属于这份成片');
  return JSON.parse(row.proofJson) as FormulaManualMediaProof;
}

export function manualMediaForClip(db: Database.Database, projectId: string, outputVersionId: string, clip: Record<string, unknown>) {
  if (clip.formulaSourceId === undefined) return null;
  if (typeof clip.formulaSourceId !== 'string') throw new BatchDomainError('conflict', '人工素材核验身份无效');
  const proof = readFormulaManualMedia(db, projectId, outputVersionId, clip.formulaSourceId);
  if (![1, 2, 3].includes(proof.version) || proof.candidate.assetId !== clip.assetId || proof.candidate.contentFingerprint !== clip.contentFingerprint
    || Number(clip.sourceStartUs) < proof.inUs || Number(clip.sourceEndUs) > proof.outUs) {
    throw new BatchDomainError('conflict', '人工素材或取用区间与核验记录不一致，请重新核验');
  }
  return proof;
}

/** Protected action may cross a continuous split, but must remain complete and in order. */
export function assertManualMediaProtection(proof: FormulaManualMediaProof, clips: Array<Record<string, unknown>>) {
  if (!proof.protected) return;
  const pieces = clips.filter(clip => clip.formulaSourceId === proof.id)
    .sort((a, b) => Number(a.timelineStartUs) - Number(b.timelineStartUs));
  let covered = proof.protected.inUs;
  let lastTimelineEnd: number | undefined;
  for (const clip of pieces) {
    const start = Math.max(Number(clip.sourceStartUs), proof.protected.inUs);
    const end = Math.min(Number(clip.sourceEndUs), proof.protected.outUs);
    if (end <= start) continue;
    if (start > covered || start < covered - 1 || (lastTimelineEnd !== undefined && Math.abs(Number(clip.timelineStartUs) - lastTimelineEnd) > 1)) break;
    covered = end; lastTimelineEnd = Number(clip.timelineEndUs);
  }
  if (covered < proof.protected.outUs) throw new BatchDomainError('conflict', '人工换片截断或打散了已确认的保护动作，请恢复完整动作');
}
