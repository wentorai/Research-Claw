export const OAUTH_PROVIDER_IDS = ['openai-codex', 'google-gemini-cli'] as const;

export function isOAuthProvider(id: string): boolean {
  return OAUTH_PROVIDER_IDS.includes(id as (typeof OAUTH_PROVIDER_IDS)[number]);
}

export function oauthProviderLabel(id: string): string {
  switch (id) {
    case 'openai-codex':
      return 'OpenAI Codex (ChatGPT)';
    case 'google-gemini-cli':
      return 'Google Gemini';
    default:
      return id;
  }
}
