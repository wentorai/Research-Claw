import type { ReactNode } from 'react';
import type { ConfigPanelPlacement } from '../stores/ui';

const ORDER: ConfigPanelPlacement[] = ['left', 'top', 'bottom', 'right'];

interface DockSideIconProps {
  placement: ConfigPanelPlacement;
  size?: number;
}

/** DevTools-style dock icon: square outline + shaded panel region on one edge. */
function DockSideIcon({ placement, size = 16 }: DockSideIconProps) {
  const s = size;
  const pad = 1.5;
  const inner = s - pad * 2;
  const band = inner * 0.32;

  let shade: ReactNode = null;
  switch (placement) {
    case 'left':
      shade = <rect x={pad} y={pad} width={band} height={inner} rx={0.5} fill="currentColor" />;
      break;
    case 'right':
      shade = <rect x={s - pad - band} y={pad} width={band} height={inner} rx={0.5} fill="currentColor" />;
      break;
    case 'top':
      shade = <rect x={pad} y={pad} width={inner} height={band} rx={0.5} fill="currentColor" />;
      break;
    case 'bottom':
      shade = <rect x={pad} y={s - pad - band} width={inner} height={band} rx={0.5} fill="currentColor" />;
      break;
  }

  return (
    <svg
      width={s}
      height={s}
      viewBox={`0 0 ${s} ${s}`}
      aria-hidden
      style={{ display: 'block', flexShrink: 0 }}
    >
      <rect
        x={pad}
        y={pad}
        width={inner}
        height={inner}
        rx={1}
        fill="none"
        stroke="currentColor"
        strokeWidth={1}
      />
      {shade}
    </svg>
  );
}

export interface ConfigPanelDockPickerProps {
  value: ConfigPanelPlacement;
  onChange: (placement: ConfigPanelPlacement) => void;
  /** Screen-reader label for the icon group */
  ariaLabel: string;
  tooltips: Record<ConfigPanelPlacement, string>;
}

export default function ConfigPanelDockPicker({
  value,
  onChange,
  ariaLabel,
  tooltips,
}: ConfigPanelDockPickerProps) {
  return (
    <div className="config-dock-picker" role="group" aria-label={ariaLabel}>
      {ORDER.map((p) => {
          const active = value === p;
          return (
            <button
              key={p}
              type="button"
              className={`config-dock-btn${active ? ' is-active' : ''}`}
              aria-label={tooltips[p]}
              aria-pressed={active}
              title={tooltips[p]}
              onClick={() => onChange(p)}
            >
              <DockSideIcon placement={p} />
            </button>
          );
        })}
    </div>
  );
}
