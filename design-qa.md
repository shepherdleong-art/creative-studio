# 成片剪辑 UI 设计 QA

## 对照对象

- 页面：`/projects/ab40db9a-87a7-4cf7-be3e-0b04ee8e9524?tab=final-edit`
- 视口：Codex 内置浏览器，1280px 桌面态与 661 × 773px 窄窗口态（DPR 2）
- 默认状态：单条编辑 / 字幕属性 / 3:4 画布
- 封面状态：单条编辑 / 封面属性 / 播放头 00:00

### 视觉来源

- 用户标注的字幕数字调时问题：`/var/folders/4y/v3q6w0gn7v7f4r79h9gjjk3r0000gn/T/codex-clipboard-16b7e84e-1651-4c4a-a777-e02eeeffd21e.png`
- 用户要求移除的左侧字幕列表：`/var/folders/4y/v3q6w0gn7v7f4r79h9gjjk3r0000gn/T/codex-clipboard-51ded2a6-c704-46de-937d-75e64c3fc38a.png`
- 用户标注的封面轨道位置问题：`/var/folders/4y/v3q6w0gn7v7f4r79h9gjjk3r0000gn/T/codex-clipboard-443687fb-3abc-4271-8357-ea6ab239f969.png`
- 用户标注的单色封面标题问题：`/var/folders/4y/v3q6w0gn7v7f4r79h9gjjk3r0000gn/T/codex-clipboard-c89e9603-1f26-4a6b-a7ff-8f5789b5765b.png`
- 用户标注的窄窗口单列问题：`/var/folders/4y/v3q6w0gn7v7f4r79h9gjjk3r0000gn/T/codex-clipboard-2c16820d-b737-4f91-bd14-1e52fb00f080.png`
- 用户标注的视频素材卡片过小问题：`/var/folders/4y/v3q6w0gn7v7f4r79h9gjjk3r0000gn/T/codex-clipboard-1bae9b5d-94e1-40fe-9fa6-86e287a1fcec.png`
- 第二步素材框参照：`/var/folders/4y/v3q6w0gn7v7f4r79h9gjjk3r0000gn/T/codex-clipboard-d91bd322-045a-4079-9c2f-d6f0154d341b.png`
- 项目视觉基准：`app/globals.css` 中的 Creative Studio 白色、浅灰、Apple Blue、圆角和系统字体令牌。

### 实现证据

- 默认编辑器：`/tmp/creative-studio-final-edit-light.jpg`
- 上一版两段式标题与预设：`/tmp/creative-studio-final-edit-cover-presets.jpg`
- 当前版两段独立控制：`/tmp/creative-studio-final-edit-independent-title-styles.jpg`
- 当前版自定义标题预设：`/tmp/creative-studio-final-edit-custom-title-preset-desktop.jpg`
- 当前版窄窗口桌面三栏与横向滚动：`/tmp/creative-studio-final-edit-fixed-desktop-scroll.png`
- 当前版大卡片素材框顶部：`/tmp/creative-studio-final-edit-large-scroll-pool-top.png`
- 当前版十条素材滚动底部：`/tmp/creative-studio-final-edit-large-scroll-pool-bottom.png`

## Findings

- 无 P0 / P1 / P2 问题。
- [P3] 每段标题都保留完整的描边和阴影参数，因此右侧属性面板需要纵向滚动。
  - 位置：单条编辑 / 右侧属性面板。
  - 影响：不阻断编辑；这是保留完整高级控制项所需的信息密度。
  - 后续：真实开发阶段可根据使用频率决定是否将效果参数折叠。

## 全视图对照

- 编辑器已从独立的黑绿主题统一为项目现有的白色、浅灰和 `#0071e3` 蓝色体系。
- 工作流导航、按钮、输入框、素材卡、时间轴和问题提示使用与现有项目一致的系统字体、圆角、浅阴影和细描边。
- 左侧字幕列表已完全移除，左栏只保留当前分镜组的视频素材。
- 画面预览、右侧属性和底部时间轴仍保持清晰的三段主任务结构。
- 窗口小于 980px 时不再把编辑器折叠为上下单列；编辑画布保持最小 1240px 桌面布局，由外层横向滚动承载。
- 视频素材栏复用第二步的两列大卡片语言：浅灰卡面、内缩圆角图片、选中描边；素材列表在固定高度容器内独立纵向滚动，不改变编辑器总高度。

## 聚焦区域对照

- 字幕调时：右侧不再出现开始、结束、时长数值输入；字幕文字保留，时间只通过时间轴块及左右手柄调整。
- 封面时序：封面不再占据视频上方的并行轨道，而是作为视频轨道最前面的 `20帧封面`；字幕、正文视频、TTS 和 BGM 从第 21 帧开始。
- 封面标题：标题保持第一段和第二段结构，通过顶部切换编辑；两段分别拥有完整的字体、字号、X/Y 位置、缩放、颜色、对齐、文本框宽度、描边和阴影控制。
- 标题预设：不提供任何系统内置预设；保留“我的标题预设”，用户可将两段标题的全部样式和位置保存到本机、再次应用或删除。具体标题文案不会随预设保存或覆盖。

## 五项视觉检查

- 字体与排版：使用项目系统字体栈，标题、正文、小型元信息层级清晰；字幕维持单行。
- 间距与布局：主界面保持素材、预览、属性三栏；时间轴和问题栏完整可见，无横向遮挡。
- 色彩与令牌：全部编辑器交互色切换为 Apple Blue，背景使用白色与 `#f5f5f7`；状态色仅用于成功、警告和错误。
- 图片质量：继续使用项目实际生成的沙发分镜图，裁切和清晰度正常，没有占位图或伪造素材。
- 文案与内容：第 21 帧、20 帧封面、字幕不重叠、双段标题完全独立等关键规则均在对应操作位置表达。

## 交互验证

- 生成设置、成片组、单条编辑三个状态均可进入。
- 字幕时间数字输入控件数量为 0。
- 时间轴拖动字幕右边缘后，当前字幕结束时间由 `08.15s` 变为 `07.61s`。
- 封面块右边界与第一段视频左边界均为 `154.65625px`，无覆盖、无间隙。
- 封面属性内不存在系统内置标题预设；“我的标题预设”提供命名、保存、应用和删除入口。
- 第一段字号由 `84px` 改为 `96px` 后，预览字号从 `36.12px` 变为 `41.28px`；第二段仍为 `30.96px`。
- 第二段 Y 位置由 `31%` 改为 `42%` 后，第一段仍保持 `19%`，两段位置状态互不覆盖。
- 每一段切换后都显示独立的文字、字体、字号、X/Y 位置、缩放、颜色、对齐、文本框宽度、描边和阴影控件。
- 保存“门店统一封面”后，刷新页面仍可看到该自定义预设。
- 将第一段字号改为 `100px` 后应用“门店统一封面”，字号恢复为预设记录的 `84px`；预设应用有效。
- 自定义预设只保存两段样式和位置，不保存或覆盖标题文字。
- 661px 窄窗口回归：编辑器计算样式为 `display: grid`，三栏宽度为 `420px / 498px / 320px`；外层可视宽度 `641px`、滚动宽度 `1240px`，横向溢出正常。
- 素材框回归：窄窗口下素材栏为 `420px`，单卡宽度 `187px`；10 张素材的滚动框可视高度 `419px`、内容高度 `988px`，产生框内纵向滚动而编辑器高度保持不变。
- 将素材框滑至底部后，第 10 张“沙发全貌”完整可见并可选中，预览画面同步切换。
- 浏览器控制台无 error / warn。

## 比较历史

1. 初始版本存在黑绿主题、右侧数字调时、重复字幕列表、封面并行覆盖素材、标题只能统一着色五项问题。
2. 第一轮白蓝改版完成后发现 P2：封面块的 `min-width: 54px` 比 20 帧实际宽度更大，导致其与第一段视频发生约 4px 重叠。
3. 移除封面最小宽度并缩短标签后复核：封面右边界与首段视频左边界完全相等，P2 已关闭。
4. 第二轮根据反馈移除系统内置标题预设，并把原先共享的标题样式拆成两套独立状态。
5. 第三轮确认用户仍需要自定义预设后，恢复仅由用户保存的预设能力；补齐保存、刷新持久化、应用和删除交互。
6. 窄窗口复核发现 P2：原 `980px` 断点会把三栏编辑器改为纵向单列，使素材区显得突然缩小且预览、属性掉到下方。
7. 移除该断点的单列覆盖，固定 1100px 编辑画布并增加横向滚动；同一 661px 视口复核后 P2 已关闭。
8. 第二次反馈发现 P2：素材栏虽然保持三栏，但只有 `230px`，两列卡片约 `100px`，无法像第二步一样清楚预览素材，未来素材增多也缺少明确的列表边界。
9. 将素材栏扩至 `420–440px`，用第二步式大卡片重做列表，并把滚动限定在 `420px` 高的内部素材框；以 10 张真实项目素材完成顶部、底部和选中态复核，P2 已关闭。
10. 最终全视图、封面聚焦视图、窄窗口与十条素材滚动状态重新对照，未发现新的 P0 / P1 / P2。

## 实施清单

- [x] 统一为项目 Apple 风格。
- [x] 删除字幕数字调时。
- [x] 删除左侧字幕列表。
- [x] 将 20 帧封面放到正文视频之前。
- [x] 标题改成两段式结构，并让每段完整样式、位置和效果独立。
- [x] 删除所有系统内置标题预设。
- [x] 保留用户自定义预设，并支持命名、保存、应用、删除和刷新持久化。
- [x] 窄窗口保持桌面三栏，通过横向滚动查看完整编辑画布。
- [x] 视频素材栏使用两列大卡片和固定高度内部滚动，十条素材不会撑高编辑器。

final result: passed

---

# Batch Phase D media pool, analysis, subtitle, and cover — Design QA

## Evidence

- Source state with full-width inline videos: `/var/folders/4y/v3q6w0gn7v7f4r79h9gjjk3r0000gn/T/codex-clipboard-621e3650-979c-41bc-8c51-0fb014d388a4.png` and `/var/folders/4y/v3q6w0gn7v7f4r79h9gjjk3r0000gn/T/codex-clipboard-a8c4708c-50fe-4c77-a4aa-cf624c27092e.png`.
- Browser-rendered fixed pool: `/tmp/creative-studio-batch-pool-qa.png`.
- Browser-rendered preview dialog: `/tmp/creative-studio-batch-preview-modal-qa.png`.
- Live viewport: Codex in-app browser at `389 × 759` CSS px, DPR 2; project `0803测试`, frozen batch version with nine real assets.

## Findings

- No actionable P0, P1, or P2 issue remains in the scoped Phase D and Phase E UI.
- The former full-width video stack is replaced by a `620px` fixed-height pool of compact real thumbnails. Only its inner list scrolls; video media is loaded in the existing preview dialog after a thumbnail click.
- The compact narrow-width pass preserves readable filenames, LUT state, source status, real crops, and play affordances without horizontal overflow.
- The existing candidate cover is now visible on the Phase E card. New candidates expose the actual subtitle cue count; historical candidates honestly remain labelled `字幕待生成`.

## Interaction And Runtime Checks

- Live measurement: outer pool height `620px`; internal viewport `512px`; internal content `2056px`; `overflow-y: auto`; nine tiles; first tile height `217.8px`.
- The internal scrollbar reveals later assets without increasing section height.
- Clicking `播放批次素材 …` opens the dialog with the matching real project video; closing the dialog returns to the same pool state.
- No real content-analysis provider, TTS provider, proxy job, reallocation, or export was triggered during visual QA.
- The frozen live batch still points at its historical technical analyses and silent candidate. The UI directs users to create a new version for content analysis instead of mutating frozen input identity.

## Comparison History

1. Initial fixed-height implementation applied the scroll container directly to a flex grid, which compressed nine cards into thin strips.
2. The scroll responsibility moved to a wrapper while the inner grid keeps natural row height. A second live comparison confirmed full thumbnail cards, fixed outer height, internal vertical overflow, and working modal playback.

final result: passed

---

# Batch project asset pool and select-all — Design QA

## Evidence

- Source visual truth: `/var/folders/4y/v3q6w0gn7v7f4r79h9gjjk3r0000gn/T/codex-clipboard-408bdc58-f66c-47bd-964d-258acecbf2e1.png`
- Browser-rendered implementation: `/tmp/creative-studio-project-asset-pool-after-aligned-1039x757.png`
- Full-view comparison: `/tmp/creative-studio-project-asset-pool-comparison-aligned.png`
- Focused comparison: `/tmp/creative-studio-project-asset-pool-comparison-focus.png`
- Responsive evidence: `/tmp/creative-studio-project-asset-pool-narrow-720x900.png`
- Source pixels: `2078 × 1514`, normalized from Retina `2x` to `1039 × 757` CSS px.
- Implementation pixels: `1039 × 757`, device scale factor `1`; responsive check at `720 × 900` CSS px.
- State: project `0803测试`, batch-production mode, draft batch selected, nine online assets waiting for technical analysis, zero currently selectable.

## Findings

- No actionable P0, P1, or P2 mismatch remains.
- The project assets now read as one bounded pool: a white rounded card with a hairline border contains the section heading, status/actions, and the two-column asset grid.
- The new `一键全选` control sits beside the existing bulk-analysis action and clearly disables when no analyzed asset is selectable. The isolated production-browser test covers its enabled, selected, and `取消全选` states.

## Required Fidelity Surfaces

- Fonts and typography: the existing system/PingFang stack, heading weight, muted description, counts, and button labels are unchanged; the new heading uses the product's existing section hierarchy.
- Spacing and layout rhythm: the pool uses the same card radius, hairline, padding, and responsive wrapping as the nearby batch card. At `720px` the header actions wrap without horizontal overflow, and the asset grid falls back to one column.
- Colors and visual tokens: existing `card`, `btn-primary`, `btn-secondary`, accent blue, hairline, and disabled-state tokens are reused; no new one-off colors or gradients were introduced.
- Image quality and asset fidelity: the existing real video thumbnails and crops are preserved without placeholders, regeneration, or image changes.
- Copy and content: the section is renamed `项目素材池`; the count reads `已选 X / 可选 Y 条`; bulk analysis, preview, source health, and per-card analysis copy remain intact.

## Interaction And Runtime Checks

- The production Playwright flow analyzes the pending fixture asset, clicks `一键全选`, verifies both selectable checkboxes, clicks `取消全选`, verifies both are cleared, then continues the batch flow.
- Only online assets with a current analysis id enter the select-all set. Existing LUT selections are preserved; cancel-all removes only the currently selectable set.
- The live project was inspected read-only in the in-app browser; no real analysis task or batch mutation was triggered.
- Browser console has no new error. One existing Next.js LCP warning for a project thumbnail remains unrelated to this change.

## Comparison History

- Initial comparison confirmed the requested structural change: the previously unbounded cards are now grouped inside a dedicated pool card, with select-all added to the existing action row. No P0/P1/P2 correction loop was required.

## Follow-up Polish

- None required for this scoped change.

final result: passed

---

# Batch project asset pool fixed-scroll follow-up — Design QA

## Evidence

- Visual truth: the accepted project asset pool above, plus the follow-up requirement that the pool keep a fixed footprint while the asset list scrolls vertically inside it.
- Live browser viewport: `1039 × 757` CSS px. The outer pool measured `818px` content height, the list viewport measured `714px`, and nine real assets produced `2447px` of scroll content.
- Responsive browser viewport: `720 × 900` CSS px. The list measured `630px` wide by `670px` high with `5302px` of one-column content.
- State: project `0803测试`, batch-production mode, draft batch selected, nine online assets waiting for technical analysis, zero currently selectable.

## Findings

- No actionable P0, P1, or P2 issue remains.
- The pool uses a stable `820px` outer height. Its title, description, count, bulk-analysis action, and select-all action remain pinned outside the scrolling list.
- The internal list exposes a persistent vertical scrollbar, reserves its gutter, contains scroll chaining, and clips horizontal overflow. At both verified viewports `scrollWidth === clientWidth`.
- Scrolling reached `scrollTop 1733.5` of a `1733px` maximum and made the ninth asset (`video-935dcfa1-1785766515573.mp4`) visible, so the remaining assets are reachable without growing the page section.

## Required Fidelity Surfaces

- Fonts and typography: unchanged from the accepted asset-pool implementation; the fixed container introduces no new typography.
- Spacing and layout rhythm: the header keeps its existing padding and wrapping while the recessed list alone consumes the remaining height.
- Colors and visual tokens: the existing white `card` shell and `bg-surface-subtle` list background retain the pool hierarchy.
- Image quality and asset fidelity: all nine real video thumbnails remain unchanged and scroll with their cards.
- Copy and content: existing counts, analysis actions, select-all state, per-card metadata, and preview affordances remain visible and unchanged.

## Interaction And Runtime Checks

- Desktop browser: `overflow-y: scroll`, `overflow-x: hidden`, `scrollbar-gutter: stable`, `scrollHeight 2447 > clientHeight 714`.
- Responsive browser: one-column grid, `scrollHeight 5302 > clientHeight 670`, no horizontal overflow.
- Header actions remained visible while the internal list was at its bottom; the live project was inspected without starting analysis or changing batch data.
- Static source test, TypeScript, targeted ESLint, production build, and diff whitespace checks passed. The isolated standalone Playwright rerun was unavailable because the local-listener escalation was rejected; equivalent top-to-bottom scrolling was independently exercised in the in-app browser.

## Comparison History

- The initial pool grouped the cards and added select-all but still expanded with asset count. This follow-up bounds the section and moves only the card grid into the internal scroll region.
- Desktop and responsive checks both matched the requested interaction; no correction loop was required.

## Follow-up Polish

- None required for this scoped change.

final result: passed

---

# Mixcut toolbar and narration-speed controls — Design QA

## Evidence

- Source visual truth: `/Users/liangpeijian/.codex/generated_images/019fae5d-a660-75e3-8b96-b445cf25ab7c/exec-6f938dbd-4d25-445a-8881-b3037b3d5c35.png`
- Browser-rendered implementation: `/tmp/mixcut-buttons-implementation-1440x1024.png`
- Focused implementation crop: `/tmp/mixcut-buttons-implementation-focus.png`
- Full-view comparison: `/tmp/mixcut-buttons-design-qa-full-comparison.png`
- Focused comparison: `/tmp/mixcut-buttons-design-qa-comparison.png`
- Browser viewport: `1440 × 1024` CSS px, device scale factor `1`
- Responsive check: `1280 × 900` and `1024 × 900` CSS px
- Source pixels: `1487 × 1058`
- Implementation pixels: `1440 × 1024`; focused crop `940 × 360`
- State: Mixcut preview step, select tool active, narration playback rate `1.0x`

## Findings

- No actionable P0, P1, or P2 mismatch remains.
- The two timeline tools render as separate `67 × 34px` targets with an `8px` gap, `flex-shrink: 0`, and `white-space: nowrap`. At `1024px` viewport width the helper copy moves to its own row while both buttons keep their full width.
- The four narration presets render as four equal `58.25 × 32px` grid cells. The active `1.0x` value uses the product blue and retains `aria-pressed="true"`.
- The precise numeric input remains beside the slider. This differs from the simplified concept image but intentionally preserves the production control contract and exact-value entry.

## Required Fidelity Surfaces

- Fonts and typography: existing system/PingFang stack, weights, numeric alignment, and Chinese wrapping are preserved; no concatenated labels remain.
- Spacing and layout rhythm: toolbar gap, fixed button targets, helper surface, summary badge, and four-column speed grid match the selected direction within the production layout.
- Colors and visual tokens: existing `--paper`, `--bg`, `--seg`, `--sub`, and `--blue` tokens are reused; selected state and hairline treatment are consistent with the current Mixcut design system.
- Image quality and assets: no new raster assets were required. Existing project icons remain vector-sharp; the former text cursor glyph was replaced with the shared icon system.
- Copy and content: all production labels and instructions are unchanged.

## Interaction And Runtime Checks

- Select → split → select state transition passed in the in-app browser; `aria-pressed` updated correctly.
- Preset grid geometry and selected state were inspected without changing the persisted project playback rate.
- Browser console: zero errors; two unrelated existing Next.js LCP image warnings.

## Comparison History

- Initial implementation comparison found no P0/P1/P2 issue. No visual-fix iteration was required after the source/implementation full-view and focused comparisons.

## Follow-up Polish

- P3: the selected implementation uses the closest existing check-circle icon for the select tool instead of the concept image's dashed selection icon, avoiding a new one-off icon asset.

final result: passed
