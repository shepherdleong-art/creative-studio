import path from 'node:path';
import fs from 'node:fs';
import { projectFile, sha256 } from './files.ts';
import { readProjectJson } from './from-project.ts';
import { requireInput } from './errors.ts';
import { array, identifier, object, string } from './validation.ts';

export const OPENING_EFFECTS = ['carton-explosion', 'bare-shell-renovation', 'giant-hand-place', 'magic-growth'] as const;
export interface OpeningGateResult {
  variant: string;
  openingEffectId: string;
  openingSha256: string;
  legacyReviewWithoutHash: boolean;
}

/** Delivery evidence only. Technical rendering neither reads nor writes visual approvals. */
export function gateOpening(projectRoot: string, variant: string): OpeningGateResult {
  identifier(variant, 'variant');
  const root = fs.realpathSync(projectRoot);
  const variantDir = `variants/${variant}`;
  const t = object(readProjectJson(root, `${variantDir}/timeline.json`), 'timeline');
  requireInput(t.variant === variant && OPENING_EFFECTS.some(effect => effect === t.openingEffectId),
    'OPENING_EFFECT_INVALID', '必须选择四种指定开头效果之一，且型号条目一致');
  const shots = array(t.shots, 'timeline.shots');
  const first = object(shots[0], 'first shot');
  const id = identifier(first.id, 'first shot.id');
  const source = string(first.file, 'first shot.file');
  const file = projectFile(root, path.resolve(root, variantDir, source));
  const reviews = object(readProjectJson(root, 'review/opening-effects.json'), 'opening reviews');
  const item = array(reviews.variants, 'reviews.variants').map(v => object(v, 'review'))
    .find(v => v.variant === variant);
  requireInput(item && item.effectId === t.openingEffectId && item.shot === id &&
    item.sourceFile === source && item.status === 'visual_approved',
    'OPENING_NOT_APPROVED', 'Opening choice, clip and visual approval must match');
  const digest = sha256(file);
  requireInput(!item.sha256 || item.sha256 === digest, 'OPENING_FILE_CHANGED', 'Reviewed opening file changed');
  return { variant, openingEffectId: t.openingEffectId as string, openingSha256: digest, legacyReviewWithoutHash: !item.sha256 };
}
