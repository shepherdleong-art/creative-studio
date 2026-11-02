export function GET(): Response {
  return Response.json(
    { live: true },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
