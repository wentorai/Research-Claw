import React, { useCallback } from 'react';
import { Button, message, Tag, Typography } from 'antd';
import {
  FileOutlined,
  FilePdfOutlined,
  FileTextOutlined,
  CodeOutlined,
  DatabaseOutlined,
  PictureOutlined,
  ExportOutlined,
  FolderViewOutlined,
} from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import CardContainer from './CardContainer';
import { useConfigStore } from '@/stores/config';
import { useGatewayStore } from '@/stores/gateway';
import { getThemeTokens } from '@/styles/theme';
import type { FileCard as FileCardType } from '@/types/cards';

const { Text } = Typography;

/** File type icon + color mapping */
function getFileTypeInfo(name: string, tokens: ReturnType<typeof getThemeTokens>): {
  icon: React.ReactNode;
  color: string;
} {
  const ext = name.includes('.') ? name.split('.').pop()?.toLowerCase() ?? '' : '';

  if (ext === 'pdf') {
    return { icon: <FilePdfOutlined />, color: '#EF4444' };
  }
  if (['tex', 'md', 'txt'].includes(ext)) {
    return { icon: <FileTextOutlined />, color: tokens.text.secondary };
  }
  if (['py', 'r', 'jl', 'm'].includes(ext)) {
    return { icon: <CodeOutlined />, color: '#22C55E' };
  }
  if (['csv', 'xlsx', 'json'].includes(ext)) {
    return { icon: <DatabaseOutlined />, color: '#3B82F6' };
  }
  if (['png', 'jpg', 'jpeg', 'svg', 'gif'].includes(ext)) {
    return { icon: <PictureOutlined />, color: '#A855F7' };
  }
  if (ext === 'bib') {
    return { icon: <FileOutlined />, color: '#F59E0B' };
  }
  return { icon: <FileOutlined />, color: tokens.text.muted };
}

/** Format bytes to human-readable size */
function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

export default function FileCard(props: FileCardType) {
  const { t } = useTranslation();
  const theme = useConfigStore((s) => s.theme);
  const tokens = getThemeTokens(theme);
  const client = useGatewayStore((s) => s.client);

  const fileInfo = getFileTypeInfo(props.name, tokens);

  const handleOpenFile = useCallback(() => {
    client?.request('rc.ws.openExternal', { path: props.path }).catch((err: unknown) => {
      const detail = err instanceof Error ? err.message : '';
      message.error(`${t('workspace.contextMenu.openFailed')}: ${props.path}${detail ? ` (${detail})` : ''}`);
    });
  }, [props.path, client, t]);

  const handleOpenFolder = useCallback(() => {
    client?.request('rc.ws.openFolder', { path: props.path }).catch((err: unknown) => {
      const detail = err instanceof Error ? err.message : '';
      message.error(`${t('workspace.contextMenu.openFailed')}: ${props.path}${detail ? ` (${detail})` : ''}`);
    });
  }, [props.path, client, t]);

  return (
    <CardContainer borderColor={fileInfo.color}>
      {/* Header: file icon + filename */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
        <span style={{ fontSize: 24, color: fileInfo.color }}>
          {fileInfo.icon}
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <Text
            strong
            style={{
              fontSize: 14,
              color: tokens.text.primary,
              display: 'block',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {props.name}
          </Text>
          {/* Git status badge */}
          {props.git_status && (
            <Tag
              color={
                props.git_status === 'new'
                  ? '#22C55E'
                  : props.git_status === 'modified'
                    ? '#3B82F6'
                    : undefined
              }
              style={{ fontSize: 10, marginTop: 2 }}
            >
              {props.git_status === 'new' && `+ ${t('card.file.gitNew')}`}
              {props.git_status === 'modified' && `M ${t('card.file.gitModified')}`}
              {props.git_status === 'committed' && t('card.file.gitCommitted')}
            </Tag>
          )}
        </div>
      </div>

      {/* Metadata */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 8 }}>
        <div>
          <Text style={{ fontSize: 12, color: tokens.text.muted }}>
            {t('card.file.path')}:{' '}
          </Text>
          <Text
            style={{
              fontSize: 12,
              color: tokens.text.secondary,
              fontFamily: "'JetBrains Mono', 'Fira Code', Consolas, monospace",
              wordBreak: 'break-all',
            }}
          >
            {props.path}
          </Text>
        </div>

        {props.size_bytes != null && (
          <div>
            <Text style={{ fontSize: 12, color: tokens.text.muted }}>
              {t('card.file.size')}:{' '}
            </Text>
            <Text style={{ fontSize: 12, color: tokens.text.secondary }}>
              {formatFileSize(props.size_bytes)}
            </Text>
          </div>
        )}

        {props.mime_type && (
          <div>
            <Text style={{ fontSize: 12, color: tokens.text.muted }}>
              {t('card.file.type')}:{' '}
            </Text>
            <Text style={{ fontSize: 12, color: tokens.text.secondary }}>
              {props.mime_type}
            </Text>
          </div>
        )}
      </div>

      {/* Actions: Open File (system) | Open Folder (Finder) */}
      <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
        <Button
          size="small"
          icon={<ExportOutlined />}
          onClick={handleOpenFile}
          style={{
            borderColor: tokens.accent.blue,
            color: tokens.accent.blue,
          }}
        >
          {t('card.file.openFile')}
        </Button>
        <Button
          size="small"
          icon={<FolderViewOutlined />}
          onClick={handleOpenFolder}
          style={{
            borderColor: tokens.accent.blue,
            color: tokens.accent.blue,
          }}
        >
          {t('card.file.openDir')}
        </Button>
      </div>
    </CardContainer>
  );
}
