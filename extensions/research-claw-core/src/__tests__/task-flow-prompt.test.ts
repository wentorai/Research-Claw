import { describe, expect, it } from 'vitest';

import {
  ACCEPTANCE_ABORTED_PREDECESSOR_MESSAGES,
  ACCEPTANCE_SUBAGENT_COMPLETION_PROMPT,
} from '../__fixtures__/long-run-incidents.js';
import {
  buildTaskFlowAgentGuidance,
  findLatestAutoLongTaskJobId,
  TASK_FLOW_AGENT_GUIDANCE,
} from '../tasks/task-flow-prompt.js';

describe('TASK_FLOW_AGENT_GUIDANCE', () => {
  it('separates exploratory literature search from library writes', () => {
    expect(TASK_FLOW_AGENT_GUIDANCE).toContain('exploratory requests');
    expect(TASK_FLOW_AGENT_GUIDANCE).toContain('library_add_paper');
    expect(TASK_FLOW_AGENT_GUIDANCE).toContain('library_batch_add');
    expect(TASK_FLOW_AGENT_GUIDANCE).toContain('入库');
    expect(TASK_FLOW_AGENT_GUIDANCE).toContain('找一下');
    expect(TASK_FLOW_AGENT_GUIDANCE).toContain('ask before adding');
    expect(TASK_FLOW_AGENT_GUIDANCE).toContain('specialized research method');
    expect(TASK_FLOW_AGENT_GUIDANCE).toContain('skill_load` exactly one');
    expect(TASK_FLOW_AGENT_GUIDANCE).toContain('exact query `skill_search`');
    expect(TASK_FLOW_AGENT_GUIDANCE).toContain('do not read generic SKILL.md files first');
  });

  it('keeps inferred long work in the foreground unless background execution was explicit or confirmed', () => {
    expect(TASK_FLOW_AGENT_GUIDANCE).toContain('explicitly requested background');
    expect(TASK_FLOW_AGENT_GUIDANCE).toContain('[Research-Claw] Auto Long Task');
    expect(TASK_FLOW_AGENT_GUIDANCE).toContain('keep the run in the foreground');
    expect(TASK_FLOW_AGENT_GUIDANCE).not.toContain('If work may exceed one agent turn, create');
    expect(TASK_FLOW_AGENT_GUIDANCE).not.toMatch(/\bETA\b|percentage|percent complete/i);
  });

  it('treats a cancelled durable Job as an absorbing user Stop across gateway recovery', () => {
    expect(TASK_FLOW_AGENT_GUIDANCE).toContain('call `job_status` before resuming');
    expect(TASK_FLOW_AGENT_GUIDANCE).toContain('status is `cancelled`');
    expect(TASK_FLOW_AGENT_GUIDANCE).toContain('do not resume it');
    expect(TASK_FLOW_AGENT_GUIDANCE).toContain('do not replace it with another subagent');
    expect(TASK_FLOW_AGENT_GUIDANCE).toContain('do not continue the cancelled work in the foreground');
  });

  it('binds a real OC subagent completion announcement to its exact Job instead of an aborted predecessor', () => {
    expect(findLatestAutoLongTaskJobId([...ACCEPTANCE_ABORTED_PREDECESSOR_MESSAGES])).toBe(
      'longtask:eeda758f-1a98-430c-9899-3c534a45c1b9',
    );

    const guidance = buildTaskFlowAgentGuidance({
      prompt: ACCEPTANCE_SUBAGENT_COMPLETION_PROMPT,
      messages: [...ACCEPTANCE_ABORTED_PREDECESSOR_MESSAGES],
    });

    expect(guidance).toContain('only to Job ID `longtask:eeda758f-1a98-430c-9899-3c534a45c1b9`');
    expect(guidance).toContain('"the original task" means only the exact user request carrying this Job ID');
    expect(guidance).toContain('`stopReason: aborted`');
    expect(guidance).toContain('Never reinterpret, resume, or call tools for it');
    expect(guidance).toContain('do not call `job_finish` again');
    expect(guidance).toContain('Do not call tools unrelated to this Job');
  });

  it('does not inject a stale Job boundary into an ordinary user turn', () => {
    expect(
      buildTaskFlowAgentGuidance({
        prompt: '普通的新用户请求',
        messages: [...ACCEPTANCE_ABORTED_PREDECESSOR_MESSAGES],
      }),
    ).toBe(TASK_FLOW_AGENT_GUIDANCE);
  });

  it('keeps foreground process waits in the same chat run instead of forcing a Job', () => {
    expect(TASK_FLOW_AGENT_GUIDANCE).toContain(
      'For foreground work, continue the same run with OpenClaw-bounded `process.poll` calls',
    );
    expect(TASK_FLOW_AGENT_GUIDANCE).toContain(
      'Never create a detached Job merely because an `exec` command is still running',
    );
    expect(TASK_FLOW_AGENT_GUIDANCE).toContain(
      'Do not start the same command again while its process session is active',
    );
    expect(TASK_FLOW_AGENT_GUIDANCE).not.toContain(
      'Never block on a background process with a long `process.poll`',
    );
  });
});
