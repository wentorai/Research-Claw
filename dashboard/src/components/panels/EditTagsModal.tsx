import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AutoComplete, Button, Modal, Tag, Typography } from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import { useGatewayStore } from '../../stores/gateway';
import { useLibraryStore } from '../../stores/library';
import { getThemeTokens } from '../../styles/theme';
import { useConfigStore } from '../../stores/config';

const { Text } = Typography;

interface EditTagsModalProps {
  open: boolean;
  paperId: string;
  paperTitle: string;
  currentTags: string[];
  onClose: () => void;
}

export default function EditTagsModal({
  open,
  paperId,
  paperTitle,
  currentTags,
  onClose,
}: EditTagsModalProps) {
  const { t } = useTranslation();
  const theme = useConfigStore((s) => s.theme);
  const tokens = useMemo(() => getThemeTokens(theme), [theme]);
  const allTags = useLibraryStore((s) => s.tags);

  // Local working copy of tags for this editing session
  const [tags, setTags] = useState<string[]>([]);
  const [inputValue, setInputValue] = useState('');
  const [inputVisible, setInputVisible] = useState(false);
  const inputRef = useRef<{ focus: () => void } | null>(null);
  const [saving, setSaving] = useState(false);

  // Reset local tags when modal opens
  useEffect(() => {
    if (open) {
      setTags([...currentTags]);
      setInputValue('');
      setInputVisible(false);
    }
  }, [open, currentTags]);

  // Focus input when it becomes visible
  useEffect(() => {
    if (inputVisible) {
      inputRef.current?.focus();
    }
  }, [inputVisible]);

  // Autocomplete options: existing library tags not already on this paper
  const autoCompleteOptions = useMemo(() => {
    const lowerTags = new Set(tags.map((t) => t.toLowerCase()));
    return allTags
      .filter((t) => !lowerTags.has(t.name.toLowerCase()))
      .map((t) => ({ value: t.name, label: t.name }));
  }, [allTags, tags]);

  const handleRemoveTag = useCallback((removedTag: string) => {
    setTags((prev) => prev.filter((t) => t !== removedTag));
  }, []);

  const handleAddTag = useCallback(() => {
    const trimmed = inputValue.trim();
    if (trimmed && !tags.some((t) => t.toLowerCase() === trimmed.toLowerCase())) {
      setTags((prev) => [...prev, trimmed]);
    }
    setInputValue('');
    setInputVisible(false);
  }, [inputValue, tags]);

  const handleInputKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      // IME composition guard (CJK input). The host is antd AutoComplete, whose
      // rc-select BaseSelect forwards keydown to props.onKeyDown unconditionally
      // (unlike Input.Search, which carries its own composedRef guard). Without
      // this, the Enter that merely CONFIRMS an IME candidate would also commit
      // a half-composed tag and close the input; Escape (cancel candidate) would
      // tear the whole input down.
      if (e.nativeEvent.isComposing || e.keyCode === 229) return;
      if (e.key === 'Enter') {
        e.preventDefault();
        handleAddTag();
      }
      if (e.key === 'Escape') {
        setInputValue('');
        setInputVisible(false);
      }
    },
    [handleAddTag],
  );

  const handleSave = useCallback(async () => {
    const client = useGatewayStore.getState().client;
    if (!client?.isConnected) return;

    setSaving(true);
    try {
      const oldSet = new Set(currentTags.map((t) => t.toLowerCase()));
      const newSet = new Set(tags.map((t) => t.toLowerCase()));

      // Remove tags that were deleted
      const toRemove = currentTags.filter((t) => !newSet.has(t.toLowerCase()));
      // Add tags that are new
      const toAdd = tags.filter((t) => !oldSet.has(t.toLowerCase()));

      const promises: Promise<unknown>[] = [];
      for (const tag of toRemove) {
        promises.push(client.request('rc.lit.untag', { paper_id: paperId, tag_name: tag }));
      }
      for (const tag of toAdd) {
        promises.push(client.request('rc.lit.tag', { paper_id: paperId, tag_name: tag }));
      }

      await Promise.allSettled(promises);

      // Refresh library data
      useLibraryStore.getState().loadPapers();
      useLibraryStore.getState().loadTags();
    } finally {
      setSaving(false);
      onClose();
    }
  }, [currentTags, tags, paperId, onClose]);

  const hasChanges = useMemo(() => {
    if (tags.length !== currentTags.length) return true;
    const sortedOld = [...currentTags].sort();
    const sortedNew = [...tags].sort();
    return sortedOld.some((t, i) => t.toLowerCase() !== sortedNew[i]?.toLowerCase());
  }, [tags, currentTags]);

  return (
    <Modal
      open={open}
      title={t('library.editTags.title')}
      onCancel={onClose}
      footer={[
        <Button key="cancel" onClick={onClose}>
          {t('library.editTags.cancel')}
        </Button>,
        <Button
          key="save"
          type="primary"
          loading={saving}
          disabled={!hasChanges}
          onClick={handleSave}
        >
          {t('library.editTags.save')}
        </Button>,
      ]}
      width={480}
      destroyOnClose
    >
      {/* Paper title */}
      <Text
        type="secondary"
        ellipsis
        style={{ fontSize: 12, display: 'block', marginBottom: 16 }}
      >
        {paperTitle}
      </Text>

      {/* Current tags */}
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: 8,
          minHeight: 32,
          padding: '8px 12px',
          borderRadius: 6,
          border: `1px solid ${tokens.border.default}`,
          background: tokens.bg.surface,
          marginBottom: 12,
        }}
      >
        {tags.length === 0 && (
          <Text type="secondary" style={{ fontSize: 12 }}>
            {t('library.editTags.noTags')}
          </Text>
        )}
        {tags.map((tag) => (
          <Tag
            key={tag}
            closable
            onClose={(e) => {
              e.preventDefault();
              handleRemoveTag(tag);
            }}
            style={{ margin: 0 }}
          >
            {tag}
          </Tag>
        ))}

        {/* Inline add input */}
        {inputVisible ? (
          <AutoComplete
            ref={inputRef as React.Ref<never>}
            size="small"
            value={inputValue}
            options={autoCompleteOptions}
            onChange={setInputValue}
            onSelect={(val: string) => {
              if (!tags.some((t) => t.toLowerCase() === val.toLowerCase())) {
                setTags((prev) => [...prev, val]);
              }
              setInputValue('');
              setInputVisible(false);
            }}
            onKeyDown={handleInputKeyDown}
            onBlur={handleAddTag}
            style={{ width: 120 }}
            placeholder={t('library.editTags.inputPlaceholder')}
            filterOption={(input, option) =>
              (option?.value as string)?.toLowerCase().includes(input.toLowerCase())
            }
          />
        ) : (
          <Tag
            onClick={() => setInputVisible(true)}
            style={{
              borderStyle: 'dashed',
              cursor: 'pointer',
              margin: 0,
            }}
          >
            <PlusOutlined /> {t('library.editTags.addTag')}
          </Tag>
        )}
      </div>

      {/* Suggestion: existing library tags */}
      {autoCompleteOptions.length > 0 && (
        <div>
          <Text type="secondary" style={{ fontSize: 11, display: 'block', marginBottom: 6 }}>
            {t('library.editTags.suggestions')}
          </Text>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
            {autoCompleteOptions.slice(0, 15).map((opt) => (
              <Tag
                key={opt.value}
                onClick={() => {
                  if (!tags.some((t) => t.toLowerCase() === opt.value.toLowerCase())) {
                    setTags((prev) => [...prev, opt.value]);
                  }
                }}
                style={{ cursor: 'pointer', fontSize: 11, margin: 0 }}
              >
                + {opt.value}
              </Tag>
            ))}
          </div>
        </div>
      )}
    </Modal>
  );
}
