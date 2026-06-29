# Creative Studio App Icon Design

## Decision

Use the N2 direction as the final icon concept for Creative Studio / 产品素材工作台.

The icon should feel like a modern Apple-style system tool: flat, geometric, crisp, and professional. It should avoid old skeuomorphic glass, heavy gradients, complex feature collage, and decorative AI-magic styling.

## Visual Concept

The icon is a rounded square with a near-black base and a white geometric Studio mark. The mark is supported by three small rounded status accents:

- Blue accent: active generation / primary product action.
- Green accent: completed usable output.
- Purple accent: creative/video/script pipeline.

The icon is intentionally more brand-like than literal. It should be memorable as a professional creative production tool, while the small accent geometry hints at the app's multi-step asset workflow.

## Geometry

- Outer shape: app-icon rounded square, matching common macOS/iOS icon proportions.
- Base color: deep neutral, close to `#202124`.
- Main mark: white or near-white, close to `#F5F5F7`.
- Main mark shape: angular Studio-like geometric glyph based on the N2 preview.
- Accent shapes: rounded rectangles or fully rounded squares, not sharp triangles.
- Avoid thin strokes. The mark must stay readable at 16px.

## Color Palette

- Base: `#202124`
- Main mark: `#F5F5F7`
- Primary blue: `#0071E3`
- Success green: `#34C759`
- Creative purple: `#5331D8`

The palette should stay flat and restrained. Shadows may be used only for icon preview or exported PNG depth, not as an essential part of the symbol.

## Deliverables

The implementation should produce:

- Source SVG for the icon.
- PNG exports for common app/web sizes: 16, 32, 48, 64, 128, 256, 512, and 1024px.
- Web favicon assets used by Next.js.
- Windows `.ico` for `app/favicon.ico`, because the installer build script uses this file as the launcher icon.

## Integration Targets

- Next.js metadata/favicon should use the new app icon.
- Windows launcher and installer should pick up `app/favicon.ico` without changing the installer script contract.
- Any generated previews or temporary brainstorming artifacts should remain ignored under `.superpowers/`.

## Acceptance Criteria

- The icon reads clearly at 16px and 32px.
- At 128px and above, it feels like a polished modern app icon, not a generic logo template.
- It visually fits the current Apple-like light UI.
- It does not rely on text, tiny decorative symbols, or complex gradients.
- The exported `.ico` can be used by the existing Windows build pipeline.
