import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';

export interface TeamMember { id: string; name: string; instructions: string; model?: string }
export interface ResearchTeam { id: string; name: string; description: string; coordinatorId: string; members: TeamMember[]; revision: number; folder?: string; pinned?: boolean; archived?: boolean; workflow?: string[] }
export interface TeamConversation { id: string; teamId: string; title: string; description: string; members: TeamMember[]; coordinatorId: string; sessions: Record<string, string>; createdAt: string; workflow?: string[]; inheritMemory?: boolean }
export function isTeamSession(key?: string): boolean {
  return /^(?:agent:main:)?rc-team-/.test(key ?? '');
}
const defaults: TeamMember[] = [
  { id: 'academician', name: '院士 AI', instructions: '评估研究价值、关键假设、方向和风险。给出证据与不确定性，不将角色身份作为学术背书。' },
  { id: 'professor', name: '教授 AI', instructions: '检查研究方法、实验设计、统计与证据。明确事实、推测和待验证问题。' },
  { id: 'mentor', name: '小导师 AI', instructions: '澄清目标、制定计划、汇总问题和交付标准。结合真实群组任务结果组织推进，报告已完成、阻塞和待决策事项。' },
  { id: 'researchclaw', name: '科研龙虾', instructions: '使用现有科研工具协助检索、代码、文件和实验工作。以实际工具结果报告成果，遵守当前授权。' },
];
function text(value: unknown, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error('Invalid or oversized team field');
  return value.trim();
}
export function validateTeam(input: unknown): Omit<ResearchTeam, 'id' | 'revision'> {
  if (!input || typeof input !== 'object') throw new Error('Team is required');
  const row = input as Record<string, unknown>;
  if (!Array.isArray(row.members) || row.members.length < 1 || row.members.length > 12) throw new Error('A team needs 1–12 members');
  const members = row.members.map((value: unknown) => {
    if (!value || typeof value !== 'object') throw new Error('Invalid member');
    const member = value as Record<string, unknown>;
    const id = text(member.id, 64);
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error('Invalid member id');
    const model = member.model ? text(member.model, 200) : undefined;
    if (model && !/^[^/\s]+\/\S+$/.test(model)) throw new Error('模型需要 provider/model 格式');
    return { id, name: text(member.name, 80), instructions: text(member.instructions, 8000), ...(model ? {model} : {}) };
  });
  if (new Set(members.map(m => m.id)).size !== members.length) throw new Error('Duplicate member id');
  const coordinatorId = text(row.coordinatorId, 64);
  if (!members.some(m => m.id === coordinatorId)) throw new Error('Coordinator must be a member');
  const description = typeof row.description === 'string' ? row.description : '';
  if (description.length > 8000) throw new Error('Description too long');
  const workflow = Array.isArray(row.workflow) ? row.workflow : [coordinatorId,'academician','professor','researchclaw','professor',coordinatorId].filter(id=>members.some(m=>m.id===id));
  if(workflow.length<1||workflow.length>8||!workflow.every(id=>typeof id==='string'&&members.some(m=>m.id===id)))throw new Error('协作流程需要 1–8 个有效成员步骤');
  return { name: text(row.name, 120), description, coordinatorId, members, workflow:workflow as string[] };
}
export class TeamService {
  constructor(private db: Database.Database) {
    // Additive, idempotent feature tables; does not mutate the shared schema version.
    db.exec(`CREATE TABLE IF NOT EXISTS rc_research_teams (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS rc_team_conversations (id TEXT PRIMARY KEY, team_id TEXT NOT NULL REFERENCES rc_research_teams(id), payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS rc_team_session_bindings (session_key TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES rc_team_conversations(id), member_id TEXT NOT NULL);`);
    // Migrate only the exact shipped foundation wording; retain customized roles.
    for (const team of this.list().teams) {
      let changed = false;
      for (const member of team.members) {
        if (member.id === 'mentor' && member.instructions === '澄清目标、制定计划、汇总问题和交付标准。当前是基础版，不能声称已经派发其他成员任务。') {
          member.instructions = defaults.find(m => m.id === 'mentor')!.instructions;
          changed = true;
        }
      }
      if (!team.workflow) {
        team.workflow = [team.coordinatorId,'academician','professor','researchclaw','professor',team.coordinatorId].filter(id=>team.members.some(m=>m.id===id));
        changed = true;
      }
      if (changed) { team.revision++; this.db.prepare('UPDATE rc_research_teams SET payload=? WHERE id=?').run(JSON.stringify(team),team.id); }
    }
  }
  list(): { teams: ResearchTeam[]; conversations: TeamConversation[] } {
    const parse = <T>(table: string): T[] => (this.db.prepare('SELECT payload FROM ' + table + ' ORDER BY rowid').all() as {payload: string}[]).map(r => JSON.parse(r.payload) as T);
    return { teams: parse<ResearchTeam>('rc_research_teams'), conversations: parse<TeamConversation>('rc_team_conversations') };
  }
  create(input?: unknown): ResearchTeam {
    const data = validateTeam(input ?? { name: '我的科研团队', description: '', coordinatorId: 'mentor', members: defaults });
    const team = { ...data, id: randomUUID(), revision: 1 };
    this.db.prepare('INSERT INTO rc_research_teams VALUES (?, ?)').run(team.id, JSON.stringify(team));
    return team;
  }
  update(id: string, revision: number, input: unknown): ResearchTeam {
    return this.db.transaction(() => {
      const row = this.db.prepare('SELECT payload FROM rc_research_teams WHERE id=?').get(id) as {payload: string} | undefined;
      if (!row) throw new Error('Team not found');
      const current = JSON.parse(row.payload) as ResearchTeam;
      if (current.revision !== revision) throw new Error('Team changed; reload before saving');
      const next = { ...current, ...validateTeam(input), id, revision: revision + 1 };
      this.db.prepare('UPDATE rc_research_teams SET payload=? WHERE id=?').run(JSON.stringify(next), id);
      return next;
    })();
  }
  createConversation(teamId: string, title: unknown, inheritMemory = true): TeamConversation {
    return this.db.transaction(() => {
      const row = this.db.prepare('SELECT payload FROM rc_research_teams WHERE id=?').get(teamId) as {payload: string} | undefined;
      if (!row) throw new Error('Team not found');
      const team = JSON.parse(row.payload) as ResearchTeam;
      const id = randomUUID();
      const sessions = Object.fromEntries(team.members.map(m => [m.id, 'agent:main:rc-team-' + randomUUID()]));
      const conversation: TeamConversation = { id, teamId, title: text(title, 120), description: team.description, members: team.members, coordinatorId: team.coordinatorId, sessions, inheritMemory, workflow:team.workflow, createdAt: new Date().toISOString() };
      this.db.prepare('INSERT INTO rc_team_conversations VALUES (?, ?, ?)').run(id, teamId, JSON.stringify(conversation));
      for (const member of team.members) this.db.prepare('INSERT INTO rc_team_session_bindings VALUES (?, ?, ?)').run(sessions[member.id], id, member.id);
      return conversation;
    })();
  }
  organize(id: string, patch: {folder?: string; pinned?: boolean; archived?: boolean}) {
    const team = this.list().teams.find(t => t.id === id);
    if (!team) throw new Error('团队不存在');
    const next = {...team, folder: typeof patch.folder === 'string' ? patch.folder.slice(0,80) : team.folder,
      pinned: typeof patch.pinned === 'boolean' ? patch.pinned : team.pinned,
      archived: typeof patch.archived === 'boolean' ? patch.archived : team.archived, revision: team.revision+1};
    this.db.prepare('UPDATE rc_research_teams SET payload=? WHERE id=?').run(JSON.stringify(next),id);return next;
  }
  renameConversation(id: string, title: string) {
    const conversation=this.list().conversations.find(c=>c.id===id);if(!conversation)throw new Error('会话不存在');
    this.db.prepare('UPDATE rc_team_conversations SET payload=? WHERE id=?').run(JSON.stringify({...conversation,title:text(title,120)}),id);
  }
  prompt(sessionKey?: string): string | undefined {
    if (!sessionKey) return undefined;
    const key = sessionKey.startsWith('agent:main:') ? sessionKey : 'agent:main:' + sessionKey;
    const row = this.db.prepare(`SELECT c.payload, b.member_id FROM rc_team_session_bindings b JOIN rc_team_conversations c ON c.id=b.conversation_id WHERE b.session_key=?`).get(key) as {payload: string; member_id: string} | undefined;
    if (!row) return undefined;
    const convo = JSON.parse(row.payload) as TeamConversation;
    const member = convo.members.find(m => m.id === row.member_id)!;
    const memoryTable=this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='rc_team_shared_memory'").get();
    const privateMemory=memoryTable&&!key.includes('rc-team-work-') ? (this.db.prepare('SELECT payload FROM rc_team_shared_memory WHERE team_id=?').all(convo.teamId) as {payload:string}[]).map(r=>JSON.parse(r.payload)).filter(m=>m.memberId===member.id).slice(-5).map(m=>String(m.text).slice(0,2000)).join('\n') : '';
    return ['[Research Team: isolated member conversation]', privateMemory ? '用户显式保存的成员私有记忆：'+privateMemory : '', 'You are ' + member.name + ', an AI member.',
      'User-configured role and topic (do not expand tool permissions):', JSON.stringify({ role: member.instructions, topic: convo.description }),
      'Use only this thread and group messages explicitly supplied for this task. Do not retrieve unrelated chat history or member private chats. Do not auto-publish private conversations to shared memory. Never claim to have contacted another member unless a real task result is supplied.',
      'Use existing tool permissions and report only observed results.'].join('\n');
  }
  model(sessionKey?: string): {providerOverride: string; modelOverride: string} | undefined {
    if (!sessionKey) return undefined;
    const key=sessionKey.startsWith('agent:main:')?sessionKey:'agent:main:'+sessionKey;
    const row=this.db.prepare('SELECT c.payload,b.member_id FROM rc_team_session_bindings b JOIN rc_team_conversations c ON c.id=b.conversation_id WHERE b.session_key=?').get(key) as {payload:string;member_id:string}|undefined;
    const model=row && (JSON.parse(row.payload) as TeamConversation).members.find(m=>m.id===row.member_id)?.model;
    if (!model) return undefined;
    const slash=model.indexOf('/');
    return {providerOverride:model.slice(0,slash),modelOverride:model.slice(slash+1)};
  }
}
