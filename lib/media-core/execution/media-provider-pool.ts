import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { ExecutionError } from './context.ts';
import { readExecutionPool, readExecutionPoolBinding, mediaUpstreamBindingKey } from './pools.ts';

export function normalizedBaseUrl(value: string): string {
  const trimmed = value.trim();
  try {
    const url = new URL(trimmed);
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    url.hostname = url.hostname.toLowerCase();
    return url.toString().replace(/\/$/, '');
  } catch {
    return trimmed.replace(/\/$/, '');
  }
}

function upstreamFingerprint(baseUrl: string, apiKey: string): string {
  return createHash('sha256').update(`${normalizedBaseUrl(baseUrl)}\0${apiKey.trim()}`).digest('hex');
}

export function legacyMediaProviderPoolKey(baseUrl: string, apiKey: string): string {
  return `media-upstream:${upstreamFingerprint(baseUrl, apiKey).slice(0, 32)}`;
}

export function legacyMediaProviderCredentialFingerprint(baseUrl: string, apiKey: string): string {
  return upstreamFingerprint(baseUrl, apiKey);
}

export function ensureMediaProviderPool(db: Database.Database, baseUrl: string, apiKey: string): string {
  const fingerprint = upstreamFingerprint(baseUrl, apiKey);
  const binding = readExecutionPoolBinding(db, mediaUpstreamBindingKey(fingerprint));
  const poolKey = binding?.poolKey ?? legacyMediaProviderPoolKey(baseUrl, apiKey);
  const pool = readExecutionPool(db, poolKey);
  const mapping = pool.mappingSnapshot as {
    protocol?: unknown; baseUrl?: unknown; credentialFingerprint?: unknown; credentialFingerprints?: unknown;
  } | null;
  if (binding) {
    const members = Array.isArray(mapping?.credentialFingerprints)
      ? mapping!.credentialFingerprints.filter((item): item is string => typeof item === 'string') : [];
    if (pool.kind !== 'remote' || mapping?.protocol !== 'media-upstream-pool/1'
      || mapping?.baseUrl !== normalizedBaseUrl(baseUrl)
      || !members.includes(fingerprint)) {
      throw new ExecutionError('pool_mapping_mismatch', `受控资源池 ${poolKey} 的共享账户映射未核验，拒绝付费提交。`);
    }
    return poolKey;
  }
  if (pool.kind !== 'remote' || mapping?.protocol !== 'legacy-media-upstream/1'
    || mapping?.baseUrl !== normalizedBaseUrl(baseUrl)
    || mapping?.credentialFingerprint !== fingerprint) {
    throw new ExecutionError('pool_mapping_mismatch', `受控资源池 ${poolKey} 的供应商映射未核验，拒绝付费提交。`);
  }
  return poolKey;
}
