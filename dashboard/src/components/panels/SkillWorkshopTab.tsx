import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  App,
  Button,
  Drawer,
  Empty,
  Input,
  Modal,
  Segmented,
  Space,
  Tag,
  Typography,
} from 'antd';
import {
  CheckOutlined,
  MessageOutlined,
  PlusOutlined,
  ReloadOutlined,
  SafetyCertificateOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import { useGatewayStore } from '../../stores/gateway';
import { useSkillWorkshopStore } from '../../stores/skill-workshop';
import { useExtensionsStore } from '../../stores/extensions';
import { useUiStore } from '../../stores/ui';
import type {
  SkillProposalManifestEntry,
  SkillProposalStatus,
} from '../../gateway/skill-workshop-types';
import { getThemeTokens } from '../../styles/theme';
import { relativeTime } from '../../utils/relativeTime';

const { Text, Paragraph } = Typography;
const { Search, TextArea } = Input;

type StatusFilter = 'all' | SkillProposalStatus | 'today';

const STATUS_COLORS: Record<SkillProposalStatus, string> = {
  pending: '#3b82f6',
  applied: '#22c55e',
  rejected: '#94a3b8',
  quarantined: '#f59e0b',
  stale: '#a78bfa',
};

function isToday(iso: string): boolean {
  const d = new Date(iso);
  const now = new Date();
  return (
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  );
}

export default function SkillWorkshopTab({ tokens }: { tokens: ReturnType<typeof getThemeTokens> }) {
  const { t } = useTranslation();
  const { message: messageApi, modal } = App.useApp();
  const isConnected = useGatewayStore((s) => s.state) === 'connected';

  const proposals = useSkillWorkshopStore((s) => s.proposals);
  const loading = useSkillWorkshopStore((s) => s.loading);
  const loaded = useSkillWorkshopStore((s) => s.loaded);
  const lastError = useSkillWorkshopStore((s) => s.lastError);
  const selectedId = useSkillWorkshopStore((s) => s.selectedId);
  const inspect = useSkillWorkshopStore((s) => s.inspect);
  const inspectLoading = useSkillWorkshopStore((s) => s.inspectLoading);

  const loadProposals = useSkillWorkshopStore((s) => s.loadProposals);
  const inspectProposal = useSkillWorkshopStore((s) => s.inspectProposal);
  const clearSelection = useSkillWorkshopStore((s) => s.clearSelection);
  const applyProposal = useSkillWorkshopStore((s) => s.applyProposal);
  const rejectProposal = useSkillWorkshopStore((s) => s.rejectProposal);
  const quarantineProposal = useSkillWorkshopStore((s) => s.quarantineProposal);
  const reviseProposal = useSkillWorkshopStore((s) => s.reviseProposal);
  const createProposal = useSkillWorkshopStore((s) => s.createProposal);
  const loadSkills = useExtensionsStore((s) => s.loadSkills);

  const setChatInputPrefill = useUiStore((s) => s.setChatInputPrefill);

  const [statusFilter, setStatusFilter] = useState<StatusFilter>('pending');
  const [search, setSearch] = useState('');
  const [draftContent, setDraftContent] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState('');
  const [createDesc, setCreateDesc] = useState('');
  const [createBody, setCreateBody] = useState('');

  useEffect(() => {
    if (isConnected && !loaded) loadProposals();
  }, [isConnected, loaded, loadProposals]);

  useEffect(() => {
    if (inspect?.content != null) setDraftContent(inspect.content);
  }, [inspect?.content, inspect?.record?.id]);

  const filtered = useMemo(() => {
    let list = proposals;
    if (statusFilter === 'today') {
      list = list.filter((p) => isToday(p.updatedAt) || isToday(p.createdAt));
    } else if (statusFilter !== 'all') {
      list = list.filter((p) => p.status === statusFilter);
    }
    const q = search.trim().toLowerCase();
    if (q) {
      list = list.filter(
        (p) =>
          p.skillName.toLowerCase().includes(q) ||
          p.title.toLowerCase().includes(q) ||
          p.description.toLowerCase().includes(q) ||
          p.id.toLowerCase().includes(q),
      );
    }
    return [...list].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  }, [proposals, statusFilter, search]);

  const pendingCount = useMemo(() => proposals.filter((p) => p.status === 'pending').length, [proposals]);

  const openDetail = useCallback(
    (id: string) => {
      void inspectProposal(id);
    },
    [inspectProposal],
  );

  const handleApply = useCallback(async () => {
    if (!selectedId) return;
    const result = await applyProposal(selectedId);
    if (result) {
      messageApi.success(t('extensions.workshop.applySuccess'));
      void loadSkills();
    } else {
      messageApi.error(t('extensions.workshop.actionFailed'));
    }
  }, [selectedId, applyProposal, messageApi, t, loadSkills]);

  const handleReject = useCallback(() => {
    if (!selectedId) return;
    modal.confirm({
      title: t('extensions.workshop.rejectTitle'),
      content: t('extensions.workshop.rejectConfirm'),
      okType: 'danger',
      onOk: async () => {
        const ok = await rejectProposal(selectedId, 'Rejected from Research-Claw dashboard');
        if (ok) messageApi.success(t('extensions.workshop.rejectSuccess'));
        else messageApi.error(t('extensions.workshop.actionFailed'));
      },
    });
  }, [selectedId, rejectProposal, modal, messageApi, t]);

  const handleQuarantine = useCallback(() => {
    if (!selectedId) return;
    modal.confirm({
      title: t('extensions.workshop.quarantineTitle'),
      content: t('extensions.workshop.quarantineConfirm'),
      onOk: async () => {
        const ok = await quarantineProposal(selectedId, 'Quarantined from Research-Claw dashboard');
        if (ok) messageApi.success(t('extensions.workshop.quarantineSuccess'));
        else messageApi.error(t('extensions.workshop.actionFailed'));
      },
    });
  }, [selectedId, quarantineProposal, modal, messageApi, t]);

  const handleRevise = useCallback(async () => {
    if (!selectedId || !draftContent.trim()) return;
    const ok = await reviseProposal(selectedId, draftContent);
    if (ok) messageApi.success(t('extensions.workshop.reviseSuccess'));
    else messageApi.error(t('extensions.workshop.actionFailed'));
  }, [selectedId, draftContent, reviseProposal, messageApi, t]);

  const handleContinueInChat = useCallback(() => {
    if (!selectedId) return;
    const name = inspect?.record.target.skillName ?? selectedId;
    setChatInputPrefill(
      t('extensions.workshop.chatHandoff', {
        id: selectedId,
        name,
      }),
    );
    messageApi.info(t('extensions.workshop.chatHandoffHint'));
  }, [selectedId, inspect, setChatInputPrefill, t, messageApi]);

  const handleCreate = useCallback(async () => {
    const name = createName.trim();
    const description = createDesc.trim();
    const content = createBody.trim();
    if (!name || !description || !content) {
      messageApi.warning(t('extensions.workshop.createIncomplete'));
      return;
    }
    const record = await createProposal({ name, description, content });
    if (record) {
      messageApi.success(t('extensions.workshop.createSuccess'));
      setCreateOpen(false);
      setCreateName('');
      setCreateDesc('');
      setCreateBody('');
      void inspectProposal(record.id);
    } else {
      messageApi.error(t('extensions.workshop.actionFailed'));
    }
  }, [createName, createDesc, createBody, createProposal, messageApi, t, inspectProposal]);

  const record = inspect?.record;
  const isPending = record?.status === 'pending';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div style={{ padding: '8px 12px', flexShrink: 0 }}>
        <Paragraph style={{ color: tokens.text.muted, fontSize: 12, marginBottom: 8 }}>
          {t('extensions.workshop.hint')}
        </Paragraph>
        {lastError && (
          <Alert type="error" message={lastError} closable style={{ marginBottom: 8 }} showIcon />
        )}
        <Space wrap style={{ marginBottom: 8, width: '100%' }}>
          <Segmented
            size="small"
            value={statusFilter}
            onChange={(v) => setStatusFilter(v as StatusFilter)}
            options={[
              { label: t('extensions.workshop.filter.pending', { count: pendingCount }), value: 'pending' },
              { label: t('extensions.workshop.filter.today'), value: 'today' },
              { label: t('extensions.workshop.filter.all'), value: 'all' },
              { label: t('extensions.workshop.filter.applied'), value: 'applied' },
              { label: t('extensions.workshop.filter.rejected'), value: 'rejected' },
            ]}
          />
          <Button size="small" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>
            {t('extensions.workshop.newProposal')}
          </Button>
          <Button size="small" icon={<ReloadOutlined />} loading={loading} onClick={() => loadProposals()}>
            {t('common.refresh', { defaultValue: 'Refresh' })}
          </Button>
        </Space>
        <Search
          allowClear
          size="small"
          placeholder={t('extensions.workshop.searchPlaceholder')}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      <div style={{ flex: 1, overflow: 'auto', padding: '0 12px 12px' }}>
        {filtered.length === 0 ? (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={t('extensions.workshop.empty')}
            style={{ marginTop: 48 }}
          />
        ) : (
          filtered.map((p) => (
            <ProposalCard
              key={p.id}
              proposal={p}
              selected={p.id === selectedId}
              tokens={tokens}
              onClick={() => openDetail(p.id)}
            />
          ))
        )}
      </div>

      <Drawer
        title={record?.title ?? t('extensions.workshop.detailTitle')}
        open={Boolean(selectedId)}
        onClose={clearSelection}
        width={Math.min(560, typeof window !== 'undefined' ? window.innerWidth * 0.92 : 560)}
        loading={inspectLoading}
        extra={
          isPending ? (
            <Space size={4} wrap>
              <Button type="primary" size="small" icon={<CheckOutlined />} onClick={() => void handleApply()}>
                {t('extensions.workshop.apply')}
              </Button>
              <Button size="small" onClick={() => void handleRevise()}>
                {t('extensions.workshop.saveDraft')}
              </Button>
              <Button size="small" icon={<MessageOutlined />} onClick={handleContinueInChat}>
                {t('extensions.workshop.continueInChat')}
              </Button>
              <Button size="small" danger onClick={handleReject}>
                {t('extensions.workshop.reject')}
              </Button>
              <Button size="small" icon={<SafetyCertificateOutlined />} onClick={handleQuarantine}>
                {t('extensions.workshop.quarantine')}
              </Button>
            </Space>
          ) : null
        }
      >
        {record && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <Space wrap size={4}>
              <Tag color={STATUS_COLORS[record.status]}>{record.status}</Tag>
              <Tag>{record.kind}</Tag>
              <Tag>{record.scan.state}</Tag>
              {record.scan.critical > 0 && (
                <Tag color="error" icon={<WarningOutlined />}>
                  {t('extensions.workshop.scanCritical', { count: record.scan.critical })}
                </Tag>
              )}
            </Space>
            <Text type="secondary" style={{ fontSize: 12 }}>
              {record.description}
            </Text>
            <Text type="secondary" style={{ fontSize: 11 }}>
              ID: {record.id} · {relativeTime(record.updatedAt)}
            </Text>
            {record.statusReason && (
              <Alert type="warning" message={record.statusReason} showIcon />
            )}
            {record.scan.findings.length > 0 && (
              <div>
                <Text strong style={{ fontSize: 12 }}>
                  {t('extensions.workshop.findings')}
                </Text>
                <ul style={{ margin: '8px 0 0', paddingLeft: 18, fontSize: 11 }}>
                  {record.scan.findings.map((f, i) => (
                    <li key={`${f.ruleId}-${i}`} style={{ marginBottom: 4 }}>
                      <Text code>{f.severity}</Text> {f.file}:{f.line} — {f.message}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <div>
              <Text strong style={{ fontSize: 12, display: 'block', marginBottom: 6 }}>
                PROPOSAL.md
              </Text>
              <TextArea
                value={draftContent}
                onChange={(e) => setDraftContent(e.target.value)}
                disabled={!isPending}
                autoSize={{ minRows: 12, maxRows: 24 }}
                style={{ fontFamily: 'var(--font-mono, monospace)', fontSize: 12 }}
              />
            </div>
            {inspect?.supportFiles && inspect.supportFiles.length > 0 && (
              <div>
                <Text strong style={{ fontSize: 12 }}>
                  {t('extensions.workshop.supportFiles')}
                </Text>
                <ul style={{ fontSize: 11, margin: '6px 0 0', paddingLeft: 18 }}>
                  {inspect.supportFiles.map((f) => (
                    <li key={f.path}>{f.path}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </Drawer>

      <Modal
        title={t('extensions.workshop.createTitle')}
        open={createOpen}
        onCancel={() => setCreateOpen(false)}
        onOk={() => void handleCreate()}
        okText={t('extensions.workshop.submitProposal')}
        width={520}
      >
        <Space direction="vertical" style={{ width: '100%' }} size={8}>
          <Input
            placeholder={t('extensions.workshop.skillName')}
            value={createName}
            onChange={(e) => setCreateName(e.target.value)}
          />
          <Input
            placeholder={t('extensions.workshop.shortDescription')}
            value={createDesc}
            onChange={(e) => setCreateDesc(e.target.value)}
            maxLength={160}
          />
          <TextArea
            placeholder={t('extensions.workshop.proposalBody')}
            value={createBody}
            onChange={(e) => setCreateBody(e.target.value)}
            autoSize={{ minRows: 10, maxRows: 18 }}
            style={{ fontFamily: 'var(--font-mono, monospace)', fontSize: 12 }}
          />
        </Space>
      </Modal>
    </div>
  );
}

function ProposalCard({
  proposal,
  selected,
  tokens,
  onClick,
}: {
  proposal: SkillProposalManifestEntry;
  selected: boolean;
  tokens: ReturnType<typeof getThemeTokens>;
  onClick: () => void;
}) {
  const { t } = useTranslation();

  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: 'block',
        width: '100%',
        textAlign: 'left',
        marginBottom: 8,
        padding: '10px 12px',
        borderRadius: 8,
        border: `1px solid ${selected ? tokens.accent.blue : tokens.border.default}`,
        background: selected ? tokens.bg.surfaceHover : tokens.bg.surface,
        cursor: 'pointer',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'flex-start' }}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <Text strong style={{ color: tokens.text.primary, fontSize: 13 }}>
            {proposal.skillName}
          </Text>
          <Text style={{ color: tokens.text.muted, fontSize: 11, display: 'block' }} ellipsis>
            {proposal.description}
          </Text>
        </div>
        <Tag color={STATUS_COLORS[proposal.status]} style={{ margin: 0, flexShrink: 0 }}>
          {proposal.status}
        </Tag>
      </div>
      <div style={{ marginTop: 6, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        <Tag style={{ fontSize: 10, margin: 0 }}>{proposal.kind}</Tag>
        <Tag style={{ fontSize: 10, margin: 0 }}>{proposal.scanState}</Tag>
        <Text style={{ fontSize: 10, color: tokens.text.muted }}>
          {relativeTime(proposal.updatedAt)}
        </Text>
      </div>
    </button>
  );
}
