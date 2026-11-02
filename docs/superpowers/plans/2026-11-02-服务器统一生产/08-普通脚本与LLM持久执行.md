# 08 普通脚本与LLM持久执行

**状态：** `ready-for-human`
**依赖：** [04 文件与公共资源隔离](04-文件与公共资源隔离.md)、[06 统一准入与调用台账](06-统一准入与调用台账.md)  
**目标：** 将普通第三步脚本从内存闭包改为持久任务，并覆盖全部 LLM 付费传输。

## 动手前

阅读 [技术方案](../../specs/2026-11-02-服务器统一生产-技术方案.md) 中对应章节与仓库 AGENTS.md；改动具体模块前读取其 docs/reference 文档。先核实依赖任务的完成证据，再将状态调整为可实施。本任务单描述待做工作，不代表功能已存在。

## 改动范围

修改 `lib/script-generation-manager.ts`、`script-generation-v3-service.ts`、`script-generation-v3.ts`、`lib/script-providers/`、`lib/usage-llm.ts`、项目 script/script-generation 及资料 organize 等路由。

## 实施步骤

1. 持久化 generationId 的输入、actor/scope、阶段、调用检查点与最终草稿 ID；worker 可仅靠记录重建执行。每次链内 LLM 调用缺准入时保存 continuation 并返回 deferred，不在内存闭包里占槽等待，也不把 deferred 当作失败修复循环。
2. server 的长同步生成请求受理后返回任务身份，保留进度流/查询接口；HTTP 断开不取消生产，本地合同不变。
3. completeJson 和 analyzeSellingPoints 均传稳定调用上下文；每种协议的实际 POST、流结束和内部温度回退记录尝试。
4. 视频分析、语义匹配、卖点与包装提取等共用此入口；明确拒绝后的合法回退与不确定网络中断分别处理。

## 完成标准

- 服务重启后普通脚本可恢复到未完成阶段，已完成草稿不重复创建；不要求旧闭包仍存在。
- 流中断不被当作免费未提交；等待准入不消耗提交次数；实际 POST 与尝试记录对应。
- 用户切换/停用不串流或泄露草稿，既有公司 temperature=1 与协议错误脱敏保持。

## 验证

复用 `script-generation-{manager,route,v3}.test.ts`、`script-generation-route-contract.test.mjs`、`usage-llm.test.ts`；新增重启、流中断、内部重试和断线继续执行测试。

新增行为测试使用临时数据根并在动态导入前设置环境；具体运行方式以已有测试文件头为准。完成时记录修改文件、测试命令/结果、剩余阻断和依赖变化，不把未执行的检查写成通过。

## Comments

### 2026-11-02 实现交付

- `script_generation_tasks` 持久保存 generation 输入、actor/scope、executor、进度、检查点和受理时固定的 draftId；`script-generation-v3-server` 注册无闭包恢复器并接入 team runtime 生命周期。server POST 仍返回 202 任务身份，GET/DELETE 读持久状态，HTTP 断开不取消；local 管理器与接口合同保持不变。`script_drafts` 按固定 ID 幂等写回，覆盖草稿已提交但任务终态未写回的崩溃窗口。
- `script-providers` 公共 `completeJson` / `analyzeSellingPoints` 在 server 经 06 `enqueue → admit → markSubmitting → transmit → settle` 执行；continuation 按 key 注册/分派，未注册模块 fail closed。缺名额返回专用 deferred，不创建 attempt、不消耗提交预算；unknown/reconciling 使用独立等待错误，不进入失败修正循环。操作冻结供应商身份，重放读取原快照；`llm_execution_checkpoints` 在流结束后、回执前保存原始正文，覆盖 result 尚未结算的恢复窗口。
- OpenAI-compatible、Responses、Anthropic Messages 与 Native Gemini 的每个真实 POST/完整流读取均记 transport attempt 并分别计价。明确温度 400 才允许内部回退，新增 transport 与费用预留并复用原并发 permit；网络/流中断保持 maybe_sent/unknown，不盲目重提。Luna 前缀强制 `temperature=1`、V3 固定 1 和未知模型一次回退三层合同保留；协议错误继续使用安全分类，不扩散上游正文。
- 普通脚本分析/生成、资料 organize、详情公共 LLM 工厂、视频分析、批量与单条语义匹配、智能贴合和包装卖点提取均传稳定 task/step/scope。仅接公共传输与身份，不提前实现 09 的批量/详情 scheduler、媒体资源闸门或转码去重。
- 06 结算补齐“不限额且费用未知的同步成功”幂等分支的 `resultJson` 写回；既有 execution operations/admission/attempts/journal/reconciliation/team-context 回归通过。

实际通过的新增/定向验证：

```text
node scripts/script-generation-persistence.test.ts
node scripts/script-provider-execution.test.ts
node scripts/script-generation-manager.test.ts
node scripts/script-generation-route.test.ts
node --loader ./scripts/typescript-extension-loader.mjs scripts/script-generation-v3.test.ts
node scripts/script-generation-route-contract.test.mjs
node scripts/script-route-v3.test.ts
node scripts/usage-llm.test.ts
node --loader ./scripts/typescript-extension-loader.mjs scripts/openai-responses-adapter.test.ts
node --loader ./scripts/typescript-extension-loader.mjs scripts/anthropic-messages-adapter.test.ts
node scripts/db-migrations.test.ts
npx tsc --noEmit
定向 ESLint（全部本任务源码与测试）
```

- 新测试覆盖重启仅凭记录恢复、固定草稿只建一次、deferred 零提交预算、SSE/网络 unknown、内部温度回退双 transport/双费用记录、持久正文与供应商配置漂移重放、断线继续及 A/B actor/scope 隔离。语义、视频分析、包装和详情相关既有测试均通过。
- 01–04/06 分组回归通过，含 runtime/auth/scope/files、schema-upgrade/graceful-shutdown 与全部 execution 测试；`node scripts/team-api-coverage.test.mjs` 通过（217 routes / 271 methods）。`npm run check:main-path` 最终通过，真实付费调用 0 次。
- 未调用真实供应商、未做生产容量或真实 Windows Server 验收。批量/详情调度细节与媒体资源恢复仍属 09；受控 `llm:remote` 池和成员额度需按 06 配置，未擅自填入生产容量。任务提到的独立 `module-adapters` 调研笔记未在仓库或既有工作树找到，实施以 06 已冻结 contracts、admission、attempts 与 reconciliation 源码为准。

