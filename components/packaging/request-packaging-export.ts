'use client';

/** Keep the selected outputs unchanged when retrying an explicitly confirmed export. */
export async function requestPackagingExport(url: string, body: { planIds: string[]; projectId?: string }): Promise<Response | null> {
  const send = (allowPackagingPlaceholder = false) => fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, allowPackagingPlaceholder }),
  });
  const response = await send();
  if (response.status !== 409) return response;
  const error = await response.clone().json().catch(() => ({}));
  if (error.code !== 'packaging_placeholder') return response;
  if (!window.confirm(`${error.message}\n\n确定：继续导出，缺失标题不显示。\n取消：返回修改。`)) return null;
  return send(true);
}
