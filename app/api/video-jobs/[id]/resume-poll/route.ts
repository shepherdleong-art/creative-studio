import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { getVideoAdapter } from '@/lib/video-providers/index';
import { getKlingToken } from '@/lib/video-providers/kling';
import { resolveVideoProviderRuntimeConfig } from '@/lib/video-auth';
import {
  describeGatewayDownloadFailure,
  downloadVideoMediaForProvider,
  shouldPersistVideoResumeDownloadFailure,
} from '@/lib/media-download-policy';
import { writeLog } from '@/lib/logger';
import fs from 'fs';
import path from 'path';
import { guardManagedWorkbench } from '@/app/api/managed-deployment/guard';
import { dataRoot } from '@/lib/data-root';
import { isManagedDeployment } from '@/lib/managed-deployment';
import {
  assertProviderExecutionAvailable,
  assertProviderExecutionIdentityStable,
  readManagedExecutionGeneration,
  ProviderExecutionGateError,
} from '@/lib/provider-execution-gate';

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const managedGuard = await guardManagedWorkbench();
  if (managedGuard) return managedGuard;
  try {
    const { id } = await params;
    const db = getDb();

    const job = db.prepare(`SELECT * FROM video_jobs WHERE id = ?`).get(id) as {
      id: string;
      projectId: string;
      providerId: string;
      providerTaskId: string | null;
      status: string;
      errorMessage: string | null;
      providerStatus: string | null;
    } | undefined;

    if (!job) return NextResponse.json({ error: 'Video job not found' }, { status: 404 });

    const providerExecutionGateCodes = new Set([
      'managed_workbench_locked',
      'managed_provider_not_allowed',
      'managed_provider_role_invalid',
      'provider_disabled',
      'provider_unconfigured',
      'provider_route_invalid',
      'runtime_not_configured',
      'runtime_stopped',
      'runtime_unavailable',
      'transport_unavailable',
    ]);
    const gateFailedStatus = job.status === 'failed'
      && Boolean(job.providerTaskId)
      && (job.errorMessage?.startsWith('provider_execution_gate:') === true
        || (job.providerStatus !== null && providerExecutionGateCodes.has(job.providerStatus)));
    if (job.status !== 'needs_check' && !gateFailedStatus) {
      return NextResponse.json({ error: 'Only needs_check or provider-gate-failed jobs can be resumed polling' }, { status: 400 });
    }

    if (!job.providerTaskId) {
      return NextResponse.json({ error: 'No provider task ID to resume polling' }, { status: 400 });
    }

    // Load provider
    const provider = db.prepare(`SELECT * FROM video_providers WHERE id = ?`).get(job.providerId) as {
      id: string;
      type: string;
      baseUrlEnv: string;
      apiKeyEnv: string;
      modelEnv: string;
      defaultModel: string;
      defaultDurationSec: number;
      baseUrl: string;
      apiKey: string;
      accessKey: string;
      secretKey: string;
      enabled: number;
    } | undefined;

    if (!provider) return NextResponse.json({ error: 'Video provider not found' }, { status: 404 });

    const managedExecution = isManagedDeployment();
    const executionRoot = dataRoot();
    const managedGeneration = managedExecution ? readManagedExecutionGeneration(executionRoot) : null;
    const executionScope = managedExecution ? 'company' as const : 'external' as const;
    let runtime = resolveVideoProviderRuntimeConfig(provider);
    let apiKey = runtime.apiKey;
    const initialVideoProviderSnapshot = {
      id: provider.id,
      type: provider.type,
      baseUrlEnv: provider.baseUrlEnv || '',
      apiKeyEnv: provider.apiKeyEnv || '',
      modelEnv: provider.modelEnv || '',
      baseUrl: runtime.baseUrl,
      model: runtime.model,
      enabled: runtime.enabled,
      apiKey: runtime.apiKey,
      accessKey: runtime.accessKey,
      secretKey: runtime.secretKey,
      durationSec: runtime.durationSec,
    };
    const initialVideoProviderIdentity = {
      id: initialVideoProviderSnapshot.id,
      type: initialVideoProviderSnapshot.type,
      executionScope,
      baseUrl: initialVideoProviderSnapshot.baseUrl,
      apiKeyEnv: initialVideoProviderSnapshot.apiKeyEnv,
      apiKey: initialVideoProviderSnapshot.type === 'kling'
        ? `${initialVideoProviderSnapshot.accessKey}\u0000${initialVideoProviderSnapshot.secretKey}`
        : initialVideoProviderSnapshot.apiKey,
      model: initialVideoProviderSnapshot.model,
      enabled: initialVideoProviderSnapshot.enabled,
      configured: runtime.configured,
      managedGeneration,
    };
    let initialExecutionChecked = false;
    const readCurrentVideoProvider = () => db.prepare(`SELECT * FROM video_providers WHERE id = ?`).get(job.providerId) as {
      id: string;
      type: string;
      baseUrlEnv: string;
      apiKeyEnv: string;
      modelEnv: string;
      defaultModel: string;
      defaultDurationSec: number;
      baseUrl: string;
      apiKey: string;
      accessKey: string;
      secretKey: string;
      enabled: number;
    } | undefined;
    const videoProviderExecution = (current: NonNullable<ReturnType<typeof readCurrentVideoProvider>>) => {
      let currentRuntime: ReturnType<typeof resolveVideoProviderRuntimeConfig>;
      try {
        currentRuntime = resolveVideoProviderRuntimeConfig(current);
      } catch {
        throw new ProviderExecutionGateError('provider_unconfigured', '供应商执行配置不可用', executionScope);
      }
      const identity = {
        id: current.id,
        type: current.type,
        executionScope,
        baseUrl: currentRuntime.baseUrl,
        apiKeyEnv: current.apiKeyEnv,
        apiKey: current.type === 'kling'
          ? `${currentRuntime.accessKey}\u0000${currentRuntime.secretKey}`
          : currentRuntime.apiKey,
        model: currentRuntime.model,
        enabled: currentRuntime.enabled,
        configured: currentRuntime.configured,
        managedGeneration: readManagedExecutionGeneration(executionRoot),
      };
      return {
        runtime: currentRuntime,
        identity,
        apiKey: currentRuntime.apiKey,
      };
    };
    const assertVideoExecution = async () => {
      if (!managedExecution) {
        if (initialExecutionChecked) return;
        await assertProviderExecutionAvailable(initialVideoProviderIdentity, {
          root: executionRoot,
          capability: 'model',
          kind: 'video',
        });
        initialExecutionChecked = true;
        return;
      }

      const pre = readCurrentVideoProvider();
      if (!pre) throw new ProviderExecutionGateError('managed_provider_not_allowed', '供应商执行配置已变化，已停止恢复轮询', executionScope);
      const preExecution = videoProviderExecution(pre);
      if ((pre.baseUrlEnv || '') !== initialVideoProviderSnapshot.baseUrlEnv
        || (pre.apiKeyEnv || '') !== initialVideoProviderSnapshot.apiKeyEnv
        || (pre.modelEnv || '') !== initialVideoProviderSnapshot.modelEnv
        || preExecution.runtime.durationSec !== initialVideoProviderSnapshot.durationSec) {
        throw new ProviderExecutionGateError('managed_provider_not_allowed', '供应商执行配置已变化，已停止恢复轮询', executionScope);
      }
      assertProviderExecutionIdentityStable(initialVideoProviderIdentity, preExecution.identity);
      await assertProviderExecutionAvailable(preExecution.identity, {
        root: executionRoot,
        capability: 'model',
        kind: 'video',
      });

      // The gate may await runtime inspection. Re-read synchronously and use
      // only this post-gate provider/runtime for the adapter boundary.
      const post = readCurrentVideoProvider();
      if (!post) throw new ProviderExecutionGateError('managed_provider_not_allowed', '供应商执行配置已变化，已停止恢复轮询', executionScope);
      const postExecution = videoProviderExecution(post);
      if ((post.baseUrlEnv || '') !== initialVideoProviderSnapshot.baseUrlEnv
        || (post.apiKeyEnv || '') !== initialVideoProviderSnapshot.apiKeyEnv
        || (post.modelEnv || '') !== initialVideoProviderSnapshot.modelEnv
        || postExecution.runtime.durationSec !== initialVideoProviderSnapshot.durationSec) {
        throw new ProviderExecutionGateError('managed_provider_not_allowed', '供应商执行配置已变化，已停止恢复轮询', executionScope);
      }
      assertProviderExecutionIdentityStable(initialVideoProviderIdentity, postExecution.identity);
      runtime = postExecution.runtime;
      apiKey = postExecution.apiKey;
    };
    const gateFailure = async (error: unknown) => {
      const code = error instanceof ProviderExecutionGateError
        ? error.code
        : (managedExecution ? 'managed_workbench_locked' : 'runtime_unavailable');
      const message = error instanceof ProviderExecutionGateError
        ? error.message
        : (managedExecution ? '受管工作台尚未就绪，无法执行生产' : '供应商运行环境不可用');
      db.prepare(`UPDATE video_jobs SET status = 'failed', providerStatus = ?, errorMessage = ? WHERE id = ? AND status IN ('needs_check', 'failed')`).run(code, `provider_execution_gate:${code}`, job.id);
      writeLog({ jobId: job.id, projectId: job.projectId, level: 'warn', message: `provider execution blocked code=${code}` });
      return { code, message };
    };

    try {
      await assertVideoExecution();
    } catch (error) {
      const code = error instanceof ProviderExecutionGateError ? error.code : 'transport_unavailable';
      if (!managedExecution && code === 'provider_disabled') {
        return NextResponse.json({ error: 'Video provider is disabled.' }, { status: 400 });
      }
      if (!managedExecution && code === 'provider_unconfigured') {
        return NextResponse.json({ error: `Provider not configured. Set ${runtime.missing.join(', ')}` }, { status: 400 });
      }
      const failure = await gateFailure(error);
      return NextResponse.json({ error: 'provider_execution_unavailable', code: failure.code, message: failure.message }, { status: 423 });
    }

    if (!runtime.enabled) {
      return NextResponse.json({ error: 'Video provider is disabled.' }, { status: 400 });
    }
    if (!runtime.configured) {
      return NextResponse.json({ error: `Provider not configured. Set ${runtime.missing.join(', ')}` }, { status: 400 });
    }
    if (!managedExecution && provider.type === 'kling') {
      apiKey = getKlingToken(runtime.accessKey, runtime.secretKey);
    }

    const adapter = getVideoAdapter(provider.type);
    if (!adapter) return NextResponse.json({ error: `Unknown provider type: ${provider.type}` }, { status: 400 });

    // Poll
    try {
      await assertVideoExecution();
    } catch (error) {
      const failure = await gateFailure(error);
      return NextResponse.json({ error: 'provider_execution_unavailable', code: failure.code, message: failure.message }, { status: 423 });
    }
    const result = await adapter.poll(job.providerTaskId!, apiKey, runtime.baseUrl);

    writeLog({
      jobId: job.id,
      projectId: job.projectId,
      level: 'info',
      message: `Resume poll: status=${result.status}`,
    });

    if (result.status === 'succeeded' && result.videoUrl) {
      try {
        await assertVideoExecution();
      } catch (error) {
        const failure = await gateFailure(error);
        return NextResponse.json({ error: 'provider_execution_unavailable', code: failure.code, message: failure.message }, { status: 423 });
      }
      let videoBuffer: Buffer;
      if (shouldPersistVideoResumeDownloadFailure(provider.type)) {
        const downloadResult = await downloadVideoMediaForProvider({
          providerType: provider.type,
          url: result.videoUrl,
          baseUrl: runtime.baseUrl,
          apiKey,
        });
        if (!downloadResult.ok) {
          const failure = describeGatewayDownloadFailure('video', result.videoUrl, downloadResult, apiKey);
          db.prepare(`
            UPDATE video_jobs SET status = ?, providerStatus = ?, errorMessage = ?, remoteVideoUrl = ?,
              finishedAt = datetime('now'), lastPolledAt = datetime('now'), pollCount = pollCount + 1
            WHERE id = ?
          `).run(failure.status, failure.providerStatus, failure.errorMessage, result.videoUrl, job.id);
          writeLog({
            jobId: job.id,
            projectId: job.projectId,
            level: 'error',
            message: `${failure.errorMessage} URL: ${failure.logUrl}`,
          });
          return NextResponse.json({ error: failure.errorMessage }, { status: 502 });
        }
        videoBuffer = downloadResult.buffer;
      } else {
        const videoRes = await fetch(result.videoUrl, { headers: {} });
        if (!videoRes.ok) {
          return NextResponse.json({ error: `Remote video download failed: ${videoRes.status}` }, { status: 502 });
        }
        videoBuffer = Buffer.from(await videoRes.arrayBuffer());
      }

      const videosDir = path.join(dataRoot(), 'storage', 'videos');
      if (!fs.existsSync(videosDir)) fs.mkdirSync(videosDir, { recursive: true });

      const videoFilename = `video-${job.id.slice(0, 8)}-${Date.now()}.mp4`;
      const videoPath = path.join(videosDir, videoFilename);
      fs.writeFileSync(videoPath, videoBuffer);

      db.prepare(`
        UPDATE video_jobs SET
          status = 'succeeded',
          providerStatus = 'succeeded',
          errorMessage = NULL,
          remoteVideoUrl = ?,
          localVideoPath = ?,
          filename = ?,
          finishedAt = datetime('now'),
          lastPolledAt = datetime('now'),
          pollCount = pollCount + 1
        WHERE id = ?
      `).run(result.videoUrl, videoPath, videoFilename, job.id);

      return NextResponse.json({ success: true, status: 'succeeded', filename: videoFilename });
    }

    const nextStatus = result.status === 'failed' ? 'failed' : 'needs_check';
    const nextError = result.status === 'failed'
      ? (result.errorMessage || 'Video generation failed')
      : 'Provider task is still running. Try resume polling again later.';

    db.prepare(
      `UPDATE video_jobs SET
        status = ?,
        errorMessage = ?,
        providerStatus = ?,
        providerRawResponse = ?,
        lastPolledAt = datetime('now'),
        pollCount = pollCount + 1
       WHERE id = ?`
    ).run(nextStatus, nextError, result.status, JSON.stringify(result.rawResponse).slice(0, 4000), job.id);

    return NextResponse.json({ success: true, status: result.status });
  } catch {
    return NextResponse.json({ error: 'resume_poll_failed', message: '恢复轮询失败' }, { status: 500 });
  }
}
