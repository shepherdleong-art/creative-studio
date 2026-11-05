import assert from 'node:assert/strict';
import fs from 'node:fs';

/**
 * 公共爆文模板 UI 契约（票 01 / 规格 §3）。
 *
 * 只断言可见行为与文案约束：管理员闭环、去掉手填 ID、员工空状态指向管理员，
 * 以及 local 设置页导入仍保留。
 */

const panel = fs.readFileSync(new URL('../components/team/TeamPublicResourcesPanel.tsx', import.meta.url), 'utf8');
const viralLibrary = fs.readFileSync(new URL('../components/team/TeamViralTemplateLibrary.tsx', import.meta.url), 'utf8');
const picker = fs.readFileSync(new URL('../components/script-studio/TemplateRewritePicker.tsx', import.meta.url), 'utf8');
const settings = fs.readFileSync(new URL('../components/script-studio/ViralTemplateSettings.tsx', import.meta.url), 'utf8');
const adminPage = fs.readFileSync(new URL('../app/team/admin/resources/page.tsx', import.meta.url), 'utf8');
const teamRoute = fs.readFileSync(new URL('../app/api/team/public-resources/viral-templates/route.ts', import.meta.url), 'utf8');
const generalRoute = fs.readFileSync(new URL('../app/api/team/public-resources/route.ts', import.meta.url), 'utf8');
const publishModule = fs.readFileSync(new URL('../lib/script-studio/viral-templates-team.ts', import.meta.url), 'utf8');

// ---- 管理员正式入口是公共资源页的「爆文模板库」卡片 ----
assert.match(panel, /TeamViralTemplateLibrary/, '公共资源页必须挂载爆文模板库卡片');
assert.match(adminPage, /TeamPublicResourcesPanel/, '管理员公共资源页沿用现有面板');
assert.match(viralLibrary, /爆文模板库/, '卡片标题必须是「爆文模板库」');
assert.match(viralLibrary, /上传 \.xlsx/, '管理员必须能直接上传文件');
assert.match(viralLibrary, /发布给团队/, '必须有明确的「发布给团队」按钮');
assert.match(viralLibrary, /发布预览（确认后才替换团队版本）/, '必须先预览再发布');
assert.match(viralLibrary, /团队当前版本 v\{current\.revisionNumber\}/, '必须展示当前团队版本号');
assert.match(viralLibrary, /当前内容：/, '必须展示当前版本可用条目数');
assert.match(viralLibrary, /设为当前版本/, '必须能切换已发布的历史版本');
assert.match(viralLibrary, /可发布的既有导入版本/, '必须能发布此前导入的版本');

// ---- 爆文模板不再依赖手工「资源类型 + 资源 ID」表单 ----
assert.doesNotMatch(panel, /value: 'viral_template_library'/, '逐条发布表单不得再列爆文模板库');
assert.doesNotMatch(panel, /value: 'viral_template_revision'/, '逐条发布表单不得再列爆文模板修订');
assert.doesNotMatch(panel, /value: 'viral_template_entry'/, '逐条发布表单不得再列爆文模板条目');
assert.match(panel, /不需要填写资源 ID/, '必须明确爆文模板不走 ID 表单');
assert.doesNotMatch(viralLibrary, /<(?:input|textarea)[^>]*(?:placeholder|value)=\{[^}]*resourceId[^}]*\}/, '爆文模板发布界面不得要求手填内部 ID');

// ---- 发布必须带基准版本做 CAS；失败不改旧版本 ----
assert.match(viralLibrary, /baseRevisionId=/, '上传发布必须显式携带基准版本');
assert.match(teamRoute, /baseRevisionId/, '路由必须接收基准版本');
assert.match(teamRoute, /缺少基准版本/, '缺少基准版本必须拒绝而不是静默覆盖');
assert.match(publishModule, /conflict/, '并发冲突必须报 conflict');
assert.match(publishModule, /团队当前版本保持不变/, '无可用条目时明确旧版本不变');
assert.match(generalRoute, /use_team_publish/, '逐条发布入口必须把爆文模板类型引导到原子发布入口');

// ---- 员工空状态指向管理员发布，不再引导去无权访问的设置页 ----
assert.match(picker, /团队还没有发布爆文模板库，请联系管理员/, '员工空状态必须提示联系管理员');
assert.doesNotMatch(picker, /请先到「设置 → 脚本知识与模板 → 爆文模板库」导入 \.xlsx。'[\s\S]{0,40}团队/,
  '员工空状态不能把团队场景引导到个人设置页');
assert.match(picker, /hasCurrentRevision/, '空状态必须依据真实「有无当前版本」而不是「可用数为 0」');
assert.match(settings, /公共资源 → 爆文模板库/, '设置页必须说明团队版本由公共资源页发布');
assert.match(settings, /canManage/, '设置页必须按 canManage 区分管理员与员工');

// ---- local 兼容：设置页导入入口保留 ----
assert.match(settings, /导入 \.xlsx/, 'local 设置页导入入口必须保留');
assert.match(settings, /import\?mode=preview/, 'local 预览仍走既有个人导入接口');

console.log('team viral template UI contract tests passed');
