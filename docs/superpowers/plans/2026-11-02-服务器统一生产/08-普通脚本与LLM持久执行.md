# 08 普通脚本与LLM持久执行

**状态：** `needs-triage`  
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

