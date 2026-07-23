import { create } from 'zustand';
import { useGatewayStore } from './gateway';
import { useChatStore } from './chat';
import { useSessionsStore } from './sessions';
import { isMainSessionKey } from '../utils/session-key';
import type { ChatMessage } from '../gateway/types';

/**
 * First-run onboarding welcome — client-side gating on top of the server-side
 * rc.onboarding.status probe. Design goal: NO FALSE POSITIVES — a veteran must
 * never be greeted, so every probe failure is treated as "not first run".
 */

/** localStorage flag — the welcome card is shown at most once per computer. */
export const WELCOME_SHOWN_STORAGE_KEY = 'rc-welcome-shown';

/** localKind marker on the synthetic welcome chat message. */
export const WELCOME_LOCAL_KIND = 'welcome';

/**
 * Plain-text fallback for the welcome message — persisted to the local bucket;
 * ChatView renders the rich WelcomeCard for localKind === 'welcome' instead.
 */
export const WELCOME_FALLBACK_TEXT = '👋 欢迎使用科研龙虾 Research-Claw';

export interface OnboardingStatus {
  firstRun: boolean;
  signals: Record<string, unknown>;
}

interface OnboardingState {
  /** Server-side first-run verdict; null until fetchStatus resolves. */
  status: OnboardingStatus | null;
  /** True once maybeShowWelcome() has made its one-shot decision this lifetime. */
  evaluated: boolean;
  /** True once boot probes (loadHistory + loadSessions + fetchStatus) all resolved. */
  probesReady: boolean;

  /** Fetch rc.onboarding.status; any failure ⇒ firstRun=false (fail-safe). */
  fetchStatus: () => Promise<void>;
  /** Called by App.tsx after loadHistory + loadSessions + fetchStatus settle. */
  markProbesReady: () => void;
  /** Inject the welcome card iff EVERY first-run gate passes (at most once). */
  maybeShowWelcome: () => void;
}

const NOT_FIRST_RUN: OnboardingStatus = { firstRun: false, signals: {} };

/** Any session with a derived title, or any non-main session, means prior activity. */
function sessionsShowActivity(sessions: Array<{ key: string; derivedTitle?: string }>): boolean {
  return sessions.some(
    (s) => !isMainSessionKey(s.key) || (s.derivedTitle?.trim().length ?? 0) > 0,
  );
}

export const useOnboardingStore = create<OnboardingState>()((set, get) => ({
  status: null,
  evaluated: false,
  probesReady: false,

  fetchStatus: async () => {
    const client = useGatewayStore.getState().client;
    if (!client?.isConnected) {
      set({ status: NOT_FIRST_RUN });
      return;
    }
    try {
      const result = await client.request<{
        firstRun?: boolean;
        signals?: Record<string, unknown>;
      }>('rc.onboarding.status', {});
      set({
        status: {
          firstRun: result?.firstRun === true,
          signals: result?.signals ?? {},
        },
      });
    } catch {
      // Probe failed (old gateway without the RPC, transient error, …) — never greet.
      set({ status: NOT_FIRST_RUN });
    }
  },

  markProbesReady: () => set({ probesReady: true }),

  maybeShowWelcome: () => {
    if (get().evaluated) return;
    set({ evaluated: true });

    // Gate 1: server says this is a genuine first run.
    if (get().status?.firstRun !== true) return;

    // Gate 2: the visible session is MAIN (welcome only ever appears there).
    const chat = useChatStore.getState();
    if (!isMainSessionKey(chat.sessionKey)) return;

    // Gate 3: main chat history is empty (checked after loadHistory resolved).
    if (chat.messages.length > 0) return;

    // Gate 4: no session shows prior activity (list already excludes synthetic
    // heartbeat/subagent rows — reuse the store data, no re-fetch).
    if (sessionsShowActivity(useSessionsStore.getState().sessions)) return;

    // Gate 5: per-computer show-once flag absent. Storage failure ⇒ fail-safe skip.
    try {
      if (localStorage.getItem(WELCOME_SHOWN_STORAGE_KEY) !== null) return;
    } catch {
      return;
    }

    // Gate 6: no welcome marker already in the local-only bucket.
    if (chat._localOnlyMsgs.some((m) => m.localKind === WELCOME_LOCAL_KIND)) return;

    injectWelcomeMessage();
    try {
      localStorage.setItem(WELCOME_SHOWN_STORAGE_KEY, '1');
    } catch { /* non-fatal — duplicate protection also via the local bucket marker */ }
  },
}));

/** Append the synthetic welcome message to the current session's local bucket. */
function injectWelcomeMessage(): void {
  const welcome: ChatMessage = {
    role: 'assistant',
    text: WELCOME_FALLBACK_TEXT,
    timestamp: Date.now(),
    localKind: WELCOME_LOCAL_KIND,
  };
  useChatStore.getState().appendLocalMessage(welcome);
}

/** Drop every welcome-marker message from the current session (both arrays). */
function removeWelcomeMessages(): void {
  useChatStore.setState((s) => ({
    messages: s.messages.filter((m) => m.localKind !== WELCOME_LOCAL_KIND),
    _localOnlyMsgs: s._localOnlyMsgs.filter((m) => m.localKind !== WELCOME_LOCAL_KIND),
  }));
}

/**
 * Manual test hooks, exposed as window.__RC_WELCOME__ (same local-debugging
 * convention as window.__RC_CLIENT__ in App.tsx). Not used by product code.
 */
export const welcomeDebug = {
  /** Force-show the FULL welcome card in the current session, bypassing every
   *  gate. Also forces the server verdict to first-run so the CTA section
   *  renders even on a veteran machine / old gateway (the CTA is gated on
   *  status.firstRun — see WelcomeCard). Does NOT set the show-once flag.
   *  Replaces an existing card instead of stacking. */
  show(): string {
    useOnboardingStore.setState({
      status: { firstRun: true, signals: { __debugForced: true } },
    });
    removeWelcomeMessages();
    injectWelcomeMessage();
    return 'welcome card injected (gates bypassed, CTA forced; F5 replays the typewriter; reset() restores the real verdict)';
  },

  /** Remove the card + clear the per-computer flag + allow the natural flow to
   *  re-run. Restores the real server verdict (undoes show()'s forced one).
   *  Note: only the CURRENT session's bucket is purged — run this from the
   *  session where the card was shown (normally main). */
  reset(): string {
    removeWelcomeMessages();
    try {
      localStorage.removeItem(WELCOME_SHOWN_STORAGE_KEY);
    } catch { /* ignore */ }
    useOnboardingStore.setState({ status: null, evaluated: false });
    void useOnboardingStore.getState().fetchStatus();
    return 'welcome state reset (card removed, show-once flag cleared, server verdict re-fetched)';
  },

  /** Re-run the real decision path (all gates), then report what happened. */
  evaluate(): Record<string, unknown> {
    useOnboardingStore.setState({ evaluated: false });
    useOnboardingStore.getState().maybeShowWelcome();
    return welcomeDebug.status();
  },

  /** Live view of the server verdict and every client-side gate. */
  status(): Record<string, unknown> {
    const { status, evaluated, probesReady } = useOnboardingStore.getState();
    const chat = useChatStore.getState();
    let shownFlag: string | null | 'unreadable' = 'unreadable';
    try {
      shownFlag = localStorage.getItem(WELCOME_SHOWN_STORAGE_KEY);
    } catch { /* keep 'unreadable' */ }
    return {
      server: status,
      evaluated,
      probesReady,
      gates: {
        serverFirstRun: status?.firstRun === true,
        isMainSession: isMainSessionKey(chat.sessionKey),
        historyEmpty: chat.messages.length === 0,
        noSessionActivity: !sessionsShowActivity(useSessionsStore.getState().sessions),
        shownFlagAbsent: shownFlag === null,
        noExistingMarker: !chat._localOnlyMsgs.some((m) => m.localKind === WELCOME_LOCAL_KIND),
      },
    };
  },
};

if (typeof window !== 'undefined') {
  (window as unknown as Record<string, unknown>).__RC_WELCOME__ = welcomeDebug;
}
