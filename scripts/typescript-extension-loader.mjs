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
      if (error?.code !== 'ERR_MODULE_NOT_FOUND' && error?.code !== 'ERR_UNSUPPORTED_DIR_IMPORT') throw error;
      if ((!candidate.startsWith('.') && !candidate.startsWith('file:')) || /\.[a-z0-9]+$/i.test(candidate)) continue;
      for (const suffix of ['.ts', '.tsx', '/index.ts', '/index.tsx']) {
        try { return await nextResolve(`${candidate}${suffix}`, context); }
        catch (candidateError) {
          if (candidateError?.code !== 'ERR_MODULE_NOT_FOUND' && candidateError?.code !== 'ERR_UNSUPPORTED_DIR_IMPORT') throw candidateError;
        }
      }
    }
  }
  throw originalError;
}
