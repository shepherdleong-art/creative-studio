import type { PackagingStickerEditPatch } from '@/lib/media-core/packaging-stickers';

export type StickerBridgeHandlers = {
  onStickerSelect?: (stickerId: string) => void;
  onStickerCommit?: (stickerId: string, patch: PackagingStickerEditPatch) => Promise<boolean> | boolean;
  onStickerDelete?: (stickerId: string) => void;
  onStickerExit?: () => void;
};

/** Direct same-origin callbacks also carry the originating document to reject old iframe gestures. */
export function installStickerBridgeCallbacks(
  target: Window,
  getFrame: () => HTMLIFrameElement | null,
  getHandlers: () => StickerBridgeHandlers,
): () => void {
  const current = (source: Window, document: Document) => {
    const frame = getFrame();
    return Boolean(frame && source === frame.contentWindow && document === frame.contentDocument);
  };
  const callbacks = {
    __packagingStickerEditSelect: (id: string, source: Window, document: Document) => {
      if (current(source, document)) getHandlers().onStickerSelect?.(id);
    },
    __packagingStickerEditCommit: (id: string, patch: PackagingStickerEditPatch, source: Window, document: Document) => (
      current(source, document) ? getHandlers().onStickerCommit?.(id, patch) ?? false : false
    ),
    __packagingStickerEditDelete: (id: string, source: Window, document: Document) => {
      if (current(source, document)) getHandlers().onStickerDelete?.(id);
    },
    __packagingStickerEditExit: (source: Window, document: Document) => {
      if (current(source, document)) getHandlers().onStickerExit?.();
    },
  };
  const destination = target as Window & Partial<typeof callbacks>;
  Object.assign(destination, callbacks);
  return () => {
    for (const key of Object.keys(callbacks) as Array<keyof typeof callbacks>) {
      if (destination[key] === callbacks[key]) delete destination[key];
    }
  };
}
