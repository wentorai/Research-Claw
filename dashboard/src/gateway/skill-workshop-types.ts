/** OpenClaw Skill Workshop types (OC 2026.6.1 gateway protocol). */

export type SkillProposalStatus = 'pending' | 'applied' | 'rejected' | 'quarantined' | 'stale';
export type SkillProposalKind = 'create' | 'update';
export type SkillProposalScanState = 'pending' | 'clean' | 'failed' | 'quarantined';

export interface SkillProposalManifestEntry {
  id: string;
  kind: SkillProposalKind;
  status: SkillProposalStatus;
  title: string;
  description: string;
  skillName: string;
  skillKey: string;
  createdAt: string;
  updatedAt: string;
  scanState: SkillProposalScanState;
}

export interface SkillProposalSupportFile {
  path: string;
  sizeBytes: number;
  hash: string;
  targetExisted?: boolean;
  targetContentHash?: string;
}

export interface SkillProposalSupportFileInput {
  path: string;
  content: string;
}

export interface SkillProposalFinding {
  ruleId: string;
  severity: 'info' | 'warn' | 'critical';
  file: string;
  line: number;
  message: string;
  evidence: string;
}

export interface SkillProposalScan {
  state: SkillProposalScanState;
  scannedAt: string;
  critical: number;
  warn: number;
  info: number;
  findings: SkillProposalFinding[];
}

export interface SkillProposalTarget {
  skillName: string;
  skillKey: string;
  skillDir: string;
  skillFile: string;
  source?: string;
  currentContentHash?: string;
}

export interface SkillProposalRecord {
  schema: 'openclaw.skill-workshop.proposal.v1';
  id: string;
  kind: SkillProposalKind;
  status: SkillProposalStatus;
  title: string;
  description: string;
  createdAt: string;
  updatedAt: string;
  createdBy: 'skill-workshop' | 'cli' | 'gateway';
  origin?: {
    agentId?: string;
    sessionKey?: string;
    runId?: string;
    messageId?: string;
  };
  proposedVersion: string;
  draftFile: 'PROPOSAL.md';
  draftHash: string;
  supportFiles?: SkillProposalSupportFile[];
  target: SkillProposalTarget;
  scan: SkillProposalScan;
  goal?: string;
  evidence?: string;
  appliedAt?: string;
  rejectedAt?: string;
  quarantinedAt?: string;
  staleAt?: string;
  statusReason?: string;
}

export interface SkillsProposalsListResult {
  schema: 'openclaw.skill-workshop.proposals-manifest.v1';
  updatedAt: string;
  proposals: SkillProposalManifestEntry[];
}

export interface SkillsProposalInspectResult {
  record: SkillProposalRecord;
  content: string;
  supportFiles?: SkillProposalSupportFileInput[];
}

export interface SkillsProposalApplyResult {
  record: SkillProposalRecord;
  targetSkillFile: string;
}
