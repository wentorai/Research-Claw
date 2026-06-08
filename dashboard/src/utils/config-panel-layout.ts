import type { CSSProperties } from 'react';

export type ConfigPanelPlacement = 'right' | 'left' | 'top' | 'bottom';

export const CONFIG_PANEL_WIDTH_MIN = 320;
export const CONFIG_PANEL_WIDTH_MAX = 480;
export const CONFIG_PANEL_HEIGHT_MIN = 200;
export const CONFIG_PANEL_HEIGHT_MAX = 520;
export const CONFIG_PANEL_WIDTH_DEFAULT = 360;
export const CONFIG_PANEL_HEIGHT_DEFAULT = 300;

const VALID_PLACEMENTS = new Set<ConfigPanelPlacement>(['right', 'left', 'top', 'bottom']);

export function clampPanelWidth(width: number): number {
  return Math.min(CONFIG_PANEL_WIDTH_MAX, Math.max(CONFIG_PANEL_WIDTH_MIN, width));
}

export function clampPanelHeight(height: number): number {
  return Math.min(CONFIG_PANEL_HEIGHT_MAX, Math.max(CONFIG_PANEL_HEIGHT_MIN, height));
}

export function loadConfigPanelPlacement(): ConfigPanelPlacement {
  try {
    const raw = localStorage.getItem('rc-config-panel-placement');
    if (raw && VALID_PLACEMENTS.has(raw as ConfigPanelPlacement)) {
      return raw as ConfigPanelPlacement;
    }
  } catch { /* ignore */ }
  return 'right';
}

export function loadConfigPanelHeight(): number {
  try {
    const raw = localStorage.getItem('rc-config-panel-height');
    if (raw) {
      const n = Number(raw);
      if (Number.isFinite(n)) return clampPanelHeight(n);
    }
  } catch { /* ignore */ }
  return CONFIG_PANEL_HEIGHT_DEFAULT;
}

export function isHorizontalPlacement(p: ConfigPanelPlacement): boolean {
  return p === 'left' || p === 'right';
}

export interface AppShellGrid {
  gridTemplateColumns: string;
  gridTemplateRows: string;
  gridTemplateAreas: string;
  configGridArea: string;
  chatGridArea: string;
  configBorderStyle: CSSProperties;
}

/** Compute CSS grid for main shell (topbar / leftnav / chat / config / statusbar). */
export function buildAppShellGrid(opts: {
  leftNavWidth: number;
  placement: ConfigPanelPlacement;
  panelOpen: boolean;
  panelWidth: number;
  panelHeight: number;
}): AppShellGrid {
  const { leftNavWidth, placement, panelOpen, panelWidth, panelHeight } = opts;
  const span = panelOpen
    ? isHorizontalPlacement(placement)
      ? `${clampPanelWidth(panelWidth)}px`
      : `${clampPanelHeight(panelHeight)}px`
    : '0px';

  const nav = `${leftNavWidth}px`;

  if (placement === 'left' && panelOpen) {
    return {
      gridTemplateColumns: `${nav} ${span} 1fr`,
      gridTemplateRows: '48px 1fr 28px',
      gridTemplateAreas: `
        "topbar topbar topbar"
        "leftnav config chat"
        "statusbar statusbar statusbar"
      `,
      configGridArea: 'config',
      chatGridArea: 'chat',
      configBorderStyle: { borderRight: '1px solid var(--border)' },
    };
  }

  if (placement === 'top' && panelOpen) {
    return {
      gridTemplateColumns: `${nav} 1fr`,
      gridTemplateRows: `48px ${span} 1fr 28px`,
      gridTemplateAreas: `
        "topbar topbar"
        "leftnav config"
        "leftnav chat"
        "statusbar statusbar"
      `,
      configGridArea: 'config',
      chatGridArea: 'chat',
      configBorderStyle: { borderBottom: '1px solid var(--border)' },
    };
  }

  if (placement === 'bottom' && panelOpen) {
    return {
      gridTemplateColumns: `${nav} 1fr`,
      gridTemplateRows: `48px 1fr ${span} 28px`,
      gridTemplateAreas: `
        "topbar topbar"
        "leftnav chat"
        "leftnav config"
        "statusbar statusbar"
      `,
      configGridArea: 'config',
      chatGridArea: 'chat',
      configBorderStyle: { borderTop: '1px solid var(--border)' },
    };
  }

  // right (default) or closed vertical placements fall back to right column slot
  const rightCol = placement === 'right' && panelOpen ? span : '0px';
  return {
    gridTemplateColumns: `${nav} 1fr ${rightCol}`,
    gridTemplateRows: '48px 1fr 28px',
    gridTemplateAreas: `
      "topbar topbar topbar"
      "leftnav chat config"
      "statusbar statusbar statusbar"
    `,
    configGridArea: 'config',
    chatGridArea: 'chat',
    configBorderStyle: { borderLeft: panelOpen && placement === 'right' ? '1px solid var(--border)' : 'none' },
  };
}

export interface OverlayPanelLayout {
  style: CSSProperties;
  animationName: string;
}

export function buildOverlayPanelLayout(opts: {
  placement: ConfigPanelPlacement;
  panelMode: 'overlay' | 'modal';
  leftNavWidth: number;
  panelWidth: number;
  panelHeight: number;
}): OverlayPanelLayout {
  const { placement, panelMode, leftNavWidth, panelWidth, panelHeight } = opts;
  const width = clampPanelWidth(panelWidth);
  const height = clampPanelHeight(panelHeight);
  const topOffset = 48;
  const bottomOffset = 28;

  if (panelMode === 'modal') {
    return {
      style: {
        position: 'fixed',
        top: topOffset,
        left: leftNavWidth,
        right: 0,
        bottom: bottomOffset,
        background: 'var(--surface)',
        zIndex: 1000,
        overflow: 'hidden',
      },
      animationName: 'rcPanelFadeIn',
    };
  }

  const base: CSSProperties = {
    position: 'fixed',
    background: 'var(--surface)',
    zIndex: 1000,
    overflow: 'hidden',
  };

  switch (placement) {
    case 'left':
      return {
        style: {
          ...base,
          top: topOffset,
          left: leftNavWidth,
          bottom: bottomOffset,
          width: Math.min(width, 480),
          borderRight: '1px solid var(--border)',
        },
        animationName: 'rcPanelSlideInLeft',
      };
    case 'top':
      return {
        style: {
          ...base,
          top: topOffset,
          left: leftNavWidth,
          right: 0,
          height,
          borderBottom: '1px solid var(--border)',
        },
        animationName: 'rcPanelSlideInTop',
      };
    case 'bottom':
      return {
        style: {
          ...base,
          left: leftNavWidth,
          right: 0,
          bottom: bottomOffset,
          height,
          borderTop: '1px solid var(--border)',
        },
        animationName: 'rcPanelSlideInBottom',
      };
    case 'right':
    default:
      return {
        style: {
          ...base,
          top: topOffset,
          right: 0,
          bottom: bottomOffset,
          width: Math.min(width, 480),
          borderLeft: '1px solid var(--border)',
        },
        animationName: 'rcPanelSlideInRight',
      };
  }
}
