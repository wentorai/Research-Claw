import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';
import WelcomeCard, { WELCOME_INIT_PROMPT, WELCOME_INIT_DISPLAY_TEXT } from './WelcomeCard';
import ChatView from './ChatView';
import { useChatStore } from '../../stores/chat';
import { useUiStore } from '../../stores/ui';
import {
  WELCOME_FALLBACK_TEXT,
  WELCOME_LOCAL_KIND,
  useOnboardingStore,
} from '../../stores/onboarding';
import { sanitizeUserMessage } from '../../utils/sanitize-message';
import { FEISHU_TUTORIAL_URL } from '../../constants/links';
import { RC_VERSION } from '../../version';

// ── Mock react-i18next (same pattern as chatview-filter.parity.test.tsx) ──

const I18N_MAP: Record<string, string> = {
  'welcome.greeting': '你好，我是科研龙虾',
  'welcome.subtitle': 'Research-Claw · 本地部署的科研智能体',
  'welcome.pillLibrary': '文献检索·管理',
  'welcome.pillWriting': '写作辅助',
  'welcome.pillMonitor': '任务·领域监控',
  'welcome.intro': '告诉我你的研究方向，我现在就能帮你完成第一次文献调研。',
  'welcome.ctaStart': '开始初始化（约 2 分钟）',
  'welcome.ctaCaption': '配置称呼与文献工具，最后用你的方向做一次真实检索演示',
  'welcome.tutorialLink': '使用教程（飞书）',
  'welcome.browseFirst': '先自己看看',
  'welcome.footerHint': '直接输入任何问题也可以开始',
  'chat.empty': 'Start a conversation',
  'chat.suggestions.searchRecent': '帮我搜 ___ 方向近一年的高引论文',
  'chat.suggestions.readPdf': '读读这篇 PDF 并加进文献库',
  'chat.suggestions.writeSurvey': '基于我的文献库写一段综述',
  'chat.suggestions.setupMonitor': '帮我设置一个领域监控',
  'chat.suggestions.whatCanYouDo': '你能做什么？',
};

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => I18N_MAP[key] ?? key,
    i18n: { changeLanguage: vi.fn() },
  }),
  initReactI18next: { type: '3rdParty', init: vi.fn() },
}));

// ── Mock gateway store (ChatView + MessageInput read connection state) ──

vi.mock('../../stores/gateway', () => ({
  useGatewayStore: (selector: (s: unknown) => unknown) => {
    const state = { client: null, state: 'disconnected' };
    return selector(state);
  },
}));

// ── Helpers ─────────────────────────────────────────────────────────

const realSend = useChatStore.getState().send;
const realSetChatInputPrefill = useUiStore.getState().setChatInputPrefill;
const realFetchStatus = useOnboardingStore.getState().fetchStatus;

function welcomeMessage() {
  return {
    role: 'assistant',
    text: WELCOME_FALLBACK_TEXT,
    timestamp: Date.now(),
    localKind: WELCOME_LOCAL_KIND,
  };
}

beforeEach(() => {
  // Reduced motion ⇒ the typewriter renders the full greeting synchronously.
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query.includes('prefers-reduced-motion'),
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: () => false,
  }));
  useChatStore.setState({
    messages: [],
    _localOnlyMsgs: [],
    sending: false,
    streaming: false,
    streamText: null,
    runId: null,
    sessionKey: 'main',
    lastError: null,
  });
  useUiStore.setState({ chatInputPrefill: null });
  // CTA is server-gated: only rendered while rc.onboarding.status still says
  // first-run. fetchStatus is stubbed because the card re-validates the verdict
  // on mount and the real implementation reaches into the mocked gateway store.
  useOnboardingStore.setState({
    status: { firstRun: true, signals: {} },
    fetchStatus: vi.fn(async () => {}),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  useChatStore.setState({ send: realSend });
  useUiStore.setState({ setChatInputPrefill: realSetChatInputPrefill });
  useOnboardingStore.setState({ fetchStatus: realFetchStatus });
});

// ── WelcomeCard ─────────────────────────────────────────────────────

describe('WelcomeCard', () => {
  it('renders greeting, subtitle + version, pills, CTA and tutorial link', () => {
    render(<WelcomeCard />);

    expect(screen.getByRole('heading', { name: '你好，我是科研龙虾' })).toBeInTheDocument();
    const card = screen.getByTestId('welcome-card');
    expect(card.textContent).toContain('Research-Claw · 本地部署的科研智能体');
    expect(card.textContent).toContain(`v${RC_VERSION}`);
    expect(screen.getByText('文献检索·管理')).toBeInTheDocument();
    expect(screen.getByText('写作辅助')).toBeInTheDocument();
    expect(screen.getByText('任务·领域监控')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '开始初始化（约 2 分钟）' })).toBeInTheDocument();

    const link = screen.getByRole('link', { name: '使用教程（飞书）' });
    expect(link).toHaveAttribute('href', FEISHU_TUTORIAL_URL);
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noreferrer');

    expect(screen.getByText('直接输入任何问题也可以开始')).toBeInTheDocument();
  });

  it('CTA click sends the init prompt with displayText separation', () => {
    const sendMock = vi.fn(async () => {});
    useChatStore.setState({ send: sendMock });

    render(<WelcomeCard />);
    fireEvent.click(screen.getByRole('button', { name: '开始初始化（约 2 分钟）' }));

    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock).toHaveBeenCalledWith(WELCOME_INIT_PROMPT, undefined, {
      displayText: WELCOME_INIT_DISPLAY_TEXT,
    });
    expect(WELCOME_INIT_DISPLAY_TEXT).toBe('开始初始化');
  });

  it('init prompt hides its instruction block from reloaded history bubbles', () => {
    // On history reload the optimistic displayText bubble is replaced by the raw
    // transcript text — sanitizeUserMessage must reduce it back to the display text.
    expect(sanitizeUserMessage(WELCOME_INIT_PROMPT)).toBe(WELCOME_INIT_DISPLAY_TEXT);
  });

  it('re-validates a firstRun verdict on mount (stale /clear resurrection guard)', () => {
    const fetchMock = vi.fn(async () => {});
    useOnboardingStore.setState({
      status: { firstRun: true, signals: {} },
      fetchStatus: fetchMock,
    });

    render(<WelcomeCard />);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('skips re-validation for the debug-forced verdict (console preview stays intact)', () => {
    const fetchMock = vi.fn(async () => {});
    useOnboardingStore.setState({
      status: { firstRun: true, signals: { __debugForced: true } },
      fetchStatus: fetchMock,
    });

    render(<WelcomeCard />);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: '开始初始化（约 2 分钟）' })).toBeInTheDocument();
  });

  it('CTA stays hidden once the server no longer reports first-run', () => {
    // /clear reloads the persisted welcome message into an empty session; the
    // CTA must not re-arm after onboarding completed (BOOTSTRAP.md is retired).
    useOnboardingStore.setState({ status: { firstRun: false, signals: {} } });

    render(<WelcomeCard />);

    expect(
      screen.queryByRole('button', { name: '开始初始化（约 2 分钟）' }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: '使用教程（飞书）' })).toBeInTheDocument();
  });

  it('"先自己看看" collapses the CTA section but keeps the tutorial link', () => {
    render(<WelcomeCard />);

    fireEvent.click(screen.getByRole('button', { name: '先自己看看' }));

    expect(screen.queryByRole('button', { name: '开始初始化（约 2 分钟）' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '先自己看看' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: '使用教程（飞书）' })).toBeInTheDocument();
  });

  it('hides the CTA once any user message exists in the session', () => {
    useChatStore.setState({
      messages: [
        welcomeMessage(),
        { role: 'user', text: '开始初始化', timestamp: Date.now() },
      ],
    });

    render(<WelcomeCard />);

    expect(screen.queryByRole('button', { name: '开始初始化（约 2 分钟）' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: '使用教程（飞书）' })).toBeInTheDocument();
  });
});

// ── ChatView integration ────────────────────────────────────────────

describe('ChatView welcome branch', () => {
  it('renders the welcome card instead of the fallback bubble', () => {
    useChatStore.setState({ messages: [welcomeMessage()] });

    render(<ChatView />);

    expect(screen.getByTestId('welcome-card')).toBeInTheDocument();
    // The plain fallback text must stay unrendered when the card shows.
    expect(screen.queryByText(WELCOME_FALLBACK_TEXT)).not.toBeInTheDocument();
    // Welcome makes messages non-empty ⇒ no empty-state chips (mutual exclusion).
    expect(screen.queryByText('帮我搜 ___ 方向近一年的高引论文')).not.toBeInTheDocument();
  });
});

describe('ChatView empty-state suggestion chips', () => {
  it('renders all five chips in the empty state', () => {
    render(<ChatView />);

    expect(screen.getByText('帮我搜 ___ 方向近一年的高引论文')).toBeInTheDocument();
    expect(screen.getByText('读读这篇 PDF 并加进文献库')).toBeInTheDocument();
    expect(screen.getByText('基于我的文献库写一段综述')).toBeInTheDocument();
    expect(screen.getByText('帮我设置一个领域监控')).toBeInTheDocument();
    expect(screen.getByText('你能做什么？')).toBeInTheDocument();
  });

  it('clicking a chip prefills the composer and never auto-sends', () => {
    const prefillSpy = vi.fn();
    const sendMock = vi.fn(async () => {});
    useUiStore.setState({ setChatInputPrefill: prefillSpy });
    useChatStore.setState({ send: sendMock });

    render(<ChatView />);
    fireEvent.click(screen.getByText('帮我设置一个领域监控'));

    expect(prefillSpy).toHaveBeenCalledWith('帮我设置一个领域监控');
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('does not render chips when messages exist', () => {
    useChatStore.setState({
      messages: [{ role: 'user', text: 'hello', timestamp: Date.now() }],
    });

    render(<ChatView />);

    expect(screen.queryByText('你能做什么？')).not.toBeInTheDocument();
  });
});
