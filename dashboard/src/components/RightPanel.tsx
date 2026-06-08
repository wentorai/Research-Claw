import React, { Suspense, lazy, useCallback, useRef } from 'react';
import { Button, Spin, Typography } from 'antd';
import { CloseOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import {
  useUiStore,
  type PanelTab,
  type ConfigPanelPlacement,
} from '../stores/ui';
import { isHorizontalPlacement } from '../utils/config-panel-layout';
import ConfigPanelDockPicker from './ConfigPanelDockPicker';

const { Text } = Typography;

const LibraryPanel = lazy(() => import('./panels/LibraryPanel'));
const WorkspacePanel = lazy(() => import('./panels/WorkspacePanel'));
const TaskPanel = lazy(() => import('./panels/TaskPanel'));
const MonitorPanel = lazy(() => import('./panels/MonitorPanel'));
const ExtensionsPanel = lazy(() => import('./panels/ExtensionsPanel'));
const SettingsPanel = lazy(() => import('./panels/SettingsPanel'));
const SupervisorPanel = lazy(() => import('./panels/SupervisorPanel'));
const PaperReviewPanel = lazy(() => import('./panels/PaperReviewPanel'));

const TAB_TITLE_KEYS: Record<PanelTab, string> = {
  library: 'library.title',
  workspace: 'workspace.title',
  review: 'paperReview.title',
  tasks: 'tasks.title',
  monitor: 'monitor.title',
  supervisor: 'supervisor.title',
  extensions: 'extensions.title',
  settings: 'settings.title',
};

function PanelContent({ tab }: { tab: PanelTab }) {
  switch (tab) {
    case 'library':
      return <LibraryPanel />;
    case 'workspace':
      return <WorkspacePanel />;
    case 'review':
      return <PaperReviewPanel />;
    case 'tasks':
      return <TaskPanel />;
    case 'monitor':
      return <MonitorPanel />;
    case 'supervisor':
      return <SupervisorPanel />;
    case 'extensions':
      return <ExtensionsPanel />;
    case 'settings':
      return <SettingsPanel />;
  }
}

function PlacementPicker() {
  const { t } = useTranslation();
  const placement = useUiStore((s) => s.configPanelPlacement);
  const setPlacement = useUiStore((s) => s.setConfigPanelPlacement);

  const tooltips: Record<ConfigPanelPlacement, string> = {
    right: t('panel.placementRight', 'Dock to the right'),
    left: t('panel.placementLeft', 'Dock to the left'),
    top: t('panel.placementTop', 'Dock to the top'),
    bottom: t('panel.placementBottom', 'Dock to the bottom'),
  };

  return (
    <ConfigPanelDockPicker
      ariaLabel={t('panel.dockSide', 'Dock side')}
      value={placement}
      onChange={setPlacement}
      tooltips={tooltips}
    />
  );
}

function ResizeHandle() {
  const { t } = useTranslation();
  const placement = useUiStore((s) => s.configPanelPlacement);
  const setWidth = useUiStore((s) => s.setRightPanelWidth);
  const setHeight = useUiStore((s) => s.setConfigPanelHeight);
  const draggingRef = useRef(false);
  const startPosRef = useRef(0);
  const startSizeRef = useRef(0);
  const horizontal = isHorizontalPlacement(placement);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      draggingRef.current = true;
      const state = useUiStore.getState();
      if (horizontal) {
        startPosRef.current = e.clientX;
        startSizeRef.current = state.rightPanelWidth;
      } else {
        startPosRef.current = e.clientY;
        startSizeRef.current = state.configPanelHeight;
      }

      const handleMouseMove = (ev: MouseEvent) => {
        if (!draggingRef.current) return;
        const st = useUiStore.getState();
        const p = st.configPanelPlacement;
        if (isHorizontalPlacement(p)) {
          let delta = startPosRef.current - ev.clientX;
          if (p === 'left') delta = ev.clientX - startPosRef.current;
          setWidth(startSizeRef.current + delta);
        } else {
          let delta = startPosRef.current - ev.clientY;
          if (p === 'top') delta = ev.clientY - startPosRef.current;
          setHeight(startSizeRef.current + delta);
        }
      };

      const handleMouseUp = () => {
        draggingRef.current = false;
        document.removeEventListener('mousemove', handleMouseMove);
        document.removeEventListener('mouseup', handleMouseUp);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      };

      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = horizontal ? 'col-resize' : 'row-resize';
      document.body.style.userSelect = 'none';
    },
    [horizontal, setWidth, setHeight],
  );

  const edgeStyle: React.CSSProperties = horizontal
    ? placement === 'left'
      ? { right: 0, top: 0, bottom: 0, width: 4, cursor: 'col-resize' }
      : { left: 0, top: 0, bottom: 0, width: 4, cursor: 'col-resize' }
    : placement === 'top'
      ? { left: 0, right: 0, bottom: 0, height: 4, cursor: 'row-resize' }
      : { left: 0, right: 0, top: 0, height: 4, cursor: 'row-resize' };

  return (
    <div
      onMouseDown={handleMouseDown}
      aria-label={t('panel.resizeHandle', 'Resize panel')}
      style={{
        position: 'absolute',
        zIndex: 10,
        background: 'transparent',
        ...edgeStyle,
      }}
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLElement).style.background = 'var(--accent-secondary)';
      }}
      onMouseLeave={(e) => {
        if (!draggingRef.current) {
          (e.currentTarget as HTMLElement).style.background = 'transparent';
        }
      }}
    />
  );
}

export default function RightPanel() {
  const { t } = useTranslation();
  const tab = useUiStore((s) => s.rightPanelTab);
  const toggleRightPanel = useUiStore((s) => s.toggleRightPanel);

  return (
    <div
      style={{
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--surface)',
        overflow: 'hidden',
        position: 'relative',
      }}
    >
      <ResizeHandle />

      <div
        className="right-panel-header"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '10px 12px',
          borderBottom: '1px solid var(--border)',
          flexShrink: 0,
        }}
      >
        <Text strong style={{ fontSize: 14, flexShrink: 0 }}>
          {t(TAB_TITLE_KEYS[tab])}
        </Text>
        <PlacementPicker />
        <div style={{ flex: 1, minWidth: 0 }} />
        <Button
          type="text"
          size="small"
          icon={<CloseOutlined />}
          onClick={toggleRightPanel}
          aria-label={t('a11y.closePanel')}
          style={{ color: 'var(--text-tertiary)', flexShrink: 0 }}
        />
      </div>

      <div style={{ flex: 1, overflow: 'auto', minHeight: 0 }}>
        <Suspense
          fallback={
            <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 40 }}>
              <Spin />
            </div>
          }
        >
          <PanelContent tab={tab} />
        </Suspense>
      </div>
    </div>
  );
}
