'use client';

import { createContext } from 'react';
import type { CanvasGenerationMode, CanvasGraph, CanvasMediaKind, CanvasReferenceRole } from '@/lib/creative-canvas/types';
import type { CanvasEditorController } from './editor-store';

export interface CanvasCapabilityParameterDto {
  key: string;
  label: string;
  type: 'enum' | 'integer' | 'number' | 'boolean' | 'string';
  options?: string[];
  min?: number;
  max?: number;
  default?: string | number | boolean;
}

export interface CanvasModelCapabilityDto {
  key: string;
  displayName: string;
  mediaKind: Exclude<CanvasMediaKind, 'audio'>;
  modes: CanvasGenerationMode[];
  inputs: Array<{ kind: CanvasMediaKind | 'text'; roles: CanvasReferenceRole[]; min: number; max: number }>;
  parameters: CanvasCapabilityParameterDto[];
  cancellation: boolean;
  evidence: 'verified' | 'mapped' | 'candidate';
  evidenceNote: string;
  providerKind: 'company' | 'external';
}

export interface CanvasNodeContextValue {
  controller: CanvasEditorController;
  capabilities: CanvasModelCapabilityDto[];
  /** 当前本地图（含未保存草稿）的解析结果，用于连线与提及校验。 */
  graph: CanvasGraph;
  /** 某个来源节点当前可用的素材（素材节点取 assetId，生成节点取当前结果）。 */
  resolveSourceAssetId: (sourceNodeId: string) => string | null;
}

export const CanvasNodeContext = createContext<CanvasNodeContextValue | null>(null);
