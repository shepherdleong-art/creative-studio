# Packy GPT-Image-2 Test Checklist

## 配置

- [ ] 在 Packy 后台创建 Sora 组的 API Token
- [ ] 工作台 `/settings` → 编辑 Packy GPT-Image-2：
  - Base URL: `https://www.packyapi.com`
  - Type: `Packy Images API (multipart, no polling)`
  - Model: `gpt-image-2`
  - API Key: 粘贴 Sora 组 Token

## 首次付费测试

- [ ] 输入图: 1 张
- [ ] 参考图: 0 张
- [ ] Quality: `low` 或 `medium`
- [ ] Size: `auto` 或 `1k`
- [ ] Concurrency: `1`
- [ ] Max attempts: `1`
- [ ] Prompt: 简单编辑，保持主体不变

## 参考图实验测试

首次单图测试成功后，再单独测试参考图：

- [ ] 输入图: 1 张
- [ ] 参考图: 1 张
- [ ] Quality: `low`
- [ ] Size: `auto` 或 `1k`
- [ ] Concurrency: `1`
- [ ] Max attempts: `1`
- [ ] Prompt: 明确说明参考图用途，例如“参考图是场景和光线风格，待处理图是产品主体；保持产品主体不变，只参考场景、光线和构图。”

说明：Packy 参考图目前是实验模式，工作台会把参考图和待处理图都作为 multipart `image` 字段提交，参考图在前，待处理图在最后。是否真正生效要以这次小样本测试结果为准。

## 预期行为

- [ ] 没有 task_id 产生
- [ ] 没有轮询
- [ ] 没有 needs_check
- [ ] 没有"补抓结果"按钮
- [ ] 请求等待直到 Packy 返回 data[0].url 或 data[0].b64_json
- [ ] 工作台下载并保存一张输出图
- [ ] job status = succeeded

## 如果超时

- [ ] 不要立即多次重试
- [ ] 检查 Packy 后台是否已扣费或已生成结果
- [ ] 确认网络/VPN 允许直连 packyapi.com
- [ ] 尝试更低的 quality 或更小的 size
