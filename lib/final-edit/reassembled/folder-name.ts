import { sanitizeExportFilenamePart } from '../../media-core/export-identity.ts';

/** Keep the delivery identity readable without letting it introduce path segments. */
export function filmFolderName(baseName: string, id: string): string {
  if (!/^[a-f0-9-]{36}$/i.test(id)) throw new Error('Invalid film binding ID');
  const label = sanitizeExportFilenamePart(baseName).trim().slice(0, 64).replace(/[. ]+$/g, '') || '实拍成片';
  return `${label}--${id}`;
}
