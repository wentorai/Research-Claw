/**
 * Dashboard-provided system prompt append — synced from the browser via RPC
 * before each chat.send. Injected through before_prompt_build prependContext.
 */

let dashboardSystemPromptAppend = '';

export function setDashboardSystemPromptAppend(text: string): void {
  dashboardSystemPromptAppend = text.trim();
}

export function getDashboardSystemPromptAppend(): string {
  return dashboardSystemPromptAppend;
}

/** Block appended to the agent system prompt when non-empty. */
export function formatDashboardSystemPromptBlock(): string | null {
  const text = dashboardSystemPromptAppend.trim();
  if (!text) return null;
  return `[Research-Claw — user system prompt]\n${text}`;
}
