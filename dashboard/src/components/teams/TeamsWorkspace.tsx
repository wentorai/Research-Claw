import React, { useEffect, useState } from 'react';
import { Alert, App, Button, Card, Empty, Form, Input, Modal, Select, Space, Spin, Typography, Checkbox, Popconfirm, Segmented } from 'antd';
import { useGatewayStore } from '../../stores/gateway';
import { MAIN_SESSION_KEY, useSessionsStore } from '../../stores/sessions';
import { useTeamsStore } from '../../stores/teams';
import ChatView from '../chat/ChatView';
import GroupChat from './GroupChat';
import { useChatStore } from '../../stores/chat';
import { teamRequestError } from './request-error';
import { normalizeSessionKey } from '../../utils/session-key';

interface Member { id: string; name: string; instructions: string; model?: string }
interface Team { id: string; name: string; description: string; coordinatorId: string; members: Member[]; revision: number; folder?: string; pinned?: boolean; archived?: boolean }
interface Conversation { id: string; teamId: string; title: string; members: Member[]; coordinatorId: string; sessions: Record<string, string>; workflow?: string[] }
interface Snapshot { teams: Team[]; conversations: Conversation[] }

export default function TeamsWorkspace() {
  const { message } = App.useApp();
  const client = useGatewayStore(s => s.client);
  const connected = useGatewayStore(s => s.state) === 'connected';
  const renderedSessionKey = useChatStore(s => s.sessionKey);
  const switchSession = useSessionsStore(s => s.switchSession);
  const [data, setData] = useState<Snapshot>({ teams: [], conversations: [] });
  const [teamId, setTeamId] = useState('');
  const [conversationId, setConversationId] = useState('');
  const [memberId, setMemberId] = useState('');
  const [privateMemoryOpen,setPrivateMemoryOpen] = useState(false);
  const [privateMemories,setPrivateMemories] = useState<Array<{id:string;text:string;revision:number}>>([]);
  const [privateNote,setPrivateNote] = useState('');
  const [referenceSource,setReferenceSource]=useState<string|null>(null);
  const [chatMode,setChatMode] = useState('group');
  const [inheritMemory,setInheritMemory] = useState(true);
  const [showArchived,setShowArchived] = useState(false);
  const [moveFolder,setMoveFolder] = useState<string|null>(null);
  const [renaming,setRenaming] = useState<string|null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<Team | null>(null);
  const [newTitle, setNewTitle] = useState<string | null>(null);
  const [form] = Form.useForm();
  const configuredMembers = Form.useWatch('members', form) as Member[] | undefined;
  const team = data.teams.find(t => t.id === teamId);
  const conversation = data.conversations.find(c => c.id === conversationId && c.teamId === teamId);
  const member = conversation?.members.find(m => m.id === memberId);
  const sessionKey = member && conversation?.sessions[member.id];
  async function request<T,>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (!client?.isConnected) throw new Error('网关未连接');
    return client.request<T>(method, params);
  }
  async function refresh() {
    const next = await request<Snapshot>('rc.team.list');
    setData(next);
    return next;
  }
  useEffect(() => {
    let active = true;
    setLoading(true);
    if (!connected) { setLoading(false); return () => { active = false; }; }
    request<Snapshot>('rc.team.list').then(next => {
      if (!active) return;
      setData(next); setError('');
      const saved = localStorage.getItem('rc-team-selection');
      let choice: { teamId: string; conversationId: string; memberId: string } | null = null;
      try { choice = saved ? JSON.parse(saved) : null; } catch { /* Ignore obsolete local preferences. */ }
      setTeamId(next.teams.some(t => t.id === choice?.teamId) ? choice!.teamId : next.teams[0]?.id ?? '');
      if (choice && next.conversations.some(c => c.id === choice.conversationId && c.teamId === choice.teamId && c.sessions[choice.memberId])) {
        setConversationId(choice.conversationId); setMemberId(choice.memberId);
      }
    }).catch(e => { if (active) setError(teamRequestError(e)); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [client, connected]);
  useEffect(() => {
    if (sessionKey && chatMode === 'private') switchSession(sessionKey);
  }, [sessionKey, chatMode, switchSession]);
  useEffect(() => {
    if (!sessionKey) return;
    localStorage.setItem('rc-team-selection', JSON.stringify({ teamId, conversationId, memberId }));
  }, [sessionKey, teamId, conversationId, memberId]);
  async function mutate(action: () => Promise<void>) {
    setBusy(true); setError('');
    try { await action(); } catch (e) { setError(teamRequestError(e)); } finally { setBusy(false); }
  }
  function selectConversation(c: Conversation) {
    setConversationId(c.id); setMemberId(c.coordinatorId);
  }
  if (loading) return <Spin style={{ margin: 'auto' }} />;
  return <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
    <Space wrap style={{ padding: 12, borderBottom: '1px solid var(--border)' }}>
      <Typography.Text strong>科研群组</Typography.Text>
      <Button onClick={() => { switchSession(MAIN_SESSION_KEY); useTeamsStore.getState().setOpen(false); }}>返回普通会话</Button>
      <Button loading={busy} disabled={!connected} onClick={() => void mutate(async () => {
        const created = await request<Team>('rc.team.create');
        await refresh(); setTeamId(created.id); setConversationId(''); setMemberId('');
      })}>新建默认团队</Button>
      <Select aria-label="选择科研团队" value={teamId || undefined} style={{ width: 180 }} options={data.teams.filter(t=>showArchived||!t.archived).sort((a,b)=>Number(!!b.pinned)-Number(!!a.pinned)).map(t => ({ value: t.id, label: (t.pinned?'★ ':'')+(t.folder?t.folder+' / ':'')+t.name+(t.archived?'（已归档）':'') }))} onChange={id => { setTeamId(id); setConversationId(''); setMemberId(''); }} />
      <Checkbox checked={showArchived} onChange={e=>setShowArchived(e.target.checked)}>显示归档</Checkbox>
      {team && <>
        <Button onClick={()=>void mutate(async()=>{await request('rc.team.organize',{id:team.id,pinned:!team.pinned});await refresh();})}>{team.pinned?'取消置顶':'置顶'}</Button>
        <Button onClick={()=>setMoveFolder(team.folder||'')}>移入分组</Button>
        <Button onClick={()=>void mutate(async()=>{await request('rc.team.organize',{id:team.id,archived:!team.archived});await refresh();setTeamId('');setConversationId('');})}>{team.archived?'恢复团队':'归档团队'}</Button>
        <Button onClick={() => { setEditing(team); form.setFieldsValue(team); }}>配置团队</Button>
        <Button type="primary" disabled={!connected} onClick={() => setNewTitle('新会话')}>新会话</Button>
      </>}
    </Space>
    <Alert type="info" showIcon message="群聊协作与成员私聊分别保存" description="群内可 @成员，或选择协作推进。私聊不会自动带入群聊。工具授权和文件访问范围沿用科研龙虾现有设置。" />
    {error && <Alert type="error" showIcon message="操作未完成" description={error} action={<Button onClick={() => void mutate(async () => { await refresh(); })}>重新加载</Button>} />}
    <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
      <div style={{ width: 200, padding: 12, overflowY: 'auto', borderRight: '1px solid var(--border)' }}>
        <Typography.Text strong>群内会话</Typography.Text>
        {data.conversations.filter(c => c.teamId === teamId).map(c => <Button key={c.id} block type={c.id === conversationId ? 'primary' : 'text'} style={{ marginTop: 6, overflow: 'hidden' }} onClick={() => selectConversation(c)}>{c.title}</Button>)}
        <Typography.Paragraph type="secondary" style={{ marginTop: 16 }}>新会话不自动带入旧聊天。文献库和工作区仍为现有共享资源。</Typography.Paragraph>
      </div>
      <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        {conversation ? <>
          <Space wrap style={{ padding: 12 }}>
            <Typography.Text strong>{conversation.title}</Typography.Text>
            <Segmented value={chatMode} onChange={v=>setChatMode(String(v))} options={[{label:'共享群聊',value:'group'},{label:'成员私聊',value:'private'}]}/>
            {chatMode==='private'&&<Button onClick={()=>void mutate(async()=>{setPrivateMemories(await request('rc.team.memory.list',{teamId,memberId}));setPrivateMemoryOpen(true);})}>成员私有记忆</Button>}
            <Button onClick={()=>setReferenceSource('')}>引用已有会话</Button>
            <Button onClick={()=>setRenaming(conversation.title)}>重命名</Button>
            <Popconfirm title="删除群内记录？" description="先停止或处理所有任务。已有磁盘成果和原始执行日志保留。" onConfirm={()=>void mutate(async()=>{await request('rc.team.conversation.delete',{id:conversation.id});await refresh();setConversationId('');})}><Button danger>删除会话</Button></Popconfirm>
            {chatMode === 'private' && <>
              <Select aria-label="选择对话成员" value={memberId} style={{ width: 180 }} options={conversation.members.map(m => ({ value: m.id, label: m.name }))} onChange={setMemberId} />
              <Typography.Text type="secondary">AI 成员 · {member?.model || '使用科研龙虾默认模型'}</Typography.Text>
            </>}
          </Space>
          {chatMode==='private' && member && <Typography.Paragraph style={{ padding: '0 12px', marginBottom: 8 }}>{member.instructions}</Typography.Paragraph>}
          {chatMode==='group' ? <div style={{flex:1,minHeight:0}}><GroupChat key={conversation.id} conversationId={conversation.id} teamId={teamId} members={conversation.members} coordinatorId={conversation.coordinatorId} workflow={conversation.workflow}/></div> : sessionKey && <div style={{ flex: 1, minHeight: 0 }}>{normalizeSessionKey(renderedSessionKey) === normalizeSessionKey(sessionKey) ? <ChatView key={sessionKey} /> : <Spin />}</div>}
        </> : <div style={{ padding: 24, overflowY: 'auto' }}>
          {team ? <>
            <Typography.Title level={4}>{team.name}</Typography.Title>
            <Typography.Paragraph>{team.description || '选择一场会话，或新建一个独立研究主题。'}</Typography.Paragraph>
            {team.members.map(m => <Card key={m.id} size="small" title={m.name + (m.id === team.coordinatorId ? ' · 协调者' : '')} style={{ marginBottom: 8 }}>{m.instructions}</Card>)}
          </> : <Empty description="先创建默认科研团队：院士 AI、教授 AI、小导师 AI、科研龙虾" />}
        </div>}
      </div>
    </div>
    <Modal title="新建独立会话" open={newTitle !== null} confirmLoading={busy} onCancel={() => setNewTitle(null)} onOk={() => void mutate(async () => {
      const c = await request<Conversation>('rc.team.conversation.create', { teamId, title: newTitle, inheritMemory });
      await refresh(); selectConversation(c); setNewTitle(null);
    })}>
      <Input aria-label="会话名称" maxLength={120} value={newTitle ?? ''} onChange={e => setNewTitle(e.target.value)} />
      <Typography.Paragraph>沿用团队配置快照，聊天上下文从空白开始。</Typography.Paragraph>
      <Checkbox checked={inheritMemory} onChange={e=>setInheritMemory(e.target.checked)}>本次使用群组共享记忆</Checkbox>
    </Modal>
    <Modal title="显式引用已有群聊" open={referenceSource!==null} onCancel={()=>setReferenceSource(null)} onOk={()=>void mutate(async()=>{await request('rc.team.conversation.reference',{targetId:conversationId,sourceId:referenceSource});setReferenceSource(null);})}>
      <Typography.Paragraph>将所选会话最近十条已发布群消息复制到当前群聊。成员私聊和私有记忆不会被引用；此操作不会自动调用模型。</Typography.Paragraph>
      <Select aria-label="选择引用来源" value={referenceSource||undefined} style={{width:'100%'}} options={data.conversations.filter(c=>c.teamId===teamId&&c.id!==conversationId).map(c=>({value:c.id,label:c.title}))} onChange={setReferenceSource}/>
    </Modal>
    <Modal title="成员私有记忆" open={privateMemoryOpen} onCancel={()=>setPrivateMemoryOpen(false)} footer={null}>
      <Typography.Paragraph>只用于该成员的私聊，不会自动带入群聊。仅保存你明确提交的内容。</Typography.Paragraph>
      {privateMemories.map(m=><Card key={m.id} size="small" style={{marginBottom:8}}><Typography.Paragraph>{m.text}</Typography.Paragraph><Popconfirm title="删除这条私有记忆？" onConfirm={()=>void mutate(async()=>{await request('rc.team.memory.delete',{teamId,memberId,id:m.id});setPrivateMemories(await request('rc.team.memory.list',{teamId,memberId}));})}><Button danger size="small">删除</Button></Popconfirm></Card>)}
      <Input.TextArea value={privateNote} onChange={e=>setPrivateNote(e.target.value)} rows={3} maxLength={4000}/>
      <Button disabled={!privateNote.trim()} onClick={()=>void mutate(async()=>{await request('rc.team.memory.save',{teamId,memberId,text:privateNote});setPrivateMemories(await request('rc.team.memory.list',{teamId,memberId}));setPrivateNote('');})}>保存私有记忆</Button>
    </Modal>
    <Modal title="移动到分组" open={moveFolder!==null} onCancel={()=>setMoveFolder(null)} onOk={()=>void mutate(async()=>{await request('rc.team.organize',{id:teamId,folder:moveFolder});await refresh();setMoveFolder(null);})}><Input value={moveFolder??''} onChange={e=>setMoveFolder(e.target.value)} placeholder="分组名称；留空移回根目录"/></Modal>
    <Modal title="重命名会话" open={renaming!==null} onCancel={()=>setRenaming(null)} onOk={()=>void mutate(async()=>{await request('rc.team.conversation.rename',{id:conversationId,title:renaming});await refresh();setRenaming(null);})}><Input value={renaming??''} onChange={e=>setRenaming(e.target.value)} maxLength={120}/></Modal>
    <Modal title="团队与角色配置" open={!!editing} width={720} confirmLoading={busy} onCancel={() => setEditing(null)} onOk={() => void mutate(async () => {
      const values = await form.validateFields();
      await request('rc.team.update', { id: editing!.id, revision: editing!.revision, team: values });
      await refresh(); setEditing(null); void message.success('已保存，新会话使用更新后的配置');
    })}>
      <Form form={form} layout="vertical">
        <Form.Item name="name" label="团队名称" rules={[{ required: true, whitespace: true, max: 120 }]}><Input maxLength={120} /></Form.Item>
        <Form.Item name="description" label="课题说明"><Input.TextArea maxLength={8000} rows={2} /></Form.Item>
        <Form.Item name="coordinatorId" label="协调者" rules={[{ required: true }]}><Select options={(configuredMembers ?? []).map(m => ({ value: m.id, label: m.name || '未命名角色' }))} /></Form.Item>
        <Form.List name="workflow">{(steps,{add,remove})=><Card size="small" title="协作推进顺序（最多八步）">{steps.map(step=><Space key={step.key} align="start"><Form.Item name={step.name} rules={[{required:true}]}><Select style={{width:180}} options={(configuredMembers??[]).map(m=>({value:m.id,label:m.name}))}/></Form.Item><Button onClick={()=>remove(step.name)}>移除步骤</Button></Space>)}<Button disabled={steps.length>=8} onClick={()=>add()}>添加步骤</Button></Card>}</Form.List>
        <Form.List name="members">{(fields, { add, remove }) => <>
          {fields.map(field => <Card key={field.key} size="small" style={{ marginBottom: 8 }}>
            <Space align="start">
              <Form.Item name={[field.name, 'id']} hidden rules={[{ required: true, pattern: /^[a-zA-Z0-9_-]+$/ }]}><Input maxLength={64} /></Form.Item>
              <Form.Item name={[field.name, 'name']} label="名字" rules={[{ required: true, whitespace: true }]}><Input maxLength={80} /></Form.Item>
              <Button onClick={() => remove(field.name)}>移除配置项</Button>
            </Space>
            <Form.Item name={[field.name, 'model']} label="模型（留空使用科研龙虾默认模型）"><Input placeholder="服务商/模型标识" maxLength={200} /></Form.Item>
            <Form.Item name={[field.name, 'instructions']} label="职责" rules={[{ required: true, whitespace: true }]}><Input.TextArea rows={2} maxLength={8000} /></Form.Item>
          </Card>)}
          <Button onClick={() => add({ id: 'role-' + crypto.randomUUID().slice(0, 8), name: '', instructions: '' })}>添加 AI 角色</Button>
        </>}</Form.List>
      </Form>
      <Typography.Paragraph type="secondary">协调者必须是团队成员。已有会话保留原职责快照和记录。</Typography.Paragraph>
    </Modal>
  </div>;
}
