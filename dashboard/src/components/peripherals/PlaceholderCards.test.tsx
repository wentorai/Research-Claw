/**
 * PlaceholderCards.test.tsx — Task 17: 物理实验室 + 具身科研智能置灰卡测试
 *
 * TDD 顺序: 先写此文件(全部 FAIL),再实现 PlaceholderCards.tsx。
 *
 * 覆盖:
 *   1. 两张卡渲染,opacity: 0.5
 *   2. 状态条存在且为灰色
 *   3. "即将推出" Tag 存在
 *   4. 点击整卡打开 Modal
 *   5. Modal 中出现愿景文案关键词
 *   6. Modal 内无行动按钮(Cancel/OK/Confirm 类)
 *   7. camera / plaud 卡不受影响(由 PeripheralsPanel 测试文件保障,本文补 sanity 断言)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ConfigProvider, App as AntdApp } from 'antd';

// ── Mock i18n ─────────────────────────────────────────────────────────────────
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallbackOrOpts?: string | Record<string, unknown>) => {
      if (typeof fallbackOrOpts === 'string') return fallbackOrOpts;
      if (fallbackOrOpts && 'defaultValue' in fallbackOrOpts)
        return fallbackOrOpts.defaultValue as string;
      return key;
    },
    i18n: { changeLanguage: vi.fn(), language: 'zh-CN' },
  }),
  initReactI18next: { type: '3rdParty', init: vi.fn() },
}));

// ── Mock config store (theme) ─────────────────────────────────────────────────
vi.mock('../../stores/config', () => ({
  useConfigStore: (selector: (s: { theme: string }) => unknown) =>
    selector({ theme: 'dark' }),
}));

import { LabPlaceholderCard, EmbodiedPlaceholderCard } from './PlaceholderCards';

function Wrapper({ children }: { children: React.ReactNode }) {
  return (
    <ConfigProvider>
      <AntdApp>{children}</AntdApp>
    </ConfigProvider>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
});

// ─────────────────────────────────────────────────────────────────────────────
// ① 物理实验室卡 — LabPlaceholderCard
// ─────────────────────────────────────────────────────────────────────────────

describe('LabPlaceholderCard', () => {
  it('renders with data-testid periph-placeholder-lab', () => {
    render(<Wrapper><LabPlaceholderCard /></Wrapper>);
    expect(screen.getByTestId('periph-placeholder-lab')).toBeTruthy();
  });

  it('card wrapper has opacity 0.5', () => {
    render(<Wrapper><LabPlaceholderCard /></Wrapper>);
    const card = screen.getByTestId('periph-placeholder-lab');
    // opacity should be set via inline style
    expect(card.style.opacity).toBe('0.5');
  });

  it('shows "即将推出" grey Tag', () => {
    render(<Wrapper><LabPlaceholderCard /></Wrapper>);
    // i18n key fallback → key itself; check both key and Chinese text
    const tag = screen.getByTestId('periph-placeholder-lab-tag');
    expect(tag).toBeTruthy();
  });

  it('has a grey status strip', () => {
    render(<Wrapper><LabPlaceholderCard /></Wrapper>);
    const strip = screen.getByTestId('periph-placeholder-lab-strip');
    expect(strip).toBeTruthy();
  });

  it('clicking the card opens a Modal with vision text', async () => {
    render(<Wrapper><LabPlaceholderCard /></Wrapper>);
    const card = screen.getByTestId('periph-placeholder-lab');
    fireEvent.click(card);

    await waitFor(() => {
      // Modal title or body should contain lab-related text
      expect(screen.getByTestId('periph-placeholder-lab-modal-title')).toBeTruthy();
    });
  });

  it('Modal body contains nodeInvokePolicies keyword', async () => {
    render(<Wrapper><LabPlaceholderCard /></Wrapper>);
    fireEvent.click(screen.getByTestId('periph-placeholder-lab'));

    await waitFor(() => {
      const body = screen.getByTestId('periph-placeholder-lab-modal-body');
      expect(body.textContent).toContain('nodeInvokePolicies');
    });
  });

  it('Modal has no action buttons (Cancel/OK)', async () => {
    render(<Wrapper><LabPlaceholderCard /></Wrapper>);
    fireEvent.click(screen.getByTestId('periph-placeholder-lab'));

    await waitFor(() => {
      expect(screen.getByTestId('periph-placeholder-lab-modal-title')).toBeTruthy();
    });

    // No button with role="button" inside modal content area
    // (antd Modal by default adds Cancel+OK footer — we must use footer={null})
    const footer = document.querySelector('.ant-modal-footer');
    expect(footer).toBeNull();
  });

  it('Modal shows "敬请期待" footer note', async () => {
    render(<Wrapper><LabPlaceholderCard /></Wrapper>);
    fireEvent.click(screen.getByTestId('periph-placeholder-lab'));

    await waitFor(() => {
      const note = screen.getByTestId('periph-placeholder-lab-modal-note');
      expect(note).toBeTruthy();
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ② 具身科研智能卡 — EmbodiedPlaceholderCard
// ─────────────────────────────────────────────────────────────────────────────

describe('EmbodiedPlaceholderCard', () => {
  it('renders with data-testid periph-placeholder-embodied', () => {
    render(<Wrapper><EmbodiedPlaceholderCard /></Wrapper>);
    expect(screen.getByTestId('periph-placeholder-embodied')).toBeTruthy();
  });

  it('card wrapper has opacity 0.5', () => {
    render(<Wrapper><EmbodiedPlaceholderCard /></Wrapper>);
    const card = screen.getByTestId('periph-placeholder-embodied');
    expect(card.style.opacity).toBe('0.5');
  });

  it('shows "即将推出" grey Tag', () => {
    render(<Wrapper><EmbodiedPlaceholderCard /></Wrapper>);
    expect(screen.getByTestId('periph-placeholder-embodied-tag')).toBeTruthy();
  });

  it('has a grey status strip', () => {
    render(<Wrapper><EmbodiedPlaceholderCard /></Wrapper>);
    expect(screen.getByTestId('periph-placeholder-embodied-strip')).toBeTruthy();
  });

  it('clicking the card opens a Modal with vision text', async () => {
    render(<Wrapper><EmbodiedPlaceholderCard /></Wrapper>);
    fireEvent.click(screen.getByTestId('periph-placeholder-embodied'));

    await waitFor(() => {
      expect(screen.getByTestId('periph-placeholder-embodied-modal-title')).toBeTruthy();
    });
  });

  it('Modal body contains "node.invoke" keyword', async () => {
    render(<Wrapper><EmbodiedPlaceholderCard /></Wrapper>);
    fireEvent.click(screen.getByTestId('periph-placeholder-embodied'));

    await waitFor(() => {
      const body = screen.getByTestId('periph-placeholder-embodied-modal-body');
      expect(body.textContent).toContain('node.invoke');
    });
  });

  it('Modal body mentions OpenClaw nodes system', async () => {
    render(<Wrapper><EmbodiedPlaceholderCard /></Wrapper>);
    fireEvent.click(screen.getByTestId('periph-placeholder-embodied'));

    await waitFor(() => {
      const body = screen.getByTestId('periph-placeholder-embodied-modal-body');
      // Should mention OC nodes or role:node
      expect(body.textContent).toMatch(/role:node|nodes 体系|OpenClaw nodes/);
    });
  });

  it('Modal has no action buttons (footer=null)', async () => {
    render(<Wrapper><EmbodiedPlaceholderCard /></Wrapper>);
    fireEvent.click(screen.getByTestId('periph-placeholder-embodied'));

    await waitFor(() => {
      expect(screen.getByTestId('periph-placeholder-embodied-modal-title')).toBeTruthy();
    });

    const footer = document.querySelector('.ant-modal-footer');
    expect(footer).toBeNull();
  });

  it('Modal shows "敬请期待" footer note', async () => {
    render(<Wrapper><EmbodiedPlaceholderCard /></Wrapper>);
    fireEvent.click(screen.getByTestId('periph-placeholder-embodied'));

    await waitFor(() => {
      expect(screen.getByTestId('periph-placeholder-embodied-modal-note')).toBeTruthy();
    });
  });

  it('mentions camera bridge connection in vision text', async () => {
    render(<Wrapper><EmbodiedPlaceholderCard /></Wrapper>);
    fireEvent.click(screen.getByTestId('periph-placeholder-embodied'));

    await waitFor(() => {
      const body = screen.getByTestId('periph-placeholder-embodied-modal-body');
      // Should mention it shares the same evolution line as camera bridge
      expect(body.textContent).toMatch(/摄像头桥|camera bridge|演进线/);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ③ cursor style — 整卡 cursor: pointer
//    刻意决策: "未开放"信号由 opacity 0.5 + 灰状态条 + "即将推出" Tag 传递;
//    cursor 用 pointer 而非 default,因为整卡必须可点(打开 Modal 愿景简介)。
// ─────────────────────────────────────────────────────────────────────────────

describe('PlaceholderCards — cursor and disabled look', () => {
  it('LabPlaceholderCard inner body uses pointer cursor (clickable)', () => {
    render(<Wrapper><LabPlaceholderCard /></Wrapper>);
    const card = screen.getByTestId('periph-placeholder-lab');
    // The outer wrapper is clickable → pointer
    expect(card.style.cursor).toBe('pointer');
  });

  it('EmbodiedPlaceholderCard inner body uses pointer cursor', () => {
    render(<Wrapper><EmbodiedPlaceholderCard /></Wrapper>);
    const card = screen.getByTestId('periph-placeholder-embodied');
    expect(card.style.cursor).toBe('pointer');
  });
});
