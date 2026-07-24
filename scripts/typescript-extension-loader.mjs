export async function resolve(specifier, context, nextResolve) {
  const candidates = specifier.startsWith('@/')
    ? [new URL(`../${specifier.slice(2)}`, import.meta.url).href]
    : [specifier];
  let originalError;
  for (const candidate of candidates) {
    try {
      return await nextResolve(candidate, context);
    } catch (error) {
      originalError = error;
      if (error?.code !== 'ERR_MODULE_NOT_FOUND') throw error;
      if ((!candidate.startsWith('.') && !candidate.startsWith('file:')) || /\.[a-z0-9]+$/i.test(candidate)) continue;
      for (const extension of ['.ts', '.tsx']) {
        try { return await nextResolve(`${candidate}${extension}`, context); }
        catch (candidateError) {
          if (candidateError?.code !== 'ERR_MODULE_NOT_FOUND') throw candidateError;
        }
      }
    }
  }
  throw originalError;
}
