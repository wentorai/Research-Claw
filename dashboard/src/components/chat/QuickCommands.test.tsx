import React from 'react';
import { App as AntdApp } from 'antd';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import QuickCommands from './QuickCommands';
import { usePromptPresetStore, type PromptPreset } from '../../stores/prompt-presets';
import i18n from '../../i18n';

const preset: PromptPreset = {
  id: 'p1',
  name: '文献梳理',
  content: '请按主题梳理文献',
  category: '阅读',
  favorite: true,
  sort_order: 0,
  use_count: 0,
  last_used_at: null,
  created_at: '2026-01-01',
  updated_at: '2026-01-01',
};

describe('QuickCommands composition safety', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('zh-CN');
    usePromptPresetStore.setState({
      presets: [preset],
      loaded: true,
      loading: false,
    });
  });

  it('cannot open or select a command while CJK composition is active', () => {
    const onInsert = vi.fn();
    render(
      <AntdApp>
        <QuickCommands composing onInsert={onInsert} />
      </AntdApp>,
    );

    const trigger = screen.getByRole('button', { name: '快捷指令' });
    expect(trigger).toBeDisabled();
    fireEvent.click(trigger);
    expect(screen.queryByText('文献梳理')).not.toBeInTheDocument();
    expect(onInsert).not.toHaveBeenCalled();
  });
});
