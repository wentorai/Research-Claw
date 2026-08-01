const TITLE_MAX_CHARS = 40;
// Reasoning models spend part of maxTokens on chain-of-thought before emitting
// content. The title is still hard-capped by sanitizeTitle below.
const LLM_MAX_TOKENS = 2048;

/** First non-empty line, label/quotes/trailing punctuation stripped, capped at 40 chars (word-aware for Latin). */
export function sanitizeTitle(raw: string): string {
  const firstLine = raw
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0) ?? '';
  const unquoted = firstLine
    .replace(/^\s*(?:标题|title|会话标题|session title)\s*[:：]\s*/i, '')
    .replace(/^["'“”‘’《【\s]+/, '')
    .replace(/["'“”‘’》】\s]+$/, '')
    .replace(/[。．.!！?？,，;；:：]+$/, '')
    .trim();
  if (unquoted.length <= TITLE_MAX_CHARS) return unquoted;
  const capped = unquoted.slice(0, TITLE_MAX_CHARS);
  const cutsMidWord = /\S/.test(unquoted.charAt(TITLE_MAX_CHARS));
  const lastSpace = capped.lastIndexOf(' ');
  if (cutsMidWord && lastSpace > 0) return capped.slice(0, lastSpace).trim();
  return capped.trim();
}

export interface SessionNamingLlmParams {
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  model?: string;
  maxTokens?: number;
  temperature?: number;
  systemPrompt?: string;
  signal?: AbortSignal;
  purpose?: string;
  agentId?: string;
}

export interface SessionNamingLlmResult {
  text: string;
}

export interface SessionNamingOptions {
  /** Host-owned completion path: resolves the configured model and live auth. */
  runtimeComplete?: (params: SessionNamingLlmParams) => Promise<SessionNamingLlmResult>;
}

export class SessionNamingService {
  private readonly runtimeComplete?: SessionNamingOptions['runtimeComplete'];

  constructor(options: SessionNamingOptions = {}) {
    this.runtimeComplete = options.runtimeComplete;
  }

  async generateTitle(input: { userText: string; assistantText: string }): Promise<string> {
    if (!this.runtimeComplete) {
      throw new Error('Research-Claw LLM runtime is unavailable for session naming');
    }

    // The language rule is stated first so the title follows the user's
    // language, not the assistant response or bilingual framing.
    const prompt = [
      'Generate one short title for the conversation below. / 为下面的对话生成一个简短标题。',
      '',
      'Rules / 要求:',
      "1. Write the title in the SAME language as the User's message. If the user wrote Chinese, the title MUST be Chinese; if English, English. / 标题语言必须与下面“用户”消息的语言一致(用户用中文则标题用中文,用英文则用英文),不要跟随助手的语言。",
      '2. Summarize the user\'s topic or intent — at most 6 English words or 15 Chinese characters. / 概括用户的主题或意图,最多 6 个英文单词或 15 个汉字。',
      '3. Output ONLY the title text — no quotes, punctuation, labels, prefixes, or explanation. / 只输出标题本身,不要引号、标点、前缀(如“标题:”)或任何解释。',
      '',
      `User / 用户: ${input.userText}`,
      `Assistant / 助手: ${input.assistantText}`,
    ].join('\n');

    const result = await this.runtimeComplete({
      messages: [{ role: 'user', content: prompt }],
      maxTokens: LLM_MAX_TOKENS,
      temperature: 0,
      purpose: 'research-claw:session-auto-name',
    });
    const title = sanitizeTitle(result.text ?? '');
    if (!title) throw new Error('Session naming model returned an empty title');
    return title;
  }
}
