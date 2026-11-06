/**
 * 部署模块开关（R04）。
 *
 * 四个首版模块：常规五步（旧媒体/成片/脚本生成）、批量生产、详情页脚本、创作画布。
 * 开关只控制 worker 是否启动；关闭时 API/readiness 明确显示不可用，不创建任何后台循环。
 * local 默认维持既有行为；server 由部署配置显式写入。
 */

export type ModuleSwitchName = 'batch' | 'scriptStudio' | 'canvas' | 'scriptStudioScheduler';

export interface TeamModuleSwitches {
  batch: boolean;
  scriptStudio: boolean;
  /** 详情页脚本真机调度器；未显式授权时任务保持 queued，由恢复逻辑续跑。 */
  scriptStudioScheduler: boolean;
  canvas: boolean;
}

export type RuntimeEnvironment = Record<string, string | undefined>;

function readFlag(env: RuntimeEnvironment, key: string, fallback: boolean): boolean {
  const raw = env[key]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (['1', 'true', 'on', 'yes'].includes(raw)) return true;
  if (['0', 'false', 'off', 'no'].includes(raw)) return false;
  throw new Error(`${key} 只接受 0/1、true/false、on/off；当前值无法识别。`);
}

export function readTeamModuleSwitches(env: RuntimeEnvironment = process.env): TeamModuleSwitches {
  return {
    batch: readFlag(env, 'CREATIVE_STUDIO_MODULE_BATCH', true),
    scriptStudio: readFlag(env, 'CREATIVE_STUDIO_MODULE_SCRIPT_STUDIO', true),
    scriptStudioScheduler: readFlag(env, 'CREATIVE_STUDIO_SCRIPT_STUDIO_ENABLE_SCHEDULER', false),
    canvas: readFlag(env, 'CREATIVE_STUDIO_CANVAS_ENABLE', false),
  };
}

export function moduleSwitchEnv(switches: TeamModuleSwitches): Record<string, string> {
  return {
    CREATIVE_STUDIO_MODULE_BATCH: switches.batch ? '1' : '0',
    CREATIVE_STUDIO_MODULE_SCRIPT_STUDIO: switches.scriptStudio ? '1' : '0',
    CREATIVE_STUDIO_SCRIPT_STUDIO_ENABLE_SCHEDULER: switches.scriptStudioScheduler ? '1' : '0',
    CREATIVE_STUDIO_CANVAS_ENABLE: switches.canvas ? '1' : '0',
  };
}
