import React from 'react';
import { App } from 'antd';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import GroupChat from './GroupChat';
const mock=vi.hoisted(()=>({request:vi.fn()}));
vi.mock('../../stores/gateway',()=>{const client={isConnected:true,request:mock.request};return {useGatewayStore:(s:(x:unknown)=>unknown)=>s({client,state:'connected'})};});
vi.mock('../MarkdownBody',()=>({default:({children}:{children:string})=><div>{children}</div>}));
const state={messages:[],tasks:[],memories:[]};
function mount(){return render(<App><GroupChat conversationId="c" teamId="t" coordinatorId="mentor" members={[{id:'mentor',name:'小导师 AI',instructions:'plan'}]}/></App>);}
beforeEach(()=>{vi.clearAllMocks();localStorage.clear();sessionStorage.clear();mock.request.mockResolvedValue(state);});
afterEach(cleanup);
describe('GroupChat',()=>{
 it('loads shared messages without loading private chat history or starting inference',async()=>{
  mount();await waitFor(()=>expect(mock.request).toHaveBeenCalledWith('rc.team.group.state',{conversationId:'c'}));
  expect(mock.request.mock.calls.every(call=>call[0]==='rc.team.group.state')).toBe(true);
  expect(screen.getByLabelText('群组消息')).toBeInTheDocument();
 });
 it('queues a user message and lets the backend own completion state',async()=>{
  mount();await screen.findByText(/提出课题需求/);
  fireEvent.change(screen.getByLabelText('群组消息'),{target:{value:'评估论文'}});
  fireEvent.click(screen.getByRole('button',{name:/发送/}));
  await waitFor(()=>expect(mock.request).toHaveBeenCalledWith('rc.team.message.send',expect.objectContaining({conversationId:'c',memberId:'mentor',text:'评估论文',requestId:expect.any(String),collaborate:false})));
  expect(screen.queryByText('已完成')).not.toBeInTheDocument();
 });
 it('reuses an idempotency key after an uncertain acknowledgement and remount',async()=>{
  mock.request.mockImplementation(async(method:string)=>{if(method==='rc.team.message.send')throw Error('connection closed');return state;});
  const first = mount();await screen.findByText(/提出课题需求/);
  fireEvent.change(screen.getByLabelText('群组消息'),{target:{value:'只发送一次'}});
  fireEvent.click(screen.getByRole('button',{name:/发送/}));await screen.findByText('connection closed');
  first.unmount();
  mount();
  fireEvent.click(screen.getByRole('button',{name:/发送/}));
  await waitFor(()=>expect(mock.request.mock.calls.filter(c=>c[0]==='rc.team.message.send')).toHaveLength(2));
  const sends=mock.request.mock.calls.filter(c=>c[0]==='rc.team.message.send');
  expect(sends[0][1].requestId).toBe(sends[1][1].requestId);
 });
 it('shows a decision control for an actual waiting task',async()=>{
  mock.request.mockResolvedValue({...state,tasks:[{id:'w',memberId:'mentor',status:'waiting_user'}]});
  mount();await screen.findByRole('button',{name:'回答并继续'});
  expect(screen.getByText('等待你决定')).toBeInTheDocument();
 });
});
