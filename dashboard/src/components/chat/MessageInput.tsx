import React, { useState, useRef, useCallback, useEffect } from 'react';
import { Button, Tooltip, message } from 'antd';
import { SendOutlined, PaperClipOutlined, ReloadOutlined, HistoryOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import { useChatStore } from '../../stores/chat';
import { useGatewayStore } from '../../stores/gateway';
import { useToolStreamStore } from '../../stores/tool-stream';
import type { ChatAttachment } from '../../gateway/types';
import SlashCommandMenu, { useSlashCommandMenu } from './SlashCommandMenu';
import InputHistoryPopup from './InputHistoryPopup';
import { useInputHistory } from '../../hooks/useInputHistory';

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
  const send = useChatStore((s) => s.send);
  const abort = useChatStore((s) => s.abort);
  const sending = useChatStore((s) => s.sending);
  const streaming = useChatStore((s) => s.streaming);
  const loadHistory = useChatStore((s) => s.loadHistory);
  const connState = useGatewayStore((s) => s.state);

  const inputHistory = useInputHistory();
  const [historyPopupOpen, setHistoryPopupOpen] = useState(false);
  /** Stashed draft text when browsing history — restored on ArrowDown past end. */
  const draftRef = useRef<string | null>(null);

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
          textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 160)}px`;
        }
      }
    } catch { /* ignore */ }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- inputHistory ref is stable
  }, [sessionKey]);

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
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 160)}px`;
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
    // Push to input history before clearing
    if (msg) {
      inputHistory.push(msg);
      inputHistory.reset();
      draftRef.current = null;
    }
    setHistoryPopupOpen(false);
    setText('');
    setAttachments([]);
    // Clear persisted draft on send
    try { localStorage.removeItem(DRAFT_STORAGE_PREFIX + sessionKey); } catch { /* ignore */ }
    send(msg, attachments.length > 0 ? attachments : undefined);
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
  }, [text, attachments, isConnected, sending, send, sessionKey, inputHistory]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Do not intercept during IME composition (e.g. Chinese pinyin input)
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
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
              el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
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
            el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
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
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  };

  return (
    <div
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      style={{
        padding: '12px 24px 16px',
        borderTop: '1px solid var(--border)',
        background: 'var(--surface)',
      }}
    >
      {/* Attachment preview strip */}
      {attachments.length > 0 && (
        <div style={{ display: 'flex', gap: 8, padding: '8px 0', flexWrap: 'wrap' }}>
          {attachments.map((att) => (
            <div key={att.id} style={{ position: 'relative', width: 64, height: 64 }}>
              <img
                src={att.dataUrl}
                alt=""
                style={{
                  width: 64,
                  height: 64,
                  objectFit: 'cover',
                  borderRadius: 6,
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

      {/* Input row — position:relative for the slash command menu overlay */}
      <div
        style={{
          position: 'relative',
          display: 'flex',
          alignItems: 'flex-end',
          gap: 8,
          background: 'var(--surface-hover)',
          border: `1px solid ${isDragging ? 'var(--accent-secondary)' : 'var(--border)'}`,
          borderRadius: 8,
          padding: '6px 12px',
          transition: 'border-color 0.15s ease',
        }}
      >
        {/* Slash command autocomplete menu — floats above input */}
        <SlashCommandMenu
          commands={slashMenu.commands}
          activeIndex={slashMenu.activeIndex}
          onSelect={slashMenu.handleSelect}
          onHover={slashMenu.setActiveIndex}
          visible={slashMenu.visible}
        />
        {/* Refresh button — reloads chat history without losing draft.
          * Matches OC chat view's onRefresh (app-render.ts:1386-1388). */}
        <Tooltip title={t('chat.refresh')}>
          <Button
            type="text"
            icon={<ReloadOutlined />}
            onClick={handleRefresh}
            disabled={!isConnected}
            style={{ color: 'var(--text-secondary)', flexShrink: 0 }}
          />
        </Tooltip>

        {/* Hidden file input */}
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

        {/* Attach button */}
        <Tooltip title={t('chat.attachImage')}>
          <Button
            type="text"
            icon={<PaperClipOutlined />}
            onClick={() => fileInputRef.current?.click()}
            disabled={!isConnected || sending}
            style={{ color: 'var(--text-secondary)', flexShrink: 0 }}
          />
        </Tooltip>

        {/* Input history popup + trigger button */}
        <InputHistoryPopup
          items={inputHistory.items()}
          visible={historyPopupOpen}
          onSelect={(historyText) => {
            setText(historyText);
            setHistoryPopupOpen(false);
            textareaRef.current?.focus();
            requestAnimationFrame(() => {
              const el = textareaRef.current;
              if (el) {
                el.style.height = 'auto';
                el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
                el.selectionStart = el.selectionEnd = el.value.length;
              }
            });
          }}
          onDismiss={() => setHistoryPopupOpen(false)}
        />
        <Tooltip title={t('chat.inputHistory', { defaultValue: 'Input history' })}>
          <Button
            type="text"
            icon={<HistoryOutlined />}
            onClick={() => setHistoryPopupOpen((v) => !v)}
            style={{ color: 'var(--text-secondary)', flexShrink: 0 }}
          />
        </Tooltip>

        <textarea
          ref={textareaRef}
          className="chat-textarea"
          value={text}
          onChange={handleInput}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          placeholder={t('chat.placeholder')}
          disabled={!isConnected || sending}
          rows={1}
          style={{
            flex: 1,
            border: 'none',
            outline: 'none',
            background: 'transparent',
            color: 'var(--text-primary)',
            fontSize: 14,
            lineHeight: '32px',
            resize: 'none',
            fontFamily: 'inherit',
            height: 32,
            minHeight: 32,
            maxHeight: 160,
            padding: 0,
            margin: 0,
          }}
        />

        {streaming ? (
          <Tooltip title={t('chat.abort')}>
            <Button
              type="text"
              icon={
                <svg width="1em" height="1em" viewBox="0 0 24 24" fill="currentColor">
                  <circle cx="12" cy="12" r="11" fill="none" stroke="currentColor" strokeWidth="2" />
                  <rect x="8" y="8" width="8" height="8" rx="1" />
                </svg>
              }
              onClick={abort}
              style={{
                color: 'var(--accent-primary)',
                flexShrink: 0,
              }}
            />
          </Tooltip>
        ) : (
          <Tooltip title={t('chat.send')}>
            <Button
              type="text"
              icon={<SendOutlined />}
              onClick={handleSend}
              disabled={!canSend}
              style={{
                color: canSend ? 'var(--accent-primary)' : 'var(--text-tertiary)',
                flexShrink: 0,
              }}
            />
          </Tooltip>
        )}
      </div>
    </div>
  );
}
