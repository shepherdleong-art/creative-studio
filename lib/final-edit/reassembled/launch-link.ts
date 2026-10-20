import fs from 'node:fs';
import path from 'node:path';
import { dataRoot } from '../../data-root.ts';

export const reviewProtocolScheme = (identity: string) => `creative-studio-film-${identity.slice(0, 16)}`;

export function reviewLaunchUrl(binding: { id: string; reviewToken: string; deliveryVersion: number }, identity: string): string | null {
  try {
    const config = JSON.parse(fs.readFileSync(path.join(dataRoot(), 'storage/run/reassembled-launcher.json'), 'utf8'));
    if (config.schemaVersion !== 1 || config.dataIdentity !== identity || config.scheme !== reviewProtocolScheme(identity) || !process.env.CREATIVE_STUDIO_APPLICATION_ROOT || fs.realpathSync(config.applicationRoot) !== fs.realpathSync(process.env.CREATIVE_STUDIO_APPLICATION_ROOT)) return null;
    return `${config.scheme}://open/${binding.id}?${new URLSearchParams({ data: identity, version: String(binding.deliveryVersion), token: binding.reviewToken })}`;
  } catch { return null; }
}
