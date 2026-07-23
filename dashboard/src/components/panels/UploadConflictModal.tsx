/**
 * UploadConflictModal — shown before uploading when target names already exist
 * in the workspace. Per-file choice: overwrite / keep both (Finder-style
 * "name (2).ext" rename, resolved by the gateway) / skip, with an
 * apply-to-all shortcut. Directories can never be overwritten by a file, so
 * the overwrite option is disabled for directory collisions.
 */

import React, { useEffect, useState } from 'react';
import { Checkbox, Modal, Radio, Typography } from 'antd';
import { useTranslation } from 'react-i18next';
import type { UploadConflictMode } from '../../gateway/upload';

const { Text } = Typography;

export type ConflictAction = 'overwrite' | 'rename' | 'skip';

export interface UploadConflict {
  /** Workspace-relative target path that already exists. */
  path: string;
  existingType: 'file' | 'directory';
}

export interface UploadConflictModalProps {
  open: boolean;
  conflicts: UploadConflict[];
  onResolve: (decisions: Map<string, ConflictAction>) => void;
  onCancel: () => void;
}

/** Map a dialog decision to the upload's onConflict mode (null = don't upload). */
export function conflictActionToMode(action: ConflictAction | undefined): UploadConflictMode | null {
  if (action === 'overwrite' || action === 'rename') return action;
  return null;
}

export default function UploadConflictModal({ open, conflicts, onResolve, onCancel }: UploadConflictModalProps) {
  const { t } = useTranslation();
  const [applyAll, setApplyAll] = useState(true);
  const [decisions, setDecisions] = useState<Map<string, ConflictAction>>(new Map());

  // Reset to the non-destructive default (keep both) each time the dialog opens.
  useEffect(() => {
    if (open) {
      setApplyAll(true);
      setDecisions(new Map(conflicts.map((c) => [c.path, 'rename' as ConflictAction])));
    }
  }, [open, conflicts]);

  const setAction = (path: string, action: ConflictAction, applyToAll: boolean) => {
    setDecisions((prev) => {
      const next = new Map(prev);
      if (applyToAll) {
        for (const c of conflicts) {
          next.set(c.path, action === 'overwrite' && c.existingType === 'directory' ? 'rename' : action);
        }
      } else {
        next.set(path, action);
      }
      return next;
    });
  };

  return (
    <Modal
      open={open}
      centered
      title={t('workspace.conflictTitle', {
        count: conflicts.length,
        defaultValue: '{{count}} file(s) already exist',
      })}
      okText={t('workspace.conflictStart', { defaultValue: 'Start upload' })}
      cancelText={t('common.cancel', { defaultValue: 'Cancel' })}
      onOk={() => onResolve(decisions)}
      onCancel={onCancel}
      width={520}
    >
      <Text type="secondary" style={{ display: 'block', marginBottom: 12 }}>
        {t('workspace.conflictHint', {
          defaultValue: 'Choose what to do with each name that already exists at the destination.',
        })}
      </Text>
      <div style={{ maxHeight: 280, overflowY: 'auto' }} data-testid="conflict-list">
        {conflicts.map((c) => (
          <div
            key={c.path}
            style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '6px 0' }}
          >
            <Text ellipsis={{ tooltip: c.path }} style={{ flex: 1, minWidth: 0 }}>
              {c.path}
            </Text>
            <Radio.Group
              size="small"
              optionType="button"
              value={decisions.get(c.path) ?? 'rename'}
              onChange={(e) => setAction(c.path, e.target.value as ConflictAction, applyAll)}
              options={[
                {
                  label: t('workspace.conflictOverwrite', { defaultValue: 'Overwrite' }),
                  value: 'overwrite',
                  disabled: c.existingType === 'directory',
                },
                { label: t('workspace.conflictKeepBoth', { defaultValue: 'Keep both' }), value: 'rename' },
                { label: t('workspace.conflictSkip', { defaultValue: 'Skip' }), value: 'skip' },
              ]}
            />
          </div>
        ))}
      </div>
      <Checkbox
        checked={applyAll}
        onChange={(e) => setApplyAll(e.target.checked)}
        style={{ marginTop: 12 }}
      >
        {t('workspace.conflictApplyAll', { defaultValue: 'Apply the same choice to all conflicts' })}
      </Checkbox>
    </Modal>
  );
}
