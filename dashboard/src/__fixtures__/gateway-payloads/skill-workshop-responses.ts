import type {
  SkillsProposalInspectResult,
  SkillsProposalsListResult,
} from '../../gateway/skill-workshop-types';

export const SKILLS_PROPOSALS_LIST_RESPONSE: SkillsProposalsListResult = {
  schema: 'openclaw.skill-workshop.proposals-manifest.v1',
  updatedAt: '2026-06-04T12:00:00.000Z',
  proposals: [
    {
      id: 'prop-morning-catchup',
      kind: 'create',
      status: 'pending',
      title: 'morning-catchup',
      description: 'Daily inbox catch-up routine',
      skillName: 'morning-catchup',
      skillKey: 'workspace:morning-catchup',
      createdAt: '2026-06-04T10:00:00.000Z',
      updatedAt: '2026-06-04T10:00:00.000Z',
      scanState: 'clean',
    },
  ],
};

export const SKILLS_PROPOSAL_INSPECT_RESPONSE: SkillsProposalInspectResult = {
  record: {
    schema: 'openclaw.skill-workshop.proposal.v1',
    id: 'prop-morning-catchup',
    kind: 'create',
    status: 'pending',
    title: 'morning-catchup',
    description: 'Daily inbox catch-up routine',
    createdAt: '2026-06-04T10:00:00.000Z',
    updatedAt: '2026-06-04T10:00:00.000Z',
    createdBy: 'gateway',
    proposedVersion: 'v1',
    draftFile: 'PROPOSAL.md',
    draftHash: 'abc123',
    target: {
      skillName: 'morning-catchup',
      skillKey: 'workspace:morning-catchup',
      skillDir: '/tmp/workspace/skills/morning-catchup',
      skillFile: '/tmp/workspace/skills/morning-catchup/SKILL.md',
    },
    scan: {
      state: 'clean',
      scannedAt: '2026-06-04T10:00:00.000Z',
      critical: 0,
      warn: 0,
      info: 0,
      findings: [],
    },
  },
  content: '---\nname: morning-catchup\ndescription: Daily inbox catch-up\n---\n\n# Morning catch-up\n',
};
