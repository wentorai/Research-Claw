import type { RegisterMethod } from '../types.js';
import { TeamService } from './service.js';
import type { CollaborationService } from './collaboration.js';
export function registerTeamRpc(register: RegisterMethod, service: TeamService, collaboration?: CollaborationService): void {
  register('rc.team.list', () => service.list());
  register('rc.team.create', p => service.create(p.team));
  register('rc.team.update', p => service.update(String(p.id ?? ''), Number(p.revision), p.team));
  register('rc.team.conversation.create', p => service.createConversation(String(p.teamId ?? ''), p.title, p.inheritMemory !== false));
  register('rc.team.organize', p => service.organize(String(p.id ?? ''), p));
  register('rc.team.conversation.rename', p => service.renameConversation(String(p.id ?? ''), String(p.title ?? '')));
  if (!collaboration) return;
  register('rc.team.conversation.reference', p => collaboration.referenceConversation(String(p.targetId ?? ''),String(p.sourceId ?? '')));
  register('rc.team.group.state', p => collaboration.state(String(p.conversationId ?? '')));
  register('rc.team.message.send', p => collaboration.submit({
    conversationId: String(p.conversationId ?? ''),
    requestId: String(p.requestId ?? ''),
    text: String(p.text ?? ''),
    memberId: typeof p.memberId === 'string' ? p.memberId : undefined,
    collaborate: p.collaborate === true,
    supplementTo: typeof p.supplementTo === 'string' ? p.supplementTo : undefined,
  }));
  register('rc.team.work.answer', p => collaboration.answer(String(p.id ?? ''),String(p.answer ?? ''),String(p.requestId ?? '')));
  register('rc.team.work.resolve', p => collaboration.resolveUnknown(String(p.id ?? '')));
  register('rc.team.work.cancel', p => collaboration.cancel(String(p.id ?? '')));
  register('rc.team.memory.save', p => collaboration.saveMemory(String(p.teamId ?? ''),String(p.text ?? ''),typeof p.id==='string'?p.id:undefined,typeof p.revision==='number'?p.revision:undefined,typeof p.memberId==='string'?p.memberId:undefined));
  register('rc.team.memory.delete', p => collaboration.deleteMemory(String(p.teamId ?? ''),String(p.id ?? ''),typeof p.memberId==='string'?p.memberId:undefined));
  register('rc.team.memory.list', p => collaboration.memories(String(p.teamId ?? ''),typeof p.memberId==='string'?p.memberId:undefined));
  register('rc.team.conversation.delete', p => collaboration.deleteConversation(String(p.id ?? '')));
}
