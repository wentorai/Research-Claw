import type { ToolDefinition } from '../types.js';
import { TeamService } from './service.js';
export function createTeamTools(service: TeamService): ToolDefinition[] {
  return [{
    name: 'research_team_configure',
    description: 'Manage persistent research-team identities when the user asks to create or edit them. List teams before edits. Configuration only: never starts work or changes tool permissions. Temporary role-play does not create a permanent role.',
    parameters: { type:'object', properties: {
      action:{type:'string',enum:['list','create','update','add_member']}, team_id:{type:'string'}, revision:{type:'number'},
      team:{type:'object',properties:{name:{type:'string'},description:{type:'string'},coordinatorId:{type:'string'},workflow:{type:'array',items:{type:'string'}},members:{type:'array',items:{type:'object',properties:{id:{type:'string'},name:{type:'string'},instructions:{type:'string'},model:{type:'string'}},required:['id','name','instructions']}}}},
      member:{type:'object',properties:{id:{type:'string'},name:{type:'string'},instructions:{type:'string'},model:{type:'string'}},required:['id','name','instructions']},
    },required:['action']},
    async execute(_callId, params) {
      try {
        let result: unknown;
        if (params.action==='list') result=service.list().teams;
        else if (params.action==='create') result=service.create(params.team);
        else {
          const current=service.list().teams.find(t=>t.id===params.team_id);
          if (!current) throw new Error('Team not found; list teams before editing');
          if (params.action==='add_member') result=service.update(current.id,Number(params.revision),{...current,members:[...current.members,params.member]});
          else if (params.action==='update') result=service.update(current.id,Number(params.revision),params.team);
          else throw new Error('Unknown configuration action');
        }
        return {content:[{type:'text',text:JSON.stringify(result)}],details:result};
      } catch(e) {return {isError:true,content:[{type:'text',text:e instanceof Error?e.message:String(e)}]};}
    },
  }];
}
