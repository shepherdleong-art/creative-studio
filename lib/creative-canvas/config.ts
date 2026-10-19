/**
 * 画布服务端功能开关与执行器模式（技术约定 C1）。
 *
 * - CREATIVE_STUDIO_CANVAS_ENABLE：默认关闭。关闭时不开放页面／API，也不创建画布表、不启动 worker。
 * - CREATIVE_STUDIO_CANVAS_EXECUTOR：disabled（默认）｜fixture｜company；非法值按 disabled 处理。
 * - fixture 只允许在显式标记的临时数据根上启用，生产环境拒绝：
 *   必须同时设置 CREATIVE_STUDIO_CANVAS_TEST_ROOT=1 与 CREATIVE_STUDIO_DATA_ROOT。
 */

import type { CanvasExecutorMode } from './types.ts';

export interface CanvasRuntimeConfig {
  enabled: boolean;
  executor: CanvasExecutorMode;
  /** 请求的 fixture 模式是否被接受；被拒绝时给出原因。 */
  fixtureAccepted: boolean;
  fixtureRejection: string | null;
}

export function canvasFeatureEnabled(): boolean {
  return process.env.CREATIVE_STUDIO_CANVAS_ENABLE === '1';
}

export function canvasFixtureRootMarked(): boolean {
  return process.env.CREATIVE_STUDIO_CANVAS_TEST_ROOT === '1'
    && Boolean(process.env.CREATIVE_STUDIO_DATA_ROOT);
}

export function readCanvasRuntimeConfig(): CanvasRuntimeConfig {
  const requested = process.env.CREATIVE_STUDIO_CANVAS_EXECUTOR;
  const enabled = canvasFeatureEnabled();
  if (requested === 'company') {
    return { enabled, executor: 'company', fixtureAccepted: false, fixtureRejection: null };
  }
  if (requested === 'fixture') {
    if (canvasFixtureRootMarked()) {
      return { enabled, executor: 'fixture', fixtureAccepted: true, fixtureRejection: null };
    }
    return {
      enabled,
      executor: 'disabled',
      fixtureAccepted: false,
      fixtureRejection: 'fixture 执行器只允许在显式标记的临时数据根上启用（需要 CREATIVE_STUDIO_CANVAS_TEST_ROOT=1 与 CREATIVE_STUDIO_DATA_ROOT）。',
    };
  }
  return { enabled, executor: 'disabled', fixtureAccepted: false, fixtureRejection: null };
}

export function canvasExecutorMode(): CanvasExecutorMode {
  return readCanvasRuntimeConfig().executor;
}
