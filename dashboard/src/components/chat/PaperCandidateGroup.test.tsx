import React from 'react';
import { App as AntdApp } from 'antd';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useGatewayStore } from '../../stores/gateway';
import { useExecutionTraceStore, type PaperCandidateGroup as Group } from '../../stores/execution-trace';
import PaperCandidateGroup from './PaperCandidateGroup';

const candidates = Array.from({ length: 4 }, (_, index) => ({
  candidateId: `candidate-${index}`,
  provider: 'openalex',
  providerId: `W${index}`,
  returnIndex: index + 1,
  source: 'openalex',
  sourceId: `W${index}`,
  strongAliases: [`provider:openalex:W${index}`],
  actionable: true,
  title: `Candidate ${index + 1}`,
  authors: ['Researcher'],
}));
const group: Group = {
  semantic: 'retrieved',
  label: '检索结果·尚未筛选',
  queries: ['attention is all you need'],
  queryUnavailable: false,
  hasAvailableResults: true,
  providers: ['openalex'],
  partialProviders: [],
  unavailableProviders: [],
  matchedTotal: 100,
  returned: 25,
  eligible: 24,
  stored: 20,
  unique: 4,
  shown: 3,
  candidates,
};

describe('PaperCandidateGroup', () => {
  beforeEach(() => {
    useGatewayStore.setState({ client: { isConnected: true, request: vi.fn() } as never });
    useExecutionTraceStore.setState({ activeSessionKey: 'session-a', generation: 1 });
  });

  function openCandidates() {
    fireEvent.click(screen.getByRole('button', { name: '查看候选' }));
  }

  it('uses Candidate semantics and keeps all six counts distinct', () => {
    render(<AntdApp><PaperCandidateGroup sessionKey="session-a" runId="run-a" group={group} /></AntdApp>);
    expect(screen.getByRole('region', { name: '检索结果·尚未筛选' })).toBeInTheDocument();
    expect(screen.getByText('去重后 4 条 · 1 个来源')).toBeInTheDocument();
    expect(screen.queryByText('Candidate 1')).not.toBeInTheDocument();
    openCandidates();
    expect(screen.getByText(/尚未由 Agent 筛选、阅读、引用或验证/)).toBeInTheDocument();
    expect(screen.getByText('查询：attention is all you need')).toBeInTheDocument();
    expect(screen.getByText('API 返回位置：openalex #1')).toBeInTheDocument();
    const counts = screen.getByTestId('paper-candidate-counts');
    expect(counts).toHaveTextContent('命中总数: 100');
    expect(counts).toHaveTextContent('工具返回: 25');
    expect(counts).toHaveTextContent('通过校验: 24');
    expect(counts).toHaveTextContent('本地保留: 20');
    expect(counts).toHaveTextContent('去重后: 4');
    expect(counts).toHaveTextContent('当前显示: 3');
    expect(screen.getByText('Candidate 3')).toBeInTheDocument();
    expect(screen.queryByText('Candidate 4')).not.toBeInTheDocument();
    expect(screen.queryByText('引用')).not.toBeInTheDocument();
  });

  it('progressively reveals bounded stored candidates', () => {
    render(<AntdApp><PaperCandidateGroup sessionKey="session-a" runId="run-a" group={group} /></AntdApp>);
    openCandidates();
    fireEvent.click(screen.getByRole('button', { name: '再显示 1 条' }));
    expect(screen.getByText('Candidate 4')).toBeInTheDocument();
    expect(screen.getByTestId('paper-candidate-counts')).toHaveTextContent('当前显示: 4');
  });

  it('disables saving when no strong identity exists', () => {
    const unsafe: Group = {
      ...group,
      unique: 1,
      shown: 1,
      candidates: [{ ...candidates[0], strongAliases: [], actionable: false, providerId: undefined }],
    };
    render(<AntdApp><PaperCandidateGroup sessionKey="session-a" runId="run-a" group={unsafe} /></AntdApp>);
    openCandidates();
    expect(screen.getByRole('button', { name: /加入文献库/ })).toBeDisabled();
  });

  it('reflects dynamic saved enrichment without changing the observation counts', async () => {
    const { rerender } = render(
      <AntdApp><PaperCandidateGroup sessionKey="session-a" runId="run-a" group={group} /></AntdApp>,
    );
    openCandidates();
    const enriched: Group = {
      ...group,
      candidates: [{ ...candidates[0], libraryId: 'paper-1' }, ...candidates.slice(1)],
    };
    rerender(<AntdApp><PaperCandidateGroup sessionKey="session-a" runId="run-a" group={enriched} /></AntdApp>);
    await waitFor(() => expect(screen.getByRole('button', { name: /已收藏/ })).toBeDisabled());
    expect(screen.getByTestId('paper-candidate-counts')).toHaveTextContent('本地保留: 20');
  });

  it('distinguishes source-unavailable, true zero, and persisted-only partial semantics', () => {
    const unavailable: Group = {
      ...group,
      hasAvailableResults: false,
      providers: [],
      partialProviders: [],
      unavailableProviders: ['wentor-network'],
      matchedTotal: undefined,
      returned: 0,
      eligible: 0,
      stored: 0,
      unique: 0,
      shown: 0,
      candidates: [],
    };
    const { rerender } = render(
      <AntdApp><PaperCandidateGroup sessionKey="session-a" runId="run-a" group={unavailable} /></AntdApp>,
    );
    openCandidates();
    expect(screen.getByText(/不将其冒充为 0 条命中/)).toBeInTheDocument();
    expect(screen.getByText(/wentor-network/)).toBeInTheDocument();
    expect(screen.queryByTestId('paper-candidate-counts')).not.toBeInTheDocument();

    const zero: Group = {
      ...unavailable,
      hasAvailableResults: true,
      providers: ['dblp'],
      unavailableProviders: [],
    };
    rerender(<AntdApp><PaperCandidateGroup sessionKey="session-a" runId="run-a" group={zero} /></AntdApp>);
    expect(screen.getByText(/真实返回 0 条结果/)).toBeInTheDocument();
    expect(screen.getByTestId('paper-candidate-counts')).toHaveTextContent('工具返回: 0');

    const partial: Group = {
      ...group,
      providers: ['wentor-network'],
      partialProviders: ['wentor-network'],
    };
    rerender(<AntdApp><PaperCandidateGroup sessionKey="session-a" runId="run-a" group={partial} /></AntdApp>);
    expect(screen.getByText(/持久化 fallback.*wentor-network/)).toBeInTheDocument();
  });
});
