import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { getVideoAdapter } from '@/lib/video-providers/index';
import { writeLog } from '@/lib/logger';
import fs from 'fs';
import path from 'path';

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const db = getDb();

    const job = db.prepare(`SELECT * FROM video_jobs WHERE id = ?`).get(id) as {
      id: string;
      projectId: string;
      providerId: string;
      providerTaskId: string | null;
      status: string;
    } | undefined;

    if (!job) return NextResponse.json({ error: 'Video job not found' }, { status: 404 });

    if (!job.providerTaskId) {
      return NextResponse.json({ error: 'No provider task ID to resume polling' }, { status: 400 });
    }

    // Load provider
    const provider = db.prepare(`SELECT * FROM video_providers WHERE id = ?`).get(job.providerId) as {
      type: string;
      baseUrlEnv: string;
      apiKeyEnv: string;
    } | undefined;

    if (!provider) return NextResponse.json({ error: 'Video provider not found' }, { status: 404 });

    const baseUrl = process.env[provider.baseUrlEnv];
    let apiKey = process.env[provider.apiKeyEnv];
    if (!baseUrl || !apiKey) {
      return NextResponse.json({ error: `Provider not configured. Set ${provider.baseUrlEnv} and ${provider.apiKeyEnv}` }, { status: 400 });
    }

    if (provider.type === 'kling') {
      const [accessKey, secretKey] = apiKey.split(':');
      if (accessKey && secretKey) {
        const { getKlingToken } = await import('@/lib/video-providers/kling');
        apiKey = getKlingToken(accessKey, secretKey);
      }
    }

    const adapter = getVideoAdapter(provider.type);
    if (!adapter) return NextResponse.json({ error: `Unknown provider type: ${provider.type}` }, { status: 400 });

    // Poll
    const result = await adapter.poll(job.providerTaskId!, apiKey, baseUrl);

    writeLog({
      jobId: job.id,
      projectId: job.projectId,
      level: 'info',
      message: `Resume poll: status=${result.status}`,
    });

    if (result.status === 'succeeded' && result.videoUrl) {
      // Download
      const videoRes = await fetch(result.videoUrl);
      if (!videoRes.ok) {
        return NextResponse.json({ error: `Remote video download failed: ${videoRes.status}` }, { status: 502 });
      }

      const videoBuffer = Buffer.from(await videoRes.arrayBuffer());
      const videosDir = path.join(process.cwd(), 'storage', 'videos');
      if (!fs.existsSync(videosDir)) fs.mkdirSync(videosDir, { recursive: true });

      const videoFilename = `video-${job.id.slice(0, 8)}-${Date.now()}.mp4`;
      const videoPath = path.join(videosDir, videoFilename);
      fs.writeFileSync(videoPath, videoBuffer);

      db.prepare(`
        UPDATE video_jobs SET
          status = 'succeeded',
          providerStatus = 'succeeded',
          remoteVideoUrl = ?,
          localVideoPath = ?,
          filename = ?,
          finishedAt = datetime('now')
        WHERE id = ?
      `).run(result.videoUrl, videoPath, videoFilename, job.id);

      return NextResponse.json({ success: true, status: 'succeeded', filename: videoFilename });
    }

    // Update status
    db.prepare(
      `UPDATE video_jobs SET providerStatus = ?, providerRawResponse = ? WHERE id = ?`
    ).run(result.status, JSON.stringify(result.rawResponse).slice(0, 4000), job.id);

    return NextResponse.json({ success: true, status: result.status });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
