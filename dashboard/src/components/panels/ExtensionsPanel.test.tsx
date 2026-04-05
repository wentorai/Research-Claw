import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { App as AntdApp, ConfigProvider } from 'antd';
import ExtensionsPanel from './ExtensionsPanel';
import { useExtensionsStore } from '../../stores/extensions';
import { useGatewayStore } from '../../stores/gateway';
import { useConfigStore } from '../../stores/config';
import {
  SKILLS_STATUS_RESPONSE,
  CHANNELS_STATUS_RESPONSE,
} from '../../__fixtures__/gateway-payloads/extensions-responses';

// Mock react-window — render all items without virtualization (jsdom has no layout engine)
vi.mock('react-window', () => ({
  List: function MockList({ rowComponent: Row, rowCount, rowProps }: {
    rowComponent: React.ComponentType<any>;
    rowCount: number;
    rowProps: Record<string, unknown>;
    [key: string]: unknown;
  }) {
    return (
      <div data-testid="virtual-list">
        {Array.from({ length: rowCount }, (_, index) => (
          <Row
            key={index}
            index={index}
            style={{}}
            ariaAttributes={{ 'aria-posinset': index + 1, 'aria-setsize': rowCount, role: 'listitem' }}
            {...rowProps}
          />
        ))}
      </div>
    );
  },
}));

// Mock i18n — t() returns fallback string if provided, else the key
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallbackOrOpts?: string | Record<string, unknown>) => {
      if (typeof fallbackOrOpts === 'string') return fallbackOrOpts;
      if (fallbackOrOpts && 'defaultValue' in fallbackOrOpts) return fallbackOrOpts.defaultValue as string;
      return key;
    },
    i18n: { changeLanguage: vi.fn(), language: 'en' },
  }),
  initReactI18next: { type: '3rdParty', init: vi.fn() },
}));

// Mock relativeTime
vi.mock('../../utils/relativeTime', () => ({
  relativeTime: () => '2h ago',
}));

function Wrapper({ children }: { children: React.ReactNode }) {
  return (
    <ConfigProvider>
      <AntdApp>{children}</AntdApp>
    </ConfigProvider>
  );
}

/** Set up store with data loaded and auto-load prevented */
function setupLoadedState() {
  useExtensionsStore.setState({
    skills: SKILLS_STATUS_RESPONSE.skills,
    skillsLoading: false,
    skillsLoaded: true,
    managedSkillsDir: '/Users/test/.openclaw/skills',
    channels: [],
    channelsLoading: false,
    channelsLoaded: true,
    plugins: [],
    pluginsLoaded: true,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  useConfigStore.setState({ theme: 'dark' });
  useGatewayStore.setState({
    state: 'connected',
    client: { isConnected: true, request: vi.fn() } as never,
  });
  useExtensionsStore.setState({
    skills: [],
    skillsLoading: false,
    skillsLoaded: true,
    managedSkillsDir: '',
    channels: [],
    channelsLoading: false,
    channelsLoaded: true,
    plugins: [],
    pluginsLoaded: true,
  });
});

/** Click a Segmented tab option by its label text */
function clickSegmentedTab(label: string) {
  // Antd Segmented renders options as <label><input type="radio"/><div>text</div></label>
  const labels = screen.getAllByText(label);
  // Find the one inside a segmented item (has closest label with ant-segmented-item class)
  for (const el of labels) {
    const labelEl = el.closest('.ant-segmented-item');
    if (labelEl) {
      fireEvent.click(labelEl);
      return;
    }
  }
  // Fallback: click the first match
  fireEvent.click(labels[0]);
}

describe('ExtensionsPanel', () => {
  it('shows disconnected message when not connected', () => {
    useGatewayStore.setState({ state: 'disconnected', client: null });

    render(<Wrapper><ExtensionsPanel /></Wrapper>);

    // t('extensions.disconnected', 'Connect to gateway...') → returns fallback
    expect(screen.getByText('Connect to gateway to view extensions')).toBeTruthy();
  });

  it('shows loading state within skills tab', () => {
    useExtensionsStore.setState({
      skillsLoading: true,
      skillsLoaded: false,
    });

    render(<Wrapper><ExtensionsPanel /></Wrapper>);

    // Loading spinner should appear inside the skills tab content
    expect(screen.getByText('Loading extensions...')).toBeTruthy();
  });

  it('renders skills tab by default', () => {
    setupLoadedState();

    render(<Wrapper><ExtensionsPanel /></Wrapper>);

    expect(screen.getByText('research-sop')).toBeTruthy();
    expect(screen.getByText('search_arxiv')).toBeTruthy();
    expect(screen.getByText('computer')).toBeTruthy();
  });

  it('renders skills grouped by source', () => {
    setupLoadedState();

    render(<Wrapper><ExtensionsPanel /></Wrapper>);

    // t('extensions.skills.group.local', 'local') → returns 'local' (fallback string)
    expect(screen.getByText('local')).toBeTruthy();
    expect(screen.getByText('research-plugins')).toBeTruthy();
    expect(screen.getByText('bundled')).toBeTruthy();
  });

  it('shows empty state for skills', () => {
    useExtensionsStore.setState({ skills: [] });

    render(<Wrapper><ExtensionsPanel /></Wrapper>);

    expect(screen.getByText('No skills loaded.')).toBeTruthy();
  });

  it('switches to channels tab', () => {
    useExtensionsStore.setState({
      skills: SKILLS_STATUS_RESPONSE.skills,
      skillsLoaded: true,
      channels: [
        {
          id: 'telegram',
          label: 'Telegram',
          accounts: CHANNELS_STATUS_RESPONSE.channelAccounts.telegram,
          defaultAccountId: 'default',
          summary: {},
        },
      ],
      channelsLoaded: true,
      pluginsLoaded: true,
    });

    render(<Wrapper><ExtensionsPanel /></Wrapper>);

    clickSegmentedTab('Channels');

    // Channel label should appear
    expect(screen.getByText('Telegram')).toBeTruthy();
  });

  it('shows empty state for channels', () => {
    useExtensionsStore.setState({
      skills: SKILLS_STATUS_RESPONSE.skills,
      skillsLoaded: true,
      channels: [],
      channelsLoaded: true,
      pluginsLoaded: true,
    });

    render(<Wrapper><ExtensionsPanel /></Wrapper>);

    clickSegmentedTab('Channels');

    expect(screen.getByText('No channels configured.')).toBeTruthy();
  });

  it('switches to plugins tab', () => {
    useExtensionsStore.setState({
      skills: SKILLS_STATUS_RESPONSE.skills,
      skillsLoaded: true,
      channelsLoaded: true,
      plugins: [
        {
          name: 'research-claw-core',
          enabled: true,
          path: 'extensions/research-claw-core',
          config: { dbPath: '~/.research-claw/library.db' },
        },
      ],
      pluginsLoaded: true,
    });

    render(<Wrapper><ExtensionsPanel /></Wrapper>);

    clickSegmentedTab('Plugins');

    expect(screen.getByText('research-claw-core')).toBeTruthy();
  });

  it('filters skills by search', () => {
    setupLoadedState();

    render(<Wrapper><ExtensionsPanel /></Wrapper>);

    const searchInput = screen.getByPlaceholderText('Filter skills...');
    fireEvent.change(searchInput, { target: { value: 'arxiv' } });

    expect(screen.getByText('search_arxiv')).toBeTruthy();
    expect(screen.queryByText('computer')).toBeNull();
  });

  it('shows count badge in header', () => {
    setupLoadedState();

    render(<Wrapper><ExtensionsPanel /></Wrapper>);

    // 3 eligible skills out of 4 total (discord is disabled)
    expect(screen.getByText('3 / 4')).toBeTruthy();
  });
});
