/**
 * Dual Model Supervisor — Memory Guardian (before/after_compaction hooks)
 *
 * Protects key information from being lost during context compaction,
 * and detects + recovers lost memory after compaction.
 */

import type { MemoryItem, MemoryLossItem, SupervisorConfig, PluginLogger, SessionState } from '../core/types.js';
import { ReviewerClient } from '../client/reviewer.js';
import { AuditLogService } from '../core/audit-log.js';
import { KEY_MEMORY_IDENTIFICATION_PROMPT, MEMORY_LOSS_DETECTION_PROMPT } from '../core/prompts.js';
import { isMemoryGuardActive } from '../core/config.js';
import { messageContentToPlainText, truncateMessagePlainText } from '../utils/message-content.js';
import { findMatchingSummary } from '../utils/summary-matcher.js';
import { validateKeyMemoryItems, validateMemoryLossItems } from '../core/validators.js';

export class MemoryGuardian {
  private config: SupervisorConfig;
  private logger: PluginLogger;
  private reviewerClient: ReviewerClient;
  private auditLog: AuditLogService;

  constructor(
    config: SupervisorConfig,
    logger: PluginLogger,
    reviewerClient: ReviewerClient,
    auditLog: AuditLogService,
  ) {
    this.config = config;
    this.logger = logger;
    this.reviewerClient = reviewerClient;
    this.auditLog = auditLog;
  }

  /** Hot-reload updated config from the dashboard without re-instantiating. */
  updateConfig(config: SupervisorConfig): void {
    this.config = config;
  }

  async beforeCompaction(
    messages: Array<{ role: string; content: unknown }>,
    sessionId: string,
    sessionState: SessionState,
  ): Promise<{ messages?: Array<{ role: string; content: unknown }> }> {
    if (!isMemoryGuardActive(this.config)) return {};

    try {
      const conversationText = messages
        .filter((m) => m.role === 'user' || m.role === 'assistant')
        .slice(-20)
        .map((m) => `[${m.role}]: ${truncateMessagePlainText(m.content, 12_000)}`)
        .join('\n\n');

      const userContent = `<user_content>\n${conversationText}\n</user_content>`;
      const raw = await this.reviewerClient.review<Record<string, unknown>>(
        KEY_MEMORY_IDENTIFICATION_PROMPT,
        userContent,
      );

      const keyItems = validateKeyMemoryItems(raw);
      sessionState.preCompactionMemory = keyItems;

      if (keyItems.length > 0) {
        const memoryNote = {
          role: 'system' as const,
          content: `[Supervisor Memory Anchor] The following critical information MUST NOT be forgotten:\n${
            keyItems.map((k) => `- [${k.category}] ${k.summary}`).join('\n')
          }`,
        };

        this.auditLog.record({
          sessionId,
          type: 'memory_guard',
          action: 'info',
          details: `Injected ${keyItems.length} memory anchors before compaction`,
          metadata: JSON.stringify(keyItems.map((k) => ({ category: k.category, summary: k.summary }))),
          timestamp: Date.now(),
        });

        return { messages: [...messages, memoryNote] };
      }

      return {};
    } catch (err) {
      this.logger.error(`Memory guardian before_compaction failed: ${err instanceof Error ? err.message : String(err)}`);
      return {};
    }
  }

  /**
   * After compaction: compare original vs compacted messages to detect information loss.
   * When structured summaries are available, uses them for richer comparison.
   * Critical/high-importance lost items are stored in `sessionState.lostMemorySummary`
   * for injection in the next prompt cycle. Also restores research goal, key conclusions,
   * user preferences, and methodology decisions from pre-compaction snapshots.
   */
  async afterCompaction(
    original: Array<{ role: string; content: unknown }>,
    compacted: Array<{ role: string; content: unknown }>,
    sessionId: string,
    sessionState: SessionState,
  ): Promise<void> {
    if (!isMemoryGuardActive(this.config)) return;

    try {
      const hasSummaries = sessionState.recentSummaries.length > 0;

      let originalText: string;
      let compactedText: string;

      if (hasSummaries) {
        const originalParts: string[] = [];
        for (const msg of original.filter((m) => m.role === 'user' || m.role === 'assistant')) {
          if (msg.role === 'user') {
            originalParts.push(`[user]: ${truncateMessagePlainText(msg.content, 800)}`);
          } else {
            const summary = findMatchingSummary(messageContentToPlainText(msg.content), sessionState.recentSummaries);
            if (summary) {
              const summaryStr = [
                summary.claims.length > 0 ? `Claims: ${summary.claims.join('; ')}` : '',
                summary.decisions.length > 0 ? `Decisions: ${summary.decisions.join('; ')}` : '',
                summary.references.length > 0 ? `Refs: ${summary.references.join('; ')}` : '',
              ].filter(Boolean).join(' | ');
              originalParts.push(`[assistant]: ${summaryStr}`);
            } else {
              originalParts.push(`[assistant]: ${truncateMessagePlainText(msg.content, 500)}`);
            }
          }
        }
        originalText = originalParts.join('\n');

        compactedText = compacted
          .filter((m) => m.role === 'user' || m.role === 'assistant')
          .map((m) => `[${m.role}]: ${truncateMessagePlainText(m.content, 500)}`)
          .join('\n');
      } else {
        originalText = original
          .filter((m) => m.role === 'user' || m.role === 'assistant')
          .map((m) => `[${m.role}]: ${truncateMessagePlainText(m.content, 200)}`)
          .join('\n');

        compactedText = compacted
          .filter((m) => m.role === 'user' || m.role === 'assistant')
          .map((m) => `[${m.role}]: ${truncateMessagePlainText(m.content, 200)}`)
          .join('\n');
      }

      const userContent = `<user_content>\n## Original Messages\n${originalText}\n\n## Compacted Messages\n${compactedText}\n</user_content>`;

      const raw = await this.reviewerClient.review<Record<string, unknown>>(
        MEMORY_LOSS_DETECTION_PROMPT,
        userContent,
      );

      const lostItems = validateMemoryLossItems(raw);

      if (lostItems.length > 0) {
        sessionState.lostMemorySummary = lostItems
          .filter((item) => item.importance !== 'medium')
          .map((item) => `- [${item.category}] ${item.content}`)
          .join('\n');

        this.auditLog.record({
          sessionId,
          type: 'memory_guard',
          action: 'warn',
          details: `Compaction lost ${lostItems.length} items (${lostItems.filter((i) => i.importance === 'critical').length} critical)`,
          metadata: JSON.stringify(lostItems),
          timestamp: Date.now(),
        });

        this.logger.warn(
          `[MemoryGuard] Compaction lost ${lostItems.length} items: ${
            lostItems.map((i) => `${i.category}(${i.importance})`).join(', ')
          }`,
        );
      }

      const keyConclusions: string[] = [];
      const userPreferences: string[] = [];
      const methodologyDecisions: string[] = [];
      let researchGoal: string | undefined;

      for (const item of sessionState.preCompactionMemory) {
        switch (item.category) {
          case 'research_goal': researchGoal = item.summary; break;
          case 'key_conclusion': keyConclusions.push(item.summary); break;
          case 'user_preference': userPreferences.push(item.summary); break;
          case 'methodology_decision': methodologyDecisions.push(item.summary); break;
        }
      }

      if (researchGoal) sessionState.researchGoal = researchGoal;
      if (keyConclusions.length > 0) sessionState.keyConclusions = keyConclusions;
      if (userPreferences.length > 0) sessionState.userPreferences = userPreferences;
      if (methodologyDecisions.length > 0) sessionState.methodologyDecisions = methodologyDecisions;
    } catch (err) {
      this.logger.error(`Memory guardian after_compaction failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
