import assert from 'node:assert/strict';
import { callGatewayFromCli } from 'openclaw/plugin-sdk/gateway-runtime';

// Explicit, opt-in live acceptance. Uses the locally configured model and quota.
const call = (method, params = {}) => callGatewayFromCli(method, {json:true,timeout:'15000'}, params);
const team = await call('rc.team.create', {team:{
  name:'科研群组协作验收', description:'本机最小验收；禁止联网、文件写入和其他工具操作。',
  coordinatorId:'mentor', workflow:['mentor','professor','mentor'], members:[
    {id:'mentor',name:'验收小导师 AI',instructions:'进行最小对话验收，只按要求简短回复，不使用工具。'},
    {id:'professor',name:'验收教授 AI',instructions:'进行最小对话验收，只按要求简短回复，不使用工具。'},
  ],
}});
const conversation = await call('rc.team.conversation.create', {teamId:team.id,title:'真实队列与回报验证',inheritMemory:false});
const requestId = crypto.randomUUID();
const submitted = await call('rc.team.message.send', {conversationId:conversation.id,requestId,text:'只回复 TEAM_GROUP_SMOKE_OK。禁止调用任何工具。',memberId:'mentor'});
assert.deepEqual(await call('rc.team.message.send', {conversationId:conversation.id,requestId,text:'只回复 TEAM_GROUP_SMOKE_OK。禁止调用任何工具。',memberId:'mentor'}),submitted);
console.log(JSON.stringify({teamId:team.id,conversationId:conversation.id,taskId:submitted.taskIds[0],status:'submitted-once'}));
const start = Date.now();
while (Date.now()-start < 210000) {
  const state = await call('rc.team.group.state', {conversationId:conversation.id});
  const work = state.tasks.find(t=>t.id===submitted.taskIds[0]);
  if (work && !['queued','running','stopping'].includes(work.status)) {
    console.log(JSON.stringify({status:work.status,result:work.result,error:work.error,usage:work.usage}));
    assert.equal(work.status,'completed');
    assert.match(work.result,/TEAM_GROUP_SMOKE_OK/);
    assert.equal(state.messages.filter(m=>m.sender==='user').length,1);
    assert.equal(state.messages.filter(m=>m.sender==='agent').length,1);
    console.log('LIVE_TEAM_COLLABORATION_OK');
    if(process.argv.includes('--pipeline')) {
      const batch=await call('rc.team.message.send',{conversationId:conversation.id,requestId:crypto.randomUUID(),text:'协作验收：每个阶段只回复 PIPELINE_STAGE_OK，不调用工具。',collaborate:true});
      const pipelineStart=Date.now();let done=false;
      while(Date.now()-pipelineStart<360000) {
        const snapshot=await call('rc.team.group.state',{conversationId:conversation.id});
        const steps=snapshot.tasks.filter(t=>batch.taskIds.includes(t.id));
        if(steps.every(t=>t.status==='completed')) {
          assert.equal(steps.length,3);assert.deepEqual(steps.map(t=>t.memberId),['mentor','professor','mentor']);
          console.log(JSON.stringify({pipeline:'completed',stages:steps.length,usage:steps.map(t=>t.usage)}));done=true;break;
        }
        const failure=steps.find(t=>['failed','unknown','blocked','waiting_user'].includes(t.status));
        if(failure)throw new Error('Pipeline did not complete: '+JSON.stringify({status:failure.status,error:failure.error}));
        await new Promise(resolve=>setTimeout(resolve,2000));
      }
      assert.equal(done,true,'Pipeline did not settle');console.log('LIVE_TEAM_PIPELINE_OK');
    }
    await call('rc.team.organize',{id:team.id,archived:true});
    process.exit(0);
  }
  await new Promise(resolve=>setTimeout(resolve,2000));
}
throw new Error('Live team task did not settle; inspect its task record before retrying.');
