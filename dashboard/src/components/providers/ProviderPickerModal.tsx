import React, { useMemo, useState } from 'react';
import { Button, Card, Input, Modal, Space, Typography } from 'antd';
import { ApiOutlined, GlobalOutlined, KeyOutlined, LaptopOutlined, SearchOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import { PROVIDER_PRESETS } from '../../utils/provider-presets';
import { isOAuthProvider } from '../../utils/oauth-providers';
import { providerIdsForPicker } from '../../utils/provider-variants';

const { Text } = Typography;

type ProviderId = (typeof PROVIDER_PRESETS)[number]['id'];

type ProviderSectionId = 'oauth' | 'direct' | 'gateway' | 'local' | 'custom';

type ProviderSection = {
  id: ProviderSectionId;
  title: string;
  icon: React.ReactNode;
  providerIds: ProviderId[];
  groups?: { id: 'cn' | 'global'; title: string; providerIds: ProviderId[] }[];
};

const LOCAL_PROVIDER_IDS: ProviderId[] = ['ollama', 'vllm'];
const GATEWAY_PROVIDER_IDS: ProviderId[] = [
  'openrouter',
  'together',
  'venice',
  'nvidia',
  'huggingface',
  'synthetic',
  'kilocode',
  'litellm',
];

// Providers that are primarily used with China/Asia endpoints (direct API key mode).
// Note: This is a UI grouping hint only — actual endpoints are controlled by presets + variant selector.
const DIRECT_CN_PROVIDER_IDS: ProviderId[] = [
  'zai',
  'zai-coding',
  'moonshot-cn',
  'kimi-coding',
  'minimax-cn',
  'volcengine',
  'volcengine-plan',
  'byteplus',
  'byteplus-plan',
  'qianfan',
  'modelstudio-cn',
  'xiaomi',
  'qwen-portal',
];

const SEARCH_ALIASES: Partial<Record<ProviderId, string[]>> = {
  // Common CN aliases
  zai: ['智谱', 'glm', 'bigmodel'],
  'zai-global': ['智谱', 'glm', 'z.ai'],
  'zai-coding': ['智谱', 'glm', 'coding'],
  'zai-coding-global': ['智谱', 'glm', 'coding'],
  moonshot: ['kimi', '月之暗面'],
  'moonshot-cn': ['kimi', '月之暗面'],
  'kimi-coding': ['kimi', '月之暗面', 'coding'],
  volcengine: ['豆包', '火山', 'ark', 'volces'],
  'volcengine-plan': ['豆包', '火山', 'ark', 'coding'],
  byteplus: ['ark', 'byteplus'],
  'byteplus-plan': ['ark', 'byteplus', 'coding'],
  qianfan: ['千帆', '百度'],
  modelstudio: ['百炼', '阿里', 'dashscope', 'qwen'],
  'modelstudio-cn': ['百炼', '阿里', 'dashscope', 'qwen'],
  xai: ['grok'],
  'qwen-portal': ['通义', 'qwen'],
  ollama: ['本地', 'local'],
  vllm: ['本地', 'local'],
};

function normalize(s: string) {
  return s.trim().toLowerCase();
}

function providerSearchText(p: (typeof PROVIDER_PRESETS)[number]): string {
  const aliases = SEARCH_ALIASES[p.id] ?? [];
  return [p.id, p.label, ...aliases].join(' ').toLowerCase();
}

function buildSections(t: (key: string) => string): ProviderSection[] {
  const allIds = PROVIDER_PRESETS.map((p) => p.id) as ProviderId[];
  const oauth = allIds.filter((id) => isOAuthProvider(id));
  const local = allIds.filter((id) => LOCAL_PROVIDER_IDS.includes(id));
  const gateway = allIds.filter((id) => GATEWAY_PROVIDER_IDS.includes(id));
  const custom: ProviderId[] = ['custom'];
  const direct = allIds.filter((id) => !oauth.includes(id) && !local.includes(id) && !gateway.includes(id) && id !== 'custom');

  const directCn = direct.filter((id) => DIRECT_CN_PROVIDER_IDS.includes(id));
  const directGlobal = direct.filter((id) => !DIRECT_CN_PROVIDER_IDS.includes(id));

  const sections: ProviderSection[] = [
    { id: 'oauth', title: t('providerPicker.sectionOAuth'), icon: <KeyOutlined />, providerIds: oauth },
    {
      id: 'direct',
      title: t('providerPicker.sectionDirect'),
      icon: <ApiOutlined />,
      providerIds: direct,
      groups: ([
        { id: 'cn', title: t('providerPicker.directCn'), providerIds: directCn },
        { id: 'global', title: t('providerPicker.directGlobal'), providerIds: directGlobal },
      ] satisfies NonNullable<ProviderSection['groups']>).filter((g) => g.providerIds.length > 0),
    },
    { id: 'gateway', title: t('providerPicker.sectionGateway'), icon: <GlobalOutlined />, providerIds: gateway },
    { id: 'local', title: t('providerPicker.sectionLocal'), icon: <LaptopOutlined />, providerIds: local },
    { id: 'custom', title: t('providerPicker.sectionCustom'), icon: <ApiOutlined />, providerIds: custom },
  ];
  return sections.filter((s): s is ProviderSection => s.providerIds.length > 0);
}

export function providerLabel(id: string, t: (key: string) => string): string {
  const preset = PROVIDER_PRESETS.find((p) => p.id === id);
  if (!preset) return id;
  return preset.id === 'custom' ? t('setup.providerCustom') : preset.label;
}

export default function ProviderPickerModal({
  open,
  value,
  title,
  onSelect,
  onClose,
}: {
  open: boolean;
  value: string;
  title: string;
  onSelect: (providerId: string) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');

  const pickerIds = useMemo(() => new Set(providerIdsForPicker()), []);
  const pickerPresets = useMemo(() => PROVIDER_PRESETS.filter((p) => pickerIds.has(p.id)), [pickerIds]);

  const presets = useMemo(() => {
    const q = normalize(query);
    if (!q) return pickerPresets;
    return pickerPresets.filter((p) => providerSearchText(p).includes(q));
  }, [query, pickerPresets]);

  const presetIds = useMemo(() => new Set(presets.map((p) => p.id)), [presets]);
  const sections = useMemo(() => buildSections(t), [t]);

  const renderCards = (ids: ProviderId[]) => (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
        gap: 10,
      }}
    >
      {ids.map((id) => {
        const p = PROVIDER_PRESETS.find((x) => x.id === id)!;
        const selected = id === value;
        const label = p.id === 'custom' ? t('setup.providerCustom') : p.label;
        return (
          <Card
            key={id}
            size="small"
            hoverable
            onClick={() => onSelect(id)}
            style={{
              cursor: 'pointer',
              border: selected ? '1px solid var(--accent-primary)' : '1px solid var(--border)',
              background: selected ? 'rgba(96,165,250,0.08)' : 'var(--surface-hover)',
            }}
            styles={{ body: { padding: 12 } }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
              <div style={{ minWidth: 0 }}>
                <Text strong style={{ display: 'block', fontSize: 13 }} ellipsis={{ tooltip: label }}>
                  {label}
                </Text>
                <Text type="secondary" style={{ fontSize: 11 }} ellipsis={{ tooltip: id }}>
                  {id}
                </Text>
              </div>
              {selected && (
                <div style={{ color: 'var(--accent-primary)', fontSize: 12, flexShrink: 0 }}>
                  {t('providerPicker.selected')}
                </div>
              )}
            </div>
          </Card>
        );
      })}
    </div>
  );

  return (
    <Modal
      title={title}
      open={open}
      onCancel={onClose}
      footer={null}
      width={720}
      destroyOnClose
      styles={{ body: { paddingTop: 8, display: 'flex', flexDirection: 'column', maxHeight: 'calc(80vh - 110px)' } }}
    >
      <Input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        allowClear
        prefix={<SearchOutlined />}
        placeholder={t('providerPicker.searchPlaceholder')}
        style={{ marginBottom: 12, flexShrink: 0 }}
      />

      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          {sections.map((section) => {
            const visible = section.providerIds.filter((id) => presetIds.has(id));
            if (visible.length === 0) return null;
            return (
              <div key={section.id}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                  <span style={{ opacity: 0.8 }}>{section.icon}</span>
                  <Text strong style={{ fontSize: 13 }}>
                    {section.title}
                  </Text>
                </div>
                {section.id === 'direct' && section.groups?.length ? (
                  <Space direction="vertical" size={10} style={{ width: '100%' }}>
                    {section.groups.map((g) => {
                      const gVisible = g.providerIds.filter((id) => presetIds.has(id));
                      if (gVisible.length === 0) return null;
                      return (
                        <div key={g.id}>
                          <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 6 }}>
                            {g.title}
                          </Text>
                          {renderCards(gVisible)}
                        </div>
                      );
                    })}
                  </Space>
                ) : (
                  renderCards(visible)
                )}
              </div>
            );
          })}
        </Space>
      </div>
    </Modal>
  );
}

