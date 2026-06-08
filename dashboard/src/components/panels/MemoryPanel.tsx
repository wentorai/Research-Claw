/**
 * Memory Panel - Card-based UI for viewing automatically captured memories
 *
 * Inspired by claude-mem's card-based design.
 * Focuses on viewing memories captured from chat sessions, not manual creation.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { Input, Select, Button, Card, Tag, Space, Typography, Empty, Spin, Tooltip, Badge } from 'antd';
import { SearchOutlined, FilterOutlined, ClockCircleOutlined, EyeOutlined, BookOutlined, ExperimentOutlined, LinkOutlined, FileTextOutlined, ThunderboltOutlined } from '@ant-design/icons';
import { useMemoryStore, type Memory, type MemoryType } from '../../stores/memory';
import { useGatewayStore } from '../../stores/gateway';

const { Title, Text, Paragraph } = Typography;

const MEMORY_TYPE_CONFIG: Record<MemoryType, { label: string; icon: string; color: string; description: string }> = {
  user: { label: '用户', icon: '👤', color: '#3B82F6', description: '用户偏好、习惯和设置' },
  feedback: { label: '反馈', icon: '💡', color: '#10B981', description: '用户反馈和改进建议' },
  project: { label: '项目', icon: '📊', color: '#F59E0B', description: '项目相关信息和上下文' },
  reference: { label: '引用', icon: '🔗', color: '#8B5CF6', description: '外部引用和资源链接' },
  agent: { label: 'Agent 记忆', icon: '🤖', color: '#EF4444', description: 'Claude-mem 捕获的观察记录与工作记忆' },
};

const TYPE_ICONS: Record<MemoryType, React.ReactNode> = {
  user: <BookOutlined style={{ color: '#3B82F6' }} />,
  feedback: <ThunderboltOutlined style={{ color: '#10B981' }} />,
  project: <ExperimentOutlined style={{ color: '#F59E0B' }} />,
  reference: <LinkOutlined style={{ color: '#8B5CF6' }} />,
  agent: <FileTextOutlined style={{ color: '#EF4444' }} />,
};

interface SessionSummary {
  id: string;
  started_at: string;
  ended_at: string | null;
  events_count: number;
  memories_extracted: number;
}

export const MemoryPanel: React.FC = () => {
  const {
    memories,
    selectedType,
    searchQuery,
    setSelectedType,
    setSearchQuery,
    fetchMemories,
    stats,
    fetchStats,
    syncHookLogs,
  } = useMemoryStore();
  const gatewayConnected = useGatewayStore((s) => s.state === 'connected');

  const [loading, setLoading] = useState(false);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [selectedSession, setSelectedSession] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<'all' | 'session'>('all');

  useEffect(() => {
    void loadData();
  }, []); // Initial load only; type filter is local for stable stats

  useEffect(() => {
    if (gatewayConnected) {
      void loadData();
    }
  }, [gatewayConnected]); // Re-load full stats once gateway is connected

  const loadData = async () => {
    setLoading(true);
    try {
      await Promise.all([
        syncHookLogs('all', 120),
        fetchMemories({ limit: 5000, is_active: true }),
        fetchStats(),
        loadSessions(),
      ]);
    } finally {
      setLoading(false);
    }
  };

  const loadSessions = async () => {
    try {
      // This would call the session list RPC method
      const sessionsData: SessionSummary[] = [
        {
          id: '1',
          started_at: new Date(Date.now() - 3600000).toISOString(),
          ended_at: new Date().toISOString(),
          events_count: 15,
          memories_extracted: 3,
        },
      ];
      setSessions(sessionsData);
    } catch (error) {
      console.error('Failed to load sessions:', error);
    }
  };

  const handleSearch = async () => {
    if (searchQuery.trim()) {
      setLoading(true);
      try {
        await fetchMemories({ limit: 5000, is_active: true });
        // In a real implementation, this would use searchMemories
      } finally {
        setLoading(false);
      }
    } else {
      await fetchMemories({ limit: 5000, is_active: true });
    }
  };

  const handleTypeFilter = async (type: MemoryType | null) => {
    setSelectedType(type);
  };

  const formatTimeAgo = (timestamp: string): string => {
    const now = new Date();
    const then = new Date(timestamp);
    const diffMs = now.getTime() - then.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return '刚刚';
    if (diffMins < 60) return `${diffMins} 分钟前`;
    if (diffHours < 24) return `${diffHours} 小时前`;
    return `${diffDays} 天前`;
  };

  const formatSessionDuration = (started: string, ended: string | null): string => {
    if (!ended) return '进行中';
    const start = new Date(started).getTime();
    const end = new Date(ended).getTime();
    const diffMins = Math.floor((end - start) / 60000);

    if (diffMins < 60) return `${diffMins} 分钟`;
    const hours = Math.floor(diffMins / 60);
    const mins = diffMins % 60;
    return `${hours} 小时 ${mins} 分钟`;
  };

  const fallbackStatsSummary = useMemo(() => {
    const byType = { user: 0, feedback: 0, project: 0, reference: 0, agent: 0 } as Record<MemoryType, number>;
    for (const memory of memories) {
      byType[memory.type] = (byType[memory.type] ?? 0) + 1;
    }
    return { total: memories.length, by_type: byType };
  }, [memories]);

  const filteredMemories = memories.filter(memory => {
    if (selectedType && memory.type !== selectedType) return false;
    if (viewMode === 'session' && selectedSession && memory.metadata) {
      try {
        const meta = JSON.parse(memory.metadata) as { session_id?: string };
        if (meta.session_id !== selectedSession) return false;
      } catch {
        // Invalid JSON, skip session filter
      }
    }
    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase();
      return (
        memory.name.toLowerCase().includes(query) ||
        (memory.description && memory.description.toLowerCase().includes(query)) ||
        memory.content.toLowerCase().includes(query)
      );
    }
    return true;
  });

  const displayedMemories = filteredMemories;
  const activeStats = useMemo(() => {
    if (!stats) return fallbackStatsSummary;
    return {
      total: stats.total ?? fallbackStatsSummary.total,
      by_type: {
        user: stats.by_type?.user ?? 0,
        feedback: stats.by_type?.feedback ?? 0,
        project: stats.by_type?.project ?? 0,
        reference: stats.by_type?.reference ?? 0,
        agent: (stats.by_type as Record<string, number> | undefined)?.agent ?? 0,
      } as Record<MemoryType, number>,
    };
  }, [stats, fallbackStatsSummary]);

  return (
    <div style={{ padding: 'clamp(12px, 3vw, 24px)', maxWidth: 1100, margin: '0 auto', minWidth: 0 }}>
      <section
        style={{
          position: 'relative',
          overflow: 'hidden',
          borderRadius: 24,
          border: '1px solid rgba(255,255,255,0.12)',
          background:
            'radial-gradient(circle at 12% 18%, rgba(239,68,68,0.22), transparent 28%), radial-gradient(circle at 88% 0%, rgba(139,92,246,0.18), transparent 32%), linear-gradient(135deg, rgba(22,22,24,0.98), rgba(10,10,12,0.96))',
          boxShadow: '0 24px 80px rgba(0,0,0,0.32)',
          padding: 'clamp(18px, 5vw, 28px)',
          marginBottom: 22,
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 18, flexWrap: 'wrap', minWidth: 0 }}>
          <div style={{ minWidth: 0, flex: '1 1 260px' }}>
            <Tag
              color="error"
              style={{
                borderRadius: 999,
                padding: '3px 10px',
                marginBottom: 14,
                border: '1px solid rgba(239,68,68,0.36)',
                background: 'rgba(239,68,68,0.12)',
              }}
            >
              Persistent Memory
            </Tag>
            <Title level={2} style={{ color: '#fff', margin: 0, letterSpacing: -0.5, fontSize: 'clamp(26px, 7vw, 38px)' }}>
              <ExperimentOutlined /> 记忆工作台
            </Title>
            <Paragraph style={{ color: 'rgba(255,255,255,0.68)', maxWidth: 620, margin: '12px 0 0' }}>
              自动捕获会话中的用户偏好、项目事实、反馈和引用，把零散上下文压缩成可检索的长期记忆。
            </Paragraph>
          </div>

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(96px, 1fr))',
              gap: 10,
              minWidth: 0,
              width: '100%',
              flex: '1 1 260px',
            }}
          >
            {[
              { label: 'Capture', value: '捕获', icon: <FileTextOutlined /> },
              { label: 'Compress', value: '压缩', icon: <ThunderboltOutlined /> },
              { label: 'Retrieve', value: '检索', icon: <SearchOutlined /> },
            ].map((item) => (
              <div
                key={item.label}
                style={{
                  borderRadius: 18,
                  padding: 14,
                  background: 'rgba(255,255,255,0.06)',
                  border: '1px solid rgba(255,255,255,0.10)',
                  backdropFilter: 'blur(8px)',
                }}
              >
                <div style={{ color: '#ef4444', fontSize: 18, marginBottom: 8 }}>{item.icon}</div>
                <div style={{ color: '#fff', fontWeight: 700 }}>{item.value}</div>
                <div style={{ color: 'rgba(255,255,255,0.42)', fontSize: 11, marginTop: 2 }}>{item.label}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 136px), 1fr))',
          gap: 12,
          marginBottom: 18,
        }}
      >
        <MemoryMetricCard
          title="总记忆数"
          value={activeStats.total}
          icon={<FileTextOutlined />}
          color="#F87171"
          active={!selectedType}
          onClick={() => void handleTypeFilter(null)}
        />
        {Object.entries(activeStats.by_type).map(([type, count]) => {
          const key = type as MemoryType;
          const config = MEMORY_TYPE_CONFIG[key];
          return (
            <MemoryMetricCard
              key={key}
              title={config.label}
              value={count}
              icon={TYPE_ICONS[key]}
              color={config.color}
              active={selectedType === key}
              onClick={() => void handleTypeFilter(key)}
            />
          );
        })}
      </div>

      <Card
        style={{
          marginBottom: 18,
          borderRadius: 22,
          background: 'var(--bg-surface)',
          border: '1px solid var(--border-default)',
          boxShadow: '0 12px 40px rgba(0,0,0,0.16)',
        }}
        styles={{ body: { padding: 18 } }}
      >
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
          <Input
            placeholder="搜索记忆..."
            prefix={<SearchOutlined />}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onPressEnter={handleSearch}
            style={{ flex: '1 1 220px', minWidth: 0 }}
            allowClear
          />
          <Select
            placeholder="筛选类型"
            style={{ flex: '1 1 130px', minWidth: 0 }}
            value={selectedType}
            onChange={handleTypeFilter}
            allowClear
            suffixIcon={<FilterOutlined />}
          >
            {Object.entries(MEMORY_TYPE_CONFIG).map(([key, config]) => (
              <Select.Option key={key} value={key}>
                {config.icon} {config.label}
              </Select.Option>
            ))}
          </Select>
          <Select
            value={viewMode}
            onChange={(value) => { setViewMode(value); setSelectedSession(null); }}
            style={{ flex: '1 1 130px', minWidth: 0 }}
          >
            <Select.Option value="all">所有记忆</Select.Option>
            <Select.Option value="session">按会话查看</Select.Option>
          </Select>
          <Button type="primary" icon={<SearchOutlined />} onClick={handleSearch} style={{ flex: '0 0 auto' }}>
            搜索
          </Button>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 14 }}>
          {Object.entries(MEMORY_TYPE_CONFIG).map(([key, config]) => (
            <Tag
              key={key}
              color={selectedType === key ? config.color : 'default'}
              icon={TYPE_ICONS[key as MemoryType]}
              style={{ borderRadius: 999, padding: '3px 10px', cursor: 'pointer' }}
              onClick={() => void handleTypeFilter(selectedType === key ? null : key as MemoryType)}
            >
              {config.label}
            </Tag>
          ))}
        </div>
      </Card>

      {/* Session View */}
      {viewMode === 'session' && (
        <Card
          style={{ marginBottom: 18, borderRadius: 22, border: '1px solid var(--border-default)' }}
          title={<Space><ClockCircleOutlined /> 最近会话</Space>}
        >
          {sessions.length === 0 ? (
            <Empty description="暂无会话记录" image={Empty.PRESENTED_IMAGE_SIMPLE} />
          ) : (
            <Space direction="vertical" style={{ width: '100%' }} size="middle">
              {sessions.map((session) => (
                <Card
                  key={session.id}
                  size="small"
                  hoverable
                  style={{
                    cursor: 'pointer',
                    border: selectedSession === session.id ? '1px solid #ef4444' : '1px solid var(--border-default)',
                    borderRadius: 16,
                    background: selectedSession === session.id ? 'rgba(239,68,68,0.08)' : 'var(--bg-surface)',
                  }}
                  onClick={() => setSelectedSession(session.id)}
                >
                  <Space style={{ width: '100%', justifyContent: 'space-between' }}>
                    <Space>
                      <ClockCircleOutlined />
                      <Text strong>{formatTimeAgo(session.started_at)}</Text>
                      <Text type="secondary">·</Text>
                      <Text type="secondary">{formatSessionDuration(session.started_at, session.ended_at)}</Text>
                    </Space>
                    <Space>
                      <Badge count={session.events_count} showZero>
                        <Text type="secondary">事件</Text>
                      </Badge>
                      <Badge count={session.memories_extracted} showZero color="#52c41a">
                        <Text type="secondary">记忆</Text>
                      </Badge>
                    </Space>
                  </Space>
                </Card>
              ))}
            </Space>
          )}
        </Card>
      )}

      {/* Memories List */}
      {loading ? (
        <div style={{ textAlign: 'center', padding: 48 }}>
          <Spin size="large" tip="加载记忆中..." />
        </div>
      ) : displayedMemories.length === 0 ? (
        <Card style={{ borderRadius: 22, border: '1px solid var(--border-default)' }}>
          <Empty
            description={selectedSession ? "该会话暂无提取的记忆" : "暂无记忆"}
            image={Empty.PRESENTED_IMAGE_SIMPLE}
          >
            {selectedSession && (
              <Button type="link" onClick={() => setSelectedSession(null)}>
                查看所有记忆
              </Button>
            )}
          </Empty>
        </Card>
      ) : (
        <Space direction="vertical" size={14} style={{ width: '100%' }}>
          {displayedMemories.map((memory) => {
            const config = MEMORY_TYPE_CONFIG[memory.type];
            return (
              <Card
                key={memory.id}
                size="small"
                style={{
                  position: 'relative',
                  overflow: 'hidden',
                  borderRadius: 20,
                  border: '1px solid var(--border-default)',
                  background: 'linear-gradient(135deg, var(--bg-surface), rgba(255,255,255,0.02))',
                  cursor: 'pointer',
                  boxShadow: '0 10px 30px rgba(0,0,0,0.12)',
                }}
                styles={{ body: { padding: 18 } }}
                hoverable
                onClick={() => {/* TODO: Show memory detail modal */}}
              >
                <div
                  style={{
                    position: 'absolute',
                    left: 0,
                    top: 0,
                    bottom: 0,
                    width: 4,
                    background: config.color,
                  }}
                />
                <div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, marginBottom: 12 }}>
                    <Space wrap>
                      <Tooltip title={config.description}>
                        <Tag
                          color={config.color}
                          icon={TYPE_ICONS[memory.type]}
                          style={{ borderRadius: 999, padding: '2px 9px' }}
                        >
                          {config.icon} {config.label}
                        </Tag>
                      </Tooltip>
                      <Text strong style={{ fontSize: 15 }}>
                        {memory.name}
                      </Text>
                    </Space>
                    <Space size={10} wrap>
                      <Tooltip title="访问次数">
                        <Text type="secondary" style={{ fontSize: 12 }}>
                          <EyeOutlined /> {memory.access_count}
                        </Text>
                      </Tooltip>
                      <Tooltip title="最后访问">
                        <Text type="secondary" style={{ fontSize: 12 }}>
                          <ClockCircleOutlined /> {memory.accessed_at ? formatTimeAgo(memory.accessed_at) : '从未'}
                        </Text>
                      </Tooltip>
                    </Space>
                  </div>

                  {memory.description && (
                    <Paragraph
                      type="secondary"
                      style={{ marginBottom: 8, fontSize: 13 }}
                      ellipsis={{ rows: 1 }}
                    >
                      {memory.description}
                    </Paragraph>
                  )}

                  <Paragraph
                    style={{
                      marginBottom: 10,
                      fontSize: 13,
                      color: 'var(--text-primary)',
                      lineHeight: 1.7,
                    }}
                    ellipsis={{ rows: 2 }}
                  >
                    {memory.content}
                  </Paragraph>

                  <Space wrap style={{ marginTop: 8 }}>
                    {memory.tags && memory.tags.length > 0 && (
                      <>
                        {memory.tags.map((tag) => (
                          <Tag key={tag.id} color={tag.color || 'default'} style={{ margin: 0, fontSize: 11 }}>
                            {tag.name}
                          </Tag>
                        ))}
                      </>
                    )}
                    {memory.is_private === 1 && (
                      <Tag color="red" style={{ margin: 0, fontSize: 11, borderRadius: 999 }}>隐私</Tag>
                    )}
                  </Space>
                </div>
              </Card>
            );
          })}
        </Space>
      )}

    </div>
  );
};

function MemoryMetricCard({
  title,
  value,
  icon,
  color,
  active,
  onClick,
}: {
  title: string;
  value: number;
  icon: React.ReactNode;
  color: string;
  active?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        textAlign: 'left',
        cursor: 'pointer',
        border: active ? `1px solid ${color}` : '1px solid var(--border-default)',
        background: active ? `linear-gradient(135deg, ${color}24, var(--bg-surface))` : 'var(--bg-surface)',
        borderRadius: 20,
        padding: 16,
        boxShadow: active ? `0 12px 32px ${color}20` : '0 8px 26px rgba(0,0,0,0.10)',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'flex-start' }}>
        <div>
          <div style={{ color: 'var(--text-tertiary)', fontSize: 12, marginBottom: 8 }}>{title}</div>
          <div style={{ color, fontSize: 30, lineHeight: 1, fontWeight: 800 }}>{value}</div>
        </div>
        <div
          style={{
            width: 36,
            height: 36,
            borderRadius: 12,
            display: 'grid',
            placeItems: 'center',
            color,
            background: `${color}18`,
            fontSize: 18,
          }}
        >
          {icon}
        </div>
      </div>
    </button>
  );
}

export default MemoryPanel;
