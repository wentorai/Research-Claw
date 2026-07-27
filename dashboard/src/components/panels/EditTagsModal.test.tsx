/**
 * EditTagsModal.test.tsx — 标签输入框的 IME 合成守卫
 *
 * 缺陷背景：`handleInputKeyDown` 见到 `e.key === 'Enter'` 就 `handleAddTag()`,
 * 没有任何合成守卫。承载它的是 antd `AutoComplete`(rc-select BaseSelect 无条件
 * 把 keydown 透传给 props.onKeyDown,不像 antd Input.Search 那样自带 composedRef
 * 守卫),所以中文用户敲「机器学习」→ 按 Enter 选定候选词时:
 *   - 这次 Enter 同时被当成「提交标签」
 *   - 半成品拼音/未定字符被写成标签,输入框还被关掉(setInputVisible(false))
 * Escape 分支同理:用 Esc 取消候选窗会连带把整个输入框收起来。
 *
 * 本文件把守卫钉在行为层:合成期的 Enter/Escape 必须完全不改变标签集合与输入
 * 框可见性,非合成期必须照常提交。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';
import { ConfigProvider } from 'antd';
import EditTagsModal from './EditTagsModal';
import { useLibraryStore } from '../../stores/library';
import { useConfigStore } from '../../stores/config';
import { useGatewayStore } from '../../stores/gateway';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      if (opts && typeof opts === 'object' && 'defaultValue' in opts) return String(opts.defaultValue);
      return key;
    },
    i18n: { changeLanguage: vi.fn(), language: 'zh-CN' },
  }),
  initReactI18next: { type: '3rdParty', init: vi.fn() },
}));

function Wrapper({ children }: { children: React.ReactNode }) {
  return <ConfigProvider>{children}</ConfigProvider>;
}

const onClose = vi.fn();

function renderModal() {
  return render(
    <Wrapper>
      <EditTagsModal
        open
        paperId="paper-1"
        paperTitle="A Paper"
        currentTags={['existing']}
        onClose={onClose}
      />
    </Wrapper>,
  );
}

/** Open the inline AutoComplete and type `value` into it. */
function openInputAndType(value: string): HTMLInputElement {
  fireEvent.click(screen.getByText('library.editTags.addTag'));
  const input = document.querySelector('.ant-select-selection-search-input') as HTMLInputElement;
  expect(input).toBeTruthy();
  fireEvent.change(input, { target: { value } });
  return input;
}

/** Names of the tags currently rendered in the tag box. */
function renderedTags(): string[] {
  return Array.from(document.querySelectorAll('.ant-tag'))
    .map((el) => (el.textContent ?? '').trim())
    // The "add tag" affordance is itself a Tag — drop it.
    .filter((text) => text && text !== 'library.editTags.addTag');
}

beforeEach(() => {
  vi.clearAllMocks();
  useConfigStore.setState({ theme: 'dark' });
  useLibraryStore.setState({ tags: [] } as never);
  useGatewayStore.setState({
    state: 'connected',
    client: { isConnected: true, request: vi.fn().mockResolvedValue({}) } as never,
  });
});

describe('EditTagsModal — IME 合成守卫 (CJK)', () => {
  it('合成期按 Enter 不得提交半成品标签,也不得收起输入框', () => {
    renderModal();
    const input = openInputAndType('机器学');

    // 候选窗打开时的 Enter：选定候选词,不是提交
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });

    expect(renderedTags()).toEqual(['existing']);
    // 输入框仍在（未被 handleAddTag 的 setInputVisible(false) 收起）
    expect(document.querySelector('.ant-select-selection-search-input')).toBeTruthy();
  });

  it('合成期的 keyCode=229 形态同样不得提交', () => {
    renderModal();
    const input = openInputAndType('深度学');

    fireEvent.keyDown(input, { key: 'Enter', keyCode: 229 });

    expect(renderedTags()).toEqual(['existing']);
    expect(document.querySelector('.ant-select-selection-search-input')).toBeTruthy();
  });

  it('合成期按 Escape 不得清空输入并收起输入框', () => {
    renderModal();
    const input = openInputAndType('图神经');

    // Esc 在候选窗打开时是「取消候选」,不该连带关掉整个输入框
    fireEvent.keyDown(input, { key: 'Escape', isComposing: true });

    expect(document.querySelector('.ant-select-selection-search-input')).toBeTruthy();
  });

  it('非合成期按 Enter 照常提交标签（守卫不得误伤主路径）', () => {
    renderModal();
    const input = openInputAndType('机器学习');

    fireEvent.keyDown(input, { key: 'Enter', isComposing: false });

    expect(renderedTags()).toEqual(['existing', '机器学习']);
    // 提交后输入框收起
    expect(document.querySelector('.ant-select-selection-search-input')).toBeNull();
  });

  it('非合成期按 Escape 照常取消输入（守卫不得误伤主路径）', () => {
    renderModal();
    const input = openInputAndType('临时');

    fireEvent.keyDown(input, { key: 'Escape', isComposing: false });

    expect(document.querySelector('.ant-select-selection-search-input')).toBeNull();
    expect(renderedTags()).toEqual(['existing']);
  });
});
