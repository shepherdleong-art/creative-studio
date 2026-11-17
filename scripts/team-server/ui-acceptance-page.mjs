// A previous screen can still have pending React navigation or media requests.
// Give every measurement its own document and keep errors attached to that screen.
export async function withUiAcceptancePage(context, onPageError, measure) {
  const page = await context.newPage();
  page.on('pageerror', onPageError);
  try { return await measure(page); }
  finally { await page.close(); }
}

export function applyKnownFailure(row, screen) {
  if (row.result !== 'failed' || !screen.knownFailure || row.error) return row;
  const allowed = screen.knownFailureChecks ?? screen.checks;
  const failing = Object.values(row.outcomes).flatMap(outcomes =>
    Object.entries(outcomes).filter(([, outcome]) => !outcome.passed).map(([key]) => key));
  if (!failing.length || failing.some(key => !allowed.includes(key))) return row;
  return { ...row, result: 'known-failure', knownFailure: screen.knownFailure, knownFailureReason: screen.knownFailureReason };
}
