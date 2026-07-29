/**
 * DestinationPickerModal — choose where an external drop (or Upload-button
 * batch) lands in the workspace. Shown for drops on panel empty space; drops
 * directly onto a folder node bypass it (Finder-style direct targeting).
 *
 * Renders the workspace directory tree (directories only, fully expanded —
 * the panel's depth-5 tree is small), an inline "new folder" input, and a
 * "keep top-level folder name" toggle for folder drops.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Button, Checkbox, Input, Modal, Typography } from 'antd';
import { FolderOutlined, FolderAddOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';

const { Text } = Typography;

/** Minimal structural view of the panel's TreeNode (avoids exporting its local type). */
export interface DirNode {
  name: string;
  path: string;
  type: 'file' | 'directory';
  children?: DirNode[];
}

export interface DestinationChoice {
  dest: string;
  preserveRootName: boolean;
}

export interface DestinationPickerModalProps {
  open: boolean;
  /** Unique identity for each destination request, even when open stays true. */
  promptId: number;
  tree: DirNode[];
  /** Whether the pending drop contains folders (shows the keep-name toggle). */
  hasFolders: boolean;
  defaultDest: string;
  /** Create a folder under `parent`; resolves the new path, or null on failure. */
  onCreateFolder?: (parent: string, name: string) => Promise<string | null>;
  onResolve: (choice: DestinationChoice) => void;
  onCancel: () => void;
}

function collectDirs(nodes: DirNode[], out: { path: string; depth: number }[] = [], depth = 0): { path: string; depth: number }[] {
  for (const n of nodes) {
    if (n.type !== 'directory') continue;
    out.push({ path: n.path, depth });
    if (n.children) collectDirs(n.children, out, depth + 1);
  }
  return out;
}

export default function DestinationPickerModal({
  open,
  promptId,
  tree,
  hasFolders,
  defaultDest,
  onCreateFolder,
  onResolve,
  onCancel,
}: DestinationPickerModalProps) {
  const { t } = useTranslation();
  const dirs = useMemo(() => {
    const collected = collectDirs(tree);
    // Fresh workspace before the tree loads — offer the standard scaffold dirs.
    const list = collected.length > 0 ? collected : [{ path: 'sources', depth: 0 }, { path: 'outputs', depth: 0 }];
    // Workspace root is always the first option ('' internally, '.' on the wire).
    return [{ path: '', depth: 0 }, ...list.map((d) => ({ ...d, depth: d.depth + 1 }))];
  }, [tree]);

  const [dest, setDest] = useState(defaultDest);
  const [preserve, setPreserve] = useState(true);
  const [creatingName, setCreatingName] = useState<string | null>(null);
  const [createBusy, setCreateBusy] = useState(false);
  const createGeneration = useRef(0);

  // Reset per open: last-used destination (fall back to sources) + defaults.
  useEffect(() => {
    createGeneration.current += 1;
    if (open) {
      setDest(dirs.some((d) => d.path === defaultDest) ? defaultDest : 'sources');
      setPreserve(true);
      setCreatingName(null);
      setCreateBusy(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, promptId]);

  const handleCreateFolder = async () => {
    const name = creatingName?.trim();
    if (!name || !onCreateFolder) return;
    const generation = ++createGeneration.current;
    setCreateBusy(true);
    try {
      const newPath = await onCreateFolder(dest, name);
      if (createGeneration.current !== generation) return;
      if (newPath) {
        setDest(newPath);
        setCreatingName(null);
      }
    } finally {
      if (createGeneration.current === generation) setCreateBusy(false);
    }
  };

  const handleCancel = () => {
    createGeneration.current += 1;
    setCreateBusy(false);
    onCancel();
  };

  return (
    <Modal
      open={open}
      centered
      title={t('workspace.destTitle', { defaultValue: 'Choose destination folder' })}
      okText={t('workspace.destUpload', { defaultValue: 'Upload' })}
      cancelText={t('common.cancel', { defaultValue: 'Cancel' })}
      okButtonProps={{ disabled: createBusy, loading: createBusy }}
      onOk={() => onResolve({ dest, preserveRootName: hasFolders ? preserve : false })}
      onCancel={handleCancel}
      width={460}
    >
      <div style={{ maxHeight: 260, overflowY: 'auto', margin: '8px 0' }} data-testid="dest-dir-list">
        {dirs.map((d) => (
          <div
            key={d.path}
            role="option"
            aria-selected={dest === d.path}
            onClick={() => setDest(d.path)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              padding: '4px 8px',
              paddingLeft: 8 + d.depth * 16,
              cursor: 'pointer',
              borderRadius: 4,
              background: dest === d.path ? 'rgba(59, 130, 246, 0.15)' : 'transparent',
              fontSize: 12,
            }}
          >
            <FolderOutlined />
            <Text ellipsis={{ tooltip: d.path || '/' }} style={{ flex: 1, minWidth: 0 }}>
              {d.path || t('workspace.destRootLabel', { defaultValue: 'Workspace root /' })}
            </Text>
          </div>
        ))}
      </div>

      {creatingName === null ? (
        <Button
          size="small"
          icon={<FolderAddOutlined />}
          onClick={() => setCreatingName('')}
          disabled={!onCreateFolder}
        >
          {t('workspace.destNewFolder', { defaultValue: 'New folder in selected directory' })}
        </Button>
      ) : (
        <Input.Search
          size="small"
          autoFocus
          value={creatingName}
          loading={createBusy}
          placeholder={t('workspace.destNewFolderIn', { path: dest || '/', defaultValue: 'New folder in {{path}}/' })}
          enterButton={t('workspace.destCreate', { defaultValue: 'Create' })}
          onChange={(e) => setCreatingName(e.target.value)}
          onSearch={handleCreateFolder}
        />
      )}

      {hasFolders && (
        <Checkbox
          checked={preserve}
          onChange={(e) => setPreserve(e.target.checked)}
          style={{ marginTop: 12, display: 'flex' }}
        >
          {t('workspace.destPreserveRoot', { defaultValue: 'Keep top-level folder name' })}
        </Checkbox>
      )}

      <Text type="secondary" style={{ display: 'block', marginTop: 8, fontSize: 12 }}>
        {t('workspace.destTarget', { path: dest || '/', defaultValue: 'Target: {{path}}/' })}
      </Text>
    </Modal>
  );
}
