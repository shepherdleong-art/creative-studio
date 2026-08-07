'use client';

import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { ManagedWorkbenchStatus } from '@/lib/managed-workbench';

export type ManagedDeploymentContextValue = {
  loading: boolean;
  status: ManagedWorkbenchStatus | null;
  locked: boolean;
  refreshNow: () => Promise<void>;
};

const ManagedDeploymentContext = createContext<ManagedDeploymentContextValue | null>(null);
const MANAGED_PHASES = new Set<ManagedWorkbenchStatus['phase']>([
  'unrestricted',
  'unconfigured',
  'starting',
  'ready',
  'failed',
]);

const FAILED_STATUS: ManagedWorkbenchStatus = {
  managed: true,
  phase: 'failed',
  configured: false,
  profileName: null,
  importedAt: null,
  configHashPrefix: null,
  proxyAvailable: false,
  reason: '公司配置状态暂时不可用，请重试',
};

function isManagedStatus(value: unknown): value is ManagedWorkbenchStatus {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<ManagedWorkbenchStatus>;
  if (typeof candidate.managed !== 'boolean'
    || typeof candidate.phase !== 'string'
    || !MANAGED_PHASES.has(candidate.phase as ManagedWorkbenchStatus['phase'])
    || typeof candidate.configured !== 'boolean'
    || typeof candidate.proxyAvailable !== 'boolean'
    || typeof candidate.reason !== 'string'
    || candidate.reason.length === 0) {
    return false;
  }

  const nullableStrings = [candidate.profileName, candidate.importedAt, candidate.configHashPrefix];
  if (!nullableStrings.every((field) => field === null || typeof field === 'string')) return false;

  const metadataMatches = candidate.configured
    ? typeof candidate.profileName === 'string'
      && candidate.profileName.length > 0
      && typeof candidate.importedAt === 'string'
      && !Number.isNaN(Date.parse(candidate.importedAt))
      && typeof candidate.configHashPrefix === 'string'
      && /^[a-f0-9]{12}$/i.test(candidate.configHashPrefix)
    : nullableStrings.every((field) => field === null);
  if (!metadataMatches) return false;

  if (candidate.phase === 'unrestricted') {
    return !candidate.managed && !candidate.configured && !candidate.proxyAvailable;
  }
  if (!candidate.managed) return false;
  if (candidate.phase === 'unconfigured') return !candidate.configured && !candidate.proxyAvailable;
  if (candidate.phase === 'starting') return candidate.configured && !candidate.proxyAvailable;
  if (candidate.phase === 'ready') return candidate.configured && candidate.proxyAvailable;
  return !candidate.proxyAvailable;
}

export function ManagedDeploymentProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<ManagedWorkbenchStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const mountedRef = useRef(true);
  const requestIdRef = useRef(0);
  const controllerRef = useRef<AbortController | null>(null);

  const refreshNow = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    try {
      const response = await fetch('/api/managed-deployment/status', {
        cache: 'no-store',
        signal: controller.signal,
      });
      const value = await response.json().catch(() => null);
      if (mountedRef.current && requestId === requestIdRef.current) {
        setStatus(response.ok && isManagedStatus(value) ? value : FAILED_STATUS);
      }
    } catch {
      if (mountedRef.current && requestId === requestIdRef.current && !controller.signal.aborted) {
        setStatus(FAILED_STATUS);
      }
    } finally {
      if (mountedRef.current && requestId === requestIdRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    const timer = window.setTimeout(() => void refreshNow(), 0);
    return () => {
      mountedRef.current = false;
      window.clearTimeout(timer);
      controllerRef.current?.abort();
    };
  }, [refreshNow]);

  useEffect(() => {
    if (loading || !status || !status.managed || !['starting', 'failed'].includes(status.phase)) return;
    const timer = window.setInterval(() => void refreshNow(), 1000);
    return () => window.clearInterval(timer);
  }, [loading, refreshNow, status]);

  const value: ManagedDeploymentContextValue = {
    loading,
    status,
    locked: Boolean(status?.managed && status.phase !== 'ready'),
    refreshNow,
  };

  return <ManagedDeploymentContext.Provider value={value}>{children}</ManagedDeploymentContext.Provider>;
}

export function useManagedDeployment(): ManagedDeploymentContextValue {
  const value = useContext(ManagedDeploymentContext);
  if (!value) throw new Error('useManagedDeployment must be used within ManagedDeploymentProvider');
  return value;
}
