/** 执行器工厂注册表：fixture 与公司执行器通过同一入口选择（C1／C6）。 */

import type Database from 'better-sqlite3';
import type { CanvasExecutorMode } from '../types.ts';
import { findCanvasCapability } from '../capabilities.ts';
import { createCanvasFixtureAdapter } from './fixture.ts';
import { registerFixtureCanvasCapabilities } from './fixture-capabilities.ts';
import { createCompanyCanvasAdapter } from './company.ts';
import { createDefaultCanvasDeliverer, type CanvasMediaDeliverer } from './media-delivery.ts';
import { createExternalCanvasAdapter } from './external.ts';
import type { CanvasTaskAdapter } from './types.ts';

export interface CanvasAdapterDeps {
  db: Database.Database;
  storageRoot: string;
}

export type CanvasAdapterFactory = (deps: CanvasAdapterDeps) => CanvasTaskAdapter | null;

const factories = new Map<CanvasExecutorMode, CanvasAdapterFactory>();

export function registerCanvasAdapterFactory(mode: CanvasExecutorMode, factory: CanvasAdapterFactory): void {
  factories.set(mode, factory);
}

export function createCanvasAdapterForMode(
  mode: CanvasExecutorMode,
  deps: CanvasAdapterDeps,
): CanvasTaskAdapter | null {
  const factory = factories.get(mode);
  if (!factory) return null;
  return factory(deps);
}

// fixture 只在被 config 明确接受（显式标记的临时数据根）时才会被选中。
// 未实现的真实供应商不会被静默替换成 fixture。
registerCanvasAdapterFactory('fixture', () => {
  // 浏览器验收需要「任务确实在运行中」的窗口，节奏由 harness 显式给出。
  const delayMs = Number(process.env.CREATIVE_STUDIO_CANVAS_FIXTURE_DELAY_MS ?? '0');
  const polls = Number(process.env.CREATIVE_STUDIO_CANVAS_FIXTURE_POLLS ?? '1');
  const failFirstDownload = process.env.CREATIVE_STUDIO_CANVAS_FIXTURE_DOWNLOAD_FAIL_ONCE === '1';
  registerFixtureCanvasCapabilities();
  return createCanvasFixtureAdapter({
    defaultScript: {
      delayMs: Number.isFinite(delayMs) && delayMs > 0 ? delayMs : 0,
      pollsBeforeSuccess: Number.isFinite(polls) && polls > 0 ? polls : 1,
      ...(failFirstDownload ? { failFirstDownload: true } : {}),
    },
  });
});

// 公司执行器：复用旧工作台已验证的 COS／本机 URL 交付通道；素材交付可注入替换。
/**
 * 真实执行器入口：公司渠道与外部网关共用它，按能力表里的 providerKind 分流。
 * fixture 模式不走这里（fixture 有自己的适配器与数据根门禁）。
 */
export function createCanvasExecutorAdapter(
  deps: CanvasAdapterDeps,
  options: { deliverer?: CanvasMediaDeliverer } = {},
): CanvasTaskAdapter {
  const deliverer = options.deliverer ?? createDefaultCanvasDeliverer();
  const company = createCompanyCanvasAdapter({ db: deps.db, deliverer });
  const external = createExternalCanvasAdapter({ db: deps.db, storageRoot: deps.storageRoot, deliverer });
  const pick = (context: { capabilityKey: string }) => (
    findCanvasCapability(context.capabilityKey)?.providerKind === 'external' ? external : company
  );
  return {
    kind: 'company-or-external',
    prepare: (context, signal) => pick(context).prepare(context, signal),
    submit: (context, signal) => pick(context).submit(context, signal),
    poll: (context, signal) => pick(context).poll(context, signal),
    download: (context, signal) => pick(context).download(context, signal),
  };
}

registerCanvasAdapterFactory('company', (deps) => createCanvasExecutorAdapter(deps));

export { registerFixtureCanvasCapabilities };
export { createDefaultCanvasDeliverer };

export type { CanvasTaskAdapter };
