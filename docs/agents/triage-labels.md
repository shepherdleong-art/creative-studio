# Triage 标签

skill 们用五个固定的「分诊角色」说话。本仓库把它们映射成任务文件顶部的状态行——不用 GitHub 标签。

| 角色（skill 里的说法） | 本仓库的写法 | 含义 |
| --- | --- | --- |
| `needs-triage` | `**状态：** \`needs-triage\`` | 待评估 |
| `needs-info` | `**状态：** \`needs-info\`` | 等提问者补信息 |
| `ready-for-agent` | `**状态：** \`ready-for-agent\`` | 已写清楚，可交给 agent 自动做 |
| `ready-for-human` | `**状态：** \`ready-for-human\`` | 需要人来做 |
| `wontfix` | `**状态：** \`wontfix\`` | 不做 |

任务文件用**中文加粗状态行** `**状态：** \`<值>\``，和 `docs/superpowers/plans/2026-10-28-实拍混剪新规矩/` 下的现有任务一致。也接受 `Status:` / `**Status:**` 的英文写法（skill 模板原样产出时不用改）。没有状态行时按 `needs-triage` 处理。

skill 提到某个角色时（比如「打上 AFK-ready 分诊标签」），用上表对应的值。要加新状态只加在这张表里，别在别处另起一套词。
