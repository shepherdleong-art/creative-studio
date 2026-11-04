/** Shared by every image upload entry; local mode retains the original API. */
export async function uploadImages(form: FormData): Promise<Response> {
  if (typeof document === 'undefined' || document.documentElement.dataset.deploymentMode !== 'server') {
    return fetch('/api/upload', { method: 'POST', body: form });
  }
  const files = form.getAll('files').filter((file): file is File => file instanceof File);
  const projectId = form.get('projectId');
  const role = String(form.get('role') || 'input');
  const usage = String(form.get('usage') || '');
  const fail = (message: string) => Response.json({ error: message, message }, { status: 400 });
  if (typeof projectId !== 'string' || !projectId) return fail('请先创建项目，再上传图片。');
  if (!files.length || files.length > (role === 'reference' ? 3 : 50)) return fail('图片数量超出允许范围。');
  if (usage === 'video_tail_frame' && files.length !== 1) return fail('尾帧图一次只能上传 1 张。');
  if (files.some(file => file.size > 50 * 1024 * 1024)) return fail('单张图片不能超过 50 MB。');
  const uploaded = [];
  async function json(url: string, init: RequestInit) {
    const response = await fetch(url, init);
    const body = await response.json();
    if (!response.ok) throw new Error(body.message || body.error || '图片上传失败');
    return body;
  }
  try {
    for (const file of files) {
      const bytes = await file.arrayBuffer();
      const digest = await crypto.subtle.digest('SHA-256', bytes);
      const sha256 = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
      const mimeType = file.type || ({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' } as Record<string, string>)[file.name.split('.').pop()?.toLowerCase() ?? ''];
      if (!mimeType || !['image/png', 'image/jpeg', 'image/webp'].includes(mimeType)) return fail('请选择 PNG / JPEG / WebP 格式的图片。');
      const sourceFingerprint = `${file.size}:${file.lastModified}:${sha256}`;
      const created = await json('/api/team/uploads', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetKind: 'project_image', targetScope: { resourceType: 'project', resourceId: projectId },
          usage: 'image', relativeName: file.name, mimeType, expectedSize: file.size, expectedSha256: sha256,
          sourceFingerprint, idempotencyKey: crypto.randomUUID(),
          imageOptions: { role, usage, preprocessEnabled: form.get('preprocessEnabled') !== 'false',
            targetMaxSide: Number(form.get('targetMaxSide') || 1536), jpegQuality: Number(form.get('jpegQuality') || 85) },
        }),
      });
      for (const part of created.missingParts as number[]) {
        const start = (part - 1) * created.partSize;
        await json(`/api/team/uploads/${created.uploadId}/parts/${part}`, {
          method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' },
          body: file.slice(start, Math.min(start + created.partSize, file.size)),
        });
      }
      const completed = await json(`/api/team/uploads/${created.uploadId}/complete`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedSha256: sha256, sourceFingerprint }),
      });
      if (!completed.uploadedFile) throw new Error('图片已上传，但归库结果不完整，请刷新项目。');
      uploaded.push(completed.uploadedFile);
    }
    return Response.json({ files: uploaded });
  } catch (error) {
    return fail(error instanceof Error ? error.message : '图片上传失败，请重试。');
  }
}
