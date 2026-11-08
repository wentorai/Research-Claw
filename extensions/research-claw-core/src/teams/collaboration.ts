import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { TeamService, TeamConversation } from './service.js';
import type { JobService } from '../jobs/service.js';

export type WorkStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'unknown' | 'blocked' | 'stopping' | 'waiting_user';
export interface GroupMessage { id: string; conversationId: string; sender: 'user' | 'agent' | 'system'; memberId?: string; text: string; createdAt: string; taskId?: string; requestId?: string }
export interface GroupWork { id: string; conversationId: string; memberId: string; requestId: string; prompt: string; status: WorkStatus; sessionKey: string; jobId?: string; dependsOn?: string; result?: string; error?: string; usage?: unknown; createdAt: string; context?: { messageId?: string; requestId: string; createdAt?: string } }
export interface SharedMemory { id: string; teamId: string; text: string; revision: number; memberId?: string }
export interface GroupRuntime {
  run: (work: GroupWork, prompt: string, model?: string) => Promise<{ text: string; usage?: unknown }>;
  abort: (work: GroupWork) => Promise<boolean>;
}
function required(value: unknown, max = 16000): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error('内容为空或超出长度限制');
  return value.trim();
}
const pendingStatuses = ['queued', 'running', 'stopping', 'unknown', 'waiting_user'];
const inFlightStatuses = ['running', 'stopping', 'unknown'];

export class CollaborationService {
  private active = new Map<string, GroupWork>();
  private timer?: ReturnType<typeof setInterval>;
  constructor(private db: Database.Database, private teams: TeamService, private runtime: GroupRuntime, private jobs?: JobService) {
    db.exec(`CREATE TABLE IF NOT EXISTS rc_team_messages (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES rc_team_conversations(id), payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS rc_team_work (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES rc_team_conversations(id), request_id TEXT NOT NULL, payload TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_rc_team_work_conversation ON rc_team_work(conversation_id);
      CREATE INDEX IF NOT EXISTS idx_rc_team_message_conversation ON rc_team_messages(conversation_id);
      CREATE INDEX IF NOT EXISTS idx_rc_team_work_status ON rc_team_work(json_extract(payload, '$.status'));
      CREATE TABLE IF NOT EXISTS rc_team_shared_memory (id TEXT PRIMARY KEY, team_id TEXT NOT NULL REFERENCES rc_research_teams(id), payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS rc_team_request_keys (conversation_id TEXT NOT NULL, request_id TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(conversation_id,request_id));`);
  }
  // Called only by the gateway service lifecycle, never by CLI/discovery registration.
  recoverInterrupted() {
    for (const work of this.pendingWork().filter(w => ['running', 'stopping'].includes(w.status))) {
      const error = '网关进程重启，执行结果待确认；不会自动重复执行。';
      this.db.transaction(() => {
        this.saveWork({ ...work, status: 'unknown', error });
        this.updateJob(work, (jobs, id) => jobs.finish(id, 'partial', undefined, error));
      })();
    }
  }
  conversation(id: string): TeamConversation {
    const row = this.db.prepare('SELECT payload FROM rc_team_conversations WHERE id=?').get(id) as {payload: string} | undefined;
    if (!row) throw new Error('会话不存在');
    return JSON.parse(row.payload);
  }
  private workById(id: string): GroupWork | undefined {
    const row = this.db.prepare('SELECT payload FROM rc_team_work WHERE id=?').get(id) as { payload: string } | undefined;
    return row && JSON.parse(row.payload);
  }
  private conversationWork(id: string): GroupWork[] {
    const rows = this.db.prepare('SELECT payload FROM rc_team_work WHERE conversation_id=? ORDER BY rowid').all(id) as { payload: string }[];
    return rows.map(row => JSON.parse(row.payload));
  }
  private pendingWork(): GroupWork[] {
    const rows = this.db.prepare(
      "SELECT payload FROM rc_team_work WHERE json_extract(payload, '$.status') IN (?, ?, ?, ?, ?) ORDER BY rowid",
    ).all(...pendingStatuses) as { payload: string }[];
    return rows.map(row => JSON.parse(row.payload));
  }
  private saveWork(work: GroupWork) {
    this.db.prepare('UPDATE rc_team_work SET payload=? WHERE id=?').run(JSON.stringify(work), work.id);
  }
  private updateJob(work: GroupWork, update: (jobs: JobService, id: string) => void) {
    // Jobs can be pruned independently of the durable group execution record.
    if (work.jobId && this.jobs?.has(work.jobId)) update(this.jobs, work.jobId);
  }
  private message(message: Omit<GroupMessage, 'id' | 'createdAt'>) {
    const row = { ...message, id: randomUUID(), createdAt: new Date().toISOString() };
    this.db.prepare('INSERT INTO rc_team_messages VALUES (?, ?, ?)').run(row.id, row.conversationId, JSON.stringify(row));
    return row;
  }
  state(conversationId: string) {
    const conversation = this.conversation(conversationId);
    const messages = (this.db.prepare('SELECT payload FROM rc_team_messages WHERE conversation_id=? ORDER BY rowid').all(conversationId) as {payload: string}[]).map(r => JSON.parse(r.payload) as GroupMessage);
    return { conversation, messages, tasks: this.conversationWork(conversationId), memories: this.memories(conversation.teamId) };
  }
  submit(
    input: { conversationId: string; requestId: string; text: string; memberId?: string; collaborate?: boolean; supplementTo?: string },
    continuation?: GroupWork,
  ) {
    return this.db.transaction(() => {
      const conversation = this.conversation(input.conversationId);
      const requestId = required(input.requestId, 120);
      const prior = this.db.prepare('SELECT payload FROM rc_team_request_keys WHERE conversation_id=? AND request_id=?').get(conversation.id, requestId) as {payload: string} | undefined;
      if (prior) {
        const result = JSON.parse(prior.payload) as { taskIds: string[]; answerFor?: string; supplementTo?: string };
        if (result.answerFor !== continuation?.id || result.supplementTo !== input.supplementTo) {
          throw new Error('请求标识已用于其他操作');
        }
        return result;
      }
      const body = required(input.text);
      const pending = this.conversationWork(conversation.id).filter(w => pendingStatuses.includes(w.status));
      if (input.supplementTo) {
        const target = pending.find(w => w.id === input.supplementTo && w.status === 'queued');
        if (!target) throw new Error('所选步骤已开始或结束，请选择仍在排队的步骤');
        this.message({
          conversationId: conversation.id, sender: 'user', text: body,
          requestId: target.context?.requestId ?? target.requestId,
        });
        const result = { taskIds: [], supplementTo: target.id };
        this.db.prepare('INSERT INTO rc_team_request_keys VALUES (?, ?, ?)').run(conversation.id, requestId, JSON.stringify(result));
        return result;
      }
      let memberId = input.memberId || conversation.coordinatorId;
      const mention = body.match(/^@([^\s，,:：]+)[\s，,:：]/u)?.[1];
      if (mention) {
        const found = conversation.members.find(m => m.id === mention || m.name.replace(/\s+AI$/, '') === mention || m.name === mention);
        if (!found) throw new Error('未找到 @ 的成员，请从成员列表选择');
        memberId = found.id;
      }
      if (!conversation.members.some(m => m.id === memberId)) throw new Error('成员不属于当前会话');
      // The bounded workflow is explicit in the UI; every stage is real execution.
      const pipeline = input.collaborate && !mention
        ? (conversation.workflow ?? [conversation.coordinatorId, 'academician', 'professor', 'researchclaw', 'professor', conversation.coordinatorId]).filter(id => conversation.members.some(m => m.id === id))
        : [memberId];
      if (!pipeline.length || pipeline.length > 8) throw new Error('协作流程需要 1–8 个有效步骤');
      if (pending.length + pipeline.length - Number(!!continuation) > 40) {
        throw new Error('当前会话待处理任务过多，请先完成或停止已有任务');
      }
      const contextRequestId = continuation?.context?.requestId ?? continuation?.requestId ?? requestId;
      const message = this.message({ conversationId: conversation.id, sender: 'user', text: body, requestId: contextRequestId });
      const context = continuation
        ? continuation.context ?? { createdAt: continuation.createdAt, requestId: contextRequestId }
        : { messageId: message.id, requestId: contextRequestId };
      const taskIds: string[] = [];
      pipeline.forEach((owner, index) => {
        const id = randomUUID();
        const work: GroupWork = { id, conversationId: conversation.id, requestId, memberId: owner, prompt: continuation?.prompt ?? body,
          status: 'queued', sessionKey: 'agent:main:rc-team-work-' + id,
          dependsOn: taskIds.at(-1), createdAt: new Date().toISOString(), context };
        if (pipeline.length > 1) work.prompt += '\n本轮阶段：' + (index + 1) + '/' + pipeline.length + '。结合群内前序结果，按你的职责推进；最后阶段负责汇总交付。不要重复执行已完成的实验。';
        if (this.jobs) work.jobId = this.jobs.create({ type: 'research-team', title: conversation.members.find(m => m.id === owner)!.name + '：' + body.slice(0, 50), session_key: work.sessionKey, input: { conversationId: conversation.id, memberId: owner, requestId } }).id;
        this.db.prepare('INSERT INTO rc_team_work VALUES (?, ?, ?, ?)').run(id, conversation.id, requestId, JSON.stringify(work));
        this.db.prepare('INSERT INTO rc_team_session_bindings VALUES (?, ?, ?)').run(work.sessionKey, conversation.id, owner);
        taskIds.push(id);
      });
      const result = { taskIds, ...(continuation ? { answerFor: continuation.id } : {}) };
      this.db.prepare('INSERT INTO rc_team_request_keys VALUES (?, ?, ?)').run(conversation.id, requestId, JSON.stringify(result));
      return result;
    })();
  }
  start(onError: (error: unknown) => void) {
    if (this.timer) return;
    this.recoverInterrupted();
    this.timer = setInterval(() => { void this.tick().catch(onError); }, 500);
    this.timer.unref?.();
  }
  async tick() {
    if (this.active.size >= 1) return;
    const pending = this.pendingWork();
    // An unknown worker may still be running: hold its conversation until user resolves it.
    for (const work of pending.filter(w => w.status === 'queued')) {
      if (pending.some(w => w.conversationId === work.conversationId && ['running', 'unknown', 'stopping', 'waiting_user'].includes(w.status))) continue;
      const dependency = work.dependsOn && this.workById(work.dependsOn);
      if (dependency && dependency.status !== 'completed') {
        if (['failed','cancelled','blocked'].includes(dependency.status)) {
          this.db.transaction(() => {
            this.saveWork({ ...work, status: 'blocked', error: '前序步骤未成功，等待重新发起任务' });
            this.updateJob(work, (jobs, id) => jobs.finish(id, 'failed', undefined, '前序步骤未成功'));
          })();
        }
        continue;
      }
      this.active.set(work.id, work);
      try {
        await this.execute(work);
      } finally {
        this.active.delete(work.id);
      }
      return;
    }
  }
  private contextMessages(work: GroupWork): GroupMessage[] {
    // Older persisted tasks have no message boundary. Use their creation time
    // and keep their own workflow results even when those were published later.
    const rows = this.db.prepare(`
      SELECT m.payload FROM rc_team_messages m
      WHERE m.conversation_id = ? AND (
        m.rowid <= (SELECT rowid FROM rc_team_messages WHERE id = ?)
        OR (? IS NULL AND json_extract(m.payload, '$.createdAt') < ?)
        OR json_extract(m.payload, '$.requestId') = ?
        OR json_extract(m.payload, '$.taskId') IN (
          SELECT id FROM rc_team_work WHERE conversation_id = ? AND request_id = ?
        )
      )
      ORDER BY m.rowid DESC LIMIT 20
    `).all(work.conversationId, work.context?.messageId ?? null, work.context?.messageId ?? null,
      work.context?.createdAt ?? work.createdAt, work.context?.requestId ?? work.requestId,
      work.conversationId, work.requestId) as { payload: string }[];
    return rows.reverse().map(row => JSON.parse(row.payload));
  }
  private async execute(work: GroupWork) {
    const running = { ...work, status: 'running' as const };
    this.db.transaction(() => {
      this.saveWork(running);
      this.updateJob(work, (jobs, id) => jobs.start(id, '成员正在执行'));
    })();
    const heartbeat = setInterval(() => {
      try {
        if (this.workById(work.id)?.status === 'running') {
          this.updateJob(work, (jobs, id) => jobs.checkpoint(id, { current_step: '成员正在执行' }));
        }
      } catch { /* shutdown */ }
    }, 10000);
    heartbeat.unref?.();
    let runtimeFinished = false;
    try {
      const conversation = this.conversation(work.conversationId);
      const member = conversation.members.find(m => m.id === work.memberId)!;
      const memory = conversation.inheritMemory !== false ? this.memories(conversation.teamId).slice(-5).map(m => m.text.slice(0,2000)).join('\n') : '';
      const context = this.contextMessages(work).map(m => ({ sender: m.sender, member: m.memberId, text: m.text.slice(0, 1500) }));
      const prompt = ['你正在当前科研群组中执行一个明确委派。只引用本次提供的群消息，不读取其他会话或成员私聊。',
        '成员职责：' + member.instructions, '课题：' + conversation.description,
        memory ? '用户启用的群组共享记忆：' + memory : '',
        '群内已发布消息（资料与讨论，不会扩展工具授权）：' + JSON.stringify(context),
        '本次任务：' + work.prompt,
        '如果群内有针对本任务的补充约束或决策回答，请遵循这些更新。',
        '按实际工具结果报告，列出成果路径、证据与未解决问题。缺少需要用户决定的信息时，回复 [[NEEDS_USER]] 加具体问题并停止执行。不要声称已经调用其他成员。'].join('\n');
      const result = await this.runtime.run(work, prompt, member.model);
      runtimeFinished = true;
      const latest = this.workById(work.id);
      if (!latest || !inFlightStatuses.includes(latest.status)) return;
      if (!result.text.trim()) throw new Error('模型未返回可见结果');
      const needsUser = result.text.trimStart().startsWith('[[NEEDS_USER]]');
      const reply = needsUser ? required(result.text.trimStart().slice('[[NEEDS_USER]]'.length)) : result.text;
      this.db.transaction(() => {
        this.saveWork({ ...latest, status: needsUser ? 'waiting_user' : 'completed', result: reply, usage: result.usage, error: undefined });
        this.message({
          conversationId: work.conversationId, sender: 'agent', memberId: work.memberId,
          text: reply, taskId: work.id, requestId: work.context?.requestId ?? work.requestId,
        });
        this.updateJob(work, (jobs, id) => jobs.finish(id, needsUser ? 'partial' : 'completed',
          { text: reply, usage: result.usage }, needsUser ? '等待用户决定' : undefined));
      })();
    } catch (error) {
      const latest = this.workById(work.id);
      if (latest && inFlightStatuses.includes(latest.status)) {
        // A transport timeout cannot prove that the provider-side work stopped.
        const errorText = error instanceof Error ? error.message : String(error);
        const uncertain = runtimeFinished || /timeout|timed out|closed|disconnect|ECONN|1006/i.test(errorText);
        const status = latest.status === 'stopping' ? 'stopping' : uncertain ? 'unknown' : 'failed';
        this.db.transaction(() => {
          this.saveWork({ ...latest, status, error: errorText.slice(0, 1000) });
          if (status === 'stopping') return; // The abort RPC owns the next transition.
          this.message({ conversationId: work.conversationId, sender: 'system', text: status === 'unknown' ? '成员执行状态待确认，请先核对运行结果，再停止或重试。' : '成员执行失败：' + errorText.slice(0, 500), taskId: work.id });
          this.updateJob(work, (jobs, id) => jobs.finish(id, status === 'unknown' ? 'partial' : 'failed', undefined, errorText.slice(0, 1000)));
        })();
      }
    } finally { clearInterval(heartbeat); }
  }
  async cancel(id: string) {
    const work = this.workById(id);
    if (!work) throw new Error('任务不存在');
    if (!pendingStatuses.includes(work.status) || work.status === 'stopping') return work;
    let latest = work;
    if (work.status === 'running' || work.status === 'unknown') {
      this.saveWork({ ...work, status: 'stopping' });
      let aborted = false;
      try {
        aborted = await this.runtime.abort(work);
      } catch {
        // A transport failure is also an unconfirmed stop.
      }
      const current = this.workById(id);
      if (!current || current.status !== 'stopping') return current;
      latest = current;
      if (!aborted) {
        const unknown: GroupWork = { ...latest, status: 'unknown', error: '网关未确认中止，请检查原执行记录' };
        return this.db.transaction(() => {
          this.saveWork(unknown);
          this.updateJob(unknown, (jobs, id) => jobs.finish(id, 'partial', undefined, unknown.error));
          return unknown;
        })();
      }
    }
    const cancelled: GroupWork = { ...latest, status: 'cancelled', error: undefined };
    return this.db.transaction(() => {
      this.saveWork(cancelled);
      this.updateJob(cancelled, (jobs, id) => jobs.cancel(id));
      return cancelled;
    })();
  }
  answer(id: string, answer: string, requestId: string) {
    return this.db.transaction(()=>{
      const work = this.workById(id);
      if (!work) throw new Error('任务不存在');
      const key = required(requestId, 120);
      const prior = this.db.prepare('SELECT payload FROM rc_team_request_keys WHERE conversation_id=? AND request_id=?')
        .get(work.conversationId, key) as { payload: string } | undefined;
      if (prior) {
        const result = JSON.parse(prior.payload) as { taskIds: string[]; answerFor?: string };
        // Older versions did not store answerFor; their continuation retained
        // the answered stage's member and original prompt in the request.
        const legacy = !result.answerFor && this.workById(result.taskIds[0]);
        if (result.answerFor === id || (legacy && legacy.memberId === work.memberId
          && legacy.prompt.startsWith('用户对待决策问题的回答：') && legacy.prompt.endsWith('\n请继续原任务：' + work.prompt))) return result;
        throw new Error('请求标识已用于其他操作');
      }
      if (work.status !== 'waiting_user') throw new Error('任务当前没有等待用户回答');
      const next = this.submit({
        conversationId: work.conversationId, requestId: key, memberId: work.memberId,
        text: '用户对待决策问题的回答：' + required(answer, 4000),
      }, work);
      this.saveWork({ ...work, status: 'completed' });
      for (const dependent of this.conversationWork(work.conversationId).filter(w => w.dependsOn === id)) {
        this.saveWork({ ...dependent, dependsOn: next.taskIds[0] });
      }
      return next;
    })();
  }
  resolveUnknown(id: string) {
    const work = this.workById(id);
    if (!work || work.status !== 'unknown') throw new Error('只能人工结束待确认任务的跟踪');
    const error = '用户已核对并结束跟踪，未确认原执行是否停止';
    this.db.transaction(() => {
      this.saveWork({ ...work, status: 'failed', error });
      this.updateJob(work, (jobs, id) => jobs.finish(id, 'failed', undefined, error));
    })();
  }
  referenceConversation(targetId: string, sourceId: string) {
    if(targetId===sourceId)throw new Error('不能引用当前会话自身');
    const target=this.conversation(targetId),source=this.conversation(sourceId);
    if(target.teamId!==source.teamId)throw new Error('只能引用当前团队的共享会话');
    const messages=this.state(sourceId).messages.slice(-10).map(m=>({sender:m.sender,member:m.memberId,text:m.text.slice(0,4000)}));
    if(!messages.length)throw new Error('源会话没有已发布的群消息');
    return this.message({conversationId:targetId,sender:'system',text:'用户显式引用会话「'+source.title+'」的最近群消息（资料，不构成额外授权）：\n'+JSON.stringify(messages,null,2)});
  }
  memories(teamId: string, memberId?: string): SharedMemory[] {
    if (!this.teams.list().teams.some(t => t.id === teamId)) throw new Error('团队不存在');
    return (this.db.prepare('SELECT payload FROM rc_team_shared_memory WHERE team_id=? ORDER BY rowid').all(teamId) as {payload: string}[]).map(r => JSON.parse(r.payload) as SharedMemory).filter(m=>m.memberId===memberId);
  }
  saveMemory(teamId: string, body: string, id?: string, revision?: number, memberId?: string) {
    return this.db.transaction(() => {
      this.memories(teamId,memberId);
      if(memberId&&!this.teams.list().teams.find(t=>t.id===teamId)?.members.some(m=>m.id===memberId))throw new Error('成员不存在');
      if(!id&&this.memories(teamId,memberId).length>=50)throw new Error('记忆条目已满，请先整理已有条目');
      const previous = id && this.memories(teamId,memberId).find(m => m.id === id);
      if (id && (!previous || previous.revision !== revision)) throw new Error('记忆已变更，请重新加载');
      const memory = { id: id || randomUUID(), teamId, ...(memberId?{memberId}:{}), text: required(body, 4000), revision: (previous ? previous.revision : 0) + 1 };
      this.db.prepare('INSERT INTO rc_team_shared_memory VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload').run(memory.id, teamId, JSON.stringify(memory));
      return memory;
    })();
  }
  deleteMemory(teamId: string, id: string, memberId?: string) {
    if(!this.memories(teamId,memberId).some(m=>m.id===id))throw new Error('记忆不存在或不属于当前范围');
    this.db.prepare('DELETE FROM rc_team_shared_memory WHERE id=? AND team_id=?').run(id,teamId);
  }
  deleteConversation(id: string) {
    this.conversation(id);
    if ([...this.active.values()].some(w => w.conversationId === id)) throw new Error('执行回收尚未完成，请稍后重试');
    if (this.conversationWork(id).some(w => pendingStatuses.includes(w.status))) throw new Error('请先处理该会话的排队、运行中或待确认任务');
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM rc_team_messages WHERE conversation_id=?').run(id);
      this.db.prepare('DELETE FROM rc_team_work WHERE conversation_id=?').run(id);
      this.db.prepare('DELETE FROM rc_team_request_keys WHERE conversation_id=?').run(id);
      this.db.prepare('DELETE FROM rc_team_session_bindings WHERE conversation_id=?').run(id);
      this.db.prepare('DELETE FROM rc_team_conversations WHERE id=?').run(id);
    })();
    // Existing OC transcripts and disk artifacts are deliberately retained.
  }
}
