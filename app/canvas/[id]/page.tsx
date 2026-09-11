'use client';

import { use } from 'react';
import { CanvasEditor } from '@/components/creative-canvas/CanvasEditor';

export default function CanvasEditorPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return <CanvasEditor canvasId={id} />;
}
