/** Keep the serialized body and its generated headers on the same Request. */
export function withTeamCsrf(request: Request, token: string): Request {
  const headers = new Headers(request.headers);
  if (!headers.has('x-csrf-token')) headers.set('x-csrf-token', token);
  return new Request(request, { headers, credentials: request.credentials });
}
