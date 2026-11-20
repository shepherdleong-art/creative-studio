import type Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { load } from 'js-yaml';
import { dataRoot } from '../data-root.ts';
import { legacyMediaExecutionRevision } from '../legacy-media-execution.ts';
import { legacyMediaProviderCredentialFingerprint as fingerprint } from '../media-core/execution/media-provider-pool.ts';
import { getVideoProviderConfigState, resolveVideoProviderRuntimeConfig, type VideoProviderEnvConfig } from '../video-auth.ts';

function configValue(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.startsWith('os.environ/') ? process.env[value.slice(11)]?.trim() ?? '' : value.trim();
}

/** The company's loopback bearer identifies the proxy. Bind its selected upstream deployment too. */
export function filmAccountRef(provider: VideoProviderEnvConfig & { id: string }, model: string): string | null {
  if (!getVideoProviderConfigState(provider).configured) return null;
  const runtime = resolveVideoProviderRuntimeConfig(provider);
  const key = runtime.type === 'kling' ? runtime.accessKey + '\0' + runtime.secretKey : runtime.apiKey;
  const direct = fingerprint(runtime.baseUrl, key);
  if (provider.baseUrlEnv !== 'COMPANY_VIDEO_BASE_URL' || !/^https?:\/\/(?:127\.0\.0\.1|localhost)(?=[:/]|$)/i.test(runtime.baseUrl)) return direct;
  try {
    const config = load(fs.readFileSync(path.join(dataRoot(), 'config.yaml'), 'utf8')) as {
      model_list?: Array<{ model_name: string; litellm_params?: { api_base?: string; api_key?: string; model?: string } }>;
    };
    const deployments = config.model_list?.filter((entry) => entry.model_name === model);
    if (deployments?.length !== 1) return null;
    const params = deployments[0]?.litellm_params;
    const base = configValue(params?.api_base);
    const credential = configValue(params?.api_key);
    if (!base || !credential || !params?.model) return null;
    return fingerprint(runtime.baseUrl, JSON.stringify([direct, params.model, fingerprint(base, credential)]));
  } catch {
    return null;
  }
}

/** Return the bound identity only while this original's actual channel and account are still available. */
export function verifiedFilmAccount(db: Database.Database, jobId: string): { ref: string; providerId: string } | null {
  const job = db.prepare('SELECT providerId, model, executionRevision, filmAccountProviderId, filmCredentialRef FROM video_jobs WHERE id=?')
    .get(jobId) as { providerId: string; model: string; executionRevision: number; filmAccountProviderId: string | null; filmCredentialRef: string | null } | undefined;
  if (!job) return null;
  let providerId = job.filmAccountProviderId || job.providerId;
  let frozen = job.filmCredentialRef;
  if (!frozen && db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='execution_operations'").get()) {
    const op = db.prepare("SELECT credentialVersionRef, json_extract(providerSnapshotJson,'$.providerId') AS providerId FROM execution_operations WHERE operationKey=?")
      .get(`video/${jobId}/submit/${legacyMediaExecutionRevision(job.executionRevision)}`) as { credentialVersionRef: string; providerId: string } | undefined;
    if (op) { frozen = op.credentialVersionRef; providerId = op.providerId; }
  }
  if (!frozen) return null;
  const provider = db.prepare('SELECT * FROM video_providers WHERE id=? AND enabled=1').get(providerId) as
    (VideoProviderEnvConfig & { id: string }) | undefined;
  if (!provider || filmAccountRef(provider, providerId === job.providerId ? job.model : provider.defaultModel ?? '') !== frozen) return null;
  return { ref: frozen, providerId };
}
