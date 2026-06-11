import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { pollGeekAITask, downloadGeekAIImage, summarizeGeekAIResponse } from '@/lib/providers/geekai-json';
import { writeLog } from '@/lib/logger';
import { sanitizeFilenameBase, ensureUniqueFilename } from '@/lib/output-filenames';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import fs from 'fs';

/**
 * Resume polling for a needs_check job without re-submitting to the API.
 * Only polls the existing providerTaskId, avoiding double charges.
 */
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const db = getDb();

    const job = db.prepare(`SELECT j.*, p.baseUrl, p.apiKey, p.apiKeyEnv, p.type, p.model as providerModel
      FROM jobs j LEFT JOIN providers p ON j.providerId = p.id WHERE j.id = ?`).get(id) as {
      id: string; projectId: string; providerId: string; providerTaskId: string;
      model: string; prompt: string; inputImageId: string; referenceImageIds: string;
      size: string; quality: string; status: string;
      baseUrl: string; apiKey: string; apiKeyEnv: string; type: string;
    } | undefined;

    if (!job) return NextResponse.json({ error: 'Job not found' }, { status: 404 });
    if (job.status !== 'needs_check') {
      return NextResponse.json({ error: 'Only needs_check jobs can be resumed' }, { status: 400 });
    }
    if (job.type !== 'geekai-json') {
      return NextResponse.json({ error: 'Only GeekAI jobs support resume-poll' }, { status: 400 });
    }

    const apiKey = job.apiKey || process.env[job.apiKeyEnv];
    if (!apiKey) return NextResponse.json({ error: 'API key not configured' }, { status: 400 });

    const taskId = job.providerTaskId;
    if (!taskId) return NextResponse.json({ error: 'No providerTaskId found' }, { status: 400 });

    // Mark as running and start polling immediately (fire-and-forget)
    db.prepare(`UPDATE jobs SET status = 'running', errorMessage = NULL WHERE id = ?`).run(job.id);

    // Start async polling
    (async () => {
      const db = getDb();
      const startedAt = Date.now();
      const maxPollMs = 300_000;

      try {
        writeLog({ jobId: job.id, projectId: job.projectId, level: 'info', message: `补抓开始 task_id=${taskId}` });

        while (Date.now() - startedAt < maxPollMs) {
          const pollResult = await pollGeekAITask(taskId, apiKey, job.baseUrl, startedAt);

          db.prepare(
            `UPDATE jobs SET providerStatus = ?, providerRawResponse = ?, lastPolledAt = datetime('now'), pollCount = pollCount + 1 WHERE id = ?`
          ).run(pollResult.status, safeJson(pollResult.rawResponse), job.id);

          writeLog({
            jobId: job.id, projectId: job.projectId, level: 'info',
            message: `补抓轮询 task_id=${taskId} raw=${summarizeGeekAIResponse(pollResult.rawResponse)}`,
          });

          if (pollResult.status === 'succeeded' && pollResult.imageUrl) {
            const imgBuffer = await downloadGeekAIImage(pollResult.imageUrl);
            if (imgBuffer) {
              const outputsDir = path.join(process.cwd(), 'storage', 'outputs');
              if (!fs.existsSync(outputsDir)) fs.mkdirSync(outputsDir, { recursive: true });

              const inputImage = db.prepare(`SELECT filename, usage FROM image_assets WHERE id = ?`).get(job.inputImageId) as { filename: string; usage?: string } | undefined;
              const inputUsage = inputImage?.usage || '';
              let filePrefix = 'output-';
              let outputUsage = '';
              if (inputUsage === 'scene_seed') { filePrefix = '场景-'; outputUsage = 'scene_gen'; }
              else if (inputUsage === 'shot_source') { filePrefix = '分镜-'; outputUsage = 'shot_gen'; }

              const inputBase = inputImage?.filename ? sanitizeFilenameBase(inputImage.filename) : job.id.slice(0, 8);
              const preferredOutputName = `${filePrefix}${inputBase}.png`;
              const outputFilename = ensureUniqueFilename(outputsDir, preferredOutputName, job.id.slice(0, 6));
              const outputPath = path.join(outputsDir, outputFilename);

              fs.writeFileSync(outputPath, imgBuffer);
              const outputImageId = uuidv4();
              db.prepare(`INSERT INTO image_assets (id, projectId, role, filename, path, mimeType, usage, createdAt) VALUES (?, ?, 'output', ?, ?, 'image/png', ?, datetime('now'))`).run(outputImageId, job.projectId, outputFilename, outputPath, outputUsage);

              db.prepare(`UPDATE jobs SET status = 'succeeded', providerStatus = 'succeeded', remoteImageUrl = ?, outputImageId = ?, finishedAt = datetime('now'), latencyMs = ? WHERE id = ?`).run(pollResult.imageUrl, outputImageId, Date.now() - startedAt, job.id);
              writeLog({ jobId: job.id, projectId: job.projectId, level: 'info', message: '补抓成功，图片已保存' });
              return;
            }
          }

          if (pollResult.status === 'failed') {
            db.prepare(`UPDATE jobs SET status = 'failed', errorMessage = ?, finishedAt = datetime('now') WHERE id = ?`).run(pollResult.errorMessage || 'failed', job.id);
            return;
          }
        }

        // Timeout — back to needs_check
        db.prepare(`UPDATE jobs SET status = 'needs_check', errorMessage = '补抓超时' WHERE id = ?`).run(job.id);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        db.prepare(`UPDATE jobs SET status = 'needs_check', errorMessage = ? WHERE id = ?`).run(msg, job.id);
      }
    })();

    return NextResponse.json({ status: 'resumed-polling' });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

function safeJson(obj: unknown, ml = 4000): string {
  if (!obj) return '';
  try { const s = JSON.stringify(obj); return s.length > ml ? s.slice(0, ml) + '...[t]' : s; } catch { return '[?]'; }
}
