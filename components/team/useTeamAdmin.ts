'use client';

import { useEffect, useState } from 'react';

/** 客户端仅投影角色，不读取凭据或完整会话。 */
export function useTeamAdmin(): boolean {
  const [admin, setAdmin] = useState(false);
  useEffect(() => {
    let active = true;
    void fetch('/api/team/auth/session', { cache: 'no-store' }).then(async (response) => {
      if (!response.ok) return;
      const body = await response.json() as { principal?: { role?: string } };
      if (active) setAdmin(body.principal?.role === 'admin');
    }).catch(() => {});
    return () => { active = false; };
  }, []);
  return admin;
}
