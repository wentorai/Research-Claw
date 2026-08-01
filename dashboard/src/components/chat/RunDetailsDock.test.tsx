import React from 'react';
import { App as AntdApp } from 'antd';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useGatewayStore } from '../../stores/gateway';
import { executionKey, useExecutionTraceStore } from '../../stores/execution-trace';
import RunDetailsDock from './RunDetailsDock';

describe('RunDetailsDock', () => {
  const request = vi.fn();
  const key = executionKey('session-a', 'run-a');

  beforeEach(() => {
    request.mockReset();
    request.mockResolvedValue({ files: [{ path: 'outputs/result.md', status: 'present' }] });
    useGatewayStore.setState({ client: { isConnected: true, request } as never, state: 'connected' });
    useExecutionTraceStore.setState({
      activeSessionKey: 'session-a',
      generation: 1,
      summaries: { [key]: { toolCount: 1, errorCount: 0, skillCount: 1 } },
      details: {},
      availability: {},
      presentations: {
        [key]: {
          runId: 'run-a',
          recordsRevision: 4,
          files: [{
            type: 'file', operation: 'workspace_save', name: 'result.md',
            path: 'outputs/result.md', sizeBytes: 12, mimeType: 'text/markdown', gitStatus: 'new',
          }],
          paperBatches: [],
        },
      },
    });
  });

  it('shows tool/Skill evidence and the unique server-projected FileCard together', async () => {
    render(<AntdApp><RunDetailsDock sessionKey="session-a" runId="run-a" noFinal /></AntdApp>);
    expect(screen.getByRole('button', { name: '调用 1 个工具，检测到 1 个 Skill' })).toBeInTheDocument();
    expect(screen.getByText('交付文件')).toBeInTheDocument();
    expect(screen.getByText('result.md')).toBeInTheDocument();
    expect(screen.getByText(/本轮没有最终回复/)).toBeInTheDocument();
    await waitFor(() => expect(request).toHaveBeenCalledWith('rc.ws.availability', {
      files: [{ path: 'outputs/result.md', expected: true }],
    }));
  });

  it('updates availability independently of recordsRevision and disables actions', async () => {
    request.mockResolvedValue({ files: [{ path: 'outputs/result.md', status: 'deleted' }] });
    render(<AntdApp><RunDetailsDock sessionKey="session-a" runId="run-a" /></AntdApp>);
    expect((useExecutionTraceStore.getState().presentations[key]?.recordsRevision)).toBe(4);
    expect(await screen.findByText('文件已删除')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /打开文件/ })).toBeDisabled();
    expect((useExecutionTraceStore.getState().presentations[key]?.recordsRevision)).toBe(4);
  });

  it('suppresses only a raw candidate that the Agent deliberately presented by strong identity', () => {
    useExecutionTraceStore.setState((state) => ({
      presentations: {
        ...state.presentations,
        [key]: {
          ...state.presentations[key],
          paperCandidates: {
            semantic: 'retrieved',
            label: '检索结果·尚未筛选',
            queries: ['reliability'],
            queryUnavailable: false,
            hasAvailableResults: true,
            providers: ['crossref', 'openalex'],
            partialProviders: [],
            unavailableProviders: [],
            returned: 2,
            eligible: 2,
            stored: 2,
            unique: 2,
            shown: 2,
            candidates: [
              {
                candidateId: 'selected', provider: 'crossref', returnIndex: 1,
                source: 'crossref', strongAliases: ['doi:10.1000/selected'], actionable: true,
                title: 'Agent selected paper', authors: ['A'], doi: '10.1000/selected',
              },
              {
                candidateId: 'raw', provider: 'openalex', returnIndex: 2,
                source: 'openalex', strongAliases: ['provider:openalex:W2'], actionable: true,
                title: 'Still raw candidate', authors: ['B'], providerId: 'W2',
              },
            ],
          },
        },
      },
    }));

    render(
      <AntdApp>
        <RunDetailsDock
          sessionKey="session-a"
          runId="run-a"
          selectedPaperAliases={new Set(['doi:10.1000/selected'])}
        />
      </AntdApp>,
    );

    fireEvent.click(screen.getByRole('button', { name: '查看候选' }));
    expect(screen.queryByText('Agent selected paper')).not.toBeInTheDocument();
    expect(screen.getByText('Still raw candidate')).toBeInTheDocument();
  });
});
