export const OAUTH_PROVIDER_IDS = [
  // OpenClaw 2026.6.1 unified the OpenAI provider id: ChatGPT OAuth lives under
  // `openai` (formerly `openai-codex`).
  'openai',
  // TODO: reserved — no preset in provider-presets.ts yet.
  // Pending Gemini CLI OAuth upstream support in OpenClaw.
  // Do NOT add a preset until the gateway `rc.oauth.initiate` handler
  // supports this provider; otherwise the OAuth flow will fail at runtime.
  'google-gemini-cli',
] as const;

export function isOAuthProvider(id: string): boolean {
  return OAUTH_PROVIDER_IDS.includes(id as (typeof OAUTH_PROVIDER_IDS)[number]);
}

export function oauthProviderLabel(id: string): string {
  switch (id) {
    case 'openai':
      return 'OpenAI ChatGPT (OAuth)';
    case 'google-gemini-cli':
      // TODO: reserved — update label when Gemini CLI OAuth is implemented
      return 'Google Gemini CLI';
    default:
      return id;
  }
}
