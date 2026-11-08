import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { TeamService, validateTeam } from '../teams/service.js';
import { registerTeamRpc } from '../teams/rpc.js';

const dbs: Database.Database[] = [];
function fixture() { const db = new Database(':memory:'); db.pragma('foreign_keys=ON'); dbs.push(db); return { db, service: new TeamService(db) }; }
afterEach(() => { for (const db of dbs.splice(0)) db.close(); });
describe('Research team foundation', () => {
  it('restores teams and conversation snapshots from the database', () => {
    const { db, service } = fixture();
    const team = service.create();
    const a = service.createConversation(team.id, 'A');
    const b = service.createConversation(team.id, 'B');
    expect(team.members).toHaveLength(4);
    expect(a.sessions.mentor).not.toBe(b.sessions.mentor);
    expect(new Set(Object.values(a.sessions)).size).toBe(4);
    const reopened = new TeamService(db);
    expect(reopened.list().conversations).toEqual([a, b]);
    expect(reopened.prompt(a.sessions.professor)).toContain('教授 AI');
    expect(reopened.prompt('main')).toBeUndefined();
    expect(reopened.prompt(a.sessions.professor.replace('agent:main:', ''))).toBe(reopened.prompt(a.sessions.professor));
  });
  it('keeps existing role snapshots after editing and rejects stale writes', () => {
    const { service } = fixture();
    const team = service.create();
    const old = service.createConversation(team.id, 'Old');
    const edited = { ...team, description: 'New topic', members: team.members.map(m => ({ ...m, instructions: 'Updated role' })) };
    service.update(team.id, 1, edited);
    expect(() => service.update(team.id, 1, edited)).toThrow('reload');
    expect(service.prompt(old.sessions.mentor)).not.toContain('Updated role');
    const next = service.createConversation(team.id, 'New');
    expect(service.prompt(next.sessions.mentor)).toContain('Updated role');
    expect(service.prompt(old.sessions.mentor)).not.toContain('New topic');
  });
  it('rejects invalid coordinators, member ids and empty fields', () => {
    const { service } = fixture();
    const team = service.create();
    expect(() => validateTeam({ ...team, coordinatorId: 'missing' })).toThrow();
    expect(() => validateTeam({ ...team, members: [team.members[0], team.members[0]] })).toThrow();
    expect(() => validateTeam({ ...team, name: ' ' })).toThrow();
    expect(() => service.createConversation('missing', 'X')).toThrow('not found');
    expect(() => service.createConversation(team.id, '')).toThrow();
  });
  it('exposes backed RPCs without creating a team on read', async () => {
    const { service } = fixture();
    const handlers = new Map<string, (p: Record<string, unknown>) => unknown>();
    registerTeamRpc((name, fn) => handlers.set(name, fn), service);
    expect(handlers.get('rc.team.list')!({})).toEqual({ teams: [], conversations: [] });
    const team = handlers.get('rc.team.create')!({}) as { id: string };
    const c = handlers.get('rc.team.conversation.create')!({ teamId: team.id, title: 'Test' }) as { sessions: Record<string, string> };
    expect(service.prompt(c.sessions.researchclaw)).toContain('科研龙虾');
  });
  it('binds model choices to the member snapshot, including private conversations', () => {
    const {service}=fixture();const team=service.create();
    service.update(team.id,team.revision,{...team,members:team.members.map(m=>({...m,model:'provider/model'}))});
    const conversation=service.createConversation(team.id,'Model test');
    expect(service.model(conversation.sessions.professor)).toEqual({providerOverride:'provider',modelOverride:'model'});
    expect(service.model('main')).toBeUndefined();
  });
});
