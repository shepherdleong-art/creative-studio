'use client';

import { Icon } from '@/components/ui/Icon';
import shellStyles from '@/components/mixcut/mixcut-shell.module.css';

export interface BatchSidebarProps {
  taskName: string;
  overview: Array<{ label: string; value: string | number; accent?: boolean }>;
}

export default function BatchProductionSidebar({ taskName, overview }: BatchSidebarProps) {

  return (
    <div className={shellStyles.panel}>
      <h3><Icon name="monitor" size={15} />{taskName}</h3>
      <div className={shellStyles.statGrid}>
        {overview.map((item) => (
          <div key={item.label} className={`${shellStyles.stat} ${item.accent ? shellStyles.statAccent : ''}`}>
            <b>{item.value}</b>
            <span>{item.label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
