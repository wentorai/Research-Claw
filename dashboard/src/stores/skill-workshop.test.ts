import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useSkillWorkshopStore } from './skill-workshop';
import { useGatewayStore } from './gateway';
import {
  SKILLS_PROPOSALS_LIST_RESPONSE,
  SKILLS_PROPOSAL_INSPECT_RESPONSE,
} from '../__fixtures__/gateway-payloads/skill-workshop-responses';

const mockRequest = vi.fn();

function setConnected(connected: boolean) {
  useGatewayStore.setState({
    state: connected ? 'connected' : 'disconnected',
    client: connected
      ? ({ isConnected: true, request: mockRequest } as never)
      : null,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  useSkillWorkshopStore.setState({
    proposals: [],
    manifestUpdatedAt: null,
    loading: false,
    loaded: false,
    lastError: null,
    selectedId: null,
    inspect: null,
    inspectLoading: false,
  });
  setConnected(true);
});

describe('skill-workshop store', () => {
  it('loadProposals fetches skills.proposals.list', async () => {
    mockRequest.mockResolvedValueOnce(SKILLS_PROPOSALS_LIST_RESPONSE);
    await useSkillWorkshopStore.getState().loadProposals();
    expect(mockRequest).toHaveBeenCalledWith('skills.proposals.list', {});
    expect(useSkillWorkshopStore.getState().proposals).toHaveLength(1);
    expect(useSkillWorkshopStore.getState().loaded).toBe(true);
  });

  it('inspectProposal fetches skills.proposals.inspect', async () => {
    mockRequest.mockResolvedValueOnce(SKILLS_PROPOSAL_INSPECT_RESPONSE);
    await useSkillWorkshopStore.getState().inspectProposal('prop-morning-catchup');
    expect(mockRequest).toHaveBeenCalledWith('skills.proposals.inspect', {
      proposalId: 'prop-morning-catchup',
    });
    expect(useSkillWorkshopStore.getState().inspect?.record.id).toBe('prop-morning-catchup');
  });

  it('applyProposal calls skills.proposals.apply and reloads', async () => {
    mockRequest
      .mockResolvedValueOnce({ record: SKILLS_PROPOSAL_INSPECT_RESPONSE.record, targetSkillFile: '/x/SKILL.md' })
      .mockResolvedValueOnce(SKILLS_PROPOSALS_LIST_RESPONSE);
    const result = await useSkillWorkshopStore.getState().applyProposal('prop-morning-catchup');
    expect(result?.targetSkillFile).toContain('SKILL.md');
    expect(mockRequest).toHaveBeenCalledWith('skills.proposals.apply', { proposalId: 'prop-morning-catchup' });
  });
});
