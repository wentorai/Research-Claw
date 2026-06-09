import React, { useState, useRef, useCallback, useEffect } from 'react';
import { Button, Tooltip, message, Modal } from 'antd';
import { SendOutlined, PaperClipOutlined, ReloadOutlined, HistoryOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import { useChatStore } from '../../stores/chat';
import { useGatewayStore } from '../../stores/gateway';
import { useToolStreamStore } from '../../stores/tool-stream';
import type { ChatAttachment } from '../../gateway/types';
import SlashCommandMenu, { useSlashCommandMenu } from './SlashCommandMenu';
import InputHistoryPopup from './InputHistoryPopup';
import { useInputHistory } from '../../hooks/useInputHistory';
import { abortChatShortcutLabel } from '../../utils/keyboard-shortcut';
import { useUiStore } from '../../stores/ui';
import { useSessionsStore } from '../../stores/sessions';
import { resizeComposerInput } from '../../utils/composer-input';

const DRAFT_STORAGE_PREFIX = 'rc-chat-draft:';

const MAX_SIZE = 5_000_000; // 5MB — must match gateway's parseMessageWithAttachments limit
const ACCEPTED_TYPES = /^image\/(png|jpe?g|gif|webp|bmp|tiff|heic|heif)$/;

export default function MessageInput() {
  const { t } = useTranslation();
  const sessionKey = useChatStore((s) => s.sessionKey);
  const [text, setText] = useState(() => {
    try {
      return localStorage.getItem(DRAFT_STORAGE_PREFIX + sessionKey) ?? '';
    } catch { return ''; }
  });
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const historyAnchorRef = useRef<HTMLDivElement>(null);
  const send = useChatStore((s) => s.send);
  const abort = useChatStore((s) => s.abort);
  const inputRestore = useChatStore((s) => s.inputRestore);
  const inputRestoreSeq = useChatStore((s) => s.inputRestoreSeq);
  const clearInputRestore = useChatStore((s) => s.clearInputRestore);
  const sending = useChatStore((s) => s.sending);
  const runId = useChatStore((s) => s.runId);
  const streaming = useChatStore((s) => s.streaming);
  const canStopGeneration = Boolean(runId) || sending || streaming;
  const loadHistory = useChatStore((s) => s.loadHistory);
  const connState = useGatewayStore((s) => s.state);
  const chatInputPrefill = useUiStore((s) => s.chatInputPrefill);
  const setChatInputPrefill = useUiStore((s) => s.setChatInputPrefill);

  const inputHistory = useInputHistory();
  const [historyPopupOpen, setHistoryPopupOpen] = useState(false);
  /** Stashed draft text when browsing history — restored on ArrowDown past end. */
  const draftRef = useRef<string | null>(null);
  /** Explicit IME composition tracking — protects against remote desktop tools
   *  (e.g. ToDesk) that break React's built-in composition detection. */
  const composingRef = useRef(false);

  const isConnected = connState === 'connected';
  const canSend = (text.trim().length > 0 || attachments.length > 0) && isConnected && !sending;

  // Persist draft to localStorage (session-isolated)
  useEffect(() => {
    try {
      if (text) {
        localStorage.setItem(DRAFT_STORAGE_PREFIX + sessionKey, text);
      } else {
        localStorage.removeItem(DRAFT_STORAGE_PREFIX + sessionKey);
      }
    } catch { /* storage full — non-fatal */ }
  }, [text, sessionKey]);

  // Restore draft when session changes
  useEffect(() => {
    // Reset history navigation state for the new session
    inputHistory.reset();
    draftRef.current = null;
    try {
      const saved = localStorage.getItem(DRAFT_STORAGE_PREFIX + sessionKey) ?? '';
      setText(saved);
      // Resize textarea to fit restored draft
      if (textareaRef.current) {
        textareaRef.current.style.height = 'auto';
        if (saved) {
          resizeComposerInput(textareaRef.current);
        }
      }
    } catch { /* ignore */ }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- inputHistory ref is stable
  }, [sessionKey]);

  // Restore draft to input after user aborts generation
  useEffect(() => {
    if (!inputRestore) return;
    setText(inputRestore.text);
    setAttachments(inputRestore.attachments);
    clearInputRestore();
    try {
      if (inputRestore.text) {
        localStorage.setItem(DRAFT_STORAGE_PREFIX + sessionKey, inputRestore.text);
      } else {
        localStorage.removeItem(DRAFT_STORAGE_PREFIX + sessionKey);
      }
    } catch { /* ignore */ }
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.style.height = 'auto';
      resizeComposerInput(el);
      el.focus();
      el.selectionStart = el.selectionEnd = el.value.length;
    });
  }, [inputRestore, inputRestoreSeq, clearInputRestore, sessionKey]);

  // Skill Workshop / other panels can push a one-shot message into the composer
  useEffect(() => {
    if (!chatInputPrefill) return;
    setText(chatInputPrefill);
    setChatInputPrefill(null);
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      el.style.height = 'auto';
      resizeComposerInput(el);
      el.selectionStart = el.selectionEnd = el.value.length;
    });
  }, [chatInputPrefill, setChatInputPrefill]);

  const handleRefresh = useCallback(async () => {
    const beforeCount = useChatStore.getState().messages.length;
    try {
      useToolStreamStore.getState().clearAll();
      await loadHistory();
      const afterCount = useChatStore.getState().messages.length;
      const diff = afterCount - beforeCount;
      if (diff > 0) {
        message.success(t('chat.refreshed', { count: diff, defaultValue: 'Refreshed — {{count}} new message(s)' }), 2);
      } else {
        message.info(t('chat.refreshUpToDate', { defaultValue: 'Chat is up to date' }), 2);
      }
    } catch {
      message.error(t('chat.refreshFailed', { defaultValue: 'Refresh failed' }), 2);
    }
  }, [loadHistory, t]);

  // Slash command autocomplete menu
  const slashMenu = useSlashCommandMenu(text, (completed) => {
    setText(completed);
    // Focus textarea and move cursor to end
    if (textareaRef.current) {
      textareaRef.current.focus();
      // Auto-resize after setting text
      textareaRef.current.style.height = 'auto';
      resizeComposerInput(textareaRef.current);
    }
  });

  const processFiles = useCallback(
    (files: FileList | File[]) => {
      for (const file of Array.from(files)) {
        if (!ACCEPTED_TYPES.test(file.type)) {
          message.warning(t('chat.imageOnly'));
          continue;
        }
        if (file.size > MAX_SIZE) {
          message.warning(t('chat.imageTooLarge'));
          continue;
        }
        const reader = new FileReader();
        reader.onload = () => {
          const dataUrl = reader.result as string;
          setAttachments((prev) => [
            ...prev,
            {
              id: crypto.randomUUID(),
              dataUrl,
              mimeType: file.type,
            },
          ]);
        };
        reader.readAsDataURL(file);
      }
    },
    [t],
  );

  const removeAttachment = useCallback((id: string) => {
    setAttachments((prev) => prev.filter((a) => a.id !== id));
  }, []);

  const handlePaste = useCallback(
    (e: React.ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;

      const imageFiles: File[] = [];
      for (let i = 0; i < items.length; i++) {
        if (items[i].type.startsWith('image/')) {
          const file = items[i].getAsFile();
          if (file) imageFiles.push(file);
        }
      }

      if (imageFiles.length > 0) {
        e.preventDefault();
        processFiles(imageFiles);
      }
    },
    [processFiles],
  );

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragging(false);

      if (e.dataTransfer.files.length > 0) {
        processFiles(e.dataTransfer.files);
      }
    },
    [processFiles],
  );

  const handleSend = useCallback(() => {
    const msg = text.trim();
    if ((!msg && attachments.length === 0) || !isConnected || sending) return;

    const doSend = () => {
      if (msg) {
        inputHistory.push(msg);
        inputHistory.reset();
        draftRef.current = null;
      }
      setHistoryPopupOpen(false);
      setText('');
      setAttachments([]);
      try { localStorage.removeItem(DRAFT_STORAGE_PREFIX + sessionKey); } catch { /* ignore */ }
      send(msg, attachments.length > 0 ? attachments : undefined);
      if (textareaRef.current) {
        textareaRef.current.style.height = 'auto';
      }
    };

    const {
      activeSessionStale,
      staleSendAcknowledgedKey,
      acknowledgeStaleSessionSend,
    } = useSessionsStore.getState();

    if (
      activeSessionStale
      && staleSendAcknowledgedKey !== sessionKey
    ) {
      Modal.confirm({
        title: t('chat.staleSessionConfirmTitle'),
        content: t('chat.staleSessionConfirmBody'),
        okText: t('chat.staleSessionConfirmOk'),
        cancelText: t('chat.staleSessionConfirmCancel'),
        onOk: () => {
          acknowledgeStaleSessionSend(sessionKey);
          doSend();
        },
      });
      return;
    }

    doSend();
  }, [text, attachments, isConnected, sending, send, sessionKey, inputHistory, t]);

  const abortShortcut = abortChatShortcutLabel();
  const abortTooltip = t('chat.abortWithShortcut', {
    shortcut: abortShortcut,
    defaultValue: 'Stop ({{shortcut}})',
  });

  const handleCompositionStart = () => {
    composingRef.current = true;
  };

  const handleCompositionEnd = () => {
    composingRef.current = false;
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Do not intercept during IME composition (e.g. Chinese pinyin input).
    // composingRef is the primary guard — survives remote desktop tools
    // (ToDesk, etc.) that may not set isComposing correctly.
    if (composingRef.current || e.nativeEvent.isComposing || e.keyCode === 229) return;

    // Let slash command menu handle navigation keys first
    if (slashMenu.handleKeyDown(e)) return;

    // ── Input history navigation (ArrowUp / ArrowDown) ──
    const el = textareaRef.current;
    if (el && e.key === 'ArrowUp' && !historyPopupOpen) {
      // Only intercept if cursor is at the first line (before first newline or at pos 0)
      const beforeCursor = el.value.slice(0, el.selectionStart);
      if (!beforeCursor.includes('\n')) {
        const prev = inputHistory.up();
        if (prev !== null) {
          e.preventDefault();
          // Stash current text as draft on first history navigation
          if (draftRef.current === null) {
            draftRef.current = text;
          }
          setText(prev);
          // Move cursor to end after React re-render
          requestAnimationFrame(() => {
            if (el) {
              el.style.height = 'auto';
              resizeComposerInput(el);
              el.selectionStart = el.selectionEnd = el.value.length;
            }
          });
        }
        return;
      }
    }

    if (el && e.key === 'ArrowDown' && inputHistory.cursor() >= 0) {
      // Only intercept if cursor is at the last line
      const afterCursor = el.value.slice(el.selectionEnd);
      if (!afterCursor.includes('\n')) {
        const next = inputHistory.down();
        e.preventDefault();
        if (next !== null) {
          setText(next);
        } else {
          // Back to draft
          setText(draftRef.current ?? '');
          draftRef.current = null;
        }
        requestAnimationFrame(() => {
          if (el) {
            el.style.height = 'auto';
            resizeComposerInput(el);
            el.selectionStart = el.selectionEnd = el.value.length;
          }
        });
        return;
      }
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setText(e.target.value);
    // Auto-resize
    const el = e.target;
    el.style.height = 'auto';
    resizeComposerInput(el);
  };

  return (
    <div
      className={`chat-composer${isDragging ? ' is-dragging' : ''}`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <div className="chat-composer-panel">
      {attachments.length > 0 && (
        <div className="chat-composer-attachments">
          {attachments.map((att) => (
            <div key={att.id} style={{ position: 'relative', width: 64, height: 64 }}>
              <img
                src={att.dataUrl}
                alt=""
                style={{
                  width: 64,
                  height: 64,
                  objectFit: 'cover',
                  borderRadius: 4,
                  border: '1px solid var(--border)',
                }}
              />
              <button
                onClick={() => removeAttachment(att.id)}
                style={{
                  position: 'absolute',
                  top: -6,
                  right: -6,
                  width: 18,
                  height: 18,
                  borderRadius: '50%',
                  border: '1px solid var(--border)',
                  background: 'var(--surface)',
                  color: 'var(--text-secondary)',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: 10,
                  lineHeight: 1,
                  padding: 0,
                }}
                aria-label={t('common.remove', { defaultValue: 'Remove' })}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="chat-composer-bar">
        <SlashCommandMenu
          commands={slashMenu.commands}
          activeIndex={slashMenu.activeIndex}
          onSelect={slashMenu.handleSelect}
          onHover={slashMenu.setActiveIndex}
          visible={slashMenu.visible}
        />

        <span className="chat-composer-prompt" aria-hidden="true">›</span>

        <textarea
          ref={textareaRef}
          className="chat-composer-input"
          value={text}
          onChange={handleInput}
          onKeyDown={handleKeyDown}
          onCompositionStart={handleCompositionStart}
          onCompositionEnd={handleCompositionEnd}
          onPaste={handlePaste}
          placeholder={t('chat.placeholder')}
          disabled={!isConnected || sending}
          rows={1}
        />

        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={(e) => {
            if (e.target.files) processFiles(e.target.files);
            e.target.value = '';
          }}
        />

        <div className="chat-composer-toolbar">
          <Tooltip title={t('chat.refresh')}>
            <Button
              type="text"
              size="small"
              icon={<ReloadOutlined />}
              onClick={handleRefresh}
              disabled={!isConnected}
            />
          </Tooltip>
          <Tooltip title={t('chat.attachImage')}>
            <Button
              type="text"
              size="small"
              icon={<PaperClipOutlined />}
              onClick={() => fileInputRef.current?.click()}
              disabled={!isConnected || sending}
            />
          </Tooltip>
          <div className="chat-composer-history" ref={historyAnchorRef}>
            <InputHistoryPopup
              items={inputHistory.items()}
              visible={historyPopupOpen}
              align="right"
              anchorRef={historyAnchorRef}
              onSelect={(historyText) => {
                setText(historyText);
                setHistoryPopupOpen(false);
                textareaRef.current?.focus();
                requestAnimationFrame(() => {
                  const el = textareaRef.current;
                  if (el) {
                    el.style.height = 'auto';
                    resizeComposerInput(el);
                    el.selectionStart = el.selectionEnd = el.value.length;
                  }
                });
              }}
              onDismiss={() => setHistoryPopupOpen(false)}
            />
            <Tooltip title={t('chat.inputHistory', { defaultValue: 'Input history' })}>
              <Button
                type="text"
                size="small"
                className="chat-composer-history-btn"
                icon={<HistoryOutlined />}
                onClick={() => setHistoryPopupOpen((v) => !v)}
                disabled={!isConnected}
                aria-expanded={historyPopupOpen}
              />
            </Tooltip>
          </div>
          {canStopGeneration ? (
            <Tooltip title={abortTooltip}>
              <Button
                type="text"
                size="small"
                icon={
                  <svg width="1em" height="1em" viewBox="0 0 24 24" fill="currentColor">
                    <circle cx="12" cy="12" r="11" fill="none" stroke="currentColor" strokeWidth="2" />
                    <rect x="8" y="8" width="8" height="8" rx="1" />
                  </svg>
                }
                onClick={abort}
                style={{ color: 'var(--accent-primary)' }}
              />
            </Tooltip>
          ) : (
            <Tooltip title={t('chat.send')}>
              <Button
                type="text"
                size="small"
                icon={<SendOutlined />}
                onClick={handleSend}
                disabled={!canSend}
                style={{
                  color: canSend ? 'var(--accent-primary)' : undefined,
                }}
              />
            </Tooltip>
          )}
        </div>
      </div>

      <div className="chat-composer-hint">
        {t('chat.composerHint', { defaultValue: 'Enter send · Shift+Enter newline' })}
      </div>
      </div>
    </div>
  );
}
