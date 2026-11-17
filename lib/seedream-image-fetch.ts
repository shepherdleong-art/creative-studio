import { Agent } from 'undici';

let dispatcher: Agent | undefined;

/**
 * Seedream waits synchronously for its image. Node's default five-minute
 * headers/body limits can expire before the caller's ten-minute deadline.
 * Only these requests use this dispatcher; their bounded signal owns timeout
 * and shutdown, including while the response body is being read.
 */
export function fetchSeedreamImage(
  url: string,
  init: RequestInit & { signal: AbortSignal },
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  dispatcher ??= new Agent({ headersTimeout: 0, bodyTimeout: 0 });
  const options: RequestInit & { dispatcher: Agent } = { ...init, dispatcher };
  return fetchImpl(url, options);
}
