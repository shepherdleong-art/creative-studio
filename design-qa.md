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

# 详情页脚本生成上传框与模型选择 — Design QA

## Evidence

- Source visual truth: `/var/folders/4y/v3q6w0gn7v7f4r79h9gjjk3r0000gn/T/codex-clipboard-c783bc40-bd15-459e-b72e-a3c65aa76ac7.png`
- Browser-rendered full state: `outputs/design-qa/script-studio-full.png`
- Browser-rendered upload region: `outputs/design-qa/script-studio-upload.png`
- Source/implementation combined comparison: `outputs/design-qa/upload-reference-vs-implementation.png`
- Route: `http://localhost:3000/projects/ab40db9a-87a7-4cf7-be3e-0b04ee8e9524?tab=script`
- Browser viewport: `1280 × 720 CSS px`, DPR 2; in-app-browser screenshots are normalized to one output pixel per CSS pixel.
- Source pixels: `796 × 570`; focused dashed region: `657 × 402`. Implementation focused region: `856 × 420 CSS px`.
- State: empty image list, default company Luna selected, company-network requirement visible. No image was uploaded and no provider request was submitted during QA.

## Findings

- No actionable P0, P1, or P2 issue remains.
- The empty image area is one large dashed button. Its whole surface opens a multiple-file chooser and continues to accept drag/drop.
- The model selector lists configured vision-capable providers. Luna remains the default and is labelled `需要公司内网`; Gemini is available as the configured external fallback.

## Required fidelity surfaces

- Fonts and typography: the existing system/PingFang stack is preserved; folder icon, main upload instruction, and muted format/processing note retain the reference hierarchy.
- Spacing and layout rhythm: the desktop upload surface was increased from `260px` to `420px` minimum height after the first comparison so it reads as the large image frame in the source. Smaller breakpoints retain a `320px` minimum.
- Colors and visual tokens: surface, hairline, ink, and accent focus colors all use the existing Creative Studio tokens; no one-off light colors or gradients were added.
- Images and assets: the existing shared folder icon is used; no placeholder image, handcrafted SVG, or generated asset was introduced.
- Copy and content: the primary instruction mirrors the source. The secondary line states accepted formats and the actual local compression/tiling behavior.

## Interaction and runtime checks

- Clicking `script-studio-upload-dropzone` opened a real file chooser; `multiple = true`.
- Switched Luna → Gemini and confirmed the selected value and `外部直连` helper, then switched back to Luna and confirmed `需要公司内网，并经本机 LiteLLM`.
- Reloaded the page and confirmed Luna remains selected in the inspected default state.
- Local provider metadata confirms Gemini `gemini-3.7-flash` is configured, enabled, and vision-capable. This check did not call Gemini.
- Browser console errors: 0.

## Comparison history

1. Initial implementation matched the dashed/clickable structure but was visibly too shallow at `856 × 260px` compared with the source.
2. Increased the desktop minimum height to `420px`, repeated the focused source/implementation comparison, and found no remaining P0/P1/P2 mismatch.

## Implementation checklist

- [x] Whole empty frame is clickable and keyboard-focusable.
- [x] PNG/JPEG/WebP multiple upload and drag/drop remain supported.
- [x] User can explicitly choose Luna or Gemini for the whole task.
- [x] Luna is the default and clearly marked as requiring company intranet.
- [x] Selected provider id/model are frozen into the task snapshot; unavailable explicit choices fail closed without silent fallback.

final result: passed

---

# Seedance 2.0 尾帧拖拽与悬浮预览 — Design QA

## Evidence

- Source visual truth: `/var/folders/4y/v3q6w0gn7v7f4r79h9gjjk3r0000gn/T/codex-clipboard-0d9eda1a-3a8c-45a6-b359-117ca8cfd488.png`
- Browser-rendered loaded state: `/tmp/seedance-tail-loaded.png`
- Browser-rendered hover state: `/tmp/seedance-tail-drag-hover-active.png`
- Browser-rendered empty state: `/tmp/seedance-tail-drag-empty.png`
- Combined comparison input opened for review: `/tmp/tail-frame-drag-comparison.png`
- Route: `http://127.0.0.1:3019/projects/c44a2df5-1ce1-4331-8117-556a63183b6e?tab=video`
- Browser viewport for the matched loaded and hover states: `1280 × 720 CSS px`, screenshot output `1280 × 720 px`.
- Source pixels: `802 × 404 px`. For the focused comparison, its `692 × 375 px` frame region was normalized to `306px` width; the implementation region is `306 × 172 px`. The combined comparison is `636 × 172 px` with a `24px` neutral gutter.
- State: Seedance 2.0 selected; a real project image was temporarily uploaded as the tail frame, inspected, hovered, and then removed. Both temporary uploaded assets were deleted through the product UI after QA.

## Findings

- No actionable P0, P1, or P2 issue remains.
- The accepted two-frame composition is unchanged. The empty tail tile now explicitly says `可选 · 点击或拖入`, while the loaded tile remains visually quiet until hover/focus.
- Drag-enter state uses the existing accent blue, a dashed inner boundary, and explicit `松开添加尾帧` / `松开替换尾帧` copy. It does not cover or alter the default state when no drag is active.
- The loaded tail frame now uses the same `HoverZoomImage` implementation, maximum preview size, keyboard behavior, and `zoom-in` cursor as the first frame.

## Full-view comparison

- The combined source/implementation image confirms the same equal-width first/tail tiles, center time-direction marker, top-left frame chips, bottom-right replace/remove controls, and warning bar placement.
- The implementation retains the Creative Studio light surfaces and project tokens established in the preceding accepted Seedance QA. Different scene imagery is expected because QA uses the current project's real frame.
- No layout, crop, padding, radius, or text-wrapping regression was introduced by the drag target.

## Focused region comparison

- The hover screenshot visibly shows the enlarged tail image beside the frame pair. Its dimensions and caption treatment match the first-frame preview because both are rendered by the same shared component.
- A separate focused drag comparison was not fabricated: the in-app browser supports the real file-chooser flow but does not expose an operating-system file drag source. Drag/drop event wiring and add/replace copy are therefore covered by the source contract test, while the shared upload path was exercised through a real file upload.

## Required fidelity surfaces

- Fonts and typography: existing system/PingFang stack and 10–12px hierarchy are preserved; the new helper and drop-state copy fit without truncation.
- Spacing and layout rhythm: no frame dimensions or card spacing changed; the drag overlay is inset `6px` and follows the tile's existing radius.
- Colors and visual tokens: the overlay uses the existing accent and surface language, with no new product palette or gradient.
- Image quality and asset fidelity: real project imagery was used; thumbnail and large preview remain `object-fit: contain`, preventing frame-content loss.
- Copy and content: `点击或拖入`, `松开添加尾帧`, and `松开替换尾帧` describe the actual available actions; no unsupported history or library feature is implied.

## Interaction and runtime checks

- Switched from an unsupported provider to `即梦 2.0 (Seedance 2.0)` and confirmed the drop-ready empty state.
- Clicked the real hidden file input through the visible tail-frame control, uploaded a `1728 × 2304` PNG, and confirmed the loaded state.
- Hovered the loaded tail image and confirmed the enlarged preview and caption are visible.
- Removed the tail frame and confirmed the UI returned to `添加尾帧图`; dev-server evidence shows both temporary uploads received successful `DELETE /api/images/<id> 200` cleanup.
- Source contract covers native `dataTransfer.files`, empty/loaded `onDrop`, add/replace drag copy, and the shared hover-preview component.
- No browser-visible error state appeared during the flow. Direct console streaming was unavailable in this browser session; the dev server showed successful upload, image load, and cleanup requests with no request failures.

## Comparison history

- This follow-up starts from the previously accepted Seedance first/tail-frame design. The first visual comparison found no P0/P1/P2 regression, so no visual-fix iteration was required.

## Implementation checklist

- [x] Keep click-to-choose upload.
- [x] Accept direct image drop on the empty tail tile.
- [x] Accept direct image drop as replacement on the loaded tail tile.
- [x] Show explicit drag-over feedback for add and replace.
- [x] Reuse the first-frame large hover preview for the tail frame.
- [x] Preserve provider support gates, upload/delete busy states, and cleanup behavior.

## Follow-up polish

- P3 test gap only: a manual operating-system drag can be smoke-tested later on the packaged desktop build; the browser automation surface used here cannot originate a local file drag.

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

---

# Seedance 2.0 首尾帧界面 Design QA

## 对照目标与证据

- Source visual truth:
  - `/var/folders/4y/v3q6w0gn7v7f4r79h9gjjk3r0000gn/T/codex-clipboard-11f452f8-9ce4-4911-9f41-0630f6429af8.png`（尾帧空态）
  - `/var/folders/4y/v3q6w0gn7v7f4r79h9gjjk3r0000gn/T/codex-clipboard-6a8d430c-21db-42aa-bffd-b82126f511fd.png`（尾帧完成态）
- Browser-rendered implementation:
  - `outputs/design-qa/seedance-tail-viewport-1280x1000-final.png`（空态全视图）
  - `outputs/design-qa/seedance-tail-loaded-rest.png`（完成态全视图）
  - `outputs/design-qa/seedance-tail-loaded-hover.png`（完成态悬停操作）
- Combined comparison input:
  - `outputs/design-qa/seedance-tail-empty-comparison.png`
  - `outputs/design-qa/seedance-tail-loaded-comparison-final.png`
- Route: `http://127.0.0.1:3019/projects/c44a2df5-1ce1-4331-8117-556a63183b6e?tab=video`

## 视口与归一化

- 两张源图均为 `920 x 780 px`。
- 实现全视图为 `1280 x 1000 CSS px`；浏览器报告 `devicePixelRatio = 2`，IAB 截图输出已归一化为 `1280 x 1000 px`，即每个 CSS px 对应一个截图像素。
- 聚焦对照使用源图 `878 x 405 px` 顶部首尾帧区域；实现首尾帧组件为 `314 x 137 CSS px`，等比放大至 `878 x 383 px` 后上下补白到 `878 x 405 px`。最终并排比较图为 `1756 x 405 px`。
- 对照状态：Seedance 2.0 供应商已选中；分别检查未添加尾帧和已添加尾帧。完成态使用现有分镜图做一次临时真实上传，截图后已删除测试资产。

## Full-view comparison

- 信息顺序与参考一致：首帧/尾帧双画面位于描述卡顶部，模型与模板参数在其后，运镜描述继续位于下方。
- 左侧编辑列从 `300–340px` 调整为 `380–420px`，双画面在桌面宽度下不再退化为附件缩略条，同时中间视频预览仍保持主视觉。
- 实现沿用 Creative Studio 的浅色、Apple 式表面和现有字体系统；没有照搬参考图的黑色主题。这是产品设计系统约束，不是结构偏差。

## Focused region comparison

- 空态：右侧整块画面作为上传入口，包含图片图标、`添加尾帧图` 和 `可选 · 点击上传`；与参考中的整块空态层级一致。
- 完成态：两张画面等宽等高，首尾帧均使用 `object-fit: contain` 展示完整内容；默认不显示操作按钮，悬停或键盘聚焦尾帧后显示“更换/移除”。
- 中央关系标识使用现有 Icon 库的右向 chevron，表达首帧到尾帧的时间方向。参考图是双向换图符号；为避免引入手写 SVG，这是可接受的 P3 差异。

## Required fidelity surfaces

- Fonts and typography: 继续使用项目 `--font-sans` 与现有 10–13px 控件层级；空态主文案 12px/600，辅助文案 10px，未出现截断或拥挤。
- Spacing and layout rhythm: 双列 `1fr 1fr`、10px 间距、10:9 画面比例、13px 圆角；中央 38px 圆形标识压在两画面接缝上，布局重心与参考一致。
- Colors and visual tokens: 使用项目已有 surface、ink、accent、warn token；只在图片标签和浮层操作上使用深色半透明玻璃，以保持画面可读性。
- Image quality and asset fidelity: 首尾帧均显示真实项目图片，不使用占位画、CSS 图形或生成素材替代；`contain` 防止裁掉首尾帧关键内容。
- Copy and content: 使用 `首帧`、`尾帧`、`添加尾帧图`、`可选 · 点击上传`，没有添加当前产品不具备的“历史创作”假入口。

## Interaction and responsiveness

- 已测试：不支持尾帧模型空态、切换 Seedance 2.0 后的可上传空态、真实临时上传、完成态、悬停显示更换/移除、提示词补全后门禁提示消失。
- 1024px：双画面容器 `896px`，两格各 `443px`，页面 `scrollWidth = 1024px`。
- 640px：双画面容器 `516px`，两格各 `253px`，页面 `scrollWidth = 640px`。
- 390px：双画面容器 `266px`，两格各 `128px`，页面 `scrollWidth = 390px`。
- 浏览器 console errors: 0。

## Comparison history

### Iteration 1 — blocked

- [P2] 中央两个 chevron 重叠后视觉上接近“X”，不能清晰表达首帧到尾帧关系。
- [P2] 初版 `object-fit: cover` 可能裁掉首尾帧内容，不适合精确预览生成边界。
- [P2] 完成态“更换/移除”常驻，遮挡尾帧并弱化双画面主体。

Fixes:

- 中央标识改为现有 Icon 库的单一右向 chevron。
- 首尾帧图片改为 `object-fit: contain`。
- 操作按钮改为尾帧 hover / focus-within 时显示。

Post-fix evidence:

- `outputs/design-qa/seedance-tail-empty-comparison.png`
- `outputs/design-qa/seedance-tail-loaded-comparison-final.png`
- `outputs/design-qa/seedance-tail-loaded-hover.png`

### Iteration 2 — passed

- 无剩余可执行的 P0/P1/P2 问题。
- P3：中央标识是单向 chevron，不是参考图的双向换图图标；保持现有图标库与时间方向清晰度，接受该差异。

## Findings

- 无 P0/P1/P2 findings。

## Open Questions

- 无。

## Implementation Checklist

- [x] 首帧/尾帧并排成为描述卡主视觉。
- [x] 空态整块可上传，完成态整块展示图片。
- [x] 更换/移除不遮挡默认画面，并保留键盘聚焦可见性。
- [x] 保留不支持模型门禁、上传中、删除中和错误提示。
- [x] 通过桌面、平板和窄屏检查。

## Follow-up Polish

- P3：如果未来 Icon 库补充官方 `arrow-left-right`，可替换中央单向 chevron，进一步贴近参考图。

final result: passed
