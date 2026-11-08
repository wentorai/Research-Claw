import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App } from 'antd';
import TeamsWorkspace from './TeamsWorkspace';
const mock = vi.hoisted(() => ({ request: vi.fn(), switchSession: vi.fn(), key: 'main' }));
vi.mock('../../stores/gateway', () => { const client = { isConnected: true, request: mock.request }; return { useGatewayStore: (selector: (s: unknown) => unknown) => selector({ state: 'connected', client }) }; });
vi.mock('../../stores/sessions', () => ({ MAIN_SESSION_KEY: 'agent:main:main', useSessionsStore: (selector: (s: unknown) => unknown) => selector({ switchSession: mock.switchSession }) }));
vi.mock('../../stores/chat', () => ({ useChatStore: (selector: (s: unknown) => unknown) => selector({ sessionKey: mock.key }) }));
vi.mock('./GroupChat', () => ({default: () => <div data-testid="group-chat">Shared group</div>}));
vi.mock('../chat/ChatView', () => ({ default: () => <div data-testid="member-chat">Actual chat surface</div> }));
const member = { id: 'mentor', name: '小导师 AI', instructions: 'Plan research' };
const team = { id: 'team', name: '测试团队', description: '', coordinatorId: 'mentor', members: [member], revision: 1 };
const convo = { id: 'convo', teamId: 'team', title: 'Topic A', members: [member], coordinatorId: 'mentor', sessions: { mentor: 'agent:main:rc-team-example' } };
function mount() { return render(<App><TeamsWorkspace /></App>); }
beforeEach(() => { vi.clearAllMocks(); localStorage.clear(); mock.key = 'main'; });
afterEach(cleanup);
describe('TeamsWorkspace', () => {
  it('does not create or call a model on opening; creates a default team only on demand', async () => {
    mock.request.mockResolvedValue({ teams: [], conversations: [] });
    mount();
    await screen.findByText(/先创建默认科研团队/);
    expect(mock.request).toHaveBeenCalledTimes(1);
    mock.request.mockResolvedValueOnce(team).mockResolvedValueOnce({ teams: [team], conversations: [] });
    fireEvent.click(screen.getByRole('button', { name: '新建默认团队' }));
    await waitFor(() => expect(mock.request).toHaveBeenCalledWith('rc.team.create', {}));
    await screen.findByText('Plan research');
    expect(mock.request.mock.calls.some(call => call[0] === 'chat.send')).toBe(false);
  });
  it('restores a saved member thread and returns to the ordinary main session', async () => {
    localStorage.setItem('rc-team-selection', JSON.stringify({ teamId: 'team', conversationId: 'convo', memberId: 'mentor' }));
    mock.key = convo.sessions.mentor;
    mock.request.mockResolvedValue({ teams: [team], conversations: [convo] });
    mount();
    await screen.findByTestId('group-chat');
    expect(mock.switchSession).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('radio', {name:'成员私聊'}));
    await screen.findByTestId('member-chat');
    expect(mock.switchSession).toHaveBeenCalledWith(convo.sessions.mentor);
    fireEvent.click(screen.getByRole('button', { name: '返回普通会话' }));
    expect(mock.switchSession).toHaveBeenLastCalledWith('agent:main:main');
  });
  it('does not render the previous transcript while switching to a member', async () => {
    localStorage.setItem('rc-team-selection', JSON.stringify({ teamId: 'team', conversationId: 'convo', memberId: 'mentor' }));
    mock.request.mockResolvedValue({ teams: [team], conversations: [convo] });
    mount();
    await screen.findByTestId('group-chat');
    fireEvent.click(screen.getByRole('radio', { name: '成员私聊' }));
    await waitFor(() => expect(mock.switchSession).toHaveBeenCalledWith(convo.sessions.mentor));
    expect(screen.queryByTestId('member-chat')).not.toBeInTheDocument();
  });
  it('shows RPC failure instead of pretending to have loaded a team', async () => {
    mock.request.mockRejectedValue(new Error('unavailable'));
    mount();
    await screen.findByText('unavailable');
    expect(screen.queryByTestId('member-chat')).not.toBeInTheDocument();
  });
});
