import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TeamService } from '../teams/service.js';
import { CollaborationService, type GroupRuntime } from '../teams/collaboration.js';
import { createTeamTools } from '../teams/tools.js';
import { JobService } from '../jobs/service.js';
import { createTestDb } from './setup.js';
const databases: Database.Database[]=[];
function setup(runtime: GroupRuntime={run:async()=>({text:'真实测试结果'}),abort:async()=>true}) {
 const db=new Database(':memory:');db.pragma('foreign_keys=ON');databases.push(db);
 const teams=new TeamService(db);const team=teams.create();const c=teams.createConversation(team.id,'课题 A');
 const service=new CollaborationService(db,teams,runtime);return {db,teams,team,c,service};
}
afterEach(()=>{for(const db of databases.splice(0))db.close();});
describe('research team collaboration',()=>{
 it('routes messages to a real worker, deduplicates retries and keeps other topics isolated',async()=>{
  const run=vi.fn(async(_work: unknown, _prompt: string)=>({text:'verified result'}));const {teams,team,c,service}=setup({run,abort:async()=>true});
  const other=teams.createConversation(team.id,'课题 B');
  const first=service.submit({conversationId:c.id,requestId:'request',text:'@教授 评估方法'});
  expect(service.submit({conversationId:c.id,requestId:'request',text:'@教授 评估方法'})).toEqual(first);
  expect(service.state(c.id).messages).toHaveLength(1);
  await service.tick();
  expect(run).toHaveBeenCalledTimes(1);
  expect(service.state(c.id).tasks[0]).toMatchObject({memberId:'professor',status:'completed'});
  expect(service.state(c.id).messages[1].text).toBe('verified result');
  expect(service.state(other.id).messages).toHaveLength(0);
  expect(run.mock.calls[0]?.[1]).not.toContain('课题 B');
 });
 it('executes a bounded sequential handoff with preceding outputs and preserves private thread separation',async()=>{
  const prompts:string[]=[];const {c,service}=setup({run:async(w,p)=>{prompts.push(p);return {text:'result '+w.memberId};},abort:async()=>true});
  service.submit({conversationId:c.id,requestId:'pipeline',text:'评估论文',collaborate:true});
  for(let i=0;i<6;i++)await service.tick();
  expect(service.state(c.id).tasks.map(w=>w.memberId)).toEqual(['mentor','academician','professor','researchclaw','professor','mentor']);
  expect(service.state(c.id).tasks.every(w=>w.status==='completed')).toBe(true);
  expect(prompts[1]).toContain('result mentor');
  expect(service.state(c.id).tasks.some(w=>Object.values(c.sessions).includes(w.sessionKey))).toBe(false);
 });
 it('keeps new requests separate and applies explicitly linked constraints to later stages',async()=>{
  let release!:(v:{text:string})=>void;let started!:(v:void)=>void;
  const begun=new Promise<void>(r=>started=r);const promptList:string[]=[];
  const {c,service}=setup({run:async(_w,p)=>{promptList.push(p);if(promptList.length===1){started();return new Promise(r=>release=r);}return {text:'done'};},abort:async()=>true});
  const { taskIds } = service.submit({conversationId:c.id,requestId:'a',text:'原任务',collaborate:true});
  const active=service.tick();await begun;
  service.submit({conversationId:c.id,requestId:'b',text:'独立任务：下载新数据集'});
  const supplement = { conversationId: c.id, requestId: 'c', text: '不要下载数据集', supplementTo: taskIds[1] };
  expect(service.submit(supplement).taskIds).toEqual([]);
  expect(service.submit(supplement).taskIds).toEqual([]);
  expect(service.state(c.id).messages.filter(m => m.text === supplement.text)).toHaveLength(1);
  await service.tick();expect(promptList).toHaveLength(1);
  expect(promptList[0]).not.toContain('不要下载数据集');
  release({text:'first result'});await active;await service.tick();
  expect(promptList[1]).toContain('不要下载数据集');
  expect(promptList[1]).not.toContain('独立任务：下载新数据集');
 });
 it('does not claim cancellation before gateway confirms it, and ignores late success after confirmed stop',async()=>{
  let release!:(v:{text:string})=>void;let begun!:(v:void)=>void;
  const started=new Promise<void>(r=>begun=r);
  const {c,service}=setup({run:async()=>{begun();return new Promise(r=>release=r);},abort:async()=>true});
  const {taskIds}=service.submit({conversationId:c.id,requestId:'cancel',text:'work'});
  const pending=service.tick();await started;await service.cancel(taskIds[0]);release({text:'late'});await pending;
  expect(service.state(c.id).tasks[0].status).toBe('cancelled');
  expect(service.state(c.id).messages.some(m=>m.text==='late')).toBe(false);
 });
 it('records transport uncertainty and refuses to delete unresolved work',async()=>{
  const {c,service}=setup({run:async()=>{throw Error('connection closed');},abort:async()=>false});
  const {taskIds}=service.submit({conversationId:c.id,requestId:'unknown',text:'work'});
  await service.tick();expect(service.state(c.id).tasks[0].status).toBe('unknown');
  expect(()=>service.deleteConversation(c.id)).toThrow();
  await service.cancel(taskIds[0]);expect(service.state(c.id).tasks[0].status).toBe('unknown');
  service.resolveUnknown(taskIds[0]);expect(service.state(c.id).tasks[0].status).toBe('failed');
 });
 it('preserves a completed result when a concurrent abort fails', async () => {
   let finishRun!: (value: { text: string }) => void;
   let rejectAbort!: (error: Error) => void;
   const abort = vi.fn(() => new Promise<boolean>((_resolve, reject) => { rejectAbort = reject; }));
   const { c, service } = setup({
     run: () => new Promise(resolve => { finishRun = resolve; }),
     abort,
   });
   const { taskIds: [id] } = service.submit({ conversationId: c.id, requestId: 'abort-race', text: 'work' });
   const run = service.tick();
   const stop = service.cancel(id);
   expect(await service.cancel(id)).toMatchObject({ status: 'stopping' });
   expect(abort).toHaveBeenCalledTimes(1);
   finishRun({ text: 'result before abort acknowledgement' });
   await run;
   rejectAbort(new Error('connection lost'));
   expect(await stop).toMatchObject({ status: 'completed' });
   expect(service.state(c.id).tasks[0]).toMatchObject({ status: 'completed' });
 });
 it('releases the worker and rolls back the running state if job startup throws', async () => {
   const db = createTestDb();
   databases.push(db);
   const teams = new TeamService(db);
   const conversation = teams.createConversation(teams.create().id, 'Retry startup');
   const jobs = new JobService(db);
   vi.spyOn(jobs, 'start').mockImplementationOnce(() => { throw new Error('startup failed'); });
   const runtime = { run: vi.fn(async () => ({ text: 'done' })), abort: async () => true };
   const service = new CollaborationService(db, teams, runtime, jobs);
   service.submit({ conversationId: conversation.id, requestId: 'start', text: 'work' });
   await expect(service.tick()).rejects.toThrow('startup failed');
   expect(runtime.run).not.toHaveBeenCalled();
   expect(service.state(conversation.id).tasks[0].status).toBe('queued');
   await service.tick();
   expect(runtime.run).toHaveBeenCalledTimes(1);
   expect(service.state(conversation.id).tasks[0].status).toBe('completed');
 });
 it('does not auto-recover jobs during discovery registration',()=>{
  const {db,c,service,teams}=setup();const {taskIds}=service.submit({conversationId:c.id,requestId:'restart',text:'work'});
  const row=db.prepare('SELECT payload FROM rc_team_work WHERE id=?').get(taskIds[0]) as {payload:string};
  db.prepare('UPDATE rc_team_work SET payload=? WHERE id=?').run(JSON.stringify({...JSON.parse(row.payload),status:'running'}),taskIds[0]);
  const reloaded=new CollaborationService(db,teams,{run:async()=>({text:'unused'}),abort:async()=>true});
  expect(reloaded.state(c.id).tasks[0].status).toBe('running');
  reloaded.recoverInterrupted();expect(reloaded.state(c.id).tasks[0].status).toBe('unknown');
 });
 it('uses only the enabled team memory, supports explicit edits and rejects stale writes',async()=>{
  const calls:string[]=[];const {team,c,teams,service}=setup({run:async(_w,p)=>{calls.push(p);return{text:'ok'};},abort:async()=>true});
  const memo=service.saveMemory(team.id,'共享偏好');
  expect(()=>service.saveMemory(team.id,'改写',memo.id,0)).toThrow();
  const isolated=teams.createConversation(team.id,'新主题',false);
  service.submit({conversationId:c.id,requestId:'m1',text:'a'});
  service.submit({conversationId:isolated.id,requestId:'m2',text:'b'});
  await service.tick();await service.tick();
  expect(calls[0]).toContain('共享偏好');expect(calls[1]).not.toContain('共享偏好');
  service.deleteMemory(team.id,memo.id);expect(service.memories(team.id)).toEqual([]);
 });
 it('creates permanent roles through the normal agent tool without starting work',async()=>{
  const {teams,team,service,c}=setup();
  const tool=createTeamTools(teams)[0];
  const result=await tool.execute('t',{action:'add_member',team_id:team.id,revision:team.revision,member:{id:'stats',name:'统计教授 AI',instructions:'检查统计方法'}});
  expect((result as {isError?:boolean}).isError).not.toBe(true);
  expect(teams.list().teams[0].members.at(-1)?.id).toBe('stats');
  expect(service.state(c.id).tasks).toHaveLength(0);
 });
 it('waits for an explicit user decision before continuing the handoff',async()=>{
  let calls=0;const {c,service}=setup({run:async()=>({text:++calls===1?'[[NEEDS_USER]]请选择数据集':'已按回答完成'}),abort:async()=>true});
  const {taskIds}=service.submit({conversationId:c.id,requestId:'question',text:'研究任务',collaborate:true});
  await service.tick();expect(service.state(c.id).tasks[0].status).toBe('waiting_user');
  await service.tick();expect(calls).toBe(1);
  const answer=service.answer(taskIds[0],'使用小样本','answer-key');
  expect(service.answer(taskIds[0],'使用小样本','answer-key')).toEqual(answer);
  await service.tick();expect(calls).toBe(2);
  expect(service.state(c.id).tasks.find(t=>t.id===answer.taskIds[0])?.status).toBe('completed');
 });
 it('keeps member private notes out of group work and out of other members',async()=>{
  const prompts:string[]=[];const {team,c,teams,service}=setup({run:async(_w,p)=>{prompts.push(p);return{text:'ok'};},abort:async()=>true});
  const privateNote=service.saveMemory(team.id,'仅教授可见的私聊笔记',undefined,undefined,'professor');
  expect(service.memories(team.id)).toEqual([]);
  expect(teams.prompt(c.sessions.professor)).toContain('仅教授可见');
  expect(teams.prompt(c.sessions.mentor)).not.toContain('仅教授可见');
  expect(()=>service.deleteMemory(team.id,privateNote.id)).toThrow();
  service.submit({conversationId:c.id,requestId:'private-test',text:'test',memberId:'professor'});
  await service.tick();expect(prompts[0]).not.toContain('仅教授可见');
 });
 it('copies only explicitly referenced shared messages and rejects cross-team references',()=>{
  const {team,c,teams,service}=setup();const target=teams.createConversation(team.id,'Target');
  service.submit({conversationId:c.id,requestId:'ref',text:'原始群消息'});
  expect(service.state(target.id).messages).toHaveLength(0);
  service.referenceConversation(target.id,c.id);
  expect(service.state(target.id).messages[0].text).toContain('原始群消息');
  const other=teams.create();const otherConversation=teams.createConversation(other.id,'Other');
  expect(()=>service.referenceConversation(otherConversation.id,c.id)).toThrow('当前团队');
 });
});
