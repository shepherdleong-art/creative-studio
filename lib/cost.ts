import { v4 as uuidv4 } from 'uuid';

export interface CostRecord {
  runId?: string;
  jobId: string;
  provider: string;
  model: string;
  inputFilename: string;
  status: string;
  attempts: number;
  latencySeconds: number;
  estimatedCost: number;
  errorMessage?: string;
  outputFilename?: string;
  providerTaskId?: string;
  providerStatus?: string;
}

export function calculateEstimatedCost(
  defaultCostPerImage: number | undefined,
  attempt: number
): number {
  const baseCost = defaultCostPerImage ?? 0;
  return baseCost * (attempt + 1);
}

export function formatCost(cost: number): string {
  return `¥${cost.toFixed(4)}`;
}

export function formatLatency(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function generateCSV(records: CostRecord[], projectId: string): string {
  const headers = [
    'run_id',
    'project_id',
    'job_id',
    'provider',
    'model',
    'input_filename',
    'status',
    'attempts',
    'latency_seconds',
    'estimated_cost_cny',
    'error_message',
    'output_filename',
    'provider_task_id',
    'provider_status',
  ];

  const rows = records.map((r) =>
    [
      r.runId || '',
      projectId,
      r.jobId,
      r.provider,
      r.model,
      r.inputFilename,
      r.status,
      r.attempts,
      r.latencySeconds,
      r.estimatedCost.toFixed(4),
      r.errorMessage || '',
      r.outputFilename || '',
      r.providerTaskId || '',
      r.providerStatus || '',
    ]
      .map((v) => `"${String(v).replace(/"/g, '""')}"`)
      .join(',')
  );

  return [headers.join(','), ...rows].join('\n');
}
