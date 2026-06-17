export const DEFAULT_VIDEO_DOWNLOAD_TIMEOUT_MS = 60_000;

export async function downloadVideo(
  url: string,
  timeoutMs = DEFAULT_VIDEO_DOWNLOAD_TIMEOUT_MS
): Promise<Buffer | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
