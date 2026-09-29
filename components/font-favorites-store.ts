import { fontIdentity, normalizeFavorites } from '../lib/media-core/font-identity.ts';

export interface FontFavoritesSnapshot { favorites: string[]; error: string }
export const EMPTY_FONT_FAVORITES: FontFavoritesSnapshot = { favorites: [], error: '' };

/** Browser cache is for display; the local workbench API owns the preference. */
export function createFontFavoritesStore(options: {
  request: (body?: object) => Promise<string[]>;
  readCache: () => string[];
  writeCache: (favorites: string[]) => void;
}) {
  const legacy = normalizeFavorites(options.readCache());
  let authoritative = legacy;
  let snapshot: FontFavoritesSnapshot = { favorites: legacy, error: '' };
  let imported = false;
  let refreshing: Promise<void> | null = null;
  let queue = Promise.resolve();
  const listeners = new Set<() => void>();
  const pending: Array<{ family: string; favorite: boolean }> = [];

  function publish(error = '') {
    let favorites = authoritative;
    for (const change of pending) {
      const rest = favorites.filter((family) => fontIdentity(family) !== fontIdentity(change.family));
      favorites = change.favorite ? [change.family, ...rest] : rest;
    }
    snapshot = { favorites, error };
    for (const listener of listeners) listener();
  }

  function accept(favorites: string[]) {
    authoritative = normalizeFavorites(favorites);
    options.writeCache(authoritative);
  }

  async function ensureImported() {
    if (imported) return;
    accept(await options.request({ action: 'import', favorites: legacy }));
    imported = true;
  }

  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    refresh(): Promise<void> {
      if (refreshing) return refreshing;
      refreshing = queue.then(async () => {
        try {
          if (imported) accept(await options.request());
          else await ensureImported();
          publish();
        } catch {
          publish('全局收藏同步失败，请稍后重试');
        }
      }).finally(() => { refreshing = null; });
      queue = refreshing;
      return refreshing;
    },
    toggleFavorite(family: string): Promise<void> {
      const change = {
        family,
        favorite: !snapshot.favorites.some((item) => fontIdentity(item) === fontIdentity(family)),
      };
      pending.push(change);
      publish();
      queue = queue.then(async () => {
        let error = '';
        try {
          await ensureImported();
          accept(await options.request({ action: 'set', ...change }));
        } catch {
          error = '收藏未保存，请重试';
        }
        pending.splice(pending.indexOf(change), 1);
        publish(error);
      });
      return queue;
    },
  };
}
