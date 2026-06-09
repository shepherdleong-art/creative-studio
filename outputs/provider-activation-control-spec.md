# Provider Activation Control Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user safely configure multiple provider API keys while clearly controlling which provider(s) can be used for new batch jobs.

**Architecture:** Reuse the existing `providers.enabled` database field as the source of truth. Add quick actions in the provider settings page for enable/disable and "use only this provider", keep API keys intact, and make the new-project provider picker select only enabled providers with configured keys.

**Tech Stack:** Next.js App Router, TypeScript React components, SQLite via `better-sqlite3`, existing provider routes under `app/api/providers`.

---

## Product Requirement

The user may configure API keys for multiple providers, such as:

```text
GeekAI
Packy
Company API
```

But for a given testing phase, the user may want to use only one provider. Example:

```text
I bought 10 yuan of Packy balance and only want this workbench to use Packy.
```

The UI must make this safe and obvious.

## Current Project Context

Existing behavior already partially supports this:

- `providers.enabled` exists in SQLite.
- `app/settings/page.tsx` edit form includes an `启用` checkbox.
- `components/ProviderSettings.tsx` renders only `providers.filter((p) => p.enabled)`.
- `app/api/providers/[id]/route.ts` can update `enabled`.
- Each project stores `providerId`; each job stores `providerId`; jobs do not automatically fan out to multiple providers.

Current issues:

- Enable/disable is hidden inside the edit form.
- There is no one-click "only use this provider" action.
- New project auto-select currently uses `data[0]`, which may be disabled or missing an API key before render filtering.
- If no providers are enabled, the new project page does not give a clear action.
- The settings list shows `已禁用`, but does not provide a direct toggle button.

## Desired UX

On the provider settings page, each provider card should show:

```text
Provider name
Key status
Enabled/disabled status
Base URL
Model
Type
Estimated cost

[启用] or [禁用]
[设为唯一启用]
[编辑]
[删除]
```

Button semantics:

- `启用`: sets this provider's `enabled` to `true`.
- `禁用`: sets this provider's `enabled` to `false`.
- `设为唯一启用`: sets this provider's `enabled` to `true` and all other providers' `enabled` to `false`.
- These actions must not delete or overwrite API keys.

New project page semantics:

- Show only enabled providers.
- Prefer auto-selecting the first enabled provider that also has an API key.
- If zero enabled providers exist, show a clear message linking to `/settings`.
- If enabled providers exist but none has an API key, show a clear message linking to `/settings`.
- Never silently select a disabled provider.

## Non-Goals

- Do not delete providers.
- Do not delete API keys.
- Do not add provider load-balancing.
- Do not add fallback from one provider to another.
- Do not automatically switch provider after failure.
- Do not run paid image generation tests for this feature.

## Task 1: Add Provider Quick Toggle API Helper

**Files:**

- Modify: `app/api/providers/[id]/route.ts`

- [ ] **Step 1: Confirm existing PUT supports `enabled`**

Open `app/api/providers/[id]/route.ts` and confirm `PUT` updates `enabled` when present:

```ts
if (body.enabled !== undefined) {
  updates.push('enabled = ?');
  values.push(body.enabled ? 1 : 0);
}
```

Expected behavior:

- Quick enable/disable can reuse this existing `PUT` endpoint.

- [ ] **Step 2: Add an activate-only route**

Create a nested route:

```text
app/api/providers/[id]/activate-only/route.ts
```

Use this implementation:

```ts
import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const db = getDb();

    const provider = db.prepare(`SELECT id FROM providers WHERE id = ?`).get(id);
    if (!provider) {
      return NextResponse.json({ error: 'Provider not found' }, { status: 404 });
    }

    const tx = db.transaction(() => {
      db.prepare(`UPDATE providers SET enabled = 0 WHERE id != ?`).run(id);
      db.prepare(`UPDATE providers SET enabled = 1 WHERE id = ?`).run(id);
    });

    tx();

    return NextResponse.json({ success: true });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
```

Expected behavior:

- One request atomically makes exactly one provider enabled.
- API keys are unchanged.
- Provider rows are not deleted.

## Task 2: Add Quick Buttons to Settings Page

**Files:**

- Modify: `app/settings/page.tsx`

- [ ] **Step 1: Add quick action handlers**

Inside `SettingsPage`, add:

```ts
const setProviderEnabled = async (id: string, enabled: boolean) => {
  setSaving(true);
  try {
    const res = await fetch(`/api/providers/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    });
    const data = await res.json();
    if (data.error) {
      alert(data.error);
      return;
    }
    await loadProviders();
  } catch (err) {
    alert('更新启用状态失败: ' + String(err));
  } finally {
    setSaving(false);
  }
};

const activateOnlyProvider = async (id: string, name: string) => {
  if (!confirm(`只启用「${name}」，并禁用其他供应商？API Key 会保留。`)) return;

  setSaving(true);
  try {
    const res = await fetch(`/api/providers/${id}/activate-only`, {
      method: 'POST',
    });
    const data = await res.json();
    if (data.error) {
      alert(data.error);
      return;
    }
    await loadProviders();
  } catch (err) {
    alert('设置唯一启用失败: ' + String(err));
  } finally {
    setSaving(false);
  }
};
```

Expected behavior:

- The settings page can toggle a provider without opening edit mode.
- The settings page can set one provider as the only enabled provider.

- [ ] **Step 2: Add quick buttons to each provider card**

In the non-editing card action area, replace the current button group:

```tsx
<div className="flex gap-2 ml-4">
  <button
    onClick={() => startEdit(p)}
    className="btn-secondary btn-sm"
  >
    编辑
  </button>
  <button
    onClick={() => handleDelete(p.id)}
    className="text-red-400 hover:text-red-600 text-sm px-2"
  >
    删除
  </button>
</div>
```

with:

```tsx
<div className="flex flex-wrap gap-2 ml-4 justify-end">
  <button
    onClick={() => setProviderEnabled(p.id, !p.enabled)}
    disabled={saving}
    className={p.enabled ? 'btn-secondary btn-sm' : 'btn-primary btn-sm'}
  >
    {p.enabled ? '禁用' : '启用'}
  </button>
  <button
    onClick={() => activateOnlyProvider(p.id, p.name)}
    disabled={saving || (!!p.enabled && providers.filter((item) => item.enabled).length === 1)}
    className="btn-secondary btn-sm"
  >
    设为唯一启用
  </button>
  <button
    onClick={() => startEdit(p)}
    disabled={saving}
    className="btn-secondary btn-sm"
  >
    编辑
  </button>
  <button
    onClick={() => handleDelete(p.id)}
    disabled={saving}
    className="text-red-400 hover:text-red-600 text-sm px-2"
  >
    删除
  </button>
</div>
```

Expected behavior:

- The user sees provider activation controls directly on the card.
- `设为唯一启用` is disabled if this provider is already the only enabled one.

- [ ] **Step 3: Fix cost display typo while editing this UI**

In `app/settings/page.tsx`, find:

```tsx
{p.defaultCostPerImage != null ? `¥{p.defaultCostPerImage}/张` : '未设置'}
```

Replace with:

```tsx
{p.defaultCostPerImage != null ? `¥${p.defaultCostPerImage}/张` : '未设置'}
```

Expected behavior:

- Estimated cost displays the actual number.

## Task 3: Make New Project Provider Picker Safe

**Files:**

- Modify: `components/ProviderSettings.tsx`

- [ ] **Step 1: Select only enabled providers with API keys**

Replace:

```ts
setProviders(data);
if (!selectedId && data.length > 0) {
  onSelect(data[0]);
}
```

with:

```ts
setProviders(data);
const selectable = data.filter((p: Provider) => p.enabled && p.hasApiKey);
if (!selectedId && selectable.length > 0) {
  onSelect(selectable[0]);
}
```

Expected behavior:

- A disabled provider is never auto-selected.
- A provider without API key is never auto-selected.

- [ ] **Step 2: Add empty state for no enabled providers**

Before the grid render, add:

```tsx
const enabledProviders = providers.filter((p) => p.enabled);
const selectableProviders = enabledProviders.filter((p) => p.hasApiKey);

if (enabledProviders.length === 0) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <label className="label mb-0">供应商</label>
        <a href="/settings" className="text-xs text-blue-600 hover:text-blue-800">
          管理供应商 →
        </a>
      </div>
      <div className="rounded-lg border border-yellow-200 bg-yellow-50 p-4 text-sm text-yellow-800">
        当前没有启用的供应商。请先到供应商配置里启用 GeekAI、Packy 或其他 API。
      </div>
    </div>
  );
}

if (selectableProviders.length === 0) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <label className="label mb-0">供应商</label>
        <a href="/settings" className="text-xs text-blue-600 hover:text-blue-800">
          管理供应商 →
        </a>
      </div>
      <div className="rounded-lg border border-orange-200 bg-orange-50 p-4 text-sm text-orange-800">
        已启用供应商，但还没有可用 API Key。请先到供应商配置里填写 Key。
      </div>
    </div>
  );
}
```

Then change the grid source from:

```tsx
{providers.filter((p) => p.enabled).map((p) => (
```

to:

```tsx
{enabledProviders.map((p) => (
```

Expected behavior:

- Empty states are clear and actionable.
- Enabled providers without keys can still be shown as disabled cards.

- [ ] **Step 3: Keep card disabled state for missing keys**

Keep:

```tsx
disabled={!p.hasApiKey}
```

Expected behavior:

- A provider can be enabled but still not selectable until its API key is configured.

## Task 4: Prevent Project Creation Without Valid Provider

**Files:**

- Modify: `app/projects/new/page.tsx`
- Modify: `app/api/projects/route.ts`

- [ ] **Step 1: Add frontend guard**

In `app/projects/new/page.tsx`, before submitting, add a guard near the existing validation:

```ts
if (!provider) {
  alert('请先选择一个已启用且已配置 Key 的供应商');
  return;
}

if (!provider.hasApiKey) {
  alert('当前供应商未配置 API Key，请先到供应商配置里填写 Key');
  return;
}
```

Expected behavior:

- The user cannot accidentally create a project with no usable provider.

- [ ] **Step 2: Add backend guard**

In `app/api/projects/route.ts`, after reading `providerId`, add:

```ts
const provider = db.prepare(`SELECT id, enabled, apiKey, apiKeyEnv FROM providers WHERE id = ?`).get(providerId) as {
  id: string;
  enabled: number;
  apiKey: string;
  apiKeyEnv: string;
} | undefined;

if (!provider) {
  return NextResponse.json({ error: 'Provider not found' }, { status: 400 });
}

if (!provider.enabled) {
  return NextResponse.json({ error: 'Provider is disabled. Enable it in Settings before creating a project.' }, { status: 400 });
}

if (!provider.apiKey && !process.env[provider.apiKeyEnv]) {
  return NextResponse.json({ error: 'Provider API key is not configured.' }, { status: 400 });
}
```

Expected behavior:

- API requests cannot create jobs against disabled providers.
- API requests cannot create jobs against providers with no API key.

## Task 5: Add User-Facing Notes

**Files:**

- Modify: `app/settings/page.tsx`
- Create: `outputs/provider-activation-test-checklist.md`

- [ ] **Step 1: Add short explanation on settings page**

Under the settings page description, add:

```tsx
<p className="text-xs text-gray-400 mt-1">
  可以保存多家供应商的 Key；只有启用的供应商会出现在新建项目里。"设为唯一启用"不会删除其他 Key。
</p>
```

Expected behavior:

- The user understands that disabled providers keep their keys but will not be used.

- [ ] **Step 2: Add manual test checklist**

Create `outputs/provider-activation-test-checklist.md`:

```md
# Provider Activation Test Checklist

## No-paid checks

- Configure at least two providers with fake or real keys.
- Disable all providers.
- Open New Project.
- Expected: New Project shows "当前没有启用的供应商".

- Enable one provider.
- Open New Project.
- Expected: Only that provider appears and is auto-selected if it has a Key.

- Enable two providers.
- Click "设为唯一启用" on Packy.
- Open New Project.
- Expected: Only Packy appears.

- Disable a provider with an API Key.
- Re-open settings.
- Expected: API Key status still shows configured; disabling did not delete the Key.

- Try to create a project through API with a disabled providerId.
- Expected: API returns 400 and does not create jobs.

## Paid checks

Do not run paid API image generation for this feature. This feature only controls provider selection.
```

Expected behavior:

- Claude Code has a clear test path that does not spend money.

## Verification Commands

Run:

```bash
npm run lint
npm run build
```

Expected:

```text
Both commands complete without errors.
```

If local dependencies are broken:

```bash
npm install
npm run lint
npm run build
```

Do not run image generation API calls as part of this feature verification.

## Handoff Prompt for Claude Code

```text
Please continue developing /Users/liangpeijian/for-cc/batch-image-workbench.

Read outputs/provider-activation-control-spec.md first.

Goal:
Let the user configure multiple providers but clearly control which one(s) are usable for new projects.

Important:
- Reuse the existing providers.enabled field.
- Do not delete API keys when disabling a provider.
- Add quick enable/disable buttons on provider cards.
- Add "设为唯一启用" to enable one provider and disable all others.
- New Project must only auto-select enabled providers with configured keys.
- New Project should show clear empty states if no provider is enabled or no enabled provider has a key.
- Backend project creation should reject disabled or keyless providers.
- Do not run paid image generation tests.

After implementation:
- Run npm run lint.
- Run npm run build.
- Commit changes locally with a clear message.
```

## Self-Review

- Spec coverage: Covers direct toggle, one-click sole activation, preserving keys, new project picker behavior, backend guard, user notes, and no-paid verification.
- Placeholder scan: No TBD/TODO/implement later placeholders remain.
- Type consistency: The feature consistently reuses `providers.enabled`; no separate active-provider table or fallback system is introduced.
