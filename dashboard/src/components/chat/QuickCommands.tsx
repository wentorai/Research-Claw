import React, { useMemo, useState } from 'react';
import {
  App,
  Button,
  Empty,
  Input,
  Modal,
  Popover,
  Spin,
  Tooltip,
  Typography,
} from 'antd';
import {
  ArrowDownOutlined,
  ArrowUpOutlined,
  DeleteOutlined,
  EditOutlined,
  PlusOutlined,
  StarFilled,
  StarOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import { usePromptPresetStore, type PromptPreset } from '../../stores/prompt-presets';

const { Text } = Typography;

interface EditorState {
  id?: string;
  name: string;
  content: string;
  category: string;
  favorite: boolean;
}

const EMPTY_EDITOR: EditorState = {
  name: '',
  content: '',
  category: '',
  favorite: false,
};

interface QuickCommandsProps {
  disabled?: boolean;
  composing?: boolean;
  onTriggerMouseDown?: () => void;
  onInsert: (preset: PromptPreset) => void;
}

export default function QuickCommands({
  disabled,
  composing,
  onTriggerMouseDown,
  onInsert,
}: QuickCommandsProps) {
  const { t } = useTranslation();
  const { modal, message } = App.useApp();
  const {
    presets,
    loaded,
    loading,
    load,
    create,
    update,
    remove,
    reorder,
    markUsed,
  } = usePromptPresetStore();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [saving, setSaving] = useState(false);

  const visiblePresets = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return presets;
    return presets.filter((preset) =>
      `${preset.name}\n${preset.content}\n${preset.category}`.toLowerCase().includes(normalized),
    );
  }, [presets, query]);

  const orderedIds = useMemo(
    () => [...presets].sort((a, b) => a.sort_order - b.sort_order).map((preset) => preset.id),
    [presets],
  );

  const move = async (id: string, delta: -1 | 1) => {
    const index = orderedIds.indexOf(id);
    const target = index + delta;
    if (index < 0 || target < 0 || target >= orderedIds.length) return;
    const next = [...orderedIds];
    [next[index], next[target]] = [next[target], next[index]];
    try {
      await reorder(next);
    } catch {
      message.error(t('quickCommands.reorderError'));
      void load();
    }
  };

  const saveEditor = async () => {
    if (!editor) return;
    setSaving(true);
    try {
      if (editor.id) {
        await update(editor.id, editor);
      } else {
        await create(editor);
      }
      setEditor(null);
      message.success(t('quickCommands.saved'));
    } catch (err) {
      message.error(err instanceof Error ? err.message : t('quickCommands.saveError'));
    } finally {
      setSaving(false);
    }
  };

  const confirmDelete = (preset: PromptPreset) => {
    modal.confirm({
      title: t('quickCommands.deleteTitle', { name: preset.name }),
      content: t('quickCommands.deleteDescription'),
      okText: t('common.delete'),
      cancelText: t('common.cancel'),
      okButtonProps: { danger: true },
      async onOk() {
        try {
          await remove(preset.id);
        } catch {
          message.error(t('quickCommands.deleteError'));
        }
      },
    });
  };

  const content = (
    <div style={{ width: 380, maxWidth: 'calc(100vw - 24px)' }}>
      <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
        <Input.Search
          size="small"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t('quickCommands.search')}
          allowClear
        />
        <Button
          size="small"
          type="primary"
          icon={<PlusOutlined />}
          onClick={() => setEditor({ ...EMPTY_EDITOR })}
        >
          {t('quickCommands.new')}
        </Button>
      </div>
      <div style={{ maxHeight: 320, overflow: 'auto' }}>
        {loading ? (
          <div style={{ padding: 24, textAlign: 'center' }}><Spin size="small" /></div>
        ) : visiblePresets.length === 0 ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('quickCommands.empty')} />
        ) : visiblePresets.map((preset) => {
          const orderIndex = orderedIds.indexOf(preset.id);
          return (
            <div
              key={preset.id}
              role="button"
              tabIndex={0}
              onMouseDown={(event) => {
                if ((event.target as HTMLElement).closest('[data-command-action]')) return;
                event.preventDefault();
                if (composing) return;
                onInsert(preset);
                void markUsed(preset.id).catch(() => { /* insertion already succeeded */ });
                setOpen(false);
              }}
              onKeyDown={(event) => {
                if (event.key !== 'Enter' || composing) return;
                event.preventDefault();
                onInsert(preset);
                void markUsed(preset.id).catch(() => { /* insertion already succeeded */ });
                setOpen(false);
              }}
              style={{
                display: 'grid',
                gridTemplateColumns: '1fr auto',
                gap: 8,
                padding: '8px 4px 8px 8px',
                borderBottom: '1px solid var(--border)',
                cursor: 'pointer',
              }}
            >
              <div style={{ minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                  {preset.favorite && <StarFilled style={{ color: '#F59E0B', fontSize: 11 }} />}
                  <Text strong ellipsis style={{ fontSize: 13 }}>{preset.name}</Text>
                  {preset.category && <Text type="secondary" style={{ fontSize: 10 }}>{preset.category}</Text>}
                </div>
                <Text type="secondary" ellipsis style={{ display: 'block', fontSize: 11 }}>
                  {preset.content}
                </Text>
              </div>
              <div data-command-action style={{ display: 'flex', alignItems: 'center' }}>
                <Tooltip title={preset.favorite ? t('quickCommands.unfavorite') : t('quickCommands.favorite')}>
                  <Button
                    type="text"
                    size="small"
                    icon={preset.favorite ? <StarFilled /> : <StarOutlined />}
                    onClick={() => {
                      void update(preset.id, { favorite: !preset.favorite })
                        .catch(() => message.error(t('quickCommands.saveError')));
                    }}
                  />
                </Tooltip>
                <Button
                  type="text"
                  size="small"
                  icon={<ArrowUpOutlined />}
                  disabled={orderIndex <= 0}
                  aria-label={t('quickCommands.moveUp')}
                  onClick={() => void move(preset.id, -1)}
                />
                <Button
                  type="text"
                  size="small"
                  icon={<ArrowDownOutlined />}
                  disabled={orderIndex === orderedIds.length - 1}
                  aria-label={t('quickCommands.moveDown')}
                  onClick={() => void move(preset.id, 1)}
                />
                <Button
                  type="text"
                  size="small"
                  icon={<EditOutlined />}
                  aria-label={t('quickCommands.edit')}
                  onClick={() => setEditor({ ...preset })}
                />
                <Button
                  type="text"
                  size="small"
                  danger
                  icon={<DeleteOutlined />}
                  aria-label={t('common.delete')}
                  onClick={() => confirmDelete(preset)}
                />
              </div>
            </div>
          );
        })}
      </div>
      <Text type="secondary" style={{ display: 'block', fontSize: 11, marginTop: 8 }}>
        {t('quickCommands.insertHint')}
      </Text>
    </div>
  );

  return (
    <>
      <Popover
        content={content}
        title={t('quickCommands.title')}
        trigger="click"
        placement="topRight"
        open={open}
        onOpenChange={(nextOpen) => {
          if (composing && nextOpen) return;
          setOpen(nextOpen);
          if (nextOpen && !loaded && !loading) {
            void load().catch(() => message.error(t('quickCommands.loadError')));
          }
        }}
      >
        <Tooltip title={t('quickCommands.title')}>
          <Button
            type="text"
            size="small"
            icon={<ThunderboltOutlined />}
            disabled={disabled || composing}
            aria-expanded={open}
            aria-label={t('quickCommands.title')}
            onMouseDown={onTriggerMouseDown}
          />
        </Tooltip>
      </Popover>

      <Modal
        open={editor !== null}
        title={editor?.id ? t('quickCommands.edit') : t('quickCommands.new')}
        okText={t('quickCommands.save')}
        cancelText={t('common.cancel')}
        confirmLoading={saving}
        onOk={() => void saveEditor()}
        onCancel={() => setEditor(null)}
        destroyOnHidden
      >
        <Text style={{ display: 'block', marginBottom: 4 }}>{t('quickCommands.name')}</Text>
        <Input
          value={editor?.name ?? ''}
          maxLength={100}
          onChange={(event) => setEditor((current) => current && ({ ...current, name: event.target.value }))}
          style={{ marginBottom: 12 }}
        />
        <Text style={{ display: 'block', marginBottom: 4 }}>{t('quickCommands.content')}</Text>
        <Input.TextArea
          value={editor?.content ?? ''}
          maxLength={20_000}
          autoSize={{ minRows: 4, maxRows: 12 }}
          onChange={(event) => setEditor((current) => current && ({ ...current, content: event.target.value }))}
          style={{ marginBottom: 12 }}
        />
        <Text style={{ display: 'block', marginBottom: 4 }}>{t('quickCommands.category')}</Text>
        <Input
          value={editor?.category ?? ''}
          maxLength={100}
          onChange={(event) => setEditor((current) => current && ({ ...current, category: event.target.value }))}
        />
      </Modal>
    </>
  );
}
