# GPT-Image-2 比例始终 1:1 问题 — 修复报告

> 基于 `ratio-bug-diagnosis.md` 的修复实施记录。  
> 项目路径：`/Users/liangpeijian/for-cc/batch-image-workbench`  
> 实施时间：2026-06-08  
> 构建状态：`npm run build` 通过，TypeScript 无错误  
> 验收状态：3/3 比例测试通过，DB size 正确

---

## 一、根因确认

| 根因 | 说明 |
|---|---|
| SIZE_PRESETS 映射错误 | 前端用的是自己编的映射表，不是 ComfyUI 节点的真实 SIZE_MAP |
| size 计算失败静默回退 1024x1024 | `SIZE_PRESETS[ratio]?.[res] \|\| '1024x1024'` 隐藏所有错误 |
| 清晰度 select 值与 state 不同步 | `value={condition ? resolution : fallback}` 只改显示不改 state |
| 3:4 被误当后处理 | 实际 ComfyUI 节点里 3:4 是三档原生尺寸 |
| 服务端也静默回退 | `size \|\| '1024x1024'` |

---

## 二、改动清单

### 新建文件

| 文件 | 用途 |
|---|---|
| `lib/gpt-image-2-size-presets.ts` | 共享尺寸配置——从 ComfyUI 节点同步的完整 SIZE_MAP |

### 修改文件

| 文件 | 关键改动 |
|---|---|
| `app/projects/new/page.tsx` | 删除 old SIZE_PRESETS + POSTPROCESS_DIMENSIONS；导入共享 presets；resolution 改为小写 `1k`/`2k`/`4k`；fix select 值同步；比例切换时自动矫正 resolution；删除 postprocessTarget；13 种比例全展示 |
| `app/api/projects/route.ts` | 服务端用 `resolveGptImage2Size(aspectRatio, resolution)` 计算 size；不接受非法 size（返回 400）；移除 `postprocessTarget` |
| `lib/queue.ts` | 删除 `containPadImage` import 和后处理逻辑；删除 `postprocessTarget` 字段 |

### 未删除但已不用的代码

| 文件 | 内容 | 状态 |
|---|---|---|
| `lib/image-preprocess.ts` | `containPadImage()` 函数 | 保留但队列不再调用 |
| `lib/db.ts` | `jobs.postprocessTarget` 列 | 保留但不再写入 |

---

## 三、关键修复细节

### 3.1 共享 SIZE_MAP（来自 ComfyUI）

```ts
// lib/gpt-image-2-size-presets.ts
'3:4':  { '1k': '864x1152',  '2k': '1728x2304', '4k': '2448x3264' },
'16:9': { '1k': '1280x720',  '2k': '2560x1440', '4k': '3840x2160' },
'9:16': { '1k': '720x1280',  '2k': '1440x2560', '4k': '2160x3840' },
// ... 13 种比例，每种 3 档分辨率
```

关键差异 vs 旧映射：
- 3:4 现在有四档原生尺寸（864x1152 / 1728x2304 / 2448x3264），不再是后处理
- 16:9 现在有 1k 档（1280x720），旧映射只有 2k/4k
- 新增 4:3, 5:4, 4:5, 2:1, 1:2, 21:9, 9:21 共 7 种比例

### 3.2 不再静默回退

```ts
// 之前（隐藏错误）
const size = SIZE_PRESETS[aspectRatio]?.[resolution] || '1024x1024';

// 之后（报错）
const size = resolveGptImage2Size(aspectRatio, resolution);
// throws if invalid combination
```

服务端同样：
```ts
// 之前
size || '1024x1024'

// 之后
resolveGptImage2Size(aspectRatio, resolution)  // or 400 error
```

### 3.3 修复 select 同步 bug

之前 select 的 value 用了条件表达式：
```tsx
value={availableResolutions.includes(resolution) ? resolution : availableResolutions[0]}
```
这会导致切换比例后显示值变了但 React state 没变。

修复后：切换比例时主动调用 `setResolution()` 同步。

### 3.4 删除后处理

3:4 现在是原生尺寸，不再走 contain-pad。相关代码已从 `queue.ts` 移除。

---

## 四、验收结果

| # | 测试 | 预期 | 结果 |
|---|---|---|---|
| 1 | 3:4 + 2k | size = 1728x2304 | ✅ |
| 2 | 16:9 + 1k | size = 1280x720 | ✅ |
| 3 | 9:16 + 4k | size = 2160x3840 | ✅ |
| 4 | 非法 size "999x999" | 400 报错 | ✅ |
| 5 | `npm run build` | 通过 | ✅ |

---

## 五、Codex 建议检查点

1. **PRICE_TABLE 不完整** — 新增的 13 种比例中，只对 1k/2k 尺寸估算了成本，4k 尺寸和部分比例缺少价格数据。当前使用 `?? 0` fallback。
2. **resolution 切换逻辑** — 在 `onChange` 中调用 `setResolution()` 可能触发额外渲染，但功能正确。
3. **containPadImage 未删除** — 函数留在 `image-preprocess.ts` 中，但队列不再调用。如需彻底清理可移除。
