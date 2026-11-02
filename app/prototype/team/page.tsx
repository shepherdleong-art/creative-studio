// THROWAWAY: compare employee and admin surfaces in three layouts on one route.
// Isolated preview only: npm run prototype:team. Never mounts the production DB.
import { Suspense } from 'react';
import { notFound } from 'next/navigation';
import TeamPrototype from './TeamPrototype';

export default function PrototypePage() {
  if (process.env.NODE_ENV === 'production' || process.env.CREATIVE_STUDIO_TEAM_UI_PROTOTYPE !== '1') notFound();
  return <Suspense fallback={<p>正在打开双端原型…</p>}><TeamPrototype /></Suspense>;
}
