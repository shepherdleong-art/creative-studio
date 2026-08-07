import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { pollGeekAITask, downloadGeekAIImage, summarizeGeekAIResponse } from '@/lib/providers/geekai-json';
import { pollGatewayTaskImage, downloadGatewayTaskImage, summarizeGatewayTaskResponse } from '@/lib/providers/gateway-task-image';
import { writeLog } from '@/lib/logger';
import { sanitizeFilenameBase, ensureUniqueFilename, getUsagePrefix } from '@/lib/output-filenames';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import { dataRoot } from '@/lib/data-root';
import fs from 'fs';
import { guardManagedWorkbench } from '@/app/api/managed-deployment/guard';
import { isManagedDeployment } from '@/lib/managed-deployment';
import {
  assertProviderExecutionAvailable,
  assertProviderExecutionIdentityStable,
  readManagedExecutionGeneration,
  ProviderExecutionGateError,
} from '@/lib/provider-execution-gate';

/**
 * Resume a needs_check job without re-submitting: poll an existing task or
 * directly download a persisted remoteImageUrl, avoiding double charges.
 */
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const managedGuard = await guardManagedWorkbench();
  if (managedGuard) return managedGuard;
  try {
    const { id } = await params;
    const db = getDb();

    const job = db.prepare(`SELECT j.*, p.baseUrl, p.apiKey, p.apiKeyEnv, p.type, p.enabled, p.model as providerModel
      FROM jobs j LEFT JOIN providers p ON j.providerId = p.id WHERE j.id = ?`).get(id) as {
      id: string; projectId: string; providerId: string; providerTaskId: string | null; remoteImageUrl: string | null;
      model: string; prompt: string; inputImageId: string; referenceImageIds: string;
      size: string; quality: string; status: string;
      baseUrl: string; apiKey: string; apiKeyEnv: string; type: string; enabled: number; providerModel: string;
    } | undefined;

    if (!job) return NextResponse.json({ error: 'Job not found' }, { status: 404 });
    if (job.status !== 'needs_check') {
      return NextResponse.json({ error: 'Only needs_check jobs can be resumed' }, { status: 400 });
    }
    if (job.type !== 'geekai-json' && job.type !== 'gateway-task-image' && !job.remoteImageUrl) {
      return NextResponse.json({ error: 'Only async-task jobs support resume-poll' }, { status: 400 });
    }

    const taskId = job.providerTaskId;
    const remoteImageUrl = job.remoteImageUrl?.trim() || null;
    if (!taskId && !remoteImageUrl) return NextResponse.json({ error: 'No remote image result found' }, { status: 400 });

    const managedExecution = isManagedDeployment();
    const executionRoot = dataRoot();
    const managedGeneration = managedExecution ? readManagedExecutionGeneration(executionRoot) : null;
    const executionScope = managedExecution ? 'company' as const : 'external' as const;
    const initialImageProviderSnapshot = {
      id: job.providerId,
      type: job.type,
      model: job.providerModel || '',
      baseUrl: job.baseUrl || '',
      apiKeyEnv: job.apiKeyEnv || '',
      enabled: job.enabled === 1,
      apiKey: job.apiKey?.trim() || (job.apiKeyEnv ? String(process.env[job.apiKeyEnv] || '').trim() : ''),
    };
    const initialImageProviderIdentity = {
      id: initialImageProviderSnapshot.id,
      type: initialImageProviderSnapshot.type,
      executionScope,
      baseUrl: initialImageProviderSnapshot.baseUrl,
      apiKeyEnv: initialImageProviderSnapshot.apiKeyEnv,
      apiKey: initialImageProviderSnapshot.apiKey,
      model: initialImageProviderSnapshot.model,
      enabled: initialImageProviderSnapshot.enabled,
      configured: Boolean(initialImageProviderSnapshot.apiKey && initialImageProviderSnapshot.baseUrl && job.model),
      managedGeneration,
    };
    let activeImageExecution = {
      apiKey: initialImageProviderSnapshot.apiKey,
      baseUrl: initialImageProviderSnapshot.baseUrl,
    };
    let initialExecutionChecked = false;
    const readCurrentImageProvider = () => db.prepare(`
      SELECT id, baseUrl, apiKey, apiKeyEnv, type, enabled, model
      FROM providers WHERE id = ?
    `).get(job.providerId) as {
      id: string;
      baseUrl: string;
      apiKey: string;
      apiKeyEnv: string;
      type: string;
      enabled: number;
      model: string;
    } | undefined;
    const imageProviderIdentity = (current: NonNullable<ReturnType<typeof readCurrentImageProvider>>) => {
      const currentApiKey = current.apiKey?.trim()
        || (current.apiKeyEnv ? String(process.env[current.apiKeyEnv] || '').trim() : '');
      return {
        identity: {
          id: current.id,
          type: current.type,
          executionScope,
          baseUrl: current.baseUrl,
          apiKeyEnv: current.apiKeyEnv,
          apiKey: currentApiKey,
          model: current.model || '',
          enabled: current.enabled === 1,
          configured: Boolean(currentApiKey && current.baseUrl && job.model),
          managedGeneration: readManagedExecutionGeneration(executionRoot),
        },
        apiKey: currentApiKey,
        baseUrl: current.baseUrl,
      };
    };
    const assertImageExecution = async () => {
      if (!managedExecution) {
        if (initialExecutionChecked) return;
        await assertProviderExecutionAvailable(initialImageProviderIdentity, {
          root: executionRoot,
          capability: 'model',
          kind: 'image',
        });
        initialExecutionChecked = true;
        return;
      }

      const pre = readCurrentImageProvider();
      if (!pre) throw new ProviderExecutionGateError('managed_provider_not_allowed', '供应商执行配置已变化，已停止恢复轮询', executionScope);
      const preExecution = imageProviderIdentity(pre);
      assertProviderExecutionIdentityStable(initialImageProviderIdentity, preExecution.identity);
      await assertProviderExecutionAvailable(preExecution.identity, {
        root: executionRoot,
        capability: 'model',
        kind: 'image',
      });

      // The gate may await runtime inspection. Re-read immediately afterwards
      // and only use this post-gate row for the adapter boundary.
      const post = readCurrentImageProvider();
      if (!post) throw new ProviderExecutionGateError('managed_provider_not_allowed', '供应商执行配置已变化，已停止恢复轮询', executionScope);
      const postExecution = imageProviderIdentity(post);
      assertProviderExecutionIdentityStable(initialImageProviderIdentity, postExecution.identity);
      activeImageExecution = { apiKey: postExecution.apiKey, baseUrl: postExecution.baseUrl };
    };
    const gateFailure = async (error: unknown) => {
      const code = error instanceof ProviderExecutionGateError
        ? error.code
        : (managedExecution ? 'managed_workbench_locked' : 'runtime_unavailable');
      const message = error instanceof ProviderExecutionGateError
        ? error.message
        : (managedExecution ? '受管工作台尚未就绪，无法执行生产' : '供应商运行环境不可用');
      db.prepare(`UPDATE jobs SET status = 'needs_check', providerStatus = ?, errorMessage = ? WHERE id = ? AND status IN ('needs_check', 'running')`).run(code, `provider_execution_gate:${code}`, job.id);
      writeLog({ jobId: job.id, projectId: job.projectId, level: 'warn', message: `provider execution blocked code=${code}` });
      return { code, message };
    };
    const persistImageBuffer = (imgBuffer: Buffer, imageUrl: string, startedAt: number) => {
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
      db.prepare(`UPDATE jobs SET status = 'succeeded', providerStatus = 'succeeded', remoteImageUrl = ?, outputImageId = ?, finishedAt = datetime('now'), latencyMs = ? WHERE id = ?`).run(imageUrl, outputImageId, Date.now() - startedAt, job.id);
      writeLog({ jobId: job.id, projectId: job.projectId, level: 'info', message: '补抓成功，图片已保存' });
    };
    const markImageDownloadFailure = (imageUrl: string) => {
      db.prepare(`UPDATE jobs SET status = 'needs_check', providerStatus = 'download_failed', errorMessage = 'resume_download_failed', remoteImageUrl = ?, finishedAt = datetime('now') WHERE id = ? AND status IN ('running', 'needs_check')`).run(imageUrl, job.id);
      writeLog({ jobId: job.id, projectId: job.projectId, level: 'error', message: 'resume_download_failed' });
    };

    try {
      await assertImageExecution();
    } catch (error) {
      const code = error instanceof ProviderExecutionGateError ? error.code : 'transport_unavailable';
      if (!managedExecution && code === 'provider_unconfigured') {
        return NextResponse.json({ error: !activeImageExecution.apiKey ? 'API key not configured' : 'Provider not configured' }, { status: 400 });
      }
      if (managedExecution) {
        const policyDenied = code === 'managed_provider_not_allowed' || code === 'managed_provider_role_invalid';
        const message = code === 'managed_provider_not_allowed'
          ? '该供应商不在公司受管配置中'
          : (error instanceof ProviderExecutionGateError ? error.message : '受管工作台暂不可执行生产');
        return NextResponse.json(
          { error: 'provider_execution_unavailable', code, message },
          { status: policyDenied ? 403 : 423, headers: { 'Cache-Control': 'no-store' } },
        );
      }
      const failure = await gateFailure(error);
      return NextResponse.json({ error: 'provider_execution_unavailable', code: failure.code, message: failure.message }, { status: 423 });
    }

    if (!taskId && remoteImageUrl) {
      const startedAt = Date.now();
      const claim = db.prepare(`UPDATE jobs SET status = 'running', errorMessage = NULL WHERE id = ? AND status = 'needs_check'`).run(job.id);
      if (claim.changes !== 1) {
        return NextResponse.json({ error: 'resume_in_progress', message: '该任务正在恢复中' }, { status: 409 });
      }
      (async () => {
        try {
          try {
            await assertImageExecution();
          } catch (error) {
            await gateFailure(error);
            return;
          }
          let imgBuffer: Buffer | null;
          if (job.type === 'gateway-task-image') {
            let downloadResult;
            try {
              downloadResult = await downloadGatewayTaskImage(remoteImageUrl, activeImageExecution.baseUrl, activeImageExecution.apiKey);
            } catch {
              markImageDownloadFailure(remoteImageUrl);
              return;
            }
            if (!downloadResult.ok) {
              markImageDownloadFailure(remoteImageUrl);
              return;
            }
            imgBuffer = downloadResult.buffer;
          } else {
            try {
              imgBuffer = await downloadGeekAIImage(remoteImageUrl);
            } catch {
              markImageDownloadFailure(remoteImageUrl);
              return;
            }
          }
          if (!imgBuffer) {
            markImageDownloadFailure(remoteImageUrl);
            return;
          }
          persistImageBuffer(imgBuffer, remoteImageUrl, startedAt);
        } catch {
          db.prepare(`UPDATE jobs SET status = 'needs_check', providerStatus = 'resume_download_failed', errorMessage = 'resume_download_failed', remoteImageUrl = ? WHERE id = ? AND status IN ('running', 'needs_check')`).run(remoteImageUrl, job.id);
          writeLog({ jobId: job.id, projectId: job.projectId, level: 'error', message: 'resume_download_failed' });
        }
      })();
      return NextResponse.json({ status: 'resumed-download' });
    }
    if (!taskId) return NextResponse.json({ error: 'No provider task ID found' }, { status: 400 });

    // Claim the task before polling; a concurrent resume must not double-poll.
    const pollClaim = db.prepare(`UPDATE jobs SET status = 'running', errorMessage = NULL WHERE id = ? AND status = 'needs_check'`).run(job.id);
    if (pollClaim.changes !== 1) {
      return NextResponse.json({ error: 'resume_in_progress', message: '该任务正在恢复中' }, { status: 409 });
    }

    // Start async polling
    (async () => {
      const db = getDb();
      const startedAt = Date.now();
      const maxPollMs = 300_000;
      const isGatewayTask = job.type === 'gateway-task-image';

      try {
        writeLog({ jobId: job.id, projectId: job.projectId, level: 'info', message: `补抓开始 task_id=${taskId}` });

        while (Date.now() - startedAt < maxPollMs) {
          try {
            await assertImageExecution();
          } catch (error) {
            await gateFailure(error);
            return;
          }
          const pollResult = isGatewayTask
            ? await pollGatewayTaskImage(taskId, activeImageExecution.apiKey, activeImageExecution.baseUrl, startedAt)
            : await pollGeekAITask(taskId, activeImageExecution.apiKey, activeImageExecution.baseUrl, startedAt);

          db.prepare(
            `UPDATE jobs SET providerStatus = ?, providerRawResponse = ?, lastPolledAt = datetime('now'), pollCount = pollCount + 1 WHERE id = ?`
          ).run(pollResult.status, safeJson(pollResult.rawResponse), job.id);

          writeLog({
            jobId: job.id, projectId: job.projectId, level: 'info',
            message: `补抓轮询 task_id=${taskId} raw=${isGatewayTask ? summarizeGatewayTaskResponse(pollResult.rawResponse, activeImageExecution.apiKey) : summarizeGeekAIResponse(pollResult.rawResponse)}`,
          });

          if (pollResult.status === 'succeeded' && pollResult.imageUrl) {
            try {
              await assertImageExecution();
            } catch (error) {
              await gateFailure(error);
              return;
            }
            let imgBuffer: Buffer | null;
            if (isGatewayTask) {
              let downloadResult;
              try {
                downloadResult = await downloadGatewayTaskImage(pollResult.imageUrl, activeImageExecution.baseUrl, activeImageExecution.apiKey);
              } catch {
                markImageDownloadFailure(pollResult.imageUrl);
                return;
              }
              if (!downloadResult.ok) {
                markImageDownloadFailure(pollResult.imageUrl);
                return;
              }
              imgBuffer = downloadResult.buffer;
            } else {
              try {
                imgBuffer = await downloadGeekAIImage(pollResult.imageUrl);
              } catch {
                markImageDownloadFailure(pollResult.imageUrl);
                return;
              }
            }
            if (!imgBuffer) {
              markImageDownloadFailure(pollResult.imageUrl);
              return;
            }
            persistImageBuffer(imgBuffer, pollResult.imageUrl, startedAt);
            return;
          }

          if (pollResult.status === 'failed') {
            db.prepare(`UPDATE jobs SET status = 'failed', errorMessage = ?, finishedAt = datetime('now') WHERE id = ?`).run(pollResult.errorMessage || 'failed', job.id);
            return;
          }
        }

        // Timeout — back to needs_check
        db.prepare(`UPDATE jobs SET status = 'needs_check', errorMessage = '补抓超时' WHERE id = ?`).run(job.id);
      } catch {
        db.prepare(`UPDATE jobs SET status = 'needs_check', providerStatus = 'resume_poll_failed', errorMessage = 'resume_poll_failed' WHERE id = ? AND status IN ('running', 'needs_check')`).run(job.id);
        writeLog({ jobId: job.id, projectId: job.projectId, level: 'error', message: 'resume_poll_failed' });
      }
    })();

    return NextResponse.json({ status: 'resumed-polling' });
  } catch {
    return NextResponse.json({ error: 'resume_poll_failed', message: '恢复轮询失败' }, { status: 500 });
  }
}

function safeJson(obj: unknown, ml = 4000): string {
  if (obj === null || obj === undefined) return '';
  try { const s = JSON.stringify(obj); return s.length > ml ? s.slice(0, ml) + '...[t]' : s; } catch { return '[?]'; }
}
