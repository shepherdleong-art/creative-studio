import assert from 'node:assert/strict';
import fs from 'node:fs';

const settingsComponent = fs.readFileSync(new URL('../components/script-studio/ScriptKnowledgeSettings.tsx', import.meta.url), 'utf8');
const settingsPage = fs.readFileSync(new URL('../app/settings/page.tsx', import.meta.url), 'utf8');
const strategyImport = fs.readFileSync(new URL('../app/api/script-studio/catalogs/strategy/import/route.ts', import.meta.url), 'utf8');
const templateImport = fs.readFileSync(new URL('../app/api/script-studio/catalogs/template/import/route.ts', import.meta.url), 'utf8');
const httpModule = fs.readFileSync(new URL('../lib/script-studio/http.ts', import.meta.url), 'utf8');
const catalogsRoute = fs.readFileSync(new URL('../app/api/script-studio/catalogs/route.ts', import.meta.url), 'utf8');
const currentRoute = fs.readFileSync(new URL('../app/api/script-studio/catalogs/[catalogId]/current/route.ts', import.meta.url), 'utf8');
const assetRoute = fs.readFileSync(new URL('../app/api/script-studio/template-assets/[assetId]/route.ts', import.meta.url), 'utf8');
const catalogsModule = fs.readFileSync(new URL('../lib/script-studio/catalogs.ts', import.meta.url), 'utf8');
const panel = fs.readFileSync(new URL('../components/script-studio/ScriptStudioPanel.tsx', import.meta.url), 'utf8');
const knowledgeContextModule = fs.readFileSync(new URL('../lib/script-studio/knowledge-context.ts', import.meta.url), 'utf8');
const titleEmbeddingModule = fs.readFileSync(new URL('../lib/script-studio/title-embedding.ts', import.meta.url), 'utf8');
const generatorModule = fs.readFileSync(new URL('../lib/script-studio/generator.ts', import.meta.url), 'utf8');

// 设置页：挂载独立组件，不继续膨胀设置页主体。
assert.match(settingsPage, /ScriptKnowledgeSettings/, '设置页必须挂载「脚本知识与模板」组件');
assert.match(settingsPage, /脚本知识与模板/, '设置页必须出现「脚本知识与模板」区块标题');
assert.match(settingsPage, /id: 'script-knowledge'/, '新增设置分类 id 必须为 script-knowledge');

// 组件契约：读取目录列表、分别导入两类、激活历史版本。
assert.match(settingsComponent, /fetch\('\/api\/script-studio\/catalogs'/, '组件必须读取目录列表');
assert.match(settingsComponent, /catalogs\/\$\{kind\}\/import/, '组件必须分别提交策略/模板导入');
assert.match(settingsComponent, /catalogs\/\$\{catalogId\}\/current/, '组件必须能激活历史修订');
assert.match(settingsComponent, /accept="\.xlsx"/, '上传控件只接受 .xlsx');
assert.match(settingsComponent, /产品策略知识库/, '组件必须展示产品策略知识库');
assert.match(settingsComponent, /脚本模板库/, '组件必须展示脚本模板库');
assert.match(settingsComponent, /历史版本/, '组件必须展示不可变版本历史');
assert.match(settingsComponent, /激活/, '组件必须提供激活历史版本入口');
assert.match(settingsComponent, /相同文件重复导入不会产生新版本/, '组件必须说明内容指纹幂等语义');
assert.doesNotMatch(settingsComponent, /method: 'DELETE'|删除版本|删除修订/, '目录只增不改，不得提供物理删除动作');

// 导入边界：只接受 .xlsx、大小上限、内容校验、来源文件路径不硬编码。
for (const [source, label] of [[strategyImport, '策略导入'], [templateImport, '模板导入']]) {
  assert.match(source, /readCatalogImportUpload/, `${label} 必须走共享上传校验 helper`);
  assert.match(source, /assertScriptStudioApiReady/, `${label} 必须先过 Script Studio readiness gate`);
  assert.doesNotMatch(source, /I:\\\\|I:[/]|2025-LINSY|电商×内容摄制/, `${label} 不得硬编码业务 Excel 绝对路径`);
}
assert.match(httpModule, /\.xlsx\$/, '共享上传校验必须只接受 .xlsx');
assert.match(httpModule, /maxCatalogImportBytes/, '大小上限必须来自 limits.ts 的集中配置');
assert.match(strategyImport, /importStrategyCatalog/, '策略导入必须调用目录服务');
assert.match(templateImport, /importTemplateCatalog/, '模板导入必须调用目录服务');

// 目录读取与激活：返回稳定错误码、只切当前指针。
assert.match(catalogsRoute, /strategy'\] as const|'strategy'|'template'/, '目录列表必须覆盖策略与模板两类');
assert.match(currentRoute, /setCatalogCurrentRevision/, '激活只切当前修订指针');
assert.match(currentRoute, /revisionId/, '激活必须校验 revisionId');
assert.match(currentRoute, /status: 404/, '目录不存在必须返回 404');
assert.match(catalogsModule, /sourceSha256/, '修订必须保存内容指纹');
assert.match(catalogsModule, /matchStrategyEntry/, '必须提供型号匹配领域函数');
assert.match(catalogsModule, /normalizeModelKey\(`\$\{modelKey\}-\$\{submodel\}`\)/, '子型号匹配必须先试「型号-子型号」组合');
assert.doesNotMatch(catalogsModule, /fuzzy|Levenshtein|includes\(modelKey\)/, '型号匹配不得使用模糊算法');

// 参考图服务：受控路径 + symlink 守卫。
assert.match(assetRoute, /script_studio_template_assets/, '参考图服务必须读取模板资产表');
assert.match(assetRoute, /assertNoStorageSymlink/, '参考图读取必须经受控路径与 symlink 守卫');
assert.match(assetRoute, /status: 404/, '参考图不存在必须返回 404');

// Phase 5/6：脚本卡片展示知识匹配状态、推荐说明与参考图（按需展开，不嵌入正文）。
assert.match(panel, /KnowledgeBadge/, '脚本卡片必须挂载知识匹配状态组件');
assert.match(panel, /RecommendationBlock/, '脚本卡片必须挂载推荐说明组件');
assert.match(panel, /未匹配产品策略，已按详情页卖点正常生成/, '未匹配必须给出中性提示，不阻断');
assert.match(panel, /已匹配策略/, '匹配成功必须给出状态标识');
assert.match(panel, /核心框架/, '推荐说明必须展示核心框架');
assert.match(panel, /文案钩子/, '推荐说明必须展示文案钩子');
assert.match(panel, /画面钩子/, '推荐说明必须展示画面钩子');
assert.match(panel, /查看参考图/, '参考图必须按需展开');
assert.match(panel, /template-assets\//, '参考图必须走受管资产服务');
assert.doesNotMatch(panel, /bg-fail.*未匹配产品策略|未匹配产品策略.*bg-fail/, '未匹配提示不得使用失败色');

// 任务创建冻结知识上下文：型号匹配、指纹、模板推荐进入快照。
assert.match(knowledgeContextModule, /resolveKnowledgeContext/, '必须提供知识上下文解析');
assert.match(knowledgeContextModule, /matchStrategyEntry/, '知识解析必须走型号匹配');
assert.match(knowledgeContextModule, /fingerprint/, '知识上下文必须携带指纹');
assert.match(titleEmbeddingModule, /checkTitleEmbedding/, '必须提供标题埋词校验');
assert.match(titleEmbeddingModule, /至少 1 个|1-2 个|too_many_search_terms/, '埋词约束必须覆盖 1-2 个搜索词');
assert.match(generatorModule, /embeddingRequirementText/, '生成 prompt 必须注入埋词约束');
assert.match(generatorModule, /recommendation/, '生成 prompt 必须注入推荐说明');

console.log('script-studio knowledge UI contract tests passed');
