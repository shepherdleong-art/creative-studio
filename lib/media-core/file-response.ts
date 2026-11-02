import { createHash } from 'node:crypto';
import fs from 'node:fs';
import {
  authorizeManagedFileRead,
  type ManagedFileGrant,
} from './access-context.ts';
import { projectAssetMediaResponse } from './project-asset-media-response.ts';

export interface FileResponseOptions {
  cacheControl?: string;
  etag?: string;
  downloadName?: string;
  onClose?: () => void;
  /** 已由 team-files 完成实体授权时传入，避免重复解析。 */
  grant?: ManagedFileGrant;
}

function strongEtag(file: string, grant: ManagedFileGrant | null): string {
  const stat = grant ? null : fs.statSync(file);
  const identity = grant
    ? `${grant.fileId}\0${grant.version}\0${grant.sha256}`
    : `${file}\0${stat!.size}\0${stat!.mtimeMs}`;
  return `"${createHash('sha256').update(identity).digest('hex')}"`;
}

/** 单文件共享入口：团队模式先完成登记与实体授权，再打开文件。 */
export function fileResponse(
  request: Request,
  file: string,
  contentType: string,
  options: FileResponseOptions = {},
): Response {
  const grant = options.grant ?? authorizeManagedFileRead(file);
  const headers: Record<string, string> = {};
  if (options.downloadName) {
    headers['Content-Disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(options.downloadName)}`;
  }
  const response = projectAssetMediaResponse(request, file, contentType, headers, undefined, {
    cacheControl: grant ? 'private, no-store' : options.cacheControl ?? 'private, max-age=3600',
    etag: options.etag ?? strongEtag(file, grant),
    onClose: options.onClose,
    grant: grant ?? undefined,
  });
  return response.status === 416
    ? new Response(null, { status: 416, headers: response.headers })
    : response;
}
