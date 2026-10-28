import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useSpeechRecognition, type BrowserSpeechRecognition, type SpeechResultEvent } from './useSpeechRecognition';

class Recognition implements BrowserSpeechRecognition {
  static instances: Recognition[] = [];
  lang = '';
  continuous = true;
  interimResults = false;
  onstart: BrowserSpeechRecognition['onstart'] = null;
  onresult: BrowserSpeechRecognition['onresult'] = null;
  onerror: BrowserSpeechRecognition['onerror'] = null;
  onend: BrowserSpeechRecognition['onend'] = null;
  start = vi.fn();
  stop = vi.fn();
  abort = vi.fn();
  constructor() { Recognition.instances.push(this); }
}
function setup() {
  Recognition.instances = [];
  vi.stubGlobal('SpeechRecognition', Recognition);
  const commit = vi.fn();
  const hook = renderHook(({ session, disabled }) => useSpeechRecognition(session, commit, disabled), {
    initialProps: { session: 'a', disabled: false },
  });
  act(() => hook.result.current.start());
  return { ...hook, commit, recognition: Recognition.instances[0] };
}
function results(...parts: Array<[string, boolean]>): SpeechResultEvent {
  return { results: parts.map(([transcript, isFinal]) => ({ isFinal, 0: { transcript } })) };
}
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('browser dictation lifecycle', () => {
  it('hides unsupported recognition and accepts the prefixed implementation', () => {
    vi.stubGlobal('SpeechRecognition', undefined);
    vi.stubGlobal('webkitSpeechRecognition', undefined);
    const { result, rerender } = renderHook(() => useSpeechRecognition('a', vi.fn()));
    expect(result.current.supported).toBe(false);
    vi.stubGlobal('webkitSpeechRecognition', Recognition);
    rerender();
    expect(result.current.supported).toBe(true);
  });
  it('previews revisions and commits cumulative final results once after Stop', () => {
    const { result, recognition, commit } = setup();
    expect(recognition.lang).toBe('zh-CN');
    act(() => { recognition.onstart?.(); result.current.start(); });
    expect(Recognition.instances).toHaveLength(1);
    act(() => recognition.onresult?.(results(['研究', false])));
    expect(result.current.preview).toBe('研究');
    expect(commit).not.toHaveBeenCalled();
    act(() => result.current.stop());
    expect(result.current.phase).toBe('stopping');
    act(() => recognition.onresult?.(results(['研究计划', true])));
    const lateEnd = recognition.onend;
    act(() => recognition.onresult?.(results(['研究计划', true])));
    act(() => lateEnd?.());
    act(() => lateEnd?.());
    expect(commit).toHaveBeenCalledExactlyOnceWith('研究计划');
    expect(result.current.active).toBe(false);
  });
  it('cancels without committing buffered final text or accepting late callbacks', () => {
    const { result, recognition, commit } = setup();
    const lateResult = recognition.onresult;
    const lateEnd = recognition.onend;
    act(() => recognition.onresult?.(results(['不要写入', true])));
    act(() => result.current.cancel());
    act(() => { lateResult?.(results(['迟到结果', true])); lateEnd?.(); });
    expect(commit).not.toHaveBeenCalled();
    expect(result.current.preview).toBe('');
    expect(recognition.abort).toHaveBeenCalled();
  });
  it('rejects callbacks and pending start actions from the previous session', () => {
    const { result, recognition, rerender, commit } = setup();
    const lateResult = recognition.onresult;
    const lateEnd = recognition.onend;
    const staleStart = result.current.start;
    rerender({ session: 'b', disabled: false });
    act(() => { lateResult?.(results(['会话 A', true])); lateEnd?.(); staleStart(); });
    expect(commit).not.toHaveBeenCalled();
    expect(Recognition.instances).toHaveLength(1);
    expect(result.current.active).toBe(false);
  });
  it.each(['not-allowed', 'audio-capture', 'network', 'no-speech'])('recovers from %s without needing an end event', (error) => {
    const { result, recognition } = setup();
    act(() => recognition.onerror?.({ error }));
    expect(result.current.error).toBe(error);
    expect(result.current.active).toBe(false);
    act(() => result.current.start());
    expect(result.current.error).toBeNull();
    expect(Recognition.instances).toHaveLength(2);
  });
  it('releases the composer when the browser never finishes stopping', () => {
    vi.useFakeTimers();
    const { result } = setup();
    act(() => result.current.stop());
    act(() => vi.advanceTimersByTime(15_000));
    expect(result.current.active).toBe(false);
    expect(result.current.error).toBe('timeout');
  });
  it('cancels on disconnect and rejects a previously captured start callback', () => {
    const { result, recognition, rerender } = setup();
    const staleStart = result.current.start;
    rerender({ session: 'a', disabled: true });
    act(() => staleStart());
    expect(recognition.abort).toHaveBeenCalled();
    expect(Recognition.instances).toHaveLength(1);
  });
  it('cancels on navigation and unmount', () => {
    const { recognition, result, unmount } = setup();
    act(() => window.dispatchEvent(new Event('pagehide')));
    expect(result.current.active).toBe(false);
    act(() => result.current.start());
    const second = Recognition.instances[1];
    unmount();
    expect(recognition.abort).toHaveBeenCalled();
    expect(second.abort).toHaveBeenCalled();
  });
});
