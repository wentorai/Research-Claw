import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { App, Button, Dropdown, Modal, Spin, Typography, Upload } from 'antd';
import type { MenuProps } from 'antd';
import {
  FileOutlined,
  FilePdfOutlined,
  FileTextOutlined,
  CodeOutlined,
  TableOutlined,
  PictureOutlined,
  BookOutlined,
  FolderOutlined,
  FolderOpenOutlined,
  UploadOutlined,
  EditOutlined,
  InboxOutlined,
  ExportOutlined,
  FolderViewOutlined,
  CopyOutlined,
  DeleteOutlined,
  LoadingOutlined,
  PlusOutlined,
  SearchOutlined,
  CloseCircleFilled,
} from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import { useGatewayStore } from '../../stores/gateway';
import { useUiStore } from '../../stores/ui';
import { getThemeTokens } from '../../styles/theme';
import { useConfigStore } from '../../stores/config';
import FilePreviewModal from './FilePreviewModal';
import DockerFileModal from './DockerFileModal';
import type { DockerFileModalProps } from './DockerFileModal';

const { Text } = Typography;
const { Dragger } = Upload;

// --- Shared inline name input with IME guard (rename + create) ---

interface InlineNameInputProps {
  defaultValue?: string;
  icon: React.ReactNode;
  iconColor: string;
  depth: number;
  tokens: ReturnType<typeof getThemeTokens>;
  loading?: boolean;
  onConfirm: (name: string) => void;
  onCancel: () => void;
}

function InlineNameInput({ defaultValue = '', icon, iconColor, depth, tokens, loading, onConfirm, onCancel }: InlineNameInputProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const composingRef = useRef(false);
  const committedRef = useRef(false);

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    if (defaultValue) {
      const dotIdx = defaultValue.lastIndexOf('.');
      el.setSelectionRange(0, dotIdx > 0 ? dotIdx : defaultValue.length);
    }
  }, [defaultValue]);

  const commit = useCallback((value: string) => {
    if (committedRef.current) return;
    const trimmed = value.trim();
    if (!trimmed || trimmed.includes('/') || trimmed === '.' || trimmed === '..') {
      committedRef.current = true;
      onCancel();
      return;
    }
    committedRef.current = true;
    onConfirm(trimmed);
  }, [onConfirm, onCancel]);

  const cancel = useCallback(() => {
    if (committedRef.current) return;
    committedRef.current = true;
    onCancel();
  }, [onCancel]);

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: '2px 8px 2px 0',
        paddingLeft: 8 + depth * 16,
        fontSize: 12,
        opacity: loading ? 0.6 : 1,
        transition: 'opacity 0.15s',
      }}
    >
      {loading
        ? <LoadingOutlined style={{ fontSize: 14, flexShrink: 0, color: 'var(--accent-secondary)' }} spin />
        : <span style={{ color: iconColor, fontSize: 14, flexShrink: 0 }}>{icon}</span>}
      <input
        ref={inputRef}
        defaultValue={defaultValue}
        disabled={loading}
        onCompositionStart={() => { composingRef.current = true; }}
        onCompositionEnd={() => { composingRef.current = false; }}
        onKeyDown={(e) => {
          if (loading) return;
          if (e.key === 'Escape') { e.preventDefault(); cancel(); return; }
          if (e.key === 'Enter' && !composingRef.current) {
            e.preventDefault();
            commit(inputRef.current?.value ?? '');
          }
        }}
        onBlur={() => {
          if (loading) return;
          setTimeout(() => {
            if (!committedRef.current) cancel();
          }, 80);
        }}
        style={{
          flex: 1,
          fontSize: 12,
          fontFamily: 'inherit',
          padding: '1px 4px',
          border: `1px solid ${loading ? 'var(--border)' : 'var(--accent-secondary)'}`,
          borderRadius: 3,
          background: tokens.bg.surface,
          color: loading ? tokens.text.muted : tokens.text.primary,
          outline: 'none',
          minWidth: 0,
          cursor: loading ? 'wait' : undefined,
        }}
      />
    </div>
  );
}

// --- Types from 03c §8 ---

interface FileEntry {
  name: string;
  path: string;
  type: 'file' | 'directory';
  size?: number;
  mime_type?: string;
  modified_at?: string;
  git_status?: 'new' | 'modified' | 'committed' | 'untracked';
}

interface TreeNode extends FileEntry {
  children?: TreeNode[];
}

interface CommitEntry {
  hash: string;
  short_hash: string;
  message: string;
  author: string;
  timestamp: string;
  files_changed: number;
}

// --- File icon helpers ---

function getFileIcon(name: string, type: 'file' | 'directory', isOpen?: boolean): { icon: React.ReactNode; color: string } {
  if (type === 'directory') {
    return { icon: isOpen ? <FolderOpenOutlined /> : <FolderOutlined />, color: '#71717A' };
  }
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  switch (ext) {
    case 'pdf': return { icon: <FilePdfOutlined />, color: '#EF4444' };
    case 'tex': case 'md': case 'txt': return { icon: <FileTextOutlined />, color: '#A1A1AA' };
    case 'py': case 'r': case 'jl': case 'm': case 'ts': case 'js': return { icon: <CodeOutlined />, color: '#22C55E' };
    case 'csv': case 'xlsx': case 'json': return { icon: <TableOutlined />, color: '#3B82F6' };
    case 'png': case 'jpg': case 'jpeg': case 'svg': case 'gif': return { icon: <PictureOutlined />, color: '#A855F7' };
    case 'bib': return { icon: <BookOutlined />, color: '#F59E0B' };
    default: return { icon: <FileOutlined />, color: '#71717A' };
  }
}

function GitBadge({ status }: { status?: string }) {
  if (!status || status === 'committed') return null;
  const isNew = status === 'new' || status === 'untracked';
  return (
    <span
      style={{
        fontSize: 10,
        fontWeight: 600,
        color: isNew ? '#22C55E' : '#3B82F6',
        marginLeft: 4,
        fontFamily: "'Fira Code', monospace",
      }}
    >
      {isNew ? '+' : 'M'}
    </span>
  );
}

function relativeTime(timestamp: string, t: (key: string, opts?: Record<string, unknown>) => string): string {
  const diff = Date.now() - new Date(timestamp).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return t('time.justNow');
  if (mins < 60) return t('time.minutesAgo', { count: mins });
  const hours = Math.floor(mins / 60);
  if (hours < 24) return t('time.hoursAgo', { count: hours });
  const days = Math.floor(hours / 24);
  return t('time.daysAgo', { count: days });
}

// --- Inline rename input (replaces name span in-place) ---

interface RenameInputProps {
  defaultValue: string;
  isFile: boolean;
  tokens: ReturnType<typeof getThemeTokens>;
  onConfirm: (name: string) => void;
  onCancel: () => void;
}

function RenameInput({ defaultValue, isFile, tokens, onConfirm, onCancel }: RenameInputProps) {
  const committedRef = useRef(false);
  const didFocusRef = useRef(false);

  const commit = useCallback((value: string) => {
    if (committedRef.current) return;
    const trimmed = value.trim();
    if (!trimmed || trimmed === defaultValue || trimmed.includes('/') || trimmed === '.' || trimmed === '..') {
      if (!committedRef.current) { committedRef.current = true; onCancel(); }
      return;
    }
    committedRef.current = true;
    onConfirm(trimmed);
  }, [defaultValue, onConfirm, onCancel]);

  const cancel = useCallback(() => {
    if (committedRef.current) return;
    committedRef.current = true;
    onCancel();
  }, [onCancel]);

  return (
    <input
      ref={(el) => {
        if (!el || didFocusRef.current) return;
        didFocusRef.current = true;
        el.focus();
        const dotIdx = defaultValue.lastIndexOf('.');
        el.setSelectionRange(0, dotIdx > 0 && isFile ? dotIdx : defaultValue.length);
      }}
      defaultValue={defaultValue}
      onCompositionStart={(e) => { (e.target as HTMLInputElement).dataset.composing = '1'; }}
      onCompositionEnd={(e) => { (e.target as HTMLInputElement).dataset.composing = ''; }}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Escape') { e.preventDefault(); cancel(); return; }
        if (e.key === 'Enter' && !(e.target as HTMLInputElement).dataset.composing) {
          e.preventDefault();
          commit((e.target as HTMLInputElement).value);
        }
      }}
      onBlur={(e) => {
        setTimeout(() => commit(e.target.value), 80);
      }}
      onClick={(e) => e.stopPropagation()}
      style={{
        flex: 1, fontSize: 12, fontFamily: 'inherit',
        padding: '0 4px', border: '1px solid var(--accent-secondary)',
        borderRadius: 3, background: tokens.bg.surface, color: tokens.text.primary,
        outline: 'none', minWidth: 0,
      }}
    />
  );
}

// --- Tree search filter utility ---

function filterTree(nodes: TreeNode[], query: string): TreeNode[] {
  if (!query) return nodes;
  const q = query.toLowerCase();
  const filter = (list: TreeNode[]): TreeNode[] => {
    const result: TreeNode[] = [];
    for (const node of list) {
      if (node.type === 'directory') {
        const filteredChildren = node.children ? filter(node.children) : [];
        const nameMatch = node.name.toLowerCase().includes(q);
        if (nameMatch || filteredChildren.length > 0) {
          result.push({ ...node, children: nameMatch ? node.children : filteredChildren });
        }
      } else {
        if (node.name.toLowerCase().includes(q)) {
          result.push(node);
        }
      }
    }
    return result;
  };
  return filter(nodes);
}

// --- FileTree component ---

interface CreatingItem {
  parentPath: string;
  type: 'file' | 'directory';
}

interface FileTreeNodeProps {
  node: TreeNode;
  depth: number;
  tokens: ReturnType<typeof getThemeTokens>;
  workspaceRoot: string;
  dragSrcPath: string | null;
  movingPath: string | null;
  creatingItem: CreatingItem | null;
  onOpenFile?: (path: string) => void;
  onDeleted?: () => void;
  onMoved?: () => void;
  onDragSrcChange?: (path: string | null) => void;
  onMoveStart?: (path: string) => void;
  onMoveEnd?: () => void;
  onCreateItem?: (item: CreatingItem) => void;
  onCreateDone?: () => void;
}

function FileTreeNode({ node, depth, tokens, workspaceRoot, dragSrcPath, movingPath, creatingItem, onOpenFile, onDeleted, onMoved, onDragSrcChange, onMoveStart, onMoveEnd, onCreateItem, onCreateDone }: FileTreeNodeProps) {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const client = useGatewayStore((s) => s.client);
  const [expanded, setExpanded] = useState(depth < 2);
  const [dragOver, setDragOver] = useState(false);
  const [isRenaming, setIsRenaming] = useState(false);
  const [dockerModal, setDockerModal] = useState<Omit<DockerFileModalProps, 'open' | 'onClose'> | null>(null);
  const expandTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { icon, color } = getFileIcon(node.name, node.type, expanded);
  const isMoving = movingPath === node.path;

  // Auto-expand folder when a new item is being created inside it
  const isCreatingHere = creatingItem !== null && creatingItem.parentPath === node.path;
  useEffect(() => {
    if (isCreatingHere && !expanded) setExpanded(true);
  }, [isCreatingHere, expanded]);

  const contextMenuItems: MenuProps['items'] = useMemo(() => {
    const items: MenuProps['items'] = [];

    // New File / New Folder — only for directories
    if (node.type === 'directory') {
      items.push(
        {
          key: 'newFile',
          icon: <FileOutlined />,
          label: t('workspace.contextMenu.newFile'),
          onClick: () => onCreateItem?.({ parentPath: node.path, type: 'file' }),
        },
        {
          key: 'newFolder',
          icon: <FolderOutlined />,
          label: t('workspace.contextMenu.newFolder'),
          onClick: () => onCreateItem?.({ parentPath: node.path, type: 'directory' }),
        },
        { type: 'divider' as const },
      );
    }

    // "Open File" — files only
    if (node.type !== 'directory') {
      items.push({
        key: 'openExternal',
        icon: <ExportOutlined />,
        label: t('workspace.contextMenu.openExternal'),
        onClick: () => {
          client?.request<Record<string, unknown>>('rc.ws.openExternal', { path: node.path }).then((res) => {
            if (res?.fallback === 'docker') {
              setDockerModal({
                mode: 'file',
                containerPath: String(res.containerPath ?? ''),
                relativePath: String(res.relativePath ?? node.path),
                fileName: String(res.fileName ?? node.name),
              });
            }
          }).catch(() => {
            message.error(t('workspace.contextMenu.openFailed'));
          });
        },
      });
    }
    // "Open Folder" — files: open parent; directories: open self
    items.push(
      {
        key: 'openFolder',
        icon: <FolderViewOutlined />,
        label: t('workspace.contextMenu.openFolder'),
        onClick: () => {
          client?.request<Record<string, unknown>>('rc.ws.openFolder', { path: node.path }).then((res) => {
            if (res?.fallback === 'docker') {
              setDockerModal({
                mode: 'folder',
                containerPath: String(res.containerPath ?? ''),
                relativePath: String(res.relativePath ?? node.path),
              });
            }
          }).catch(() => {
            message.error(t('workspace.contextMenu.openFailed'));
          });
        },
      },
      { type: 'divider' as const },
      {
        key: 'copyPath',
        icon: <CopyOutlined />,
        label: t('workspace.contextMenu.copyPath'),
        onClick: () => {
          const absolutePath = workspaceRoot
            ? `${workspaceRoot.replace(/\/$/, '')}/${node.path}`
            : node.path;
          navigator.clipboard.writeText(absolutePath).then(() => {
            message.success(t('workspace.contextMenu.pathCopied'));
          });
        },
      },
      {
        key: 'rename',
        icon: <EditOutlined />,
        label: t('workspace.contextMenu.rename'),
        onClick: () => setIsRenaming(true),
      },
      { type: 'divider' as const },
      {
        key: 'delete',
        icon: <DeleteOutlined />,
        label: t('workspace.contextMenu.delete'),
        danger: true,
        onClick: () => {
          Modal.confirm({
            title: t('workspace.contextMenu.deleteConfirmTitle'),
            content: node.path,
            okText: t('workspace.contextMenu.deleteOk'),
            cancelText: t('workspace.contextMenu.deleteCancel'),
            okButtonProps: { danger: true },
            onOk: async () => {
              try {
                await client?.request('rc.ws.delete', { path: node.path });
                message.success(t('workspace.contextMenu.deleteSuccess'));
                onDeleted?.();
              } catch {
                message.error(t('workspace.contextMenu.deleteFailed'));
              }
            },
          });
        },
      },
    );

    return items;
  }, [node.path, node.type, t, client, workspaceRoot, onDeleted, message, onCreateItem]);

  // --- Drag source: lightweight custom ghost image ---
  const handleDragStart = useCallback((e: React.DragEvent) => {
    e.dataTransfer.setData('text/x-workspace-path', node.path);
    e.dataTransfer.effectAllowed = 'move';
    onDragSrcChange?.(node.path);
    // Create a small, unobtrusive drag ghost so it doesn't block drop targets
    const ghost = document.createElement('div');
    ghost.textContent = node.name;
    ghost.style.cssText =
      'position:fixed;top:-999px;left:-999px;padding:4px 10px;border-radius:4px;' +
      'font-size:12px;background:rgba(59,130,246,0.85);color:#fff;white-space:nowrap;' +
      'pointer-events:none;z-index:9999;max-width:200px;overflow:hidden;text-overflow:ellipsis';
    document.body.appendChild(ghost);
    e.dataTransfer.setDragImage(ghost, 0, 0);
    // Clean up the off-screen element after the browser captures it
    requestAnimationFrame(() => document.body.removeChild(ghost));
  }, [node.path, node.name, onDragSrcChange]);

  // --- Drop target (directories only) + auto-expand on hover ---
  // Block: self-drop, dropping onto own parent, ancestor→descendant
  const isInvalidDropTarget = useCallback((src: string | null): boolean => {
    if (!src) return false;
    // Can't drop onto self
    if (src === node.path) return true;
    // Can't drop onto own parent directory
    const srcDir = src.includes('/') ? src.substring(0, src.lastIndexOf('/')) : '';
    if (srcDir === node.path) return true;
    // Can't drop ancestor into descendant (prevents circular moves)
    if (node.path.startsWith(src + '/')) return true;
    return false;
  }, [node.path]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    if (node.type !== 'directory') return;
    if (!e.dataTransfer.types.includes('text/x-workspace-path')) return;
    // Block invalid drop targets using the lifted dragSrcPath
    if (isInvalidDropTarget(dragSrcPath)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (!dragOver) {
      setDragOver(true);
      // Auto-expand collapsed folder after 500ms hover
      if (!expanded) {
        expandTimerRef.current = setTimeout(() => setExpanded(true), 500);
      }
    }
  }, [node.type, dragOver, expanded, dragSrcPath, isInvalidDropTarget]);

  const handleDragLeave = useCallback(() => {
    setDragOver(false);
    if (expandTimerRef.current) {
      clearTimeout(expandTimerRef.current);
      expandTimerRef.current = null;
    }
  }, []);

  // --- Rename handler ---
  const handleRename = useCallback(async (newName: string) => {
    setIsRenaming(false);
    if (newName === node.name) return;
    const parentDir = node.path.includes('/') ? node.path.substring(0, node.path.lastIndexOf('/')) : '';
    const destPath = parentDir ? `${parentDir}/${newName}` : newName;
    onMoveStart?.(node.path);
    try {
      await client?.request('rc.ws.move', { from: node.path, to: destPath });
      message.success(t('workspace.renameSuccess'));
      onMoved?.();
    } catch (err) {
      console.error('[WorkspacePanel] rename failed:', err);
      message.error(t('workspace.renameFailed'));
    } finally {
      onMoveEnd?.();
    }
  }, [node.path, node.name, client, t, message, onMoved, onMoveStart, onMoveEnd]);

  // --- Create file/folder handler ---
  const [createLoading, setCreateLoading] = useState(false);
  const handleCreate = useCallback(async (name: string) => {
    if (!isCreatingHere || !creatingItem) return;
    const fullPath = `${node.path}/${name}`;
    setCreateLoading(true);
    try {
      if (creatingItem.type === 'directory') {
        await client?.request('rc.ws.mkdir', { path: fullPath });
      } else {
        await client?.request('rc.ws.save', { path: fullPath, content: '', message: `Add: ${name}` });
      }
      message.success(t('workspace.createSuccess'));
      onMoved?.();
    } catch (err) {
      console.error('[WorkspacePanel] create failed:', err);
      message.error(t('workspace.createFailed'));
    } finally {
      setCreateLoading(false);
      onCreateDone?.();
    }
  }, [isCreatingHere, creatingItem, node.path, client, t, message, onMoved, onCreateDone]);

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    setDragOver(false);
    if (expandTimerRef.current) {
      clearTimeout(expandTimerRef.current);
      expandTimerRef.current = null;
    }
    if (node.type !== 'directory') return;
    e.preventDefault();

    const srcPath = e.dataTransfer.getData('text/x-workspace-path');
    if (!srcPath) return;

    // Block: self, parent, ancestor→descendant
    if (isInvalidDropTarget(srcPath)) return;

    const fileName = srcPath.includes('/') ? srcPath.substring(srcPath.lastIndexOf('/') + 1) : srcPath;
    const destPath = `${node.path}/${fileName}`;

    onMoveStart?.(srcPath);
    try {
      await client?.request('rc.ws.move', { from: srcPath, to: destPath });
      // Auto-expand the target folder so the user sees the moved file
      setExpanded(true);
      message.success(t('workspace.moveSuccess', { defaultValue: `Moved to ${node.name}` }));
      onMoved?.();
    } catch (err) {
      console.error('[WorkspacePanel] move failed:', err);
      message.error(t('workspace.moveFailed', { defaultValue: 'Move failed' }));
    } finally {
      onMoveEnd?.();
    }
  }, [node, client, t, message, onMoved, isInvalidDropTarget, onMoveStart, onMoveEnd]);

  return (
    <div>
      <Dropdown menu={{ items: contextMenuItems }} trigger={['contextMenu']}>
        <div
          draggable={!isMoving}
          onDragStart={handleDragStart}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          onClick={() => {
            if (isMoving) return;
            if (node.type === 'directory') {
              setExpanded(!expanded);
            } else {
              onOpenFile?.(node.path);
            }
          }}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            padding: '3px 8px 3px 0',
            paddingLeft: 8 + depth * 16,
            cursor: isMoving ? 'wait' : 'pointer',
            fontSize: 12,
            color: tokens.text.primary,
            background: dragOver ? 'rgba(59, 130, 246, 0.15)' : 'transparent',
            borderRadius: dragOver ? 4 : 0,
            opacity: isMoving ? 0.45 : 1,
            transition: 'background 0.15s, opacity 0.2s',
            animation: isMoving ? 'rc-pulse 1.2s ease-in-out infinite' : undefined,
          }}
          onMouseEnter={(e) => {
            if (!dragOver && !isMoving) (e.currentTarget as HTMLElement).style.background = tokens.bg.surfaceHover;
          }}
          onMouseLeave={(e) => {
            if (!dragOver && !isMoving) (e.currentTarget as HTMLElement).style.background = 'transparent';
          }}
        >
          <span style={{ color, fontSize: 14, flexShrink: 0 }}>{icon}</span>
          {isRenaming ? (
            <RenameInput
              defaultValue={node.name}
              isFile={node.type === 'file'}
              tokens={tokens}
              onConfirm={handleRename}
              onCancel={() => setIsRenaming(false)}
            />
          ) : (
            <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {node.name}
            </span>
          )}
          {isMoving
            ? <LoadingOutlined style={{ fontSize: 10, color: tokens.text.muted }} spin />
            : !isRenaming && <GitBadge status={node.git_status} />}
        </div>
      </Dropdown>
      {expanded && (
        <>
          {isCreatingHere && creatingItem && (
            <InlineNameInput
              icon={creatingItem.type === 'directory' ? <FolderOutlined /> : <FileOutlined />}
              iconColor="#71717A"
              depth={depth + 1}
              tokens={tokens}
              loading={createLoading}
              onConfirm={handleCreate}
              onCancel={() => onCreateDone?.()}
            />
          )}
          {node.children?.map((child) => (
            <FileTreeNode key={child.path} node={child} depth={depth + 1} tokens={tokens} workspaceRoot={workspaceRoot} dragSrcPath={dragSrcPath} movingPath={movingPath} creatingItem={creatingItem} onOpenFile={onOpenFile} onDeleted={onDeleted} onMoved={onMoved} onDragSrcChange={onDragSrcChange} onMoveStart={onMoveStart} onMoveEnd={onMoveEnd} onCreateItem={onCreateItem} onCreateDone={onCreateDone} />
          ))}
        </>
      )}
      {dockerModal && (
        <DockerFileModal
          open
          onClose={() => setDockerModal(null)}
          {...dockerModal}
        />
      )}
    </div>
  );
}

// --- Inline diff renderer ---

const MAX_DIFF_LINES = 80;

function DiffView({ diff, tokens }: { diff: string; tokens: ReturnType<typeof getThemeTokens> }) {
  if (!diff.trim()) return null;

  const lines = diff.split('\n');
  const truncated = lines.length > MAX_DIFF_LINES;
  const visible = truncated ? lines.slice(0, MAX_DIFF_LINES) : lines;

  return (
    <div style={{
      margin: '4px 0 6px 20px',
      padding: '6px 8px',
      borderRadius: 4,
      background: tokens.bg.secondary,
      border: `1px solid ${tokens.border.default}`,
      fontFamily: "'Fira Code', 'Consolas', monospace",
      fontSize: 11,
      lineHeight: 1.5,
      overflowX: 'auto',
      maxHeight: 300,
      overflowY: 'auto',
    }}>
      {visible.map((line, i) => {
        let color = tokens.text.muted;
        let bg = 'transparent';
        if (line.startsWith('+') && !line.startsWith('+++')) {
          color = '#4ade80'; bg = 'rgba(74, 222, 128, 0.08)';
        } else if (line.startsWith('-') && !line.startsWith('---')) {
          color = '#f87171'; bg = 'rgba(248, 113, 113, 0.08)';
        } else if (line.startsWith('@@')) {
          color = '#60a5fa'; bg = 'rgba(96, 165, 250, 0.06)';
        } else if (line.startsWith('diff ') || line.startsWith('index ')) {
          color = tokens.text.muted;
        } else {
          color = tokens.text.secondary;
        }
        return (
          <div key={i} style={{ color, background: bg, padding: '0 4px', whiteSpace: 'pre' }}>
            {line || '\u00a0'}
          </div>
        );
      })}
      {truncated && (
        <div style={{ color: tokens.text.muted, fontStyle: 'italic', padding: '4px 4px 0' }}>
          ...truncated ({lines.length - MAX_DIFF_LINES} more lines)
        </div>
      )}
    </div>
  );
}

// --- RecentChanges component ---

function RecentChanges({ commits, tokens, hasMore, onLoadMore, loadingMore }: {
  commits: CommitEntry[];
  tokens: ReturnType<typeof getThemeTokens>;
  hasMore: boolean;
  onLoadMore: () => void;
  loadingMore: boolean;
}) {
  const { t } = useTranslation();
  const client = useGatewayStore((s) => s.client);
  const [expandedHash, setExpandedHash] = useState<string | null>(null);
  const [diffContent, setDiffContent] = useState<string>('');
  const [diffLoading, setDiffLoading] = useState(false);

  // Git's well-known empty tree hash — used to diff the initial commit
  const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf899d69f7cb0cab1';

  const handleToggleDiff = useCallback(async (hash: string) => {
    if (expandedHash === hash) {
      setExpandedHash(null);
      return;
    }
    setExpandedHash(hash);
    setDiffLoading(true);
    setDiffContent('');
    try {
      const result = await client?.request<{ diff: string }>('rc.ws.diff', {
        from: `${hash}^`,
        to: hash,
      });
      setDiffContent(result?.diff ?? '');
    } catch {
      // hash^ fails for the initial commit (no parent) — diff against empty tree
      try {
        const fallback = await client?.request<{ diff: string }>('rc.ws.diff', {
          from: EMPTY_TREE,
          to: hash,
        });
        setDiffContent(fallback?.diff ?? '');
      } catch {
        setDiffContent('');
      }
    } finally {
      setDiffLoading(false);
    }
  }, [expandedHash, client]);

  if (commits.length === 0) return null;

  return (
    <div style={{ padding: '0 16px 8px' }}>
      <Text strong style={{ fontSize: 12, textTransform: 'uppercase', letterSpacing: 0.5, color: tokens.text.muted }}>
        {t('workspace.recentChanges')}
      </Text>
      <div style={{ marginTop: 6 }}>
        {commits.map((commit) => (
          <div key={commit.hash}>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '4px 0',
                fontSize: 12,
                cursor: 'pointer',
                borderRadius: 4,
              }}
              onClick={() => handleToggleDiff(commit.hash)}
            >
              <span style={{
                color: tokens.text.muted,
                fontSize: 10,
                flexShrink: 0,
                transition: 'transform 0.15s',
                transform: expandedHash === commit.hash ? 'rotate(90deg)' : 'rotate(0deg)',
                display: 'inline-block',
              }}>
                ▶
              </span>
              <Text
                ellipsis
                style={{ flex: 1, fontSize: 12, color: tokens.text.primary }}
              >
                {commit.message}
              </Text>
              <Text style={{ fontSize: 11, color: tokens.text.muted, flexShrink: 0, fontFamily: "'Fira Code', monospace" }}>
                {relativeTime(commit.timestamp, t)}
              </Text>
            </div>
            {expandedHash === commit.hash && (
              diffLoading
                ? <div style={{ padding: '8px 20px', fontSize: 11, color: tokens.text.muted }}>
                    <LoadingOutlined spin style={{ marginRight: 6 }} />
                    {t('workspace.diffLoading')}
                  </div>
                : <DiffView diff={diffContent} tokens={tokens} />
            )}
          </div>
        ))}
      </div>
      {hasMore && (
        <Button
          type="link"
          size="small"
          loading={loadingMore}
          onClick={onLoadMore}
          style={{ fontSize: 11, padding: '4px 0', color: tokens.text.muted }}
        >
          {t('workspace.loadMore')}
        </Button>
      )}
    </div>
  );
}

export default function WorkspacePanel() {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const configTheme = useConfigStore((s) => s.theme);
  const tokens = useMemo(() => getThemeTokens(configTheme), [configTheme]);
  const client = useGatewayStore((s) => s.client);
  const connState = useGatewayStore((s) => s.state);
  const workspaceRefreshKey = useUiStore((s) => s.workspaceRefreshKey);
  const pendingPreviewPath = useUiStore((s) => s.pendingPreviewPath);
  const clearPendingPreview = useUiStore((s) => s.clearPendingPreview);
  const showSystemFiles = useUiStore((s) => s.showSystemFiles);
  const setShowSystemFiles = useUiStore((s) => s.setShowSystemFiles);

  const [tree, setTree] = useState<TreeNode[]>([]);
  const [commits, setCommits] = useState<CommitEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [previewPath, setPreviewPath] = useState<string | null>(null);
  const [workspaceRoot, setWorkspaceRoot] = useState('');
  const [uploading, setUploading] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const scrollRafRef = useRef<number | null>(null);

  // External file drag-over detection (OS → upload zone)
  const [externalDragOver, setExternalDragOver] = useState(false);
  const dragEnterCounterRef = useRef(0);

  // Drag-and-drop: track source path for self/ancestor guard (Fix #3)
  const [dragSrcPath, setDragSrcPath] = useState<string | null>(null);
  // Move loading state (Fix #4)
  const [movingPath, setMovingPath] = useState<string | null>(null);
  // Drop-to-root zone state (Fix #2)
  const [rootDropHover, setRootDropHover] = useState(false);
  // Create file/folder state
  const [creatingItem, setCreatingItem] = useState<CreatingItem | null>(null);
  // Root-level create (parentPath = '' sentinel)
  const [rootCreateType, setRootCreateType] = useState<'file' | 'directory' | null>(null);
  const [rootCreateLoading, setRootCreateLoading] = useState(false);
  // System files hidden count (from backend)
  const [hiddenCount, setHiddenCount] = useState(0);
  // History pagination
  const [hasMoreCommits, setHasMoreCommits] = useState(false);
  const [loadingMoreCommits, setLoadingMoreCommits] = useState(false);
  // Search state
  const [searchQuery, setSearchQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Auto-scroll file tree when dragging near top/bottom edges.
  // Uses requestAnimationFrame for smooth 60fps scrolling.
  const handleTreeDragOver = useCallback((e: React.DragEvent) => {
    const container = scrollRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const EDGE = 40; // px from edge to trigger scroll
    const SPEED = 6; // px per frame

    const y = e.clientY;
    const nearTop = y - rect.top < EDGE;
    const nearBottom = rect.bottom - y < EDGE;

    if (!nearTop && !nearBottom) {
      // Cursor in safe zone — stop scrolling
      if (scrollRafRef.current) {
        cancelAnimationFrame(scrollRafRef.current);
        scrollRafRef.current = null;
      }
      return;
    }

    // Already scrolling — let the rAF loop handle it
    if (scrollRafRef.current) return;

    const tick = () => {
      if (!scrollRef.current) return;
      if (nearTop) scrollRef.current.scrollTop -= SPEED;
      else scrollRef.current.scrollTop += SPEED;
      scrollRafRef.current = requestAnimationFrame(tick);
    };
    scrollRafRef.current = requestAnimationFrame(tick);
  }, []);

  // Stop auto-scroll when drag leaves the tree area or ends
  const stopAutoScroll = useCallback(() => {
    if (scrollRafRef.current) {
      cancelAnimationFrame(scrollRafRef.current);
      scrollRafRef.current = null;
    }
  }, []);

  // Clean up rAF on unmount
  useEffect(() => () => stopAutoScroll(), [stopAutoScroll]);

  // Clear drag source when drag ends anywhere in the panel
  const handlePanelDragEnd = useCallback(() => {
    setDragSrcPath(null);
    setRootDropHover(false);
  }, []);

  // Search debounce
  useEffect(() => {
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    searchTimerRef.current = setTimeout(() => setDebouncedQuery(searchQuery), 200);
    return () => { if (searchTimerRef.current) clearTimeout(searchTimerRef.current); };
  }, [searchQuery]);

  const filteredTree = useMemo(() => filterTree(tree, debouncedQuery), [tree, debouncedQuery]);

  const loadData = useCallback(async () => {
    if (!client?.isConnected) return;
    setLoading(true);
    try {
      console.log('[WorkspacePanel] loading tree & history');
      const [treeResult, historyResult] = await Promise.all([
        client.request<{ tree: TreeNode[]; workspace_root: string; hidden_count: number }>('rc.ws.tree', {
          // Increase depth so nested outputs (e.g. outputs/ppt/YYYY-MM-DD/*.pptx) are visible.
          depth: 5,
          includeHidden: showSystemFiles,
        }),
        client.request<{ commits: CommitEntry[]; total: number; has_more: boolean }>('rc.ws.history', { limit: 5 }),
      ]);
      setTree(treeResult.tree);
      setWorkspaceRoot(treeResult.workspace_root ?? '');
      setHiddenCount(treeResult.hidden_count ?? 0);
      setCommits(historyResult.commits);
      setHasMoreCommits(historyResult.has_more ?? false);
      setHasLoaded(true);
    } catch (err) {
      console.warn('[WorkspacePanel] loadData failed:', err);
    } finally {
      setLoading(false);
    }
  }, [client, showSystemFiles]);

  const loadMoreCommits = useCallback(async () => {
    if (!client?.isConnected || loadingMoreCommits) return;
    setLoadingMoreCommits(true);
    try {
      const result = await client.request<{ commits: CommitEntry[]; total: number; has_more: boolean }>(
        'rc.ws.history',
        { limit: 10, offset: commits.length },
      );
      setCommits((prev) => [...prev, ...result.commits]);
      setHasMoreCommits(result.has_more ?? false);
    } catch (err) {
      console.warn('[WorkspacePanel] loadMoreCommits failed:', err);
    } finally {
      setLoadingMoreCommits(false);
    }
  }, [client, loadingMoreCommits, commits.length]);

  // Root-level create handler
  const handleRootCreate = useCallback(async (name: string) => {
    setRootCreateLoading(true);
    try {
      if (rootCreateType === 'directory') {
        await client?.request('rc.ws.mkdir', { path: name });
      } else {
        await client?.request('rc.ws.save', { path: name, content: '', message: `Add: ${name}` });
      }
      message.success(t('workspace.createSuccess'));
      await loadData();
    } catch (err) {
      console.error('[WorkspacePanel] root create failed:', err);
      message.error(t('workspace.createFailed'));
    } finally {
      setRootCreateLoading(false);
      setRootCreateType(null);
    }
  }, [rootCreateType, client, t, message, loadData]);

  // --- Root drop zone handlers (Fix #2): internal files → move to root ---
  const handleRootDropZoneDragOver = useCallback((e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes('text/x-workspace-path')) return;
    // Only show root-drop when dragging internal workspace items
    if (!dragSrcPath) return;
    // Already at root (no '/') → no-op
    if (!dragSrcPath.includes('/')) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';
    setRootDropHover(true);
  }, [dragSrcPath]);

  const handleRootDropZoneDragLeave = useCallback(() => {
    setRootDropHover(false);
  }, []);

  const handleRootDropZoneDrop = useCallback(async (e: React.DragEvent) => {
    setRootDropHover(false);
    const srcPath = e.dataTransfer.getData('text/x-workspace-path');
    if (!srcPath || !srcPath.includes('/')) return;
    e.preventDefault();
    e.stopPropagation();

    const fileName = srcPath.substring(srcPath.lastIndexOf('/') + 1);
    const destPath = fileName;

    setMovingPath(srcPath);
    try {
      await client?.request('rc.ws.move', { from: srcPath, to: destPath });
      message.success(t('workspace.moveSuccess'));
      await loadData();
    } catch (err) {
      console.error('[WorkspacePanel] move to root failed:', err);
      message.error(t('workspace.moveFailed'));
    } finally {
      setMovingPath(null);
      setDragSrcPath(null);
    }
  }, [client, t, message, loadData]);

  useEffect(() => {
    if (connState === 'connected') {
      loadData();
    }
  }, [connState, loadData]);

  useEffect(() => {
    if (workspaceRefreshKey > 0 && connState === 'connected') {
      loadData();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceRefreshKey]);

  // Reload tree when showSystemFiles toggle changes
  useEffect(() => {
    if (hasLoaded && connState === 'connected') {
      loadData();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showSystemFiles]);

  useEffect(() => {
    if (pendingPreviewPath) {
      setPreviewPath(pendingPreviewPath);
      clearPendingPreview();
    }
  }, [pendingPreviewPath, clearPendingPreview]);

  const uploadOneFile = useCallback(
    async (file: File): Promise<boolean> => {
      const formData = new FormData();
      formData.append('file', file);
      formData.append('destination', 'uploads/');
      const token = new URLSearchParams(window.location.search).get('token') || 'research-claw';
      const res = await fetch('/rc/upload', {
        method: 'POST',
        body: formData,
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error?.message ?? `Upload failed (${res.status})`);
      }
      return true;
    },
    [],
  );

  const handleUpload = useCallback(
    async (file: File, fileList: File[]) => {
      if (uploading) return false;
      // Only trigger once for the first file in a multi-select batch
      if (file !== fileList[0]) return false;
      setUploading(true);
      let successCount = 0;
      let failCount = 0;
      try {
        for (const f of fileList) {
          try {
            await uploadOneFile(f);
            successCount++;
          } catch (err) {
            failCount++;
            console.error(`[WorkspacePanel] upload failed for ${f.name}:`, err);
          }
        }
        if (successCount > 0) {
          message.success(
            t('workspace.uploadSuccessWithPath', {
              count: successCount,
              path: 'uploads/',
              defaultValue: `${successCount} file(s) uploaded to uploads/`,
            }),
          );
        }
        if (failCount > 0) {
          message.error(
            t('workspace.uploadFailedMulti', { count: failCount, defaultValue: `${failCount} file(s) failed to upload` }),
          );
        }
        await loadData();
        setTimeout(() => loadData(), 1000);
      } finally {
        setUploading(false);
      }
      return false;
    },
    [uploading, uploadOneFile, loadData, t, message],
  );

  // --- External file drag-over detection (panel-level) ---
  const isExternalFileDrag = useCallback((e: React.DragEvent) => {
    return e.dataTransfer.types.includes('Files') && !e.dataTransfer.types.includes('text/x-workspace-path');
  }, []);

  const handlePanelDragEnter = useCallback((e: React.DragEvent) => {
    if (!isExternalFileDrag(e)) return;
    dragEnterCounterRef.current++;
    if (dragEnterCounterRef.current === 1) {
      setExternalDragOver(true);
    }
  }, [isExternalFileDrag]);

  const handlePanelDragOver = useCallback((e: React.DragEvent) => {
    if (!isExternalFileDrag(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  }, [isExternalFileDrag]);

  const handlePanelDragLeave = useCallback((e: React.DragEvent) => {
    if (!isExternalFileDrag(e)) return;
    dragEnterCounterRef.current--;
    if (dragEnterCounterRef.current <= 0) {
      dragEnterCounterRef.current = 0;
      setExternalDragOver(false);
    }
  }, [isExternalFileDrag]);

  const handlePanelDrop = useCallback((e: React.DragEvent) => {
    if (!isExternalFileDrag(e)) return;
    e.preventDefault();
    dragEnterCounterRef.current = 0;
    setExternalDragOver(false);

    const files = Array.from(e.dataTransfer.files);
    if (files.length > 0) {
      handleUpload(files[0], files);
    }
  }, [isExternalFileDrag, handleUpload]);

  return (
    <div
      style={{ display: 'flex', flexDirection: 'column', height: '100%' }}
      onDragEnd={handlePanelDragEnd}
      onDragEnter={handlePanelDragEnter}
      onDragOver={handlePanelDragOver}
      onDragLeave={handlePanelDragLeave}
      onDrop={handlePanelDrop}
    >
      <RecentChanges commits={commits} tokens={tokens} hasMore={hasMoreCommits} onLoadMore={loadMoreCommits} loadingMore={loadingMoreCommits} />

      {commits.length > 0 && tree.length > 0 && (
        <div style={{ borderTop: `1px solid ${tokens.border.default}`, margin: '4px 16px' }} />
      )}

      {/* Content area: loading spinner, empty state, or file tree */}
      {!hasLoaded && connState === 'connected' && tree.length === 0 ? (
        <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', flex: 1, minHeight: 200 }}>
          <Spin indicator={<LoadingOutlined style={{ fontSize: 24 }} spin />} />
        </div>
      ) : !loading && tree.length === 0 && commits.length === 0 ? (
        <div style={{ padding: 24, textAlign: 'center', paddingTop: 60 }}>
          <FolderOutlined style={{ fontSize: 48, color: tokens.text.muted, opacity: 0.4 }} />
          <div style={{ marginTop: 16, whiteSpace: 'pre-line' }}>
            <Text type="secondary" style={{ fontSize: 13 }}>
              {t('workspace.empty')}
            </Text>
          </div>
          <div style={{ marginTop: 24 }}>
            <Upload
              accept="*"
              multiple
              showUploadList={false}
              beforeUpload={handleUpload}
              disabled={uploading}
            >
              <Button icon={uploading ? <LoadingOutlined /> : <UploadOutlined />} size="small" loading={uploading}>
                {t('workspace.upload')}
              </Button>
            </Upload>
          </div>
        </div>
      ) : tree.length > 0 ? (
        <>
          {/* Sticky header: title + [+] + search — stays fixed above scroll */}
          <div style={{ flexShrink: 0, paddingTop: 4 }}>
            {/* FILE TREE title + [+] button */}
            <div style={{ padding: '0 16px 4px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <Text strong style={{ fontSize: 12, textTransform: 'uppercase', letterSpacing: 0.5, color: tokens.text.muted }}>
                {t('workspace.fileTree')}
              </Text>
              <Dropdown
                menu={{
                  items: [
                    { key: 'newFile', icon: <FileOutlined />, label: t('workspace.contextMenu.newFile'), onClick: () => setRootCreateType('file') },
                    { key: 'newFolder', icon: <FolderOutlined />, label: t('workspace.contextMenu.newFolder'), onClick: () => setRootCreateType('directory') },
                  ],
                }}
                trigger={['click']}
                placement="bottomRight"
              >
                <span
                  title={t('workspace.newItemTooltip', { defaultValue: 'New...' })}
                  style={{
                    cursor: 'pointer',
                    fontSize: 12,
                    color: tokens.text.muted,
                    padding: '0 2px',
                    borderRadius: 3,
                    transition: 'color 0.15s',
                  }}
                  onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = tokens.text.primary; }}
                  onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = tokens.text.muted; }}
                >
                  <PlusOutlined />
                </span>
              </Dropdown>
            </div>

            {/* Search box */}
            <div style={{ padding: '0 16px 6px' }}>
              <div style={{
                display: 'flex', alignItems: 'center', gap: 6,
                padding: '3px 8px',
                border: `1px solid ${tokens.border.default}`,
                borderRadius: 4,
                background: tokens.bg.surface,
                transition: 'border-color 0.15s',
              }}
                onFocus={(e) => { (e.currentTarget as HTMLElement).style.borderColor = 'var(--accent-secondary)'; }}
                onBlur={(e) => { (e.currentTarget as HTMLElement).style.borderColor = tokens.border.default; }}
              >
                <SearchOutlined style={{ fontSize: 12, color: tokens.text.muted, flexShrink: 0 }} />
                <input
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder={t('workspace.searchPlaceholder', { defaultValue: 'Search files...' })}
                  style={{
                    flex: 1, fontSize: 12, fontFamily: 'inherit',
                    border: 'none', background: 'transparent',
                    color: tokens.text.primary, outline: 'none', minWidth: 0,
                  }}
                />
                {searchQuery && (
                  <CloseCircleFilled
                    style={{ fontSize: 12, color: tokens.text.muted, cursor: 'pointer', flexShrink: 0 }}
                    onClick={() => setSearchQuery('')}
                  />
                )}
              </div>
            </div>
          </div>

          {/* Scrollable tree area */}
          <div
            ref={scrollRef}
            onDragOver={handleTreeDragOver}
            onDragLeave={stopAutoScroll}
            onDrop={stopAutoScroll}
            onDragEnd={stopAutoScroll}
            style={{ flex: 1, overflow: 'auto' }}
          >
            {/* Root-level create input */}
            {rootCreateType && (
              <InlineNameInput
                icon={rootCreateType === 'directory' ? <FolderOutlined /> : <FileOutlined />}
                iconColor="#71717A"
                depth={0}
                tokens={tokens}
                loading={rootCreateLoading}
                onConfirm={handleRootCreate}
                onCancel={() => setRootCreateType(null)}
              />
            )}

            {/* Tree nodes */}
            {filteredTree.length > 0 ? (
              filteredTree.map((node) => (
                <FileTreeNode key={node.path} node={node} depth={0} tokens={tokens} workspaceRoot={workspaceRoot} dragSrcPath={dragSrcPath} movingPath={movingPath} creatingItem={creatingItem} onOpenFile={setPreviewPath} onDeleted={loadData} onMoved={loadData} onDragSrcChange={setDragSrcPath} onMoveStart={setMovingPath} onMoveEnd={() => setMovingPath(null)} onCreateItem={setCreatingItem} onCreateDone={() => setCreatingItem(null)} />
              ))
            ) : debouncedQuery ? (
              <div style={{ padding: '16px', textAlign: 'center' }}>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  {t('workspace.searchNoResults', { defaultValue: 'No matches found' })}
                </Text>
              </div>
            ) : null}
          </div>
        </>
      ) : null}

      {/* System files toggle bar */}
      {!showSystemFiles && hiddenCount > 0 ? (
        <div style={{
          padding: '4px 16px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          borderTop: `1px solid ${tokens.border.default}`,
        }}>
          <Text type="secondary" style={{ fontSize: 11 }}>
            {t('workspace.systemFilesHidden', { count: hiddenCount })}
          </Text>
          <Button
            type="link"
            size="small"
            style={{ fontSize: 11, padding: 0, height: 'auto' }}
            onClick={() => setShowSystemFiles(true)}
          >
            {t('workspace.showSystemFiles')}
          </Button>
        </div>
      ) : showSystemFiles ? (
        <div style={{
          padding: '4px 16px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          borderTop: `1px solid ${tokens.border.default}`,
        }}>
          <Text type="secondary" style={{ fontSize: 11 }}>
            {t('workspace.systemFilesVisible')}
          </Text>
          <Button
            type="link"
            size="small"
            style={{ fontSize: 11, padding: 0, height: 'auto' }}
            onClick={() => setShowSystemFiles(false)}
          >
            {t('workspace.hideSystemFiles')}
          </Button>
        </div>
      ) : null}

      {/* Upload / move-to-root drop zone */}
      {(() => {
        // Derive drag state: show root-drop zone as soon as a non-root item is being dragged
        const isDraggingNonRoot = dragSrcPath !== null && dragSrcPath.includes('/');
        const showRootDrop = isDraggingNonRoot && !uploading;

        if (uploading) {
          return (
            <div style={{ padding: '8px 16px', borderTop: `1px solid ${tokens.border.default}` }}>
              <div style={{ padding: '12px 0', border: `1px dashed ${tokens.border.hover}`, borderRadius: 4, textAlign: 'center' }}>
                <LoadingOutlined style={{ fontSize: 16, color: tokens.text.muted, marginRight: 6 }} spin />
                <span style={{ color: tokens.text.muted, fontSize: 12 }}>
                  {t('workspace.uploading', { defaultValue: 'Uploading...' })}
                </span>
              </div>
            </div>
          );
        }

        if (externalDragOver && !showRootDrop) {
          return (
            <div style={{ padding: '8px 16px', borderTop: `1px solid ${tokens.border.default}` }}>
              <div
                style={{
                  padding: '12px 0',
                  border: '1px solid rgba(239, 68, 68, 0.7)',
                  borderRadius: 4,
                  textAlign: 'center',
                  background: 'rgba(239, 68, 68, 0.12)',
                  transition: 'border 0.15s, background 0.15s',
                }}
              >
                <p style={{
                  color: '#F87171',
                  fontSize: 12,
                  margin: 0,
                  fontWeight: 500,
                  transition: 'color 0.15s',
                }}>
                  <UploadOutlined style={{ fontSize: 16, marginRight: 4 }} />
                  {t('workspace.dropToUpload')}
                </p>
              </div>
            </div>
          );
        }

        if (showRootDrop) {
          return (
            <div
              style={{ padding: '8px 16px', borderTop: `1px solid ${tokens.border.default}` }}
              onDragOver={handleRootDropZoneDragOver}
              onDragLeave={handleRootDropZoneDragLeave}
              onDrop={handleRootDropZoneDrop}
            >
              <div
                style={{
                  padding: '12px 0',
                  border: rootDropHover
                    ? '1px solid rgba(59, 130, 246, 0.7)'
                    : '1px dashed rgba(59, 130, 246, 0.35)',
                  borderRadius: 4,
                  textAlign: 'center',
                  background: rootDropHover
                    ? 'rgba(59, 130, 246, 0.12)'
                    : 'rgba(59, 130, 246, 0.04)',
                  transition: 'border 0.15s, background 0.15s',
                }}
              >
                <p style={{
                  color: rootDropHover ? '#60A5FA' : 'rgba(59, 130, 246, 0.6)',
                  fontSize: 12,
                  margin: 0,
                  fontWeight: 500,
                  transition: 'color 0.15s',
                }}>
                  <FolderOutlined style={{ fontSize: 16, marginRight: 4 }} />
                  {t('workspace.moveToRoot')}
                </p>
              </div>
            </div>
          );
        }

        return (
          <div style={{ padding: '8px 16px', borderTop: `1px solid ${tokens.border.default}` }}>
            <Dragger
              accept="*"
              multiple
              showUploadList={false}
              beforeUpload={handleUpload}
              style={{ padding: '8px 0', border: `1px dashed ${tokens.border.hover}`, background: 'transparent' }}
            >
              <p style={{ color: tokens.text.muted, fontSize: 12, margin: 0 }}>
                <InboxOutlined style={{ fontSize: 16, marginRight: 4 }} />
                {t('workspace.dragDrop')}
              </p>
            </Dragger>
          </div>
        );
      })()}

      <FilePreviewModal
        open={previewPath !== null}
        filePath={previewPath}
        workspaceRoot={workspaceRoot}
        onClose={() => setPreviewPath(null)}
        onDeleted={loadData}
      />
    </div>
  );
}
