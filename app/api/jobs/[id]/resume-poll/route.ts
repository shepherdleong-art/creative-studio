import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { pollGeekAITask, downloadGeekAIImage, summarizeGeekAIResponse } from '@/lib/providers/geekai-json';
import { pollGatewayTaskImage, downloadGatewayTaskImage, summarizeGatewayTaskResponse } from '@/lib/providers/gateway-task-image';
import { describeGatewayDownloadFailure } from '@/lib/media-download-policy';
import { writeLog } from '@/lib/logger';
import { sanitizeFilenameBase, ensureUniqueFilename, getUsagePrefix } from '@/lib/output-filenames';
import { recordImageJobUsage } from '@/lib/usage-async-jobs';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import { dataRoot } from '@/lib/data-root';
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
      size: string; quality: string; status: string; attempt: number; usageSnapshotJson: string | null;
      baseUrl: string; apiKey: string; apiKeyEnv: string; type: string;
    } | undefined;

    if (!job) return NextResponse.json({ error: 'Job not found' }, { status: 404 });
    if (job.status !== 'needs_check') {
      return NextResponse.json({ error: 'Only needs_check jobs can be resumed' }, { status: 400 });
    }
    if (job.type !== 'geekai-json' && job.type !== 'gateway-task-image') {
      return NextResponse.json({ error: 'Only async-task jobs support resume-poll' }, { status: 400 });
    }

    const apiKey = job.apiKey;
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
      const isGatewayTask = job.type === 'gateway-task-image';

      try {
        writeLog({ jobId: job.id, projectId: job.projectId, level: 'info', message: `补抓开始 task_id=${taskId}` });

        while (Date.now() - startedAt < maxPollMs) {
          const pollResult = isGatewayTask
            ? await pollGatewayTaskImage(taskId, apiKey, job.baseUrl, startedAt)
            : await pollGeekAITask(taskId, apiKey, job.baseUrl, startedAt);

          db.prepare(
            `UPDATE jobs SET providerStatus = ?, providerRawResponse = ?, lastPolledAt = datetime('now'), pollCount = pollCount + 1 WHERE id = ?`
          ).run(pollResult.status, safeJson(pollResult.rawResponse), job.id);

          writeLog({
            jobId: job.id, projectId: job.projectId, level: 'info',
            message: `补抓轮询 task_id=${taskId} raw=${isGatewayTask ? summarizeGatewayTaskResponse(pollResult.rawResponse, apiKey) : summarizeGeekAIResponse(pollResult.rawResponse)}`,
          });

          if (pollResult.status === 'succeeded' && pollResult.imageUrl) {
            let imgBuffer: Buffer | null;
            if (isGatewayTask) {
              const downloadResult = await downloadGatewayTaskImage(pollResult.imageUrl, job.baseUrl, apiKey);
              if (!downloadResult.ok) {
                const failure = describeGatewayDownloadFailure('image', pollResult.imageUrl, downloadResult, apiKey);
                db.prepare(
                  `UPDATE jobs SET status = 'needs_check', errorMessage = ?, providerStatus = ?, remoteImageUrl = ?, finishedAt = datetime('now') WHERE id = ?`
                ).run(failure.errorMessage, failure.providerStatus, pollResult.imageUrl, job.id);
                writeLog({
                  jobId: job.id, projectId: job.projectId, level: 'error',
                  message: `补抓下载失败: ${failure.errorMessage} URL: ${failure.logUrl}`,
                });
                return;
              }
              imgBuffer = downloadResult.buffer;
            } else {
              imgBuffer = await downloadGeekAIImage(pollResult.imageUrl);
            }
            if (imgBuffer) {
              const outputsDir = path.join(dataRoot(), 'storage', 'outputs');
              if (!fs.existsSync(outputsDir)) fs.mkdirSync(outputsDir, { recursive: true });

              const inputImage = db.prepare(`SELECT filename, usage FROM image_assets WHERE id = ?`).get(job.inputImageId) as { filename: string; usage?: string } | undefined;
              const { filePrefix, outputUsage } = getUsagePrefix(inputImage?.usage || '');

              const inputBase = inputImage?.filename ? sanitizeFilenameBase(inputImage.filename) : job.id.slice(0, 8);
              const preferredOutputName = `${filePrefix}${inputBase}.png`;
              const outputFilename = ensureUniqueFilename(outputsDir, preferredOutputName, job.id.slice(0, 6));
              const outputPath = path.join(outputsDir, outputFilename);

              fs.writeFileSync(outputPath, imgBuffer);
              const outputImageId = uuidv4();
              db.prepare(`INSERT INTO image_assets (id, projectId, role, filename, path, mimeType, usage, createdAt) VALUES (?, ?, 'output', ?, ?, 'image/png', ?, datetime('now'))`).run(outputImageId, job.projectId, outputFilename, outputPath, outputUsage);

              const finishedAt = new Date().toISOString();
              const completeResult = db.prepare(`UPDATE jobs SET status = 'succeeded', providerStatus = 'succeeded', remoteImageUrl = ?, outputImageId = ?, finishedAt = ?, latencyMs = ? WHERE id = ? AND status = 'running'`).run(pollResult.imageUrl, outputImageId, finishedAt, Date.now() - startedAt, job.id);
              if (completeResult.changes === 1) {
                const usageResult = recordImageJobUsage(db, {
                  jobId: job.id,
                  projectId: job.projectId,
                  attempt: job.attempt,
                  snapshot: job.usageSnapshotJson,
                  finishedAt,
                });
                if (!usageResult.ok) {
                  writeLog({ jobId: job.id, projectId: job.projectId, level: 'warn', message: `补抓成功后的 usage 记账失败，将由 reconciler 补记 (${usageResult.reason ?? 'unknown'})` });
                }
              }
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
  if (obj === null || obj === undefined) return '';
  try { const s = JSON.stringify(obj); return s.length > ml ? s.slice(0, ml) + '...[t]' : s; } catch { return '[?]'; }
}
