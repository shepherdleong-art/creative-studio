# Triage 标签

skill 们用五个固定的「分诊角色」说话。本仓库把它们映射成任务文件顶部的 `Status:` 值——不用 GitHub 标签。

| 角色（skill 里的说法） | 本仓库的写法 | 含义 |
| --- | --- | --- |
| `needs-triage` | `Status: needs-triage` | 待评估 |
| `needs-info` | `Status: needs-info` | 等提问者补信息 |
| `ready-for-agent` | `Status: ready-for-agent` | 已写清楚，可交给 agent 自动做 |
| `ready-for-human` | `Status: ready-for-human` | 需要人来做 |
| `wontfix` | `Status: wontfix` | 不做 |

任务文件没有 `Status:` 行时，按 `needs-triage` 处理。写成 `**Status:** <值>` 的加粗形式同样有效。

skill 提到某个角色时（比如「打上 AFK-ready 分诊标签」），用上表对应的值。要加新状态只加在这张表里，别在别处另起一套词。
