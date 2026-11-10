# MiniMax H3 与 Wan 3.0 消耗单价

用户于 2026-11-10 提供账单均价，并确认按 5 秒折算，用于本地费用估算。

| 模型 | 账单净消耗 | 单价 | 10 秒估算 |
| --- | ---: | ---: | ---: |
| minimax-h3 | ¥8.00 | ¥4.00 / 5 秒 | ¥8.00 |
| wan-3.0 | ¥42.00 | ¥6.00 / 5 秒 | ¥12.00 |

统一注册在 `lib/usage-pricing.ts` 的 `BILLING_MODEL_PRICES`，沿用公司视频供应商身份校验、按请求时长折算和冻结快照规则。消耗看板同步提供模型筛选与趋势图例。成功但无快照、无账本的旧视频任务由既有对账流程补记；已有快照和账本金额不覆盖。其余模型价格不变。

## 服务器发布

用户确认保留工作台现有估算口径后，已更新 `https://ai-test-pc.linshimuye.local`，未按随后提供的参考价或其他日期账单调价。

- 当前版本：`team-server-model-pricing-20261110-r1`；前版 `team-server-beta-csrf-20261109-r1`。发布包位于 `outputs/01-服务器/发布包/`，manifest SHA-256：`71069ba8ae4576f1849e345da91a6f63e8bc7d783b566fe6a0582a08e752e7c2`。
- 基于当前 main `e454c27a` 加本次未提交计价补丁构建；源码差异保存在部署证据的 `source.patch`。相对旧服务器包也包含 main 已合入的首次改密修复，认证与认证路由测试通过，数据库副本完成首次登录及改密验证。
- 生产构建、TypeScript、计价、账本、查询和 UI 契约回归通过；37,802 文件完整校验与本机/服务器原生探针通过。视频记账测试原有的 resume-poll 静态断言失败已在修改前版本复现，不宣称该测试整文件通过。
- 生产数据库 Online Backup 副本验证两项价格、5/10 秒折算、快照解析及启动对账；既有账本逐行保持，schema 16 不变，历史错误与业务数据保持，无真实供应商调用。
- 受控发布 `model-pricing-20261110-r1` 的 11 个阶段全部 completed；升级前备份 `model-pricing-20261110-r1-pre-upgrade` 已验证。恢复时按既有 WinSW 问题处理流程核验归属后重启服务，原发布作业正常完成，没有手改发布回执。
- 线上 HTTPS `ready=true / maintenance=false`，13 个入口资源及 2 个包含 H3/Wan 计价的 JS 资源哈希一致。App、Caddy、Maintenance、LiteLLM 均运行新版路径；LiteLLM liveliness=200，3300/4300 仅监听回环，保留现场代理配置。
- 升级前后 10 张业务表数量一致、历史错误摘要一致、数据库完整性为 ok、pending submissions=0。客户端壳无需重装，刷新服务器页面即可。

构建、隔离验证、备份发布回执、前后审计与 HTTPS 核验：`outputs/05-日志与排查/2026-11-10-model-pricing-r1/`；服务器证据：`E:\CreativeStudio\deployment\preflight\model-pricing-20261110-r1\`。
