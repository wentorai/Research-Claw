import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useChatStore } from '../../stores/chat';
import { useToolStreamStore } from '../../stores/tool-stream';
import ToolActivityHistory from './ToolActivityHistory';

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: vi.fn() },
  useTranslation: () => ({
    t: (key: string, params?: Record<string, string>) => {
      if (key === 'chat.activityHistory') return '活动日志';
      if (key === 'chat.activityToolStarted') return `开始工具调用：${params?.name}`;
      if (key === 'chat.activityToolCompleted') return `工具调用完成：${params?.name}`;
      if (key === 'chat.activityDurationSeconds') return `${params?.duration} 秒`;
      return key;
    },
  }),
}));

describe('ToolActivityHistory', () => {
  beforeEach(() => {
    useChatStore.setState({ sessionKey: 'project-a' });
    useToolStreamStore.setState({
      activityLog: [
        {
          id: 'start',
          ts: 100,
          sessionKey: 'project-a',
          runId: 'run-a',
          toolCallId: 'tool-1',
          scope: 'foreground',
          status: 'tool_start',
          text: 'Tool started: process',
          toolName: 'process',
        },
        {
          id: 'result',
          ts: 30_100,
          sessionKey: 'project-a',
          runId: 'run-a',
          toolCallId: 'tool-1',
          scope: 'foreground',
          status: 'tool_result',
          text: 'Tool returned: process',
          toolName: 'process',
          durationMs: 30_000,
        },
      ],
    });
  });

  afterEach(() => cleanup());

  it('shows one localized completion row for one completed tool invocation', () => {
    render(<ToolActivityHistory />);
    fireEvent.click(screen.getByRole('button', { name: /活动日志/ }));

    expect(screen.getByText('工具调用完成：process')).toBeInTheDocument();
    expect(screen.getByText('30.0 秒')).toBeInTheDocument();
    expect(screen.queryByText('开始工具调用：process')).not.toBeInTheDocument();
    expect(screen.queryByText('Tool returned: process')).not.toBeInTheDocument();
  });
});
