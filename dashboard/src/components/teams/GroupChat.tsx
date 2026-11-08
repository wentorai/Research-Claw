import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Button, Card, Checkbox, Empty, Input, Modal, Popconfirm, Select, Space, Tag, Typography } from 'antd';
import { SendOutlined, StopOutlined, ReloadOutlined } from '@ant-design/icons';
import { useGatewayStore } from '../../stores/gateway';
import MarkdownBody from '../MarkdownBody';
import { teamRequestError } from './request-error';

interface Member { id: string; name: string; instructions: string }
interface Work { id: string; memberId: string; status: string; error?: string; jobId?: string; usage?: unknown }
interface Memory { id: string; text: string; revision: number }
interface State { messages: {id: string; sender: string; memberId?: string; text: string; createdAt: string}[]; tasks: Work[]; memories: Memory[] }
interface PendingSend { text: string; target: string; collaborate: boolean; supplementTo?: string; id: string }
const labels: Record<string,string> = {waiting_user:'等待你决定',queued:'排队',running:'执行中',completed:'已完成',failed:'失败',cancelled:'已停止',unknown:'待确认',blocked:'前序步骤未完成',stopping:'正在确认停止'};
function usageLabel(value: unknown): string {
  if(!value || typeof value!=='object')return '已记录';
  const usage=value as Record<string,unknown>;
  return '输入 '+Number(usage.input??0).toLocaleString()+' / 输出 '+Number(usage.output??0).toLocaleString()+' Token';
}
export default function GroupChat({conversationId,teamId,members,coordinatorId,workflow}: {conversationId:string;teamId:string;members:Member[];coordinatorId:string;workflow?:string[]}) {
  const client=useGatewayStore(s=>s.client);
  const connected=useGatewayStore(s=>s.state)==='connected';
  const [data,setData]=useState<State>({messages:[],tasks:[],memories:[]});
  const [error,setError]=useState('');
  const [loadError, setLoadError] = useState('');
  const draftKey = 'rc-team-draft-' + conversationId;
  const sendKey = 'rc-team-pending-send-' + conversationId;
  const [draft,setDraft]=useState(()=>localStorage.getItem(draftKey)||'');
  const [pendingSend] = useState<PendingSend | null>(() => {
    try {
      const saved = JSON.parse(sessionStorage.getItem(sendKey) ?? 'null') as PendingSend | null;
      return saved?.text === draft && members.some(member => member.id === saved.target) ? saved : null;
    } catch { return null; }
  });
  const [target,setTarget]=useState(pendingSend?.target ?? coordinatorId);
  const [collaborate,setCollaborate]=useState(pendingSend?.collaborate ?? false);
  const [supplementTo, setSupplementTo] = useState(pendingSend?.supplementTo);
  const [sending,setSending]=useState(false);
  const [answering,setAnswering]=useState<string|null>(null);
  const [answer,setAnswer]=useState('');
  const [savingAnswer, setSavingAnswer] = useState(false);
  const [memoryOpen,setMemoryOpen]=useState(false);
  const [memoryDraft,setMemoryDraft]=useState('');
  const [editingMemory,setEditingMemory]=useState<Memory|null>(null);
  const retryKey=useRef<PendingSend | null>(pendingSend);
  const answerKey = useRef<{ taskId: string; answer: string; id: string }>();
  const generation=useRef(0);
  const sequence = useRef(0);
  const applied = useRef(0);
  const rpc = useCallback(async <T,>(method:string,params:Record<string,unknown>):Promise<T> => {
    if(!client?.isConnected)throw Error('网关未连接');
    return client.request<T>(method,params);
  }, [client]);
  const refresh = useCallback(async () => {
    const epoch = generation.current;
    const request = ++sequence.current;
    try {
      const state = await rpc<State>('rc.team.group.state', { conversationId });
      if (generation.current !== epoch || applied.current >= request) return;
      applied.current = request;
      setData(state);
      setLoadError('');
    } catch (e) {
      if (generation.current !== epoch || applied.current >= request) return;
      applied.current = request;
      setLoadError(teamRequestError(e));
    }
  }, [rpc, conversationId]);
  useEffect(() => {
    if (!connected) return;
    void refresh();
    const timer = setInterval(() => void refresh(), 2000);
    return () => { clearInterval(timer); generation.current++; };
  }, [connected, refresh]);
  async function action(fn:()=>Promise<void>){try{await fn();setError('');await refresh();}catch(e){setError(teamRequestError(e));}}
  async function send() {
    if(!draft.trim()||sending)return;
    setSending(true);
    const text=draft;
    let request=retryKey.current;
    if(!request||request.text!==text||request.target!==target||request.collaborate!==collaborate||request.supplementTo!==supplementTo){
      request={text,target,collaborate,supplementTo,id:crypto.randomUUID()};
      retryKey.current=request;
    }
    try{
      sessionStorage.setItem(sendKey, JSON.stringify(request));
      await rpc('rc.team.message.send',{conversationId,requestId:request.id,text,memberId:target,collaborate,supplementTo});
      setDraft('');setSupplementTo(undefined);localStorage.removeItem(draftKey);sessionStorage.removeItem(sendKey);retryKey.current=null;setError('');
      await refresh();
    }catch(e){setError(teamRequestError(e));}finally{setSending(false);}
  }
  async function submitAnswer() {
    if (!answering || !answer.trim() || savingAnswer) return;
    if (answerKey.current?.taskId !== answering || answerKey.current.answer !== answer) {
      answerKey.current = { taskId: answering, answer, id: crypto.randomUUID() };
    }
    const requestId = answerKey.current.id;
    setSavingAnswer(true);
    try {
      await action(async () => {
        await rpc('rc.team.work.answer', { id: answering, answer, requestId });
        answerKey.current = undefined;
        setAnswering(null);
      });
    } finally {
      setSavingAnswer(false);
    }
  }
  return <div style={{display:'flex',flexDirection:'column',height:'100%',minHeight:0}}>
    <Space wrap style={{padding:12}}>
      <Typography.Text strong>群内共享对话</Typography.Text>
      <Select aria-label="群消息接收成员" value={target} disabled={!!supplementTo || sending} style={{width:170}} onChange={setTarget} options={members.map(m=>({value:m.id,label:'@ '+m.name}))}/>
      <Checkbox checked={collaborate} disabled={!!supplementTo || sending} onChange={e=>setCollaborate(e.target.checked)}>协作推进</Checkbox>
      <Button onClick={()=>setMemoryOpen(true)}>群组记忆</Button>
    </Space>
    <Typography.Paragraph type="secondary" style={{padding:'0 12px'}}>
      {collaborate?'依次执行：'+(workflow??[coordinatorId,'academician','professor','researchclaw','professor',coordinatorId]).filter(id=>members.some(m=>m.id===id)).map(id=>members.find(m=>m.id===id)?.name).join(' → '):'默认由所选成员响应，也可在消息开头 @成员。'}
      {' '}发送新消息会排入新任务。要更新现有任务，请在排队步骤上选择“补充约束”。
    </Typography.Paragraph>
    {!connected&&<Alert type="warning" message="连接已断开，执行状态暂不可确认。重连后恢复记录。"/>}
    {error&&<Alert type="error" message="群组操作未完成" description={error}/>}
    {loadError&&<Alert type="warning" message="群组状态暂未刷新" description={loadError}/>}
    <div style={{flex:1,minHeight:0,overflowY:'auto',padding:12}}>
      {!data.messages.length&&<Empty description="提出课题需求，或 @ 一位成员开始。成员私聊不会自动发布到这里。"/>}
      {data.messages.map(m=><Card key={m.id} size="small" style={{marginBottom:10}} title={<Space>
        <Tag>{m.sender==='user'?'你':m.sender==='system'?'状态更新':members.find(x=>x.id===m.memberId)?.name||'AI 成员'}</Tag>
        <Typography.Text type="secondary">{new Date(m.createdAt).toLocaleString()}</Typography.Text>
      </Space>}>
        <MarkdownBody>{m.text}</MarkdownBody>
      </Card>)}
      {data.tasks.length>0&&<Card size="small" title="协作任务与执行记录">
        {data.tasks.map(w=><div key={w.id} style={{padding:'7px 0',borderBottom:'1px solid var(--border)'}}>
          <Space wrap><Typography.Text>{members.find(m=>m.id===w.memberId)?.name}</Typography.Text>
            <Tag color={w.status==='completed'?'green':w.status==='running'?'blue':w.status==='unknown'?'orange':undefined}>{labels[w.status]||w.status}</Tag>
            {w.status==='queued'&&<Button size="small" disabled={sending} onClick={()=>setSupplementTo(w.id)}>补充约束</Button>}
            {['queued','running','unknown','stopping','waiting_user'].includes(w.status)&&<Button size="small" disabled={w.status==='stopping'} icon={<StopOutlined/>} onClick={()=>void action(async()=>{await rpc('rc.team.work.cancel',{id:w.id});})}>停止</Button>}
            {w.status==='waiting_user'&&<Button type="primary" size="small" onClick={()=>{setAnswer('');setAnswering(w.id);}}>回答并继续</Button>}
            {w.status==='unknown'&&<Popconfirm title="已经人工核对原执行？" description="仅解除待确认状态，不代表进程已停止。请先检查结果与运行记录。" onConfirm={()=>void action(async()=>{await rpc('rc.team.work.resolve',{id:w.id});})}><Button size="small">结束跟踪</Button></Popconfirm>}
            {w.usage!==undefined&&<Typography.Text type="secondary">{usageLabel(w.usage)}</Typography.Text>}
          </Space>
          {w.error&&<Typography.Paragraph type="secondary">{w.error}</Typography.Paragraph>}
        </div>)}
      </Card>}
    </div>
    {supplementTo&&<Alert type="info" message="这条消息会补充所选任务的后续步骤。" action={<Button disabled={sending} onClick={()=>setSupplementTo(undefined)}>取消补充</Button>}/>}
    <Space.Compact style={{padding:12,width:'100%'}}>
      <Input.TextArea aria-label="群组消息" value={draft} disabled={sending} rows={3} maxLength={16000} placeholder={supplementTo?'输入后续步骤需要遵循的约束。':'输入研究需求，或 @成员。'}
        onChange={e=>{setDraft(e.target.value);localStorage.setItem(draftKey,e.target.value);}}/>
      <Button type="primary" icon={<SendOutlined/>} disabled={!connected||!draft.trim()} loading={sending} onClick={()=>void send()}>发送</Button>
      <Button icon={<ReloadOutlined/>} onClick={()=>void action(async()=>{})} aria-label="刷新群组"/>
    </Space.Compact>
    <Modal title="回答并继续" open={answering!==null} confirmLoading={savingAnswer} okButtonProps={{disabled: !answer.trim()}} onCancel={()=>setAnswering(null)} onOk={()=>void submitAnswer()}>
      <Input.TextArea aria-label="决策回答" value={answer} disabled={savingAnswer} maxLength={4000} onChange={e=>setAnswer(e.target.value)} rows={3}/>
    </Modal>
    <Modal title="群组共享记忆" open={memoryOpen} onCancel={()=>setMemoryOpen(false)} footer={null}>
      <Typography.Paragraph>只保存你明确提交的长期背景；新会话可选择不继承。聊天记录不会自动变成共享记忆。</Typography.Paragraph>
      {data.memories.map(m=><Card key={m.id} size="small" style={{marginBottom:8}}><MarkdownBody>{m.text}</MarkdownBody><Space>
        <Button size="small" onClick={()=>{setEditingMemory(m);setMemoryDraft(m.text);}}>编辑</Button>
        <Popconfirm title="删除这条共享记忆？" onConfirm={()=>void action(async()=>{await rpc('rc.team.memory.delete',{teamId,id:m.id});})}><Button size="small" danger>删除</Button></Popconfirm>
      </Space></Card>)}
      <Input.TextArea aria-label="共享记忆内容" value={memoryDraft} maxLength={4000} rows={3} onChange={e=>setMemoryDraft(e.target.value)}/>
      <Button disabled={!memoryDraft.trim()} onClick={()=>void action(async()=>{
        await rpc('rc.team.memory.save',{teamId,text:memoryDraft,...(editingMemory?{id:editingMemory.id,revision:editingMemory.revision}:{})});
        setMemoryDraft('');setEditingMemory(null);
      })}>{editingMemory?'保存修改':'添加共享记忆'}</Button>
    </Modal>
  </div>;
}
