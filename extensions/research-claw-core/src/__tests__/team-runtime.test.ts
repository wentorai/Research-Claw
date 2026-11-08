import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createGroupRuntime } from '../teams/runtime.js';
import type { GroupWork } from '../teams/collaboration.js';
const mock=vi.hoisted(()=>({call:vi.fn()}));
vi.mock('openclaw/plugin-sdk/gateway-runtime',()=>({callGatewayFromCli:mock.call}));
const work={id:'task',sessionKey:'agent:main:rc-team-work-task'} as GroupWork;
beforeEach(() => mock.call.mockReset());
describe('Group host runtime',()=>{
 it('uses authenticated normal agent execution and waits for the final result',async()=>{
  mock.call.mockResolvedValue({status:'ok',result:{payloads:[{text:'result'},{text:'reasoning',isReasoning:true}],meta:{agentMeta:{usage:{input:10}}}}});
  expect(await createGroupRuntime().run(work,'prompt','provider/model')).toEqual({text:'result',usage:{input:10}});
  expect(mock.call).toHaveBeenCalledWith('agent',expect.objectContaining({expectFinal:true}),expect.objectContaining({sessionKey:work.sessionKey,idempotencyKey:'task',deliver:false,provider:'provider',model:'model'}));
 });
 it('does not turn an accepted or aborted run into completed work',async()=>{
  mock.call.mockResolvedValue({status:'accepted'});
  await expect(createGroupRuntime().run(work,'prompt')).rejects.toThrow();
 });
 it('requires affirmative gateway abort confirmation',async()=>{
  mock.call.mockResolvedValue({aborted:false});expect(await createGroupRuntime().abort(work)).toBe(false);
  mock.call.mockResolvedValue({aborted:true});expect(await createGroupRuntime().abort(work)).toBe(true);
 });
 it('never forwards a group prompt to a configured remote gateway', async () => {
   const runtime = createGroupRuntime(() => ({ gateway: { mode: 'remote' } }));
   await expect(runtime.run(work, 'private group context')).rejects.toThrow('require the local gateway');
   expect(mock.call).not.toHaveBeenCalled();
 });
});
