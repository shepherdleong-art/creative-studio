/**
 * Versioned, encrypted company configuration payload.
 *
 * This module intentionally contains only the shape and safe (non-secret)
 * metadata types. Secrets are accepted at the boundary and are never returned
 * from the status API.
 */

export const PROVISIONING_SCHEMA_VERSION = 1 as const;

export type ProvisioningApiStyle =
  | 'openai-compatible'
  | 'openai-responses'
  | 'anthropic-messages'
  | 'doubao-http-chunked';

export interface ProvisioningProvider {
  id: string;
  name: string;
  type: string;
  apiStyle: ProvisioningApiStyle;
  baseUrl: string;
  model: string;
  enabled: boolean;
  /** Optional per-provider credential. Company profiles normally use the gateway key. */
  apiKey?: string;
  maxTokens?: number;
  supportsVision?: boolean;
  visionCostPerRequest?: number;
  defaultCostPerImage?: number;
  defaultDurationSec?: number;
  executionScope?: 'company';
  costPerThousandCharacters?: number;
}

export interface ProvisioningCosConfig {
  secretId: string;
  secretKey: string;
  domain: string;
  signHost?: string;
  prefix?: string;
  ttlSec?: number;
}

export interface ProvisioningPayload {
  schemaVersion: typeof PROVISIONING_SCHEMA_VERSION;
  profileName: string;
  gatewayApiKey: string;
  liteLlmConfigYaml: string;
  image: ProvisioningProvider;
  script: ProvisioningProvider;
  videos: ProvisioningProvider[];
  tts: ProvisioningProvider;
  cos: ProvisioningCosConfig;
}

export interface ProvisioningStatus {
  configured: boolean;
  profileName: string | null;
  importedAt: string | null;
  configHashPrefix: string | null;
}
