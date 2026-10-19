# Project Information Editing and Export Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users edit project name, product name, product model, and category at any time, and recover from a missing product model directly during final export.

**Architecture:** Keep `projects` as the single source of truth. A shared `ProjectInfoDialog` owns the four-field form and calls the existing project PATCH endpoint; project and Mixcut parents update their local state from the returned project information. The export step reuses that dialog, then lets the server create the render job from freshly persisted project data.

**Tech Stack:** Next.js App Router, React 19, strict TypeScript, Tailwind CSS 4, SQLite, native Node test scripts.

---

### Task 1: Project information normalization

**Files:**
- Create: `lib/project-info.ts`
- Create: `scripts/project-info.test.ts`

- [ ] **Step 1: Write the failing normalization test**

```ts
import assert from 'node:assert/strict';
import { parseProjectInfoUpdate } from '../lib/project-info.ts';

assert.deepEqual(parseProjectInfoUpdate({
  name: '  七月-床  ',
  productName: '  舒适软床 ',
  productCode: ' RQ1A-1 ',
  productCategory: ' 家居 / 床具 ',
}), {
  name: '七月-床',
  productName: '舒适软床',
  productCode: 'RQ1A-1',
  productCategory: '家居 / 床具',
});

assert.throws(
  () => parseProjectInfoUpdate({ name: '   ' }),
  /项目名称不能为空/,
);
```

- [ ] **Step 2: Run the test and confirm RED**

Run: `node scripts/project-info.test.ts`

Expected: failure because `lib/project-info.ts` does not exist.

- [ ] **Step 3: Implement the parser**

```ts
export interface ProjectInfo {
  name: string;
  productName: string;
  productCode: string;
  productCategory: string;
}

export function parseProjectInfoUpdate(body: Record<string, unknown>): Partial<ProjectInfo> {
  const update: Partial<ProjectInfo> = {};
  if (typeof body.name === 'string') {
    const name = body.name.trim();
    if (!name) throw new ProjectInfoValidationError('项目名称不能为空');
    update.name = name;
  }
  for (const key of ['productName', 'productCode', 'productCategory'] as const) {
    if (typeof body[key] === 'string') update[key] = body[key].trim();
  }
  return update;
}
```

- [ ] **Step 4: Run the test and confirm GREEN**

Run: `node scripts/project-info.test.ts`

Expected: exit code 0 with all assertions passing.

### Task 2: Project PATCH endpoint

**Files:**
- Modify: `app/api/projects/[id]/route.ts`
- Test: `scripts/project-info.test.ts`

- [ ] **Step 1: Add a source contract asserting the route uses `parseProjectInfoUpdate` and returns the updated four fields**
- [ ] **Step 2: Run `node scripts/project-info.test.ts` and confirm the new assertion fails**
- [ ] **Step 3: Merge parsed project fields into the existing PATCH allowlist without changing script-setting updates**
- [ ] **Step 4: Query and return `{ id, name, productName, productCode, productCategory }` after a successful update**
- [ ] **Step 5: Re-run `node scripts/project-info.test.ts` and confirm it passes**

### Task 3: Shared aligned project information dialog

**Files:**
- Create: `components/ProjectInfoDialog.tsx`
- Create: `scripts/project-info-ui-contract.test.mjs`

- [ ] **Step 1: Write UI contract assertions for four fields, `content-start`, equal `h-11` inputs, normal save, and save-then-export modes**
- [ ] **Step 2: Run `node scripts/project-info-ui-contract.test.mjs` and confirm RED because the component is missing**
- [ ] **Step 3: Implement the reusable controlled dialog**

```tsx
export type ProjectInfoDialogIntent = 'edit' | 'export';

export function ProjectInfoDialog(props: {
  open: boolean;
  project: ProjectInfo & { id: string };
  intent: ProjectInfoDialogIntent;
  onClose: () => void;
  onSaved: (project: ProjectInfo & { id: string }) => void | Promise<void>;
}) {
  // Local draft, PATCH submission, validation, and aligned two-column form.
}
```

- [ ] **Step 4: Re-run the UI contract and confirm the component assertions pass**

### Task 4: Persistent entry points and Mixcut context

**Files:**
- Modify: `app/projects/[id]/page.tsx`
- Modify: `components/mixcut/MixcutPanel.tsx`
- Modify: `lib/final-edit/mixcut-context.ts`
- Modify: `lib/final-edit/types.ts`
- Test: `scripts/project-info-ui-contract.test.mjs`
- Test: `scripts/final-edit-mixcut-context-contract.test.ts`

- [ ] **Step 1: Add failing contract assertions for the project header and Mixcut topbar entry points**
- [ ] **Step 2: Add `productCategory` to the Mixcut project context**
- [ ] **Step 3: Mount the shared dialog in the main project header and update page state on save**
- [ ] **Step 4: Mount the shared dialog in the Mixcut topbar and update `context.project` on save**
- [ ] **Step 5: Run both contract tests and confirm GREEN**

### Task 5: Export recovery flow

**Files:**
- Modify: `components/mixcut/ExportStep.tsx`
- Modify: `components/mixcut/MixcutPanel.tsx`
- Test: `scripts/project-info-ui-contract.test.mjs`
- Test: `scripts/final-edit-mixcut-ui-contract.test.mjs`

- [ ] **Step 1: Add failing assertions for “填写信息并导出”, the inline edit action, and absence of `null.mp4` preview construction**
- [ ] **Step 2: Replace null filename previews with “填写产品型号后自动生成”**
- [ ] **Step 3: Keep blocking timeline issues disabled, but make a missing product model recoverable through the dialog**
- [ ] **Step 4: After “保存并开始导出”, update parent project context and call render creation only after PATCH succeeds**
- [ ] **Step 5: Run both UI contract tests and confirm GREEN**

### Task 6: Verification

**Files:**
- Review all files changed by Tasks 1–5.

- [ ] **Step 1:** Run `node scripts/project-info.test.ts`
- [ ] **Step 2:** Run `node scripts/project-info-ui-contract.test.mjs`
- [ ] **Step 3:** Run `node scripts/final-edit-mixcut-context-contract.test.ts`
- [ ] **Step 4:** Run `node scripts/final-edit-mixcut-ui-contract.test.mjs`
- [ ] **Step 5:** Run `npm run lint`
- [ ] **Step 6:** Run `npm run build`
- [ ] **Step 7:** Inspect `git diff --check`, `git diff --stat`, and the complete relevant diff; verify unrelated pre-existing changes remain untouched.
