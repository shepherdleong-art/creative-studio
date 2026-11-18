/**
 * 02 号票：演示启动条件与开关。
 *
 * 规格要求 IT 能复现「画布关闭、批量与脚本保留、真实调度显式开启」，
 * 所以这些判断必须是纯函数并在这里钉住；启动脚本只负责把结果写进环境变量。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  demoModuleEnv,
  describeDemoModuleSwitches,
  readDemoModuleSwitches,
} from '../lib/demo-runtime.ts';
import { canvasFeatureEnabled } from '../lib/creative-canvas/config.ts';
import {
  DEMO_SCRIPT_PRODUCTION_MODES,
  assertScriptProductionModeAllowed,
  legacyScriptModesAllowed,
} from '../lib/script-studio/production-mode-policy.ts';

// ---- 默认演示环境：画布关闭，批量与脚本保留，真实调度关闭 ----
const defaults = readDemoModuleSwitches({});
assert.deepEqual(defaults, { canvas: false, batch: true, scriptStudio: true, scriptStudioScheduler: false });
const defaultEnv = demoModuleEnv(defaults);
assert.equal(defaultEnv.CREATIVE_STUDIO_CANVAS_ENABLE, '0', 'Demo 必须显式关闭画布');
assert.equal(defaultEnv.CREATIVE_STUDIO_MODULE_BATCH, '1');
assert.equal(defaultEnv.CREATIVE_STUDIO_MODULE_SCRIPT_STUDIO, '1');
assert.equal(defaultEnv.CREATIVE_STUDIO_SCRIPT_STUDIO_ENABLE_SCHEDULER, '0');

// ---- `.env.local` 里写 CANVAS_ENABLE=1 也不能打开画布 ----
const envFileTriesCanvas = readDemoModuleSwitches({ CREATIVE_STUDIO_CANVAS_ENABLE: '1' });
assert.equal(envFileTriesCanvas.canvas, false, '画布只认演示专用开关，不被 .env.local 打开');
// ---- 只有显式演示开关才放行 ----
assert.equal(readDemoModuleSwitches({ CREATIVE_STUDIO_DEMO_ALLOW_CANVAS: '1' }).canvas, true);
assert.equal(readDemoModuleSwitches({ CREATIVE_STUDIO_DEMO_ALLOW_CANVAS: 'yes' }).canvas, true);
assert.equal(readDemoModuleSwitches({ CREATIVE_STUDIO_DEMO_ALLOW_CANVAS: '0' }).canvas, false);

// ---- 批量/脚本可显式关闭；调度必须显式开启 ----
assert.equal(readDemoModuleSwitches({ CREATIVE_STUDIO_MODULE_BATCH: '0' }).batch, false);
assert.equal(readDemoModuleSwitches({ CREATIVE_STUDIO_MODULE_SCRIPT_STUDIO: '0' }).scriptStudio, false);
assert.equal(readDemoModuleSwitches({ CREATIVE_STUDIO_SCRIPT_STUDIO_ENABLE_SCHEDULER: '1' }).scriptStudioScheduler, true);
assert.equal(readDemoModuleSwitches({ CREATIVE_STUDIO_SCRIPT_STUDIO_ENABLE_SCHEDULER: '0' }).scriptStudioScheduler, false);

// ---- 摘要能让 IT 一眼看出范围 ----
assert.match(describeDemoModuleSwitches(defaults), /创作画布 关/);
assert.match(describeDemoModuleSwitches(defaults), /批量生产 开/);
assert.match(describeDemoModuleSwitches(defaults), /脚本调度 关/);
assert.match(describeDemoModuleSwitches({ ...defaults, scriptStudioScheduler: true }), /真实模型/);

// ---- 写回环境后，画布闸门真的读到关闭 ----
const previous = process.env.CREATIVE_STUDIO_CANVAS_ENABLE;
process.env.CREATIVE_STUDIO_CANVAS_ENABLE = defaultEnv.CREATIVE_STUDIO_CANVAS_ENABLE;
assert.equal(canvasFeatureEnabled(), false, '写回后画布 API/页面闸门读到关闭');
process.env.CREATIVE_STUDIO_CANVAS_ENABLE = '1';
assert.equal(canvasFeatureEnabled(), true, '显式打开时闸门才放行');
if (previous === undefined) delete process.env.CREATIVE_STUDIO_CANVAS_ENABLE;
else process.env.CREATIVE_STUDIO_CANVAS_ENABLE = previous;

// ---- 启动脚本与首页都不再引用「实拍混剪」入口 ----
const navigation = fs.readFileSync(new URL('../lib/workspace-navigation.ts', import.meta.url), 'utf8');
assert.doesNotMatch(navigation, /实拍混剪/, '首页新建清单不得再有实拍混剪入口');
const preview = fs.readFileSync(new URL('./local-preview.mjs', import.meta.url), 'utf8');
assert.match(preview, /readDemoModuleSwitches/, '启动脚本必须走共享演示开关');
assert.match(preview, /CREATIVE_STUDIO_DEPLOYMENT_MODE: 'server'/, '演示启动必须是团队模式');
assert.match(preview, /--hostname', '127\.0\.0\.1'/, '服务只监听回环地址');
assert.match(preview, /previewRoot/, '使用独立的演示数据根');

// ---- 03 号票：AI 写脚本只保留爆文模板改写 ----
assert.deepEqual([...DEMO_SCRIPT_PRODUCTION_MODES], ['template_rewrite']);
assert.equal(legacyScriptModesAllowed({}), false, '默认不允许旧模式');
assert.doesNotThrow(() => assertScriptProductionModeAllowed('template_rewrite', {}));
assert.throws(() => assertScriptProductionModeAllowed('standard', {}), /只支持爆文模板改写/);
assert.throws(() => assertScriptProductionModeAllowed('pain_solving_15s', {}), /只支持爆文模板改写/);
assert.doesNotThrow(
  () => assertScriptProductionModeAllowed('standard', { CREATIVE_STUDIO_SCRIPT_ALLOW_LEGACY_MODES: '1' }),
  '排障开关显式打开时才放行旧模式',
);

// 路由与 runner 都必须在入口拒绝旧模式（不是只在界面上隐藏）。
const taskRoute = fs.readFileSync(new URL('../app/api/projects/[id]/script-studio/tasks/route.ts', import.meta.url), 'utf8');
assert.match(taskRoute, /assertScriptProductionModeAllowed\(productionMode\)/, '创建任务必须校验写作模式');
assert.match(taskRoute, /body\.extractOnly === true/, '仅提取卖点库作为改写前置不受限制');
const runner = fs.readFileSync(new URL('../lib/script-studio/runner.ts', import.meta.url), 'utf8');
assert.match(runner, /assertScriptProductionModeAllowed\(productionMode\)/, '执行器必须再校验一次，旧快照不能执行');
const regenerate = fs.readFileSync(new URL('../app/api/projects/[id]/script-studio/scripts/[scriptId]/regenerate/route.ts', import.meta.url), 'utf8');
assert.match(regenerate, /legacyScriptModesAllowed/, '结果页再生成必须拒绝旧模式脚本');
const retry = fs.readFileSync(new URL('../app/api/projects/[id]/script-studio/tasks/[taskId]/retry/route.ts', import.meta.url), 'utf8');
assert.match(retry, /legacyScriptModesAllowed/, '补跑旧模式任务必须被拒绝');

// 面板不再提供两种旧模式的下拉选项。
const panel = fs.readFileSync(new URL('../components/script-studio/ScriptStudioPanel.tsx', import.meta.url), 'utf8');
assert.doesNotMatch(panel, /<option value="standard">多方向生成<\/option>/, '界面不得再提供多方向生成');
assert.doesNotMatch(panel, /<option value="pain_solving_15s">/, '界面不得再提供痛点解决型');
assert.match(panel, /value="template_rewrite" disabled/, '生产模式固定为爆文模板改写');

console.log('team demo runtime tests passed');
