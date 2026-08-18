# 自由素材视频 Demo — Design QA

## Evidence

- Source visual truth: `/var/folders/4y/v3q6w0gn7v7f4r79h9gjjk3r0000gn/T/codex-clipboard-c7dd9682-dc45-456f-82da-fde60e2f3c09.png`
- Browser-rendered implementation: `/tmp/free-material-prototype-replica-1.png`
- Full-view combined comparison: `/tmp/free-material-prototype-comparison-1.png`
- Focused left-control comparison: `/tmp/free-material-prototype-left-comparison-1.png`
- Route: `http://127.0.0.1:3107/free-material-video-prototype`
- Viewport: `1424 × 803 CSS px`, device scale factor `2`.
- Source pixels: `2848 × 1604`; implementation pixels: `2848 × 1606`. The full-view comparison crops the implementation by two bottom pixels so both halves are `2848 × 1604`.
- State: one uploaded portrait image, three motion descriptions, three mock completed results, first result selected.

## Findings

- No actionable P0, P1, or P2 mismatch remains.
- The implementation intentionally changes `分镜 N` to `图 N` and adds an `添加图片` tab because the free-material entry owns uploaded images rather than upstream storyboard shots.
- Scene imagery and result count differ because QA uses a local uploaded image and mock results; component structure, proportions, states, and tokens remain the same.

## Full-view comparison

- The same `420px / 626px / 260px` three-column composition is preserved at this viewport, with a `720px` workbench height.
- Left parameter column, center 3:4 preview, right scrollable result list, playback controls, active result border, panel radii, and light surfaces match the source hierarchy.
- No extra concept selector, guided flow, filmstrip, floating summary, or alternate variant remains.

## Focused comparison

- The focused left comparison confirms the same tab treatment, equal first/tail frame tiles, circular bridge, provider selector, template/duration row, prompt field, add-description action, concurrency field, and full-width generate action.
- The only functional adaptation is the first-frame source: an empty first-frame tile accepts click or drag; once uploaded it occupies the same tile used by the original read-only storyboard image.
- The uploaded first frame stays read-only. Replacing it means using `添加图片` to create another image tab; the prototype intentionally has no in-place replace action.

## Required fidelity surfaces

- Fonts and typography: project system/PingFang stack, sizes, weights, line heights, and control hierarchy come from the existing global video-workspace classes.
- Spacing and layout rhythm: the prototype reuses the existing workbench grid, panel padding, radii, shadows, frame aspect ratio, control heights, and scroll boundaries.
- Colors and visual tokens: existing Creative Studio surface, hairline, accent blue, success green, and ink tokens are reused directly.
- Image quality and asset fidelity: QA uses a real local portrait image selected through the upload input; no placeholder artwork or CSS-drawn media is used.
- Copy and content: existing provider, template, duration, prompt, concurrency, playback, status, download, and play copy is retained; only storyboard-specific naming changes to image-specific naming.

## Interaction and runtime checks

- Uploaded a real `3584 × 4800` JPEG through the new first-frame input.
- Added two motion descriptions and generated three mock completed results.
- Confirmed the first result becomes active in the center preview and the right column renders three result cards.
- Browser measurements: workspace `1338 × 720 CSS px`; columns `420 / 626 / 260 CSS px`.
- Browser console errors: none.
- Targeted ESLint: passed.
- Route HTTP status: `200`.

## Comparison history

1. The prior prototype used three invented A/B/C layouts and did not match the provided product screen.
2. It was replaced with the production `video-workspace`, shot tab, motion card, frame pair, preview, playback, and result-card structures and tokens.
3. The first same-state screenshot comparison found no remaining P0/P1/P2 visual mismatch; no additional visual-fix iteration was required.

## Implementation checklist

- [x] Remove A/B/C variants and extra visual concepts.
- [x] Reuse the existing three-column video-generation UI.
- [x] Turn the existing first-frame slot into upload/drop input.
- [x] Keep an uploaded first frame read-only; add another image instead of replacing it in place.
- [x] Support additional image tabs and motion descriptions.
- [x] Mock result generation, result selection, preview controls, and download action.
- [x] Verify the rendered state at the source-sized viewport.

final result: passed
