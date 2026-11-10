import { isPlaceholderValue } from '../../video-auth.ts';
import { isVisibleImageProvider } from '../../provider-list-visibility.ts';
import {
  isUnifiedImageChannelProvider,
  unifiedImageAnchorProjection,
} from './catalog.ts';

export interface ImageProviderListRow {
  id: string;
  name: string;
  model: string;
  type: string;
  enabled: number;
  apiKey: string;
  baseUrl: string;
}

function configuredSecret(value: unknown): boolean {
  const secret = String(value ?? '').trim();
  return Boolean(secret) && !isPlaceholderValue(secret);
}

function isRealImage2Channel(row: ImageProviderListRow): boolean {
  return isUnifiedImageChannelProvider(row);
}

export function projectTeamImageModels(
  rows: ImageProviderListRow[],
  options: { mode: 'local' | 'server'; unifiedAvailable: boolean },
) {
  const enabledVisible = rows
    .filter((row) => row.enabled === 1)
    .filter(isVisibleImageProvider);
  const project = (row: ImageProviderListRow) => {
    const configured = configuredSecret(row.apiKey);
    return {
      id: row.id,
      name: row.name,
      model: row.model,
      type: row.type,
      category: 'image',
      enabled: 1,
      configured,
      hasApiKey: configured,
      missing: configured ? [] : ['API Key'],
    };
  };
  if (options.mode === 'server') {
    return [
      unifiedImageAnchorProjection(options.unifiedAvailable),
      ...enabledVisible
        .filter((row) => !isRealImage2Channel(row))
        .map(project),
    ];
  }
  return enabledVisible.map(project);
}
