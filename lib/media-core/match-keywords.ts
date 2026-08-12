const MAX_KEYWORDS = 24;

function normalizeKeyword(value: string): string {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/^[\p{P}\p{S}\s]+|[\p{P}\p{S}\s]+$/gu, '')
    .trim();
}

/**
 * Deterministic fallback when no LLM-authored visual keywords are available.
 * Keep natural punctuation-delimited phrases instead of generating Chinese
 * sliding bigrams, so both the matcher and the semantic prompt receive useful
 * concepts from the whole sentence.
 */
export function extractMatchKeywords(value: string): string[] {
  const chunks = value
    .normalize('NFKC')
    .split(/[，,、。！？!?；;：:\n]+/u)
    .map(normalizeKeyword)
    .filter((keyword) => Array.from(keyword).length >= 2);
  return [...new Set(chunks)].slice(0, MAX_KEYWORDS);
}
