import JSZip from 'jszip';
import { App as AntdApp, ConfigProvider } from 'antd';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CONFIG_GET_RESPONSE,
  CONFIG_GET_UPLOAD_ENABLED_RESPONSE,
  SKILLS_CLAWHUB_INSTALL_RESPONSE,
  SKILLS_DETAIL_RESPONSE,
  SKILLS_SEARCH_RESPONSE,
  SKILLS_STATUS_RESPONSE,
} from '../../__fixtures__/gateway-payloads/extensions-responses';
import { useConfigStore } from '../../stores/config';
import { useExtensionsStore } from '../../stores/extensions';
import { useGatewayStore } from '../../stores/gateway';
import { getThemeTokens } from '../../styles/theme';
import SkillInstallCenter from './SkillInstallCenter';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallbackOrOpts?: string | Record<string, unknown>) => {
      if (typeof fallbackOrOpts === 'string') return fallbackOrOpts;
      if (fallbackOrOpts && 'defaultValue' in fallbackOrOpts) {
        return Object.entries(fallbackOrOpts).reduce(
          (text, [name, value]) =>
            name === 'defaultValue'
              ? text
              : text.replaceAll(`{{${name}}}`, String(value)),
          fallbackOrOpts.defaultValue as string,
        );
      }
      return key;
    },
    i18n: { changeLanguage: vi.fn(), language: 'en' },
  }),
  initReactI18next: { type: '3rdParty', init: vi.fn() },
}));

const request = vi.fn();

function selectSource(label: string) {
  const option = screen.getByText(label).closest('.ant-segmented-item');
  if (!option) throw new Error(`Missing install source option: ${label}`);
  fireEvent.click(option);
}

function Wrapper({ children }: { children: React.ReactNode }) {
  return (
    <ConfigProvider>
      <AntdApp>{children}</AntdApp>
    </ConfigProvider>
  );
}

async function makeMedicalBundle(): Promise<File> {
  const zip = new JSZip();
  zip.file(
    'clinical-trial-review/SKILL.md',
    [
      '---',
      'name: Clinical Trial Review',
      'description: Review clinical trial evidence',
      'metadata:',
      '  openclaw:',
      '    requires:',
      '      bins: [python3]',
      '      env: [NCBI_API_KEY]',
      '---',
      '# Clinical Trial Review',
    ].join('\n'),
  );
  zip.file(
    'medical-literature-map/SKILL.md',
    [
      '---',
      'name: Medical Literature Map',
      'description: Build a biomedical evidence map',
      '---',
      '# Medical Literature Map',
    ].join('\n'),
  );
  const bytes = await zip.generateAsync({ type: 'uint8array' });
  return new File([Uint8Array.from(bytes).buffer], '10-medical-skills.zip', {
    type: 'application/zip',
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  request.mockReset();
  useConfigStore.setState({ theme: 'dark' });
  useGatewayStore.setState({
    state: 'connected',
    client: { isConnected: true, request } as never,
    eventEpoch: 0,
  });
  useExtensionsStore.setState({
    skills: SKILLS_STATUS_RESPONSE.skills,
    skillsLoading: false,
    skillsLoaded: true,
  });
});

describe('SkillInstallCenter', () => {
  it('discloses native sources and blocks local mutation when the upload gate is off', async () => {
    request.mockResolvedValueOnce(CONFIG_GET_RESPONSE);

    render(
      <Wrapper>
        <SkillInstallCenter tokens={getThemeTokens('dark')} />
      </Wrapper>,
    );

    expect(screen.getByText('ClawHub')).toBeTruthy();
    selectSource('Local ZIP');

    expect(await screen.findByText('Local archive upload is disabled by the Gateway configuration.')).toBeTruthy();
    expect(screen.getByText('Enable skills.install.allowUploadedArchives in openclaw.json, then reconnect. You can still inspect a ZIP while installation is blocked.')).toBeTruthy();
    expect(screen.getByLabelText('Choose Skill ZIP')).toBeTruthy();
  });

  it('searches, reviews, confirms, and installs from ClawHub using native RPCs', async () => {
    request.mockImplementation((method: string) => {
      if (method === 'config.get') return Promise.resolve(CONFIG_GET_UPLOAD_ENABLED_RESPONSE);
      if (method === 'skills.search') return Promise.resolve(SKILLS_SEARCH_RESPONSE);
      if (method === 'skills.detail') return Promise.resolve(SKILLS_DETAIL_RESPONSE);
      if (method === 'skills.install') return Promise.resolve(SKILLS_CLAWHUB_INSTALL_RESPONSE);
      if (method === 'skills.status') return Promise.resolve(SKILLS_STATUS_RESPONSE);
      throw new Error(`unexpected RPC ${method}`);
    });

    render(
      <Wrapper>
        <SkillInstallCenter tokens={getThemeTokens('dark')} />
      </Wrapper>,
    );

    fireEvent.change(screen.getByPlaceholderText('Search ClawHub skills'), {
      target: { value: 'pubmed' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));

    expect(await screen.findByText('PubMed Research')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Review' }));
    expect(await screen.findByText('Improved evidence extraction')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Install' }));
    expect(screen.getByText('Confirm Skill installation')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Install now' }));

    expect(await screen.findByText('Installed pubmed-research@1.2.3')).toBeTruthy();
    expect(request).toHaveBeenCalledWith('skills.search', { query: 'pubmed', limit: 20 });
    expect(request).toHaveBeenCalledWith('skills.detail', { slug: 'pubmed-research' });
    expect(request).toHaveBeenCalledWith('skills.install', {
      source: 'clawhub',
      slug: 'pubmed-research',
      version: '1.2.3',
      force: false,
    });
  });

  it('reports a native ClawHub search failure without inventing fallback results', async () => {
    request.mockImplementation((method: string) => {
      if (method === 'config.get') return Promise.resolve(CONFIG_GET_UPLOAD_ENABLED_RESPONSE);
      if (method === 'skills.search') return Promise.reject(new Error('ClawHub unavailable'));
      throw new Error(`unexpected RPC ${method}`);
    });

    render(
      <Wrapper>
        <SkillInstallCenter tokens={getThemeTokens('dark')} />
      </Wrapper>,
    );

    fireEvent.change(screen.getByPlaceholderText('Search ClawHub skills'), {
      target: { value: 'pubmed' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));

    expect(await screen.findByText('ClawHub unavailable')).toBeTruthy();
    expect(screen.queryByText('PubMed Research')).toBeNull();
  });

  it('does not search while a CJK IME composition is active', async () => {
    request.mockImplementation((method: string) => {
      if (method === 'config.get') return Promise.resolve(CONFIG_GET_UPLOAD_ENABLED_RESPONSE);
      if (method === 'skills.search') return Promise.resolve(SKILLS_SEARCH_RESPONSE);
      throw new Error(`unexpected RPC ${method}`);
    });

    render(
      <Wrapper>
        <SkillInstallCenter tokens={getThemeTokens('dark')} />
      </Wrapper>,
    );

    const input = screen.getByPlaceholderText('Search ClawHub skills');
    fireEvent.change(input, { target: { value: '医学' } });
    fireEvent.keyDown(input, {
      key: 'Enter',
      code: 'Enter',
      keyCode: 13,
      isComposing: true,
    });

    await waitFor(() => {
      expect(request).toHaveBeenCalledWith('config.get', {});
    });
    expect(request).not.toHaveBeenCalledWith('skills.search', expect.anything());
  });

  it('refreshes native capabilities after reconnect even when the client object is reused', async () => {
    const sharedClient = { isConnected: true, request };
    request.mockResolvedValue(CONFIG_GET_UPLOAD_ENABLED_RESPONSE);
    useGatewayStore.setState({
      state: 'connected',
      client: sharedClient as never,
      eventEpoch: 10,
    });

    render(
      <Wrapper>
        <SkillInstallCenter tokens={getThemeTokens('dark')} />
      </Wrapper>,
    );

    await waitFor(() => {
      expect(request).toHaveBeenCalledWith('config.get', {});
    });
    expect(request.mock.calls.filter(([method]) => method === 'config.get')).toHaveLength(1);

    act(() => {
      sharedClient.isConnected = false;
      useGatewayStore.setState({ state: 'disconnected', eventEpoch: 11 });
    });
    expect(screen.getByText('Connect to gateway to view extensions')).toBeTruthy();

    act(() => {
      sharedClient.isConnected = true;
      useGatewayStore.setState({ state: 'connected', eventEpoch: 12 });
    });
    await waitFor(() => {
      expect(request.mock.calls.filter(([method]) => method === 'config.get')).toHaveLength(2);
    });
  });

  it('preflights a multi-Skill ZIP and carries selection, conflict, scan, dependency, confirmation, and results', async () => {
    useExtensionsStore.setState({
      skills: [
        ...SKILLS_STATUS_RESPONSE.skills,
        {
          ...SKILLS_STATUS_RESPONSE.skills[2],
          name: 'clinical-trial-review',
          skillKey: 'clinical-trial-review',
          baseDir: '/workspace/skills/clinical-trial-review',
          filePath: '/workspace/skills/clinical-trial-review/SKILL.md',
        },
      ],
    });
    let uploadCounter = 0;
    request.mockImplementation((method: string, params: Record<string, unknown>) => {
      if (method === 'config.get') return Promise.resolve(CONFIG_GET_UPLOAD_ENABLED_RESPONSE);
      if (method === 'skills.upload.begin') {
        uploadCounter += 1;
        return Promise.resolve({ uploadId: `upload-${uploadCounter}` });
      }
      if (method === 'skills.upload.chunk') return Promise.resolve({ ok: true });
      if (method === 'skills.upload.commit') return Promise.resolve({ ok: true });
      if (method === 'skills.install') {
        return Promise.resolve({
          ok: true,
          slug: params.slug,
          targetDir: `/workspace/skills/${params.slug}`,
          sha256: params.sha256,
        });
      }
      if (method === 'skills.status') return Promise.resolve(SKILLS_STATUS_RESPONSE);
      throw new Error(`unexpected RPC ${method}`);
    });

    render(
      <Wrapper>
        <SkillInstallCenter tokens={getThemeTokens('dark')} />
      </Wrapper>,
    );
    selectSource('Local ZIP');

    const file = await makeMedicalBundle();
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Choose Skill ZIP'), {
        target: { files: [file] },
      });
    });

    expect(await screen.findByText('2 Skills found')).toBeTruthy();
    expect(screen.getByText('Clinical Trial Review')).toBeTruthy();
    expect(screen.getByText('Medical Literature Map')).toBeTruthy();
    expect(screen.getByText('Existing Skill')).toBeTruthy();
    expect(screen.getAllByText('Local scan passed')).toHaveLength(2);
    expect(screen.getByText('python3')).toBeTruthy();
    expect(screen.getByText('NCBI_API_KEY')).toBeTruthy();
    expect(screen.getByText('Gateway security scan runs during installation.')).toBeTruthy();

    // Existing conflicting Skills are not selected by default; the safe item is.
    fireEvent.click(screen.getByRole('button', { name: 'Review installation' }));
    expect(screen.getByText('1 Skill selected')).toBeTruthy();
    fireEvent.click(screen.getByRole('checkbox', {
      name: 'I understand that the Gateway security verdict is produced during installation.',
    }));
    fireEvent.click(screen.getByRole('button', { name: 'Install selected' }));

    expect(await screen.findByText('Installed: Medical Literature Map')).toBeTruthy();
    await waitFor(() => {
      expect(request).toHaveBeenCalledWith('skills.install', expect.objectContaining({
        source: 'upload',
        slug: 'medical-literature-map',
      }));
    });
  });
});
