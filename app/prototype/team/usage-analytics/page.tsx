// THROWAWAY: three team usage layouts, ?variant=, no production page or API changes.
import { Suspense } from 'react';
import { notFound } from 'next/navigation';
import UsageAnalyticsPrototype from './UsageAnalyticsPrototype';

export default function UsageAnalyticsPrototypePage() {
  if (process.env.NODE_ENV === 'production' || process.env.CREATIVE_STUDIO_TEAM_UI_PROTOTYPE !== '1') notFound();
  return <Suspense fallback={<p>正在打开用量设计原型…</p>}><UsageAnalyticsPrototype /></Suspense>;
}
