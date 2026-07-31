import React, { useState, useRef, useCallback, useEffect } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { App, Button, Dropdown, Tooltip, message, Image } from 'antd';
import { SendOutlined, PaperClipOutlined, ReloadOutlined, HistoryOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import { useChatStore } from '../../stores/chat';
import { useGatewayStore } from '../../stores/gateway';
import { useToolStreamStore } from '../../stores/tool-stream';
import { useConfigStore, imageModelSupportsVision } from '../../stores/config';
import { useVisionSupport } from '../../hooks/useVisionSupport';
import type { ChatAttachment, ChatReference } from '../../gateway/types';
import SlashCommandMenu, { useSlashCommandMenu } from './SlashCommandMenu';
import ReferenceMenu, { useReferenceMenu } from './ReferenceMenu';
import InputHistoryPopup from './InputHistoryPopup';
import QuickCommands from './QuickCommands';
import { useInputHistory } from '../../hooks/useInputHistory';
import { abortChatShortcutLabel } from '../../utils/keyboard-shortcut';
import { useUiStore } from '../../stores/ui';
import { useSessionsStore } from '../../stores/sessions';
import { selectSessionRunView, useSessionRunsStore } from '../../stores/session-runs';
import { resizeComposerInput } from '../../utils/composer-input';
import { insertTextAtSelection, type TextSelection } from '../../utils/insert-text-at-selection';
import { uploadFileToWorkspace } from '../../gateway/upload';
import {
  CHAT_DROP_DIR,
  CHAT_IMAGE_DIR,
  MAX_REFERENCE_SIZE,
  basenameOf,
  composerDropDestination,
  isImagePath,
  safeUploadName,
  timestampedUploadName,
} from '../../utils/file-reference';
import {
  applyDropPolicy,
  collectDroppedEntries,
  collectSelectedFiles,
  mapWithConcurrency,
  splitRelPath,
  UPLOAD_CONCURRENCY,
  type CollectedDrop,
  type DroppedFile,
} from '../../utils/drop-entries';
import { flattenWorkspaceFiles } from '../../utils/mention';
import { FileOutlined, FolderOutlined, PictureOutlined, LoadingOutlined, CloseOutlined } from '@ant-design/icons';

const DRAFT_STORAGE_PREFIX = 'rc-chat-draft:';

const MAX_SIZE = 5_000_000; // 5MB — must match gateway's parseMessageWithAttachments limit
const ACCEPTED_TYPES = /^image\/(png|jpe?g|gif|webp|bmp|tiff|heic|heif)$/;

const WORKSPACE_PATH_MIME = 'text/x-workspace-path';

export default function MessageInput() {
  const { t } = useTranslation();
  const { modal } = App.useApp();
  const sessionKey = useChatStore((s) => s.sessionKey);
  const [text, setText] = useState(() => {
    try {
      return localStorage.getItem(DRAFT_STORAGE_PREFIX + sessionKey) ?? '';
    } catch { return ''; }
  });
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [references, setReferences] = useState<ChatReference[]>([]);
  const referencesRef = useRef(references);
  referencesRef.current = references;
  const [caret, setCaret] = useState(0);
  const [wsFilePaths, setWsFilePaths] = useState<string[]>([]);
  const wsPathsLoadedRef = useRef(false);
  const [isDragging, setIsDragging] = useState(false);
  const [attachmentMenuOpen, setAttachmentMenuOpen] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const historyAnchorRef = useRef<HTMLDivElement>(null);
  const send = useChatStore((s) => s.send);
  const abort = useChatStore((s) => s.abort);
  const inputRestore = useChatStore((s) => s.inputRestore);
  const inputRestoreSeq = useChatStore((s) => s.inputRestoreSeq);
  const clearInputRestore = useChatStore((s) => s.clearInputRestore);
  const sending = useChatStore((s) => s.sending);
  const client = useGatewayStore((s) => s.client);
  const sessionRun = useSessionRunsStore(useShallow((s) => selectSessionRunView(s, sessionKey)));
  const canStopGeneration = sessionRun.canAbort;
  const loadHistory = useChatStore((s) => s.loadHistory);
  const connState = useGatewayStore((s) => s.state);
  const chatInputPrefill = useUiStore((s) => s.chatInputPrefill);
  const setChatInputPrefill = useUiStore((s) => s.setChatInputPrefill);
  const chatAttachmentPrefill = useUiStore((s) => s.chatAttachmentPrefill);
  const setChatAttachmentPrefill = useUiStore((s) => s.setChatAttachmentPrefill);

  const inputHistory = useInputHistory();
  const [historyPopupOpen, setHistoryPopupOpen] = useState(false);
  const [isComposing, setIsComposing] = useState(false);
  /** Stashed draft text when browsing history — restored on ArrowDown past end. */
  const draftRef = useRef<string | null>(null);
  /** Explicit IME composition tracking — protects against remote desktop tools
   *  (e.g. ToDesk) that break React's built-in composition detection. */
  const composingRef = useRef(false);
  const lastSelectionRef = useRef<TextSelection>({ start: 0, end: 0 });

  const isConnected = connState === 'connected';
  const hasReadyReference = references.some((r) => r.status === 'ready');
  const hasUploadingReference = references.some((r) => r.status === 'uploading');

  // §13.5 (SPEC:417-419): the composer hint MUST share the vision resolver with
  // the send pipeline (chat.ts:995 resolveVisionSupport). Using the config-primary
  // -only primaryModelSupportsVision() here mis-fired under a session /model
  // override (config primary=vision but the active session is text-only → hint
  // hidden while chat.ts still routes to /image degradation, and vice-versa).
  // useVisionSupport() is the session-aware, reactive wrapper over the same pure
  // resolver, so composer and pipeline can never disagree.
  const gatewayConfig = useConfigStore((s) => s.gatewayConfig);
  const vision = useVisionSupport();
  // Show the soft hint only on an AUTHORITATIVE text-only verdict (matches the
  // send pipeline's `supportsImage === false` degradation trigger; `true` and
  // 'unknown' are fail-open → no blocking hint). A dedicated /image vision model
  // (imageModel) is a config-level escape hatch that can still read the image, so
  // its presence suppresses the hint.
  const attachNoVisionModel =
    attachments.length > 0
    && Boolean(gatewayConfig)
    && vision.supportsImage === false
    && !imageModelSupportsVision();
  const canSend =
    (text.trim().length > 0 || attachments.length > 0 || hasReadyReference)
    && !hasUploadingReference
    && isConnected
    && !sessionRun.isBusy;

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
    setReferences(inputRestore.references.map((path) => ({
      id: crypto.randomUUID(),
      path,
      name: basenameOf(path),
      source: 'workspace',
      status: 'ready',
    })));
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

  // Peripherals panel / other panels can push attachments into the composer (append semantics)
  useEffect(() => {
    if (!chatAttachmentPrefill) return;
    const prefill = chatAttachmentPrefill;
    setAttachments((prev) => [...prev, ...prefill]);
    setChatAttachmentPrefill(null);
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
    });
  }, [chatAttachmentPrefill, setChatAttachmentPrefill]);

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

  // Images carry BOTH a preview thumbnail (attachment) and a chip (reference),
  // linked by attachment.wsPath === reference.path. Removing either drops both.
  const removeAttachment = useCallback((id: string) => {
    const target = attachments.find((a) => a.id === id);
    setAttachments((prev) => prev.filter((a) => a.id !== id));
    if (target?.wsPath) {
      setReferences((prev) => prev.filter((r) => r.path !== target.wsPath));
    }
  }, [attachments]);

  const removeReference = useCallback((id: string) => {
    const target = references.find((r) => r.id === id);
    setReferences((prev) => prev.filter((r) => r.id !== id));
    if (target) {
      setAttachments((prev) => prev.filter((a) => a.wsPath !== target.path));
    }
  }, [references]);

  /** Add a known-path reference (workspace drag or `@` mention). Dedupes by path. */
  const addReference = useCallback(
    (ref: Omit<ChatReference, 'id'>): string | null => {
      if (references.some((r) => r.path === ref.path)) return null;
      const id = crypto.randomUUID();
      setReferences((prev) =>
        prev.some((r) => r.path === ref.path) ? prev : [...prev, { ...ref, id }],
      );
      return id;
    },
    [references],
  );

  /** Reference a workspace file by relative path; for images, also fetch bytes
   *  for an inline vision thumbnail (thumbnail + reference run in parallel). */
  const addWorkspaceReference = useCallback(
    async (path: string) => {
      const id = addReference({ path, name: basenameOf(path), source: 'workspace', status: 'ready' });
      if (id && isImagePath(path) && client) {
        try {
          const result = await client.request<{ content: string; encoding: string; mime_type?: string }>(
            'rc.ws.read',
            { path },
          );
          if (result?.encoding === 'base64') {
            if (!referencesRef.current.some((r) => r.id === id && r.path === path)) return;
            const mime = result.mime_type || 'image/png';
            setAttachments((prev) =>
              prev.some((a) => a.wsPath === path)
                ? prev
                : [...prev, { id: crypto.randomUUID(), dataUrl: `data:${mime};base64,${result.content}`, mimeType: mime, wsPath: path }],
            );
          }
        } catch {
          // Image unreadable (deleted/binary) — keep the reference chip only.
        }
      }
    },
    [addReference, client],
  );

  /** Ingest an external (host) file into the workspace, tracking its upload
   *  state as a chip. Always uses a timestamped name to avoid collisions. */
  const ingestExternalFile = useCallback(
    async (file: File, destination: typeof CHAT_DROP_DIR | typeof CHAT_IMAGE_DIR) => {
      if (file.size > MAX_REFERENCE_SIZE) {
        message.warning(
          t('chat.refTooLarge', {
            name: file.name,
            limit: Math.round(MAX_REFERENCE_SIZE / (1024 * 1024)),
            defaultValue: '"{{name}}" exceeds the {{limit}}MB limit and was not ingested',
          }),
        );
        return;
      }
      const id = crypto.randomUUID();
      const uploadName = timestampedUploadName(file.name, Date.now());
      const provisionalPath = `${destination}/${uploadName}`;
      setReferences((prev) => [
        ...prev,
        {
          id,
          path: provisionalPath,
          name: file.name,
          source: 'external',
          status: 'uploading',
          size: file.size,
          mimeType: file.type,
        },
      ]);
      try {
        const result = await uploadFileToWorkspace(file, destination, uploadName);
        setReferences((prev) =>
          prev.map((r) =>
            r.id === id
              ? { ...r, path: result.path, status: 'ready', size: result.size, mimeType: result.mime_type }
              : r,
          ),
        );
        // A new file now exists in the workspace — invalidate the cached `@`-mention
        // file list so the next mention re-fetches and can suggest it.
        wsPathsLoadedRef.current = false;
        // For images small enough for inline vision, also attach a thumbnail
        // bound to the just-ingested workspace path (no duplicate re-save on send).
        if (ACCEPTED_TYPES.test(file.type) && file.size <= MAX_SIZE) {
          const reader = new FileReader();
          reader.onload = () => {
            // The upload and FileReader complete independently. If the user
            // removed the linked chip meanwhile, do not resurrect an orphan
            // thumbnail after that removal.
            if (!referencesRef.current.some((r) => r.id === id && r.path === result.path)) return;
            const dataUrl = reader.result as string;
            setAttachments((prev) =>
              prev.some((a) => a.wsPath === result.path)
                ? prev
                : [...prev, { id: crypto.randomUUID(), dataUrl, mimeType: file.type, wsPath: result.path }],
            );
          };
          reader.readAsDataURL(file);
        }
      } catch (err) {
        // Retain the File on the errored chip so retry can re-upload without a
        // re-drop (released again once the retry succeeds).
        setReferences((prev) =>
          prev.map((r) =>
            r.id === id
              ? { ...r, status: 'error', errorMsg: err instanceof Error ? err.message : String(err), file }
              : r,
          ),
        );
      }
    },
    [t],
  );

  /** Ingest a whole dropped folder as a SINGLE folder chip, preserving the
   *  internal directory structure under a timestamped root in sources/chat/. */
  const ingestFolder = useCallback(
    async (rootName: string, group: DroppedFile[]) => {
      const safeRoot = `${Date.now()}-${safeUploadName(rootName)}`;
      const rootPath = `${CHAT_DROP_DIR}/${safeRoot}/`;
      const chipId = crypto.randomUUID();
      const totalSize = group.reduce((sum, d) => sum + d.file.size, 0);
      setReferences((prev) => [
        ...prev,
        { id: chipId, path: rootPath, name: `${rootName}/`, source: 'external', status: 'uploading', size: totalSize },
      ]);

      let failCount = 0;
      await mapWithConcurrency(group, UPLOAD_CONCURRENCY, async (d) => {
        // Sanitize directory segments (path safety) but keep the original
        // filename — the gateway strips slashes/control chars while preserving
        // non-ASCII (CJK) names, so folder contents stay human-readable.
        const { subDir, fileName } = splitRelPath(d.relPath, d.rootDir, safeUploadName);
        const destDir = subDir ? `${CHAT_DROP_DIR}/${safeRoot}/${subDir}` : `${CHAT_DROP_DIR}/${safeRoot}`;
        try {
          await uploadFileToWorkspace(d.file, destDir, fileName);
        } catch (err) {
          failCount++;
          console.error('[MessageInput] folder upload failed:', d.relPath, err);
        }
      });

      // New files now exist — invalidate the cached `@`-mention list.
      wsPathsLoadedRef.current = false;
      if (failCount === group.length) {
        setReferences((prev) =>
          prev.map((r) =>
            r.id === chipId
              ? { ...r, status: 'error', errorMsg: t('chat.dropFolderAllFailed', { defaultValue: 'All files in this folder failed to upload' }) }
              : r,
          ),
        );
      } else {
        setReferences((prev) => prev.map((r) => (r.id === chipId ? { ...r, status: 'ready' } : r)));
        if (failCount > 0) {
          message.warning(
            t('chat.dropFolderPartial', {
              failed: failCount,
              total: group.length,
              defaultValue: '{{failed}}/{{total}} files in the folder failed to upload',
            }),
          );
        }
      }
    },
    [t],
  );

  /** Apply the shared drop policy (skip >1GB files, confirm bulk drops) and
   *  fan out: loose files → individual chips, folders → one folder chip each. */
  const ingestDroppedEntries = useCallback(
    async (collected: CollectedDrop) => {
      if (collected.entriesUnsupported) {
        message.warning(
          t('chat.dropEntriesUnsupported', {
            defaultValue: 'This browser cannot expand dropped folders — only loose files were picked up',
          }),
        );
      }
      // Shared drop policy: skip oversized files, confirm very large batches.
      const kept = await applyDropPolicy(collected, {
        maxFileSize: MAX_REFERENCE_SIZE,
        warnOversize: (count, limit) =>
          message.warning(
            t('chat.dropSkippedLarge', {
              count,
              limit,
              defaultValue: '{{count}} file(s) over {{limit}}MB were skipped',
            }),
          ),
        confirmBulk: (count, size) =>
          new Promise<boolean>((resolve) => {
            modal.confirm({
              title: t('chat.dropBulkTitle', { defaultValue: 'Upload many files?' }),
              content: t('chat.dropBulkContent', {
                count,
                size,
                defaultValue: 'This drop contains {{count}} files (~{{size}}MB). Upload all of them?',
              }),
              okText: t('chat.dropBulkConfirm', { defaultValue: 'Upload all' }),
              cancelText: t('common.cancel', { defaultValue: 'Cancel' }),
              centered: true,
              onOk: () => resolve(true),
              onCancel: () => resolve(false),
            });
          }),
      });
      if (!kept || kept.length === 0) return;

      // Loose files keep the existing per-file behavior (images → vision thumbnail),
      // but share the same bounded fan-out as folder uploads.
      const looseFiles = kept.filter((d) => d.rootDir === null);
      await mapWithConcurrency(looseFiles, UPLOAD_CONCURRENCY, async (d) => {
        const dest = composerDropDestination(d.file.name, ACCEPTED_TYPES.test(d.file.type));
        await ingestExternalFile(d.file, dest);
      });

      // Folder files are grouped by their top-level directory → one chip each.
      const folderGroups = new Map<string, DroppedFile[]>();
      for (const d of kept) {
        if (d.rootDir === null) continue;
        const list = folderGroups.get(d.rootDir);
        if (list) list.push(d);
        else folderGroups.set(d.rootDir, [d]);
      }
      for (const [rootName, group] of folderGroups) {
        // Process roots sequentially so multiple selected roots cannot multiply
        // the per-folder concurrency ceiling.
        await ingestFolder(rootName, group);
      }
    },
    [modal, t, ingestExternalFile, ingestFolder],
  );

  const retryReference = useCallback(
    async (id: string) => {
      const ref = references.find((r) => r.id === id);
      // Folder chips (and legacy chips) carry no File handle — the honest
      // recovery there is still remove-and-redrop.
      if (!ref?.file) {
        removeReference(id);
        return;
      }
      const file = ref.file;
      // Re-upload to the chip's existing provisional path (stable name).
      const slash = ref.path.lastIndexOf('/');
      const destination = slash > 0 ? ref.path.slice(0, slash) : 'sources';
      const uploadName = slash > 0 ? ref.path.slice(slash + 1) : ref.path;
      setReferences((prev) =>
        prev.map((r) => (r.id === id ? { ...r, status: 'uploading', errorMsg: undefined } : r)),
      );
      try {
        const result = await uploadFileToWorkspace(file, destination, uploadName);
        setReferences((prev) =>
          prev.map((r) =>
            r.id === id
              ? { ...r, path: result.path, status: 'ready', size: result.size, mimeType: result.mime_type, file: undefined }
              : r,
          ),
        );
        wsPathsLoadedRef.current = false;
      } catch (err) {
        setReferences((prev) =>
          prev.map((r) =>
            r.id === id
              ? { ...r, status: 'error', errorMsg: err instanceof Error ? err.message : String(err) }
              : r,
          ),
        );
      }
    },
    [references, removeReference],
  );

  // Lazily load the workspace file list for the `@` mention menu.
  const ensureWsPaths = useCallback(async () => {
    if (wsPathsLoadedRef.current || !client) return;
    wsPathsLoadedRef.current = true;
    try {
      const res = await client.request<{ tree: unknown[] }>('rc.ws.tree', { depth: 5, includeHidden: false });
      setWsFilePaths(flattenWorkspaceFiles((res.tree as never) ?? []));
    } catch {
      wsPathsLoadedRef.current = false;
    }
  }, [client]);

  // `@`-mention reference menu (workspace files)
  const refMenu = useReferenceMenu(text, caret, wsFilePaths, (path, strippedText, newCaret) => {
    setText(strippedText);
    void addWorkspaceReference(path);
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      el.selectionStart = el.selectionEnd = newCaret;
      setCaret(newCaret);
      el.style.height = 'auto';
      resizeComposerInput(el);
    });
  });

  // Load workspace file list the moment an `@` mention becomes active.
  useEffect(() => {
    if (refMenu.visible) void ensureWsPaths();
  }, [refMenu.visible, ensureWsPaths]);

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
        // Ingest into the workspace so pasted images get a chip + thumbnail,
        // matching the external-drop flow (consistency with R3).
        for (const file of imageFiles) void ingestExternalFile(file, CHAT_IMAGE_DIR);
      }
    },
    [ingestExternalFile],
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

      // 1) Workspace drag (file tree → composer): zero-copy reference by path.
      if (e.dataTransfer.types.includes(WORKSPACE_PATH_MIME)) {
        const path = e.dataTransfer.getData(WORKSPACE_PATH_MIME);
        if (path) void addWorkspaceReference(path);
        return;
      }

      // 2) External file/folder drop (host filesystem → composer). collectDroppedEntries
      //    expands any dropped directories; it captures entries synchronously, so it
      //    must run inside the event handler before the browser recycles dataTransfer.
      if (!e.dataTransfer.types.includes('Files')) return;
      void collectDroppedEntries(e.dataTransfer).then((collected) => ingestDroppedEntries(collected));
    },
    [addWorkspaceReference, ingestDroppedEntries],
  );

  const handlePickerChange = useCallback(
    (input: HTMLInputElement) => {
      const collected = collectSelectedFiles(input.files ?? []);
      // Reset even after cancellation so selecting the same file/folder again
      // always produces a change event in browsers.
      input.value = '';
      void ingestDroppedEntries(collected);
    },
    [ingestDroppedEntries],
  );

  const openAttachmentPicker = useCallback((kind: 'files' | 'folder') => {
    // Close the Ant Design menu before the blocking native picker opens.
    setAttachmentMenuOpen(false);
    requestAnimationFrame(() => {
      (kind === 'files' ? fileInputRef.current : folderInputRef.current)?.click();
    });
  }, []);

  const handleSend = useCallback(() => {
    const msg = text.trim();
    const readyRefs = references.filter((r) => r.status === 'ready');
    if ((!msg && attachments.length === 0 && readyRefs.length === 0) || !isConnected || sessionRun.isBusy) return;
    if (references.some((r) => r.status === 'uploading')) {
      message.warning(t('chat.refUploadingHint', { defaultValue: 'Some references are still uploading — please wait' }));
      return;
    }

    const doSend = () => {
      if (msg) {
        inputHistory.push(msg);
        inputHistory.reset();
        draftRef.current = null;
      }
      setHistoryPopupOpen(false);
      setText('');
      setAttachments([]);
      setReferences([]);
      try { localStorage.removeItem(DRAFT_STORAGE_PREFIX + sessionKey); } catch { /* ignore */ }
      send(
        msg,
        attachments.length > 0 ? attachments : undefined,
        readyRefs.length > 0 ? { references: readyRefs.map((r) => r.path) } : undefined,
      );
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
      modal.confirm({
        title: t('chat.staleSessionConfirmTitle'),
        content: t('chat.staleSessionConfirmBody'),
        okText: t('chat.staleSessionConfirmOk'),
        cancelText: t('chat.staleSessionConfirmCancel'),
        centered: true,
        onOk: () => {
          acknowledgeStaleSessionSend(sessionKey);
          doSend();
        },
      });
      return;
    }

    doSend();
  }, [text, attachments, references, isConnected, sessionRun.isBusy, send, sessionKey, inputHistory, t, modal]);

  const abortShortcut = abortChatShortcutLabel();
  const abortTooltip = t('chat.abortWithShortcut', {
    shortcut: abortShortcut,
    defaultValue: 'Stop ({{shortcut}})',
  });

  const handleCompositionStart = () => {
    composingRef.current = true;
    setIsComposing(true);
  };

  const handleCompositionEnd = () => {
    composingRef.current = false;
    setIsComposing(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Do not intercept during IME composition (e.g. Chinese pinyin input).
    // composingRef is the primary guard — survives remote desktop tools
    // (ToDesk, etc.) that may not set isComposing correctly.
    if (composingRef.current || e.nativeEvent.isComposing || e.keyCode === 229) return;

    // Let slash command menu handle navigation keys first
    if (slashMenu.handleKeyDown(e)) return;
    // Then the `@`-mention reference menu (mutually exclusive trigger chars)
    if (refMenu.handleKeyDown(e)) return;

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
    setCaret(e.target.selectionStart ?? e.target.value.length);
    // Auto-resize
    const el = e.target;
    el.style.height = 'auto';
    resizeComposerInput(el);
  };

  // Keep the caret position in sync for the `@`-mention detector (clicks, arrows).
  const syncCaret = useCallback(() => {
    const el = textareaRef.current;
    if (el) {
      const start = el.selectionStart ?? 0;
      const end = el.selectionEnd ?? start;
      setCaret(start);
      lastSelectionRef.current = { start, end };
    }
  }, []);

  const insertQuickCommand = useCallback((preset: { content: string }) => {
    if (composingRef.current) return;
    const el = textareaRef.current;
    if (!el) return;
    const result = insertTextAtSelection(el, preset.content, lastSelectionRef.current);
    setText(result.value);
    setCaret(result.caret);
    lastSelectionRef.current = { start: result.caret, end: result.caret };
    el.style.height = 'auto';
    resizeComposerInput(el);
  }, []);

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
          <Image.PreviewGroup>
            {attachments.map((att) => (
              <div key={att.id} className="chat-attachment">
                <Image
                  rootClassName="chat-attachment-thumb"
                  src={att.dataUrl}
                  alt=""
                  width={64}
                  height={64}
                  preview={{ mask: t('chat.previewZoom', { defaultValue: '预览' }) }}
                />
                <button
                  type="button"
                  className="chat-attachment-remove"
                  onClick={() => removeAttachment(att.id)}
                  aria-label={t('common.remove', { defaultValue: 'Remove' })}
                >
                  ×
                </button>
              </div>
            ))}
          </Image.PreviewGroup>
        </div>
      )}

      {attachNoVisionModel && (
        <div className="chat-composer-novision" role="status">
          {t('chat.attachNoVisionModel')}
        </div>
      )}

      {references.length > 0 && (
        <div className="chat-composer-references">
          {references.map((ref) => {
            const isDir = ref.path.endsWith('/');
            const icon = isImagePath(ref.path)
              ? <PictureOutlined />
              : isDir
                ? <FolderOutlined />
                : <FileOutlined />;
            return (
              <div
                key={ref.id}
                className={`chat-reference-chip is-${ref.status}`}
                title={ref.status === 'error' ? (ref.errorMsg || ref.path) : ref.path}
              >
                <span className="chat-reference-icon" aria-hidden="true">
                  {ref.status === 'uploading' ? <LoadingOutlined spin /> : icon}
                </span>
                <span className="chat-reference-name">{ref.name}</span>
                {ref.status === 'error' && (
                  <button
                    type="button"
                    className="chat-reference-retry"
                    onClick={() => retryReference(ref.id)}
                  >
                    {t('chat.refRetry', { defaultValue: 'Retry' })}
                  </button>
                )}
                <button
                  type="button"
                  className="chat-reference-remove"
                  onClick={() => removeReference(ref.id)}
                  aria-label={t('chat.refRemove', { defaultValue: 'Remove reference' })}
                >
                  <CloseOutlined />
                </button>
              </div>
            );
          })}
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
        <ReferenceMenu
          items={refMenu.items}
          activeIndex={refMenu.activeIndex}
          onSelect={refMenu.handleSelect}
          onHover={refMenu.setActiveIndex}
          visible={refMenu.visible}
        />

        <span className="chat-composer-prompt" aria-hidden="true">›</span>

        <textarea
          ref={textareaRef}
          className="chat-composer-input"
          value={text}
          onChange={handleInput}
          onKeyDown={handleKeyDown}
          onKeyUp={syncCaret}
          onClick={syncCaret}
          onSelect={syncCaret}
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
          multiple
          hidden
          onChange={(e) => handlePickerChange(e.currentTarget)}
        />
        <input
          ref={folderInputRef}
          type="file"
          hidden
          {...({ webkitdirectory: '' } as React.InputHTMLAttributes<HTMLInputElement>)}
          onChange={(e) => handlePickerChange(e.currentTarget)}
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
          <Dropdown
            open={attachmentMenuOpen}
            onOpenChange={setAttachmentMenuOpen}
            trigger={['click']}
            placement="topRight"
            menu={{
              items: [
                {
                  key: 'files',
                  icon: <FileOutlined />,
                  label: t('chat.selectFiles', { defaultValue: 'Select files' }),
                },
                {
                  key: 'folder',
                  icon: <FolderOutlined />,
                  label: t('chat.selectFolder', { defaultValue: 'Select folder' }),
                },
              ],
              onClick: ({ key }) => openAttachmentPicker(key === 'folder' ? 'folder' : 'files'),
            }}
          >
            <Tooltip title={t('chat.attachAttachment', { defaultValue: 'Add attachment' })}>
              <Button
                type="text"
                size="small"
                icon={<PaperClipOutlined />}
                disabled={!isConnected || sending}
                aria-label={t('chat.attachAttachment', { defaultValue: 'Add attachment' })}
                aria-haspopup="menu"
                aria-expanded={attachmentMenuOpen}
              />
            </Tooltip>
          </Dropdown>
          <QuickCommands
            disabled={!isConnected || sending}
            composing={isComposing}
            onTriggerMouseDown={syncCaret}
            onInsert={insertQuickCommand}
          />
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
                aria-label={abortTooltip}
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
