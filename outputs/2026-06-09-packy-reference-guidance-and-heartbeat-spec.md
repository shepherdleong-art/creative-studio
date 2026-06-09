# Packy Reference Guidance Toggle and Heartbeat Logs

Audience: Claude Code

Date: 2026-06-09

## Context

The workbench now has experimental Packy GPT-Image-2 support for reference images. The user tested it and confirmed Packy can succeed when the request sends reference images and the target image as repeated multipart `image` fields.

Important: do not revert the recent Packy fixes. These changes were made after live Packy API errors and are required for Packy to work:

- `lib/providers/packy-images.ts` must not send `response_format`. Live Packy `/v1/images/edits` returned `400 Unknown parameter: 'response_format'`.
- `lib/providers/packy-images.ts` must not send `input_fidelity`. Live Packy `/v1/images/edits` returned `400 ... does not support the 'input_fidelity' parameter`.
- Packy reference images are currently sent as repeated multipart `image` fields before the target image. The target image is appended last.
- `lib/queue.ts` logs Packy reference-image experimental mode when reference images are present.
- `lib/queue.ts` should keep the Packy timeout protection and Packy 4xx no-retry behavior to reduce duplicate-charge risk.

The current issue is product flexibility: Packy currently prepends a hard-coded prompt instruction when reference images exist:

```text
图1-N是风格/场景参考图，图N+1是需要编辑的原图。保持最后一张图的产品主体、比例、材质不变，参考前面图片调整场景、光线和布置。
```

This worked for product consistency, but the user wants it to be optional so future workflows can use reference images for other purposes.

The user also wants better visibility while Packy is running. Packy has no `task_id` and no polling endpoint, so true remote progress is unavailable. The right improvement is local heartbeat logging during the long synchronous request.

## Goals

1. Add a project/job-level option to enable or disable the automatic reference-image subject-preservation guidance.
2. Default the option to enabled so existing successful Packy behavior is preserved.
3. Store the option with each job so retry/regenerate behavior is stable.
4. Add heartbeat logs for Packy long-connection requests so the user can see the request is still waiting.
5. Avoid fake progress percentages. Logs should say elapsed time, not pretend to know remote progress.

## Non-Goals

- Do not add real Packy polling. Packy does not provide a task polling flow in the current integration.
- Do not call paid Packy/GeekAI APIs during implementation unless the user explicitly approves.
- Do not re-add `response_format` or `input_fidelity` to Packy.
- Do not block Packy reference images again.
- Do not redesign the whole project creation page.

## Recommended Design

### 1. Add `referenceGuidanceMode`

Use a string mode instead of a boolean. The UI can still be a checkbox, but the stored value should be future-proof.

Allowed values:

- `preserve_subject`: auto-prepend the current subject-preservation guidance when reference images exist.
- `none`: do not prepend automatic reference guidance; use the user's prompt as written.

Default:

- `preserve_subject`

Reason: this preserves the user's Packy success case while allowing opt-out.

Potential future value, not required now:

- `role_hint_only`: only explain image order without saying "keep subject unchanged".

Do not implement `role_hint_only` unless the user asks. Mentioning it here is only to explain why a string mode is preferable to a boolean column.

### 2. Database Changes

Update `lib/db.ts`.

Add columns to both tables:

```sql
projects.referenceGuidanceMode TEXT NOT NULL DEFAULT 'preserve_subject'
jobs.referenceGuidanceMode TEXT NOT NULL DEFAULT 'preserve_subject'
```

Also add migrations:

```sql
ALTER TABLE projects ADD COLUMN referenceGuidanceMode TEXT NOT NULL DEFAULT 'preserve_subject'
ALTER TABLE jobs ADD COLUMN referenceGuidanceMode TEXT NOT NULL DEFAULT 'preserve_subject'
```

Existing DB migration style catches duplicate-column errors, so follow the local pattern.

Why both tables:

- `projects` stores the user's project-level choice for display and future reuse.
- `jobs` stores the exact behavior used by each job, so retry/regenerate does not silently change if a future UI setting changes.

### 3. New Project UI

Update `app/projects/new/page.tsx`.

Add state:

```ts
const [referenceGuidanceMode, setReferenceGuidanceMode] =
  useState<'preserve_subject' | 'none'>('preserve_subject');
```

Add a checkbox near the reference-image upload area or near the prompt editor:

Label:

```text
保持待处理图主体不变
```

Helper copy:

```text
有参考图时生效。开启后会自动提示模型保留待处理图的主体、比例和材质；关闭后只使用你写的提示词。
```

Behavior:

- Checked means `referenceGuidanceMode = 'preserve_subject'`.
- Unchecked means `referenceGuidanceMode = 'none'`.
- Default checked.
- The option can remain visible even when there are no reference images, with helper copy saying it only takes effect when reference images exist.

Include `referenceGuidanceMode` in the `POST /api/projects` body.

### 4. Project Creation API

Update `app/api/projects/route.ts`.

Read `referenceGuidanceMode` from the request body:

```ts
const requestedReferenceGuidanceMode =
  body.referenceGuidanceMode === 'none' ? 'none' : 'preserve_subject';
```

Validate strictly:

- Accept only `preserve_subject` or `none`.
- Default missing/invalid values to `preserve_subject` if you want backward compatibility.
- Prefer returning `400` for unknown values if you want stricter API behavior. If you choose strict behavior, make sure old clients without this field still default successfully.

Insert the mode into:

- `projects.referenceGuidanceMode`
- each `jobs.referenceGuidanceMode`

### 5. Queue and Provider Data Flow

Update `lib/queue.ts`.

Add `referenceGuidanceMode` to `JobRecord`.

When calling Packy:

```ts
editImagePacky({
  ...
  referenceGuidanceMode: job.referenceGuidanceMode || 'preserve_subject',
})
```

When calling GeekAI:

```ts
submitGeekAITask({
  ...
  referenceGuidanceMode: job.referenceGuidanceMode || 'preserve_subject',
})
```

Reason: `lib/providers/geekai-json.ts` currently has a similar hard-coded subject-preservation prompt. The user asked for the hidden guidance to be optional; if this only changes Packy, GeekAI will still be locked.

OpenAI-compatible provider currently does not add the same hidden guidance; do not add new behavior there unless needed.

### 6. Provider Prompt Logic

Update `lib/providers/packy-images.ts`.

Extend the request interface:

```ts
referenceGuidanceMode?: 'preserve_subject' | 'none';
```

Build the prompt like this:

```ts
const shouldUseSubjectGuidance =
  request.referenceGuidanceMode !== 'none' &&
  request.referenceImagePaths.length > 0;

const prompt = shouldUseSubjectGuidance
  ? `图1-${request.referenceImagePaths.length}是风格/场景参考图，图${request.referenceImagePaths.length + 1}是需要编辑的原图。保持最后一张图的产品主体、比例、材质不变，参考前面图片调整场景、光线和布置。\n${request.prompt}`
  : request.prompt;
```

Important:

- Do not change multipart image order.
- Reference images should still be appended first.
- Target input image should still be appended last.
- Do not re-add `response_format`.
- Do not re-add `input_fidelity`.

Update `lib/providers/geekai-json.ts` similarly so its hard-coded subject guidance respects the same mode.

### 7. Regenerate Route

Update `app/api/jobs/[id]/regenerate/route.ts`.

When creating a revision job, copy `referenceGuidanceMode` from the original job.

This route currently inserts a new job from the original job fields. Add the new column to both the insert column list and the selected values.

Expected behavior:

- If the original job used `preserve_subject`, regenerated jobs keep it.
- If the original job used `none`, regenerated jobs keep it.
- The user's changed prompt in regenerate should not reset this mode.

### 8. Project Details API and UI

Recommended but not mandatory:

- `app/api/projects/[id]/route.ts` already uses `SELECT *` for project/job data, so the mode may appear automatically.
- `app/projects/[id]/page.tsx` can display a small project metadata line such as:

```text
参考图引导: 保持主体
```

or

```text
参考图引导: 无自动引导
```

Keep this lightweight. The key requirement is behavior, not display.

## Packy Heartbeat Logs

### Why This Is Needed

GeekAI returns `task_id` and can be polled. Packy does not. Packy `/v1/images/edits` is a long synchronous request: the workbench waits until Packy returns `data[0].url` or `data[0].b64_json`.

Therefore heartbeat logs should say:

- the request is still waiting,
- how long it has waited,
- that this is not real remote progress.

Do not show percentages.

### Implementation

Update the Packy branch in `lib/queue.ts`.

Before calling `editImagePacky`, log:

```text
Packy 长连接请求已开始，等待服务端返回...
```

Start a heartbeat interval before awaiting the Packy promise:

- interval: 15 seconds
- log level: `info`
- message example:

```text
Packy 长连接等待中，已等待 15s
```

After 60 seconds, use a slightly more helpful message:

```text
Packy 长连接等待中，已等待 60s；如果长时间无响应，可能是代理或网络限制了长连接
```

Always clear the interval in `finally`, including success, failure, timeout, or cancellation.

Pseudo-code:

```ts
const stopPackyHeartbeat = startPackyHeartbeat(logInfo);
try {
  const packyResult = await withTimeout(
    editImagePacky(...),
    timeoutMs,
    reqAbort
  );
  logInfo(`Packy 已返回并下载图片，耗时 ${Math.round(packyResult.latencyMs / 1000)}s，开始保存本地输出`);
  ...
} finally {
  stopPackyHeartbeat();
}
```

Suggested helper:

```ts
function startPackyHeartbeat(logInfo: (msg: string) => void, intervalMs = 15000): () => void {
  const startedAt = Date.now();
  const timer = setInterval(() => {
    const elapsed = Math.round((Date.now() - startedAt) / 1000);
    if (elapsed >= 60) {
      logInfo(`Packy 长连接等待中，已等待 ${elapsed}s；如果长时间无响应，可能是代理或网络限制了长连接`);
    } else {
      logInfo(`Packy 长连接等待中，已等待 ${elapsed}s`);
    }
  }, intervalMs);

  return () => clearInterval(timer);
}
```

TypeScript note:

- If TS complains about timer type, use `ReturnType<typeof setInterval>`.

### Expected Logs

For a successful Packy job:

```text
Calling Packy Images API (multipart, no polling)...
Packy 参考图实验模式：将 1 张参考图和 1 张待处理图都作为 image 字段提交
Packy 长连接请求已开始，等待服务端返回...
Packy 长连接等待中，已等待 15s
Packy 长连接等待中，已等待 30s
Packy 已返回并下载图片，耗时 42s，开始保存本地输出
任务完成 (成本: ¥...)
```

For Packy 400 errors:

```text
Packy API error 400: ...
Packy 返回 4xx 参数/请求错误，自动重试不会成功；已停止自动重试。请根据错误调整参数后手动重跑。
```

It should not retry automatically for Packy 4xx errors.

## Testing Checklist

Do not run paid API calls unless the user explicitly approves.

Required local checks:

1. Static check: Packy adapter does not send unsupported params.

```bash
node -e "const fs=require('fs'); const s=fs.readFileSync('lib/providers/packy-images.ts','utf8'); if (/form\\.append\\(['\\\"](response_format|input_fidelity)['\\\"]/.test(s)) throw new Error('Packy adapter sends unsupported params'); console.log('ok');"
```

2. Static check: Packy prompt guidance is gated by `referenceGuidanceMode`.

```bash
node -e "const fs=require('fs'); const s=fs.readFileSync('lib/providers/packy-images.ts','utf8'); if (!s.includes('referenceGuidanceMode')) throw new Error('Packy guidance mode missing'); if (!/referenceGuidanceMode[\\s\\S]*none/.test(s)) throw new Error('Packy guidance mode does not support none'); console.log('ok');"
```

3. Static check: GeekAI prompt guidance is also gated by `referenceGuidanceMode`.

```bash
node -e "const fs=require('fs'); const s=fs.readFileSync('lib/providers/geekai-json.ts','utf8'); if (!s.includes('referenceGuidanceMode')) throw new Error('GeekAI guidance mode missing'); console.log('ok');"
```

4. Static check: heartbeat helper exists and is cleared in a `finally` path.

```bash
node -e "const fs=require('fs'); const s=fs.readFileSync('lib/queue.ts','utf8'); if (!s.includes('startPackyHeartbeat')) throw new Error('Packy heartbeat helper missing'); if (!/finally\\s*{[\\s\\S]*stopPackyHeartbeat\\(\\)/.test(s)) throw new Error('Packy heartbeat is not cleared in finally'); console.log('ok');"
```

5. Build:

```bash
npm run build
```

Known issue:

- `npm run lint` previously failed due a local dependency/package issue around `node-exports-info@1.6.0` missing `getCategoriesForRange.js`. If lint still fails with that same error, record it as existing environment/dependency issue and do not hide it.

Optional manual test, only with user approval because it may cost Packy credits:

- Create Packy project with 1 input image and 1 reference image.
- Checkbox on: output should behave like the current successful test and preserve product subject more strongly.
- Checkbox off: request should still send images, but no hidden subject-preservation guidance should be prepended.
- Confirm logs show Packy heartbeat every 15 seconds while waiting.

## Acceptance Criteria

- User can create a project with reference guidance enabled or disabled.
- Default is enabled.
- Existing projects/jobs without the new column behave as enabled.
- Packy and GeekAI both respect `referenceGuidanceMode`.
- Packy still sends reference images before the target image.
- Packy still omits `response_format` and `input_fidelity`.
- Packy heartbeat logs appear during long waits and stop after success/failure/cancel/timeout.
- Packy 4xx errors do not auto-retry.
- `npm run build` passes.

