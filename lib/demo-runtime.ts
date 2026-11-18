/**
 * 团队工作台四步制作演示版的运行开关（02 号票）。
 *
 * 规格要求 Demo 显式关闭创作画布、保留批量生产与脚本工作室；真实脚本调度
 * 只在获准使用真实模型的演示环境显式打开。这里做成纯函数，启动脚本与测试共用。
 *
 * 画布在演示里**强制关闭**：`.env.local` 里的同名变量不生效，只有显式设置
 * `CREATIVE_STUDIO_DEMO_ALLOW_CANVAS=1` 才放行——演示范围由规格钉死。
 */

export type DemoEnvironment = Record<string, string | undefined>;

function enabled(value: string | undefined): boolean {
  return ['1', 'true', 'on', 'yes'].includes(value?.trim().toLowerCase() ?? '');
}

export interface DemoModuleSwitches {
  canvas: boolean;
  batch: boolean;
  scriptStudio: boolean;
  scriptStudioScheduler: boolean;
}

export function readDemoModuleSwitches(env: DemoEnvironment): DemoModuleSwitches {
  return {
    canvas: enabled(env.CREATIVE_STUDIO_DEMO_ALLOW_CANVAS),
    batch: env.CREATIVE_STUDIO_MODULE_BATCH?.trim() !== '0',
    scriptStudio: env.CREATIVE_STUDIO_MODULE_SCRIPT_STUDIO?.trim() !== '0',
    scriptStudioScheduler: enabled(env.CREATIVE_STUDIO_SCRIPT_STUDIO_ENABLE_SCHEDULER),
  };
}

/** 写回环境变量，交给 Next / 团队服务读取（它们都只认 `CREATIVE_STUDIO_*`）。 */
export function demoModuleEnv(switches: DemoModuleSwitches): Record<string, string> {
  return {
    CREATIVE_STUDIO_CANVAS_ENABLE: switches.canvas ? '1' : '0',
    CREATIVE_STUDIO_MODULE_BATCH: switches.batch ? '1' : '0',
    CREATIVE_STUDIO_MODULE_SCRIPT_STUDIO: switches.scriptStudio ? '1' : '0',
    CREATIVE_STUDIO_SCRIPT_STUDIO_ENABLE_SCHEDULER: switches.scriptStudioScheduler ? '1' : '0',
  };
}

/** 启动日志里的单行摘要，IT 一眼能看出这个演示环境开了什么。 */
export function describeDemoModuleSwitches(switches: DemoModuleSwitches): string {
  return [
    `创作画布 ${switches.canvas ? '开' : '关'}`,
    `批量生产 ${switches.batch ? '开' : '关'}`,
    `脚本工作室 ${switches.scriptStudio ? '开' : '关'}`,
    `脚本调度 ${switches.scriptStudioScheduler ? '开（真实模型）' : '关（任务只排队）'}`,
  ].join('；');
}
