import React, { Suspense, lazy, useCallback, useRef } from 'react';
import { Button, Spin, Typography } from 'antd';
import { CloseOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import { useUiStore, type PanelTab } from '../stores/ui';

const { Text } = Typography;

const LibraryPanel = lazy(() => import('./panels/LibraryPanel'));
const WorkspacePanel = lazy(() => import('./panels/WorkspacePanel'));
const TaskPanel = lazy(() => import('./panels/TaskPanel'));
const MonitorPanel = lazy(() => import('./panels/MonitorPanel'));
const ExtensionsPanel = lazy(() => import('./panels/ExtensionsPanel'));
const SettingsPanel = lazy(() => import('./panels/SettingsPanel'));
const SupervisorPanel = lazy(() => import('./panels/SupervisorPanel'));

const TAB_TITLE_KEYS: Record<PanelTab, string> = {
  library: 'library.title',
  workspace: 'workspace.title',
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

function ResizeHandle() {
  const setRightPanelWidth = useUiStore((s) => s.setRightPanelWidth);
  const draggingRef = useRef(false);
  const startXRef = useRef(0);
  const startWidthRef = useRef(0);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      draggingRef.current = true;
      startXRef.current = e.clientX;
      startWidthRef.current = useUiStore.getState().rightPanelWidth;

      const handleMouseMove = (ev: MouseEvent) => {
        if (!draggingRef.current) return;
        // Dragging left increases width (panel is on the right)
        const delta = startXRef.current - ev.clientX;
        setRightPanelWidth(startWidthRef.current + delta);
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
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    },
    [setRightPanelWidth],
  );

  return (
    <div
      onMouseDown={handleMouseDown}
      style={{
        position: 'absolute',
        left: 0,
        top: 0,
        bottom: 0,
        width: 4,
        cursor: 'col-resize',
        zIndex: 10,
        background: 'transparent',
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
      {/* Drag resize handle */}
      <ResizeHandle />

      {/* Panel header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '10px 16px',
          borderBottom: '1px solid var(--border)',
          flexShrink: 0,
        }}
      >
        <Text strong style={{ fontSize: 14 }}>
          {t(TAB_TITLE_KEYS[tab])}
        </Text>
        <Button
          type="text"
          size="small"
          icon={<CloseOutlined />}
          onClick={toggleRightPanel}
          aria-label={t('a11y.closePanel')}
          style={{ color: 'var(--text-tertiary)' }}
        />
      </div>

      {/* Panel body */}
      <div style={{ flex: 1, overflow: 'auto' }}>
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
