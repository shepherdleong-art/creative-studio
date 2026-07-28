import type {
  AnalysisResult,
  ScriptStrategyAnalysisV3,
  SelectedSellingPoint,
} from './script-providers/types';

type StrategyAnalysis = AnalysisResult | ScriptStrategyAnalysisV3;
type StrategyRanking = StrategyAnalysis['rankings'][number];

export function getSellingPointSelectionKey(
  ranking: Pick<StrategyRanking, 'title'> & { sellingPointId?: string },
): string {
  return ranking.sellingPointId?.trim() || ranking.title.trim();
}

export function getDefaultSelectedSellingPointKeys(
  analysis: { rankings?: Array<{ rank?: number; title?: string; sellingPointId?: string }> },
): string[] {
  return [...(analysis.rankings || [])]
    .sort((left, right) => (left.rank ?? Number.MAX_SAFE_INTEGER) - (right.rank ?? Number.MAX_SAFE_INTEGER))
    .map((ranking) => getSellingPointSelectionKey({
      title: ranking.title?.trim() || '',
      sellingPointId: ranking.sellingPointId,
    }))
    .filter((key, index, keys) => Boolean(key) && keys.indexOf(key) === index)
    .slice(0, 3);
}

export function resolveSelectedSellingPoints(
  analysis: StrategyAnalysis | null,
  selectedKeys: string[],
): SelectedSellingPoint[] {
  if (!analysis) return [];

  const resolved = selectedKeys.flatMap((key) => {
    const ranking = analysis.rankings.find((candidate) => (
      getSellingPointSelectionKey(candidate) === key || candidate.title === key
    ));
    if (!ranking) return [];
    return [{
      ...('sellingPointId' in ranking ? { sellingPointId: ranking.sellingPointId } : {}),
      title: ranking.title,
      priority: ranking.priority,
      reason: ranking.reason,
    }];
  });

  return resolved.filter((point, index) => {
    const key = point.sellingPointId || point.title;
    return resolved.findIndex((candidate) => (candidate.sellingPointId || candidate.title) === key) === index;
  });
}

export function getScriptStrategyAnalysisV3ValidationIssues(value: unknown): string[] {
  const issues: string[] = [];
  if (!value || typeof value !== 'object') return ['analysis_object_required'];
  const analysis = value as Record<string, unknown>;
  if (analysis.version !== 3) issues.push('version_invalid');
  if (typeof analysis.audienceInsight !== 'string' || !analysis.audienceInsight.trim()) {
    issues.push('audienceInsight_required');
  }
  if (typeof analysis.platformAdvice !== 'string' || !analysis.platformAdvice.trim()) {
    issues.push('platformAdvice_required');
  }
  if (analysis.recommendationSource !== 'model') issues.push('recommendationSource_invalid');
  const recommendation = analysis.recommendedTemplate;
  if (!recommendation || typeof recommendation !== 'object') {
    issues.push('recommendedTemplate_required');
  } else {
    const recommendationRecord = recommendation as Record<string, unknown>;
    ['id', 'name', 'reason'].forEach((key) => {
      if (typeof recommendationRecord[key] !== 'string' || !(recommendationRecord[key] as string).trim()) {
        issues.push(`recommendedTemplate_${key}_required`);
      }
    });
  }
  if (!Array.isArray(analysis.rankings) || analysis.rankings.length === 0) {
    issues.push('rankings_required');
    return issues;
  }
  const rankings = analysis.rankings;
  const seenIds = new Set<string>();
  const seenRanks = new Set<number>();
  rankings.forEach((value, index) => {
    if (!value || typeof value !== 'object') {
      issues.push(`ranking_object_required:${index}`);
      return;
    }
    const ranking = value as Record<string, unknown>;
    const sellingPointId = typeof ranking.sellingPointId === 'string' ? ranking.sellingPointId.trim() : '';
    const rank = Number(ranking.rank);
    const factors = ranking.factors;
    if (!sellingPointId) issues.push(`sellingPointId_required:${index}`);
    else if (seenIds.has(sellingPointId)) issues.push(`sellingPointId_duplicate:${sellingPointId}`);
    if (!Number.isInteger(rank) || rank < 1 || rank > rankings.length) {
      issues.push(`rank_invalid:${sellingPointId || index}`);
    } else if (seenRanks.has(rank)) {
      issues.push(`rank_duplicate:${rank}`);
    }
    if (typeof ranking.title !== 'string' || !ranking.title.trim()) {
      issues.push(`ranking_title_required:${sellingPointId || index}`);
    }
    if (typeof ranking.reason !== 'string' || !ranking.reason.trim()) {
      issues.push(`ranking_reason_required:${sellingPointId || index}`);
    }
    if (!factors || typeof factors !== 'object') {
      issues.push(`ranking_factors_required:${sellingPointId || index}`);
    } else {
      const factorRecord = factors as Record<string, unknown>;
      ['audienceFit', 'platformFit', 'sellingPointStrength'].forEach((key) => {
        const score = Number(factorRecord[key]);
        if (!Number.isInteger(score) || score < 1 || score > 5) {
          issues.push(`ranking_factor_invalid:${sellingPointId || index}:${key}`);
        }
      });
    }
    if (sellingPointId) seenIds.add(sellingPointId);
    if (Number.isInteger(rank) && rank >= 1 && rank <= rankings.length) seenRanks.add(rank);
  });
  return issues;
}

export function isCompleteScriptStrategyAnalysisV3(value: unknown): boolean {
  return getScriptStrategyAnalysisV3ValidationIssues(value).length === 0;
}
