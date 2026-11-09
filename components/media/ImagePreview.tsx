'use client';

import { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Dialog } from '@/components/ui/Dialog';
import { Icon } from '@/components/ui/Icon';
import styles from './image-preview.module.css';

/** Fixed-size comparison surface; the original image opens on an explicit click. */
export default function ImagePreview({ src, alt }: { src: string; alt: string }) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const close = () => { setOpen(false); trigger.current?.focus(); };
  return <>
    <button ref={trigger} type="button" className={styles.trigger} aria-label={`放大预览：${alt}`} onClick={() => setOpen(true)}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={src} alt={alt} draggable={false} />
      <span className={styles.hint}><Icon name="search" size={14} />点击放大</span>
    </button>
    {open && createPortal(
      <Dialog open title={alt} width="wide" onClose={close}>
        <div className={styles.stage}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={src} alt={`${alt} · 大图`} />
        </div>
      </Dialog>, document.body,
    )}
  </>;
}
