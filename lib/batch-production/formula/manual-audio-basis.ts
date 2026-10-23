import type Database from 'better-sqlite3';
import { readFormulaOutputBasis, type FormulaOutputAudioSource } from './output-audio.ts';
import { manualMediaForClip, type FormulaManualMediaProof, type FormulaReplacedSpeechRange } from './manual-media.ts';

type Range = { inUs: number; outUs: number };
function merge(ranges: Range[]): Range[] {
  const result: Range[] = [];
  for (const range of ranges.sort((a, b) => a.inUs - b.inUs)) {
    const tail = result.at(-1);
    if (tail && range.inUs <= tail.outUs) tail.outUs = Math.max(tail.outUs, range.outUs);
    else result.push({ ...range });
  }
  return result;
}

/** Derive active sound from immutable manual proofs; never rewrite the generation basis. */
export function effectiveFormulaOutputBasis(db: Database.Database, projectId: string, outputVersionId: string,
  arrangement: Record<string, unknown>, clips = arrangement.clips as Array<Record<string, unknown>>) {
  const basis = readFormulaOutputBasis(arrangement.formula);
  if (!basis) return undefined;
  const proofs = new Map<string, FormulaManualMediaProof>();
  for (const clip of clips ?? []) {
    const proof = manualMediaForClip(db, projectId, outputVersionId, clip);
    if (proof) proofs.set(proof.id, proof);
  }
  const sources: FormulaOutputAudioSource[] = [...basis.audioSources];
  const replaced = new Map<string, Range[]>();
  const narrationCoverage = new Map<string, { proof: FormulaReplacedSpeechRange; ranges: Range[] }>();
  const replacedNarration: Array<{ clipId: string; mediaId: string; inUs: number; outUs: number }> = [];
  for (const proof of proofs.values()) {
    if (proof.sound !== 'source') continue;
    sources.push({ mediaId: proof.id, manualMediaId: proof.id, kind: 'source', slotId: proof.id,
      assetId: proof.candidate.assetId, contentFingerprint: proof.candidate.contentFingerprint,
      sourceDurationUs: proof.candidate.media.durationUs, verifiedInUs: proof.inUs, verifiedOutUs: proof.outUs,
      words: proof.segments.map((segment, i) => ({ id: `${proof.id}:word:${i}`, text: segment.text,
        sourceInUs: segment.startUs, sourceOutUs: segment.endUs })) });
    for (const old of proof.replaces) for (const clip of clips.filter(clip => clip.formulaSourceId === proof.id)) {
      const start = Math.max(Number(clip.sourceStartUs), old.replacementInUs);
      const end = Math.min(Number(clip.sourceEndUs), old.replacementOutUs);
      if (end <= start) continue;
      if (old.narration) {
        const coverage = narrationCoverage.get(old.narration.coverageId) ?? { proof: old, ranges: [] };
        coverage.ranges.push({ inUs: old.narration.partInUs + start - old.replacementInUs,
          outUs: old.narration.partInUs + end - old.replacementInUs });
        narrationCoverage.set(old.narration.coverageId, coverage);
        continue;
      }
      const list = replaced.get(old.mediaId) ?? [];
      list.push({ inUs: old.inUs + start - old.replacementInUs, outUs: old.inUs + end - old.replacementInUs });
      replaced.set(old.mediaId, list);
    }
  }
  for (const { proof, ranges } of narrationCoverage.values()) {
    const narration = proof.narration!;
    if (!merge(ranges).some(range => range.inUs <= narration.requiredInUs && range.outUs >= narration.requiredOutUs)) continue;
    const list = replaced.get(proof.mediaId) ?? [];
    list.push({ inUs: proof.inUs, outUs: proof.outUs }); replaced.set(proof.mediaId, list);
    replacedNarration.push({ clipId: narration.clipId, mediaId: proof.mediaId, inUs: proof.inUs, outUs: proof.outUs });
  }
  return { ...basis, replacedNarration, audioSources: sources.map(source => {
    const ranges = merge(replaced.get(source.mediaId) ?? []);
    const first = source.words[0], last = source.words.at(-1);
    if (!ranges.length || !first || !last) return source;
    const requiredRanges: Range[] = [];
    let start = first.sourceInUs;
    for (const range of ranges) {
      if (range.inUs > start) requiredRanges.push({ inUs: start, outUs: Math.min(range.inUs, last.sourceOutUs) });
      start = Math.max(start, range.outUs);
      if (start >= last.sourceOutUs) break;
    }
    if (start < last.sourceOutUs) requiredRanges.push({ inUs: start, outUs: last.sourceOutUs });
    return { ...source, requiredRanges: requiredRanges.filter(range => range.outUs > range.inUs),
      words: source.words.filter(word => !ranges.some(range => range.inUs <= word.sourceInUs && range.outUs >= word.sourceOutUs)) };
  }) };
}
