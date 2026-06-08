import { describe, it, expect } from 'vitest';
import { buildAppShellGrid, clampPanelHeight, isHorizontalPlacement } from './config-panel-layout';

describe('config-panel-layout', () => {
  it('isHorizontalPlacement', () => {
    expect(isHorizontalPlacement('left')).toBe(true);
    expect(isHorizontalPlacement('top')).toBe(false);
  });

  it('clampPanelHeight', () => {
    expect(clampPanelHeight(100)).toBe(200);
    expect(clampPanelHeight(400)).toBe(400);
  });

  it('buildAppShellGrid left dock', () => {
    const g = buildAppShellGrid({
      leftNavWidth: 240,
      placement: 'left',
      panelOpen: true,
      panelWidth: 360,
      panelHeight: 300,
    });
    expect(g.gridTemplateAreas).toContain('leftnav config chat');
    expect(g.configGridArea).toBe('config');
  });

  it('buildAppShellGrid bottom dock', () => {
    const g = buildAppShellGrid({
      leftNavWidth: 56,
      placement: 'bottom',
      panelOpen: true,
      panelWidth: 360,
      panelHeight: 280,
    });
    expect(g.gridTemplateRows).toContain('280px');
    expect(g.gridTemplateAreas).toContain('leftnav config');
  });
});
