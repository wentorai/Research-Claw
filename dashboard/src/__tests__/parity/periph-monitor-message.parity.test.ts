/**
 * Behavioral Parity Tests: buildMonitorCronMessage — device branch + non-regression
 *
 * Verifies:
 *   1. device monitor → message contains periph_camera_snap/{target} references
 *      and check_prompt substitution (custom + default)
 *   2. device branch does NOT contain the 6-step EXECUTION PROTOCOL collector header
 *      (feed/api/code path only; device uses dedicated vision protocol)
 *   3. feed/api monitor output is byte-for-byte identical after the device branch
 *      is added (non-regression snapshot lock)
 *
 * Source references:
 *   - Plugin template:
 *       extensions/research-claw-core/src/monitor/service.ts → defaultAgentPrompt('device')
 *   - Dashboard replacement logic:
 *       stores/monitor.ts → buildMonitorCronMessage (device branch)
 *
 * T8 authority (from session notes):
 *   Template placeholders:
 *     {target}            — replaced with monitor.target (device_id)
 *     {check_prompt ...}  — entire placeholder replaced with monitor.filters.check_prompt
 *                           or the in-template default: "描述画面中正在发生什么,判断是否存在异常。"
 *
 * feed/api snapshots captured from the CURRENT (pre-T16) buildMonitorCronMessage output.
 */

import { describe, it, expect } from 'vitest';
import type { Monitor } from '../../stores/monitor';

// ── Import the internal helper via the module's exported bundle ───────────────
// buildMonitorCronMessage is NOT exported; we test it indirectly through
// a thin test-only re-export.  To avoid touching the source for testing,
// we replicate a reference implementation here and then verify parity with
// the actual implementation by calling it through testBuildMonitorCronMessage.
import { testBuildMonitorCronMessage } from '../../stores/monitor';

// ── Fixture helpers ────────────────────────────────────────────────────────────

function makeMonitor(overrides: Partial<Monitor>): Monitor {
  return {
    id: 'mon-test',
    name: 'Test Monitor',
    source_type: 'feed',
    target: 'https://example.com/feed.xml',
    filters: {},
    schedule: '0 8 * * *',
    enabled: true,
    notify: true,
    agent_prompt: 'Fetch the RSS feed and report new items.',
    gateway_job_id: 'gw-job-001',
    last_check_at: null,
    last_results: null,
    last_error: null,
    check_count: 0,
    finding_count: 0,
    created_at: '2026-07-01T00:00:00.000Z',
    updated_at: '2026-07-01T00:00:00.000Z',
    ...overrides,
  };
}

// ── Device monitor fixtures ────────────────────────────────────────────────────

// Device template stored in agent_prompt (from defaultAgentPrompt('device') in service.ts)
// Source: extensions/research-claw-core/src/monitor/service.ts
// NOTE: representative mirror — feeds buildMonitorCronMessage to test its
// {target}/{monitor_id}/{check_prompt} substitution. Kept in sync with the real
// defaultAgentPrompt('device') placeholders (service.ts). monitor_report now uses
// the real schema (monitor_id/results/fingerprints — no top-level title=).
const DEVICE_AGENT_PROMPT_TEMPLATE =
  '你是外设定时查证代理。目标设备 ID: {target}。本监控 ID: {monitor_id}。\n' +
  '0. 调用 periph_list 检查 camera_bridge.online。online=false 时:periph_observe 记录 verdict=\'missed\'、monitor_id=\'{monitor_id}\',然后 monitor_report({"monitor_id":"{monitor_id}","results":[],"fingerprints":[]}) 结束。online=true 才继续。\n' +
  '1. 调用 periph_camera_snap({"device_id":"{target}","purpose":"scheduled check","monitor_id":"{monitor_id}"}) 抓取当前帧。\n' +
  '4. 调用 periph_observe 记录 kind=\'check\'、monitor_id=\'{monitor_id}\'。\n' +
  '5. 调用 monitor_report({"monitor_id":"{monitor_id}","results":[{"title":结论一句话}],"fingerprints":[frame_path]})。\n' +
  '查证要求: {check_prompt 或 "描述画面中正在发生什么,判断是否存在异常。"}';

const DEVICE_MONITOR_WITH_CUSTOM_PROMPT: Monitor = makeMonitor({
  id: 'cam-lab-001',
  name: 'Lab Camera Monitor',
  source_type: 'device',
  target: 'dev-cam-001',
  filters: { check_prompt: '判断实验台是否整洁,有无危险品裸露。' },
  schedule: '*/30 * * * *',
  agent_prompt: DEVICE_AGENT_PROMPT_TEMPLATE,
});

const DEVICE_MONITOR_NO_CUSTOM_PROMPT: Monitor = makeMonitor({
  id: 'cam-lab-002',
  name: 'Corridor Camera',
  source_type: 'device',
  target: 'dev-cam-002',
  filters: {},
  schedule: '*/5 * * * *',
  agent_prompt: DEVICE_AGENT_PROMPT_TEMPLATE,
});

// ── Feed monitor fixture (for non-regression snapshot) ────────────────────────

const FEED_MONITOR: Monitor = makeMonitor({
  id: 'rss-001',
  name: 'RSS Feed Monitor',
  source_type: 'feed',
  target: 'https://huggingface.co/blog/feed.xml',
  filters: { keywords: [] },
  schedule: '0 8 * * *',
  agent_prompt: 'Fetch the RSS feed at the target URL.\nReport new entries.',
});

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('buildMonitorCronMessage — device branch', () => {
  describe('target substitution', () => {
    it('replaces {monitor_id} with the monitor id and uses real monitor_report schema (audit #3/P2-O1)', () => {
      const msg = testBuildMonitorCronMessage(DEVICE_MONITOR_WITH_CUSTOM_PROMPT);
      // Every {monitor_id} placeholder is substituted with the monitor's id.
      expect(msg).not.toContain('{monitor_id}');
      expect(msg).toContain('"monitor_id":"cam-lab-001"');
      // monitor_report is called with the real schema, never a top-level title= arg.
      expect(msg).toContain('"results"');
      expect(msg).toContain('"fingerprints"');
      expect(msg).not.toMatch(/monitor_report[^\n]*上报本轮结果\(title=/);
    });

    it('replaces all {target} occurrences with monitor.target (custom check_prompt)', () => {
      const msg = testBuildMonitorCronMessage(DEVICE_MONITOR_WITH_CUSTOM_PROMPT);
      // Both {target} placeholders must be filled
      expect(msg).not.toContain('{target}');
      expect(msg).toContain('dev-cam-001');
      // device_id argument in periph_camera_snap call
      expect(msg).toContain('"device_id":"dev-cam-001"');
      // Header line
      expect(msg).toContain('目标设备 ID: dev-cam-001');
    });

    it('replaces all {target} occurrences for monitor without custom check_prompt', () => {
      const msg = testBuildMonitorCronMessage(DEVICE_MONITOR_NO_CUSTOM_PROMPT);
      expect(msg).not.toContain('{target}');
      expect(msg).toContain('dev-cam-002');
      expect(msg).toContain('"device_id":"dev-cam-002"');
    });
  });

  describe('check_prompt substitution', () => {
    it('replaces {check_prompt ...} placeholder with custom check_prompt from filters', () => {
      // Source: DEVICE_MONITOR_WITH_CUSTOM_PROMPT.filters.check_prompt = '判断实验台是否整洁...'
      const msg = testBuildMonitorCronMessage(DEVICE_MONITOR_WITH_CUSTOM_PROMPT);
      // Entire placeholder (including default text) must be replaced
      expect(msg).not.toMatch(/\{check_prompt[^}]*\}/);
      expect(msg).toContain('判断实验台是否整洁,有无危险品裸露。');
      // Must NOT contain the template's default fallback text
      expect(msg).not.toContain('描述画面中正在发生什么,判断是否存在异常。');
    });

    it('falls back to in-template default when filters.check_prompt is empty/absent', () => {
      const msg = testBuildMonitorCronMessage(DEVICE_MONITOR_NO_CUSTOM_PROMPT);
      // Placeholder replaced with template default
      expect(msg).not.toMatch(/\{check_prompt[^}]*\}/);
      expect(msg).toContain('描述画面中正在发生什么,判断是否存在异常。');
    });

    it('falls back to default when filters.check_prompt is an empty string', () => {
      const monitor: Monitor = {
        ...DEVICE_MONITOR_WITH_CUSTOM_PROMPT,
        filters: { check_prompt: '' },
      };
      const msg = testBuildMonitorCronMessage(monitor);
      expect(msg).not.toMatch(/\{check_prompt[^}]*\}/);
      expect(msg).toContain('描述画面中正在发生什么,判断是否存在异常。');
    });
  });

  describe('device branch does NOT include collector EXECUTION PROTOCOL', () => {
    it('device message contains no EXECUTION PROTOCOL header', () => {
      const msg = testBuildMonitorCronMessage(DEVICE_MONITOR_WITH_CUSTOM_PROMPT);
      expect(msg).not.toContain('EXECUTION PROTOCOL (mandatory, follow every step)');
      expect(msg).not.toContain('monitor_collect_candidates');
      expect(msg).not.toContain('monitor_get_context');
    });

    it('device message contains periph_camera_snap tool call reference', () => {
      const msg = testBuildMonitorCronMessage(DEVICE_MONITOR_WITH_CUSTOM_PROMPT);
      expect(msg).toContain('periph_camera_snap');
      expect(msg).toContain('periph_observe');
      expect(msg).toContain('monitor_report');
    });

    it('device message contains standard RC monitor header lines', () => {
      const msg = testBuildMonitorCronMessage(DEVICE_MONITOR_WITH_CUSTOM_PROMPT);
      expect(msg).toContain('[Research-Claw Monitor Scheduled Run]');
      expect(msg).toContain('MONITOR_ID: cam-lab-001');
      expect(msg).toContain('MONITOR_NAME: Lab Camera Monitor');
      expect(msg).toContain('SOURCE_TYPE: device');
      expect(msg).toContain('TARGET: dev-cam-001');
    });
  });

  describe('non-regression: feed monitor output unchanged', () => {
    it('feed monitor message still contains EXECUTION PROTOCOL header', () => {
      // The device branch must NOT alter feed monitor output
      const msg = testBuildMonitorCronMessage(FEED_MONITOR);
      // Current (pre-T16) structure: 6-step EXECUTION PROTOCOL via "Stored monitor agent prompt"
      expect(msg).toContain('[Research-Claw Monitor Scheduled Run]');
      expect(msg).toContain('SOURCE_TYPE: feed');
      expect(msg).toContain('Stored monitor agent prompt:');
      expect(msg).toContain('Fetch the RSS feed at the target URL.');
      // The standard protocol lines must still be present
      expect(msg).toContain('Tool boundary: use monitor_get_context');
      expect(msg).toContain('monitor_collect_candidates');
    });

    it('feed monitor message has exact MONITOR_ID header', () => {
      const msg = testBuildMonitorCronMessage(FEED_MONITOR);
      expect(msg).toContain('MONITOR_ID: rss-001');
      expect(msg).toContain('MONITOR_NAME: RSS Feed Monitor');
      expect(msg).toContain('TARGET: https://huggingface.co/blog/feed.xml');
    });
  });

  // ── P1-R1 (SPEC:378, §13.4): report/reminder Tool boundary exemption ────────
  // The seed prompts require workspace_save / task_list:
  //   weekly-report:  extensions/research-claw-core/src/monitor/service.ts:202-209
  //   daily-reminder: extensions/research-claw-core/src/monitor/service.ts:220-227
  // The strict boundary ("Do not call ... workspace_* or other task/workspace
  // tools") would forbid the monitor's own stored prompt, so report/reminder get
  // a relaxed boundary via a source_type branch (same approach as device).

  describe('P1-R1: report/reminder monitors get a relaxed Tool boundary', () => {
    const REPORT_MONITOR: Monitor = makeMonitor({
      id: 'weekly-report',
      name: 'Weekly Progress Report',
      source_type: 'report',
      target: '',
      schedule: '0 17 * * 5',
      // Real seed prompt: monitor/service.ts:202-209
      agent_prompt:
        'Generate a weekly research progress report covering the past 7 days. Include: ' +
        '1) Papers added/read this week (use library_search). ' +
        '2) Tasks completed and in-progress (use task_list). ' +
        '3) Key findings or notes added. ' +
        '4) Suggested focus areas for next week. ' +
        'Save the report to workspace: workspace_save("outputs/reports/weekly-YYYY-MM-DD.md", ...). ' +
        'Send a brief notification with send_notification.',
    });

    const REMINDER_MONITOR: Monitor = makeMonitor({
      id: 'daily-reminder',
      name: 'Daily Task Reminder',
      source_type: 'reminder',
      target: '',
      schedule: '0 9 * * *',
      // Real seed prompt: monitor/service.ts:220-227
      agent_prompt:
        'Check for tasks due within 24 hours using task_list with deadline filter. ' +
        'Also check for overdue tasks. ' +
        'Send a notification with send_notification summarizing: ' +
        '- Number of overdue tasks (if any, list titles). ' +
        '- Tasks due today. ' +
        '- Top 3 priority tasks for the day. ' +
        'Keep the notification concise (under 200 chars for title).',
    });

    it('report monitor message no longer bans workspace_*/task tools', () => {
      const msg = testBuildMonitorCronMessage(REPORT_MONITOR);
      // The strict prohibition must be gone…
      expect(msg).not.toContain('Do not call read, task_flow_stage, workspace_*');
      // …replaced by an explicit allowance for the tools the seed prompt requires
      expect(msg).toContain(
        'You may also call the workspace/task/library tools the stored monitor agent prompt requires (e.g. workspace_save, task_list).',
      );
      // Seed prompt itself still delivered verbatim
      expect(msg).toContain('Stored monitor agent prompt:');
      expect(msg).toContain('workspace_save("outputs/reports/weekly-YYYY-MM-DD.md", ...)');
    });

    it('reminder monitor message no longer bans workspace_*/task tools', () => {
      const msg = testBuildMonitorCronMessage(REMINDER_MONITOR);
      expect(msg).not.toContain('Do not call read, task_flow_stage, workspace_*');
      expect(msg).toContain(
        'You may also call the workspace/task/library tools the stored monitor agent prompt requires (e.g. workspace_save, task_list).',
      );
      expect(msg).toContain('task_list with deadline filter');
    });

    it('report/reminder keep the numbered protocol and monitor bookkeeping tools', () => {
      const msg = testBuildMonitorCronMessage(REPORT_MONITOR);
      expect(msg).toContain('You are executing a scheduled monitor. Follow this exact protocol:');
      expect(msg).toContain('monitor_get_context');
      expect(msg).toContain('monitor_report');
      expect(msg).toContain('send_notification');
      expect(msg).toContain('MONITOR_ID: weekly-report');
      expect(msg).toContain('SOURCE_TYPE: report');
    });

    it('feed/api/code monitors keep the strict Tool boundary (non-regression)', () => {
      const msg = testBuildMonitorCronMessage(FEED_MONITOR);
      expect(msg).toContain(
        'Tool boundary: use monitor_get_context, monitor_collect_candidates, monitor_report, monitor_note, and send_notification only. Do not call read, task_flow_stage, workspace_* or other task/workspace tools for this scheduled monitor.',
      );
    });
  });

  describe('non-regression: arbitrary non-device monitor passes through unchanged', () => {
    it('code/api monitor retains all protocol lines in agent_prompt section', () => {
      const apiMonitor: Monitor = makeMonitor({
        id: 'api-mon',
        source_type: 'api',
        target: 'https://api.example.com/data',
        agent_prompt: 'Call the API and report new entries.',
      });
      const msg = testBuildMonitorCronMessage(apiMonitor);
      expect(msg).toContain('Stored monitor agent prompt:');
      expect(msg).toContain('Call the API and report new entries.');
      expect(msg).not.toContain('periph_camera_snap');
    });
  });

  // ── Byte-lock: full-text snapshot for a representative feed monitor (Fix 2) ──
  // Hard-coded from a single live run of testBuildMonitorCronMessage(FEED_MONITOR).
  // This is NOT a self-referential test: the expected string is inlined verbatim
  // and must NOT be regenerated automatically.  Any deviation from this text
  // (even whitespace) means the cron message format has changed and needs review.

  describe('byte-lock snapshot: feed monitor full output', () => {
    it('FEED_MONITOR output matches verbatim expected string', () => {
      const msg = testBuildMonitorCronMessage(FEED_MONITOR);
      const expected =
        '[Research-Claw Monitor Scheduled Run]\n' +
        'MONITOR_ID: rss-001\n' +
        'MONITOR_NAME: RSS Feed Monitor\n' +
        'SOURCE_TYPE: feed\n' +
        'TARGET: https://huggingface.co/blog/feed.xml\n' +
        'You are executing a scheduled monitor. Follow this exact protocol:\n' +
        'Tool boundary: use monitor_get_context, monitor_collect_candidates, monitor_report, monitor_note, and send_notification only. Do not call read, task_flow_stage, workspace_* or other task/workspace tools for this scheduled monitor.\n' +
        '1. CONTEXT: call monitor_get_context with {"monitor_id":"rss-001"}.\n' +
        '2. COLLECT: call monitor_collect_candidates with {"monitor_id":"rss-001"} to gather raw source candidates in the core collector layer.\n' +
        '3. ANALYZE: inspect/filter the collected candidates against the monitor goal. Only use browser/search if the collector reports errors or lacks enough context.\n' +
        '4. REPORT: call monitor_report with monitor_id="rss-001", final results, and the exact fingerprint values returned by monitor_collect_candidates for accepted candidates; do not invent date-based or summary-based fingerprints.\n' +
        '5. OBSERVE: call monitor_note with monitor_id="rss-001" if source reliability, errors, or useful patterns should be remembered.\n' +
        '6. NOTIFY: if the context says notify=true and monitor_report found new items, call send_notification.\n' +
        '\n' +
        'Stored monitor agent prompt:\n' +
        'Fetch the RSS feed at the target URL.\n' +
        'Report new entries.';
      expect(msg).toBe(expected);
    });
  });
});
