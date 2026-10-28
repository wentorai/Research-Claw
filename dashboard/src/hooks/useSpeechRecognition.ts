import { useCallback, useEffect, useRef, useState } from 'react';

// Keep the experimental browser API local rather than augmenting global DOM types.
export interface SpeechResultEvent {
  results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }>;
}
export interface BrowserSpeechRecognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onstart: (() => void) | null;
  onresult: ((event: SpeechResultEvent) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
type SpeechConstructor = new () => BrowserSpeechRecognition;
type Phase = 'idle' | 'starting' | 'listening' | 'stopping';

function constructor(): SpeechConstructor | undefined {
  const browser = window as unknown as {
    SpeechRecognition?: SpeechConstructor;
    webkitSpeechRecognition?: SpeechConstructor;
  };
  return browser.SpeechRecognition ?? browser.webkitSpeechRecognition;
}

export function useSpeechRecognition(sessionKey: string, onCommit: (text: string) => void, disabled = false) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [preview, setPreview] = useState('');
  const [error, setError] = useState<string | null>(null);
  const current = useRef<{ recognition: BrowserSpeechRecognition; sessionKey: string } | null>(null);
  const scope = useRef(sessionKey);
  scope.current = sessionKey;
  const blocked = useRef(disabled);
  blocked.current = disabled;
  const commit = useRef(onCommit);
  commit.current = onCommit;
  const timer = useRef<ReturnType<typeof setTimeout>>();

  const cancel = useCallback(() => {
    const run = current.current;
    current.current = null;
    clearTimeout(timer.current);
    if (run) {
      run.recognition.onstart = run.recognition.onresult = run.recognition.onerror = run.recognition.onend = null;
      try { run.recognition.abort(); } catch { /* Already ended. */ }
    }
    setPhase('idle');
    setPreview('');
  }, []);

  useEffect(() => {
    setError(null);
    return cancel;
  }, [sessionKey, cancel]);
  useEffect(() => { if (disabled) cancel(); }, [disabled, cancel]);
  useEffect(() => {
    window.addEventListener('pagehide', cancel);
    return () => window.removeEventListener('pagehide', cancel);
  }, [cancel]);

  const start = useCallback(() => {
    const Constructor = constructor();
    if (!Constructor || current.current || blocked.current || scope.current !== sessionKey) return;
    setError(null);
    setPreview('');
    let recognition: BrowserSpeechRecognition;
    try { recognition = new Constructor(); } catch { setError('unavailable'); return; }
    const run = { recognition, sessionKey };
    current.current = run;
    const valid = () => current.current === run && scope.current === run.sessionKey;
    let finalText = '';
    const fail = (code: string) => {
      if (!valid()) return;
      cancel();
      setError(code);
    };
    recognition.lang = 'zh-CN';
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.onstart = () => {
      if (!valid()) return;
      clearTimeout(timer.current);
      setPhase((previous) => previous === 'stopping' ? previous : 'listening');
    };
    recognition.onresult = (event) => {
      if (!valid()) return;
      // Results are a cumulative list, not a delta. Rebuild to avoid duplicates.
      const results = Array.from(event.results);
      finalText = results.filter((result) => result.isFinal).map((result) => result[0].transcript).join('');
      setPreview(results.map((result) => result[0].transcript).join(''));
    };
    recognition.onerror = (event) => fail(event.error);
    recognition.onend = () => {
      if (!valid()) return;
      const transcript = finalText.trim();
      cancel();
      if (transcript) commit.current(transcript);
      else setError('no-speech');
    };
    setPhase('starting');
    timer.current = setTimeout(() => fail('timeout'), 15_000);
    try { recognition.start(); } catch { fail('unavailable'); }
  }, [sessionKey, disabled, cancel]);

  const stop = useCallback(() => {
    const run = current.current;
    if (!run || run.sessionKey !== scope.current) return;
    setPhase('stopping');
    clearTimeout(timer.current);
    // A broken implementation must not leave Send permanently disabled.
    timer.current = setTimeout(() => { cancel(); setError('timeout'); }, 15_000);
    try { run.recognition.stop(); } catch { cancel(); setError('unavailable'); }
  }, [cancel]);

  return { supported: Boolean(constructor()), phase, active: phase !== 'idle', preview, error, start, stop, cancel };
}
