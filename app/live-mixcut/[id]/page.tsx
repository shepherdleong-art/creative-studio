'use client';

import { use } from 'react';
import LiveMixcutTaskPanel from '@/components/live-mixcut/LiveMixcutTaskPanel';

export default function LiveMixcutTaskPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return <LiveMixcutTaskPanel projectId={id} />;
}
