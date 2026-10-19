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
import { registerCanvasCapability, listCanvasCapabilities, type CanvasModelCapability } from './capabilities.ts';
import { configuredCanvasImages } from './adapters/configured-images.ts';
import { configuredCanvasVideos } from './adapters/configured-videos.ts';
import { canvasExecutorMode } from './config.ts';

export function ensureCanvasCapabilitiesRegistered(db?: Database.Database): CanvasModelCapability[] {
  const executor = canvasExecutorMode();
  if (executor === 'fixture') {
    registerFixtureCanvasCapabilities();
  }
  if (executor === 'company') {
    for (const capability of COMPANY_CANVAS_CAPABILITIES) {
      registerCanvasCapability(capability);
    }
    // 外部供应商：只在「行存在 + 已启用 + 已配置 Key」时注册
    if (db) {
      const configured = [...configuredCanvasImages(db), ...configuredCanvasVideos(db)];
      for (const capability of configured) registerCanvasCapability(capability);
      const externalKeys = registerExternalCanvasCapabilities(db, registerCanvasCapability);
      const available = new Set([...configured.map((capability) => capability.key), ...externalKeys]);
      // 历史能力留在注册表供在途任务恢复；选择列表只含当前设置中可用的项。
      return listCanvasCapabilities().filter((capability) => available.has(capability.key));
    }
  }
  return executor === 'disabled' ? [] : listCanvasCapabilities();
}
