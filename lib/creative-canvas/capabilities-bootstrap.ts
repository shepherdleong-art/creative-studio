/**
 * 画布能力表的统一注册入口。
 *
 * 执行器决定注册哪一组能力：
 * - fixture：本地测试能力（evidence=candidate，只在被标记的临时数据根启用）；
 * - company：公司模型能力表在 P4 注册，未注册前不开放任何公司模型。
 *
 * 每个请求都会调用一次（幂等），避免依赖 instrumentation 与路由共享模块实例。
 */

import type Database from 'better-sqlite3';
import { COMPANY_CANVAS_CAPABILITIES } from './adapters/company-capabilities.ts';
import { registerExternalCanvasCapabilities } from './adapters/external-capabilities.ts';
import { registerFixtureCanvasCapabilities } from './adapters/fixture-capabilities.ts';
import { registerCanvasCapability } from './capabilities.ts';
import { canvasExecutorMode } from './config.ts';

export function ensureCanvasCapabilitiesRegistered(db?: Database.Database): void {
  const executor = canvasExecutorMode();
  if (executor === 'fixture') {
    registerFixtureCanvasCapabilities();
  }
  if (executor === 'company') {
    for (const capability of COMPANY_CANVAS_CAPABILITIES) registerCanvasCapability(capability);
    // 外部供应商：只在「行存在 + 已启用 + 已配置 Key」时注册
    if (db) registerExternalCanvasCapabilities(db, registerCanvasCapability);
  }
}
