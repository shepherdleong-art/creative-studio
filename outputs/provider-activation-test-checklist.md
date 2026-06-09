# Provider Activation Test Checklist

## No-paid checks

- [ ] 配置至少两个供应商的 Key
- [ ] 禁用所有供应商
- [ ] 打开新建项目 → 应显示"当前没有启用的供应商"
- [ ] 启用一个供应商
- [ ] 打开新建项目 → 只出现该供应商，有 Key 则自动选中
- [ ] 启用两个供应商
- [ ] 在 Packy 上点"设为唯一启用"
- [ ] 打开新建项目 → 只出现 Packy
- [ ] 禁用一个已配置 Key 的供应商
- [ ] 重新打开设置 → Key 状态仍显示已配置（禁用未删除 Key）
- [ ] 通过 API 用已禁用的 providerId 创建项目 → 返回 400

## Paid checks

不适用——此功能仅控制供应商选择，无需付费 API 调用。
