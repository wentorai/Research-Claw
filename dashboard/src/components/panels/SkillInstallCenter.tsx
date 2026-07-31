import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  App,
  Button,
  Checkbox,
  Input,
  Modal,
  Segmented,
  Spin,
  Tag,
  Typography,
} from 'antd';
import {
  CheckCircleOutlined,
  CloudDownloadOutlined,
  FileZipOutlined,
  SafetyCertificateOutlined,
  SearchOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import {
  createSkillInstallAdapter,
  SkillArchiveValidationError,
  type ClawHubSearchResult,
  type ClawHubSkillDetail,
  type LocalArchivePreflight,
  type LocalInstallProgress,
  type LocalSkillCandidate,
  type LocalSkillInstallResult,
  type SkillInstallCapabilities,
} from '../../gateway/skill-install-adapter';
import { useExtensionsStore } from '../../stores/extensions';
import { useGatewayStore } from '../../stores/gateway';
import { type getThemeTokens } from '../../styles/theme';

const { Text, Paragraph } = Typography;

type InstallSource = 'clawhub' | 'local';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function dependencyValues(candidate: LocalSkillCandidate): Array<{
  kind: string;
  value: string;
}> {
  return [
    ...candidate.requirements.bins.map((value) => ({ kind: 'bin', value })),
    ...candidate.requirements.anyBins.map((value) => ({ kind: 'any-bin', value })),
    ...candidate.requirements.env.map((value) => ({ kind: 'env', value })),
    ...candidate.requirements.config.map((value) => ({ kind: 'config', value })),
    ...candidate.requirements.os.map((value) => ({ kind: 'os', value })),
  ];
}

function CandidateCard({
  candidate,
  selected,
  force,
  onSelectedChange,
  onForceChange,
  tokens,
}: {
  candidate: LocalSkillCandidate;
  selected: boolean;
  force: boolean;
  onSelectedChange: (selected: boolean) => void;
  onForceChange: (force: boolean) => void;
  tokens: ReturnType<typeof getThemeTokens>;
}) {
  const { t } = useTranslation();
  const dependencies = dependencyValues(candidate);
  const blocked = candidate.localScan === 'blocked';

  return (
    <div
      style={{
        padding: 10,
        border: `1px solid ${
          blocked
            ? tokens.accent.red
            : candidate.conflict.kind === 'existing'
              ? tokens.accent.amber
              : tokens.border.default
        }`,
        borderRadius: 8,
        background: tokens.bg.surface,
      }}
    >
      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
        <Checkbox
          checked={selected}
          disabled={blocked}
          onChange={(event) => onSelectedChange(event.target.checked)}
          aria-label={t('extensions.install.local.selectCandidate', {
            defaultValue: 'Select {{name}}',
            name: candidate.displayName,
          })}
        />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
            <Text strong style={{ color: tokens.text.primary, fontSize: 13 }}>
              {candidate.displayName}
            </Text>
            <Tag style={{ margin: 0, fontFamily: 'var(--font-mono)', fontSize: 10 }}>
              {candidate.slug || t('extensions.install.local.invalidSlug', 'Invalid slug')}
            </Tag>
            {candidate.conflict.kind === 'existing' && (
              <Tag color="orange" style={{ margin: 0 }}>
                {t('extensions.install.local.existing', 'Existing Skill')}
              </Tag>
            )}
          </div>
          {candidate.description && (
            <Text style={{ color: tokens.text.muted, display: 'block', fontSize: 11 }}>
              {candidate.description}
            </Text>
          )}
          <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginTop: 6 }}>
            <Tag
              color={
                candidate.localScan === 'pass'
                  ? 'green'
                  : candidate.localScan === 'warning'
                    ? 'orange'
                    : 'red'
              }
              style={{ margin: 0 }}
            >
              {candidate.localScan === 'pass'
                ? t('extensions.install.local.scanPassed', 'Local scan passed')
                : candidate.localScan === 'warning'
                  ? t('extensions.install.local.scanWarning', 'Local scan warnings')
                  : t('extensions.install.local.scanBlocked', 'Local scan blocked')}
            </Tag>
            {dependencies.length === 0 ? (
              <Tag style={{ margin: 0 }}>
                {t('extensions.install.local.noDependencies', 'No declared dependencies')}
              </Tag>
            ) : (
              dependencies.map(({ kind, value }) => (
                <Tag key={`${kind}:${value}`} style={{ margin: 0 }}>
                  <span style={{ color: tokens.text.muted, marginRight: 4 }}>{kind}</span>
                  {value}
                </Tag>
              ))
            )}
          </div>
          {candidate.issues.map((issue) => (
            <Text
              key={`${issue.code}:${issue.message}`}
              style={{
                color: issue.severity === 'blocked' ? tokens.accent.red : tokens.accent.amber,
                display: 'block',
                fontSize: 10,
                marginTop: 4,
              }}
            >
              {issue.message}
            </Text>
          ))}
          {candidate.conflict.kind === 'existing' && selected && (
            <Checkbox
              checked={force}
              onChange={(event) => onForceChange(event.target.checked)}
              style={{ color: tokens.text.secondary, marginTop: 6, fontSize: 11 }}
            >
              {t('extensions.install.local.overwrite', 'Overwrite the existing Skill')}
            </Checkbox>
          )}
        </div>
      </div>
    </div>
  );
}

export default function SkillInstallCenter({
  tokens,
}: {
  tokens: ReturnType<typeof getThemeTokens>;
}) {
  const { t } = useTranslation();
  const { message: messageApi } = App.useApp();
  const client = useGatewayStore((state) => state.client);
  const gatewayState = useGatewayStore((state) => state.state);
  const gatewayEventEpoch = useGatewayStore((state) => state.eventEpoch);
  const skills = useExtensionsStore((state) => state.skills);
  const loadSkills = useExtensionsStore((state) => state.loadSkills);
  const adapter = useMemo(
    () =>
      gatewayState === 'connected' && client?.isConnected
        ? createSkillInstallAdapter(client)
        : null,
    // A Gateway reconnect reuses the same client object. eventEpoch makes the
    // native-capability snapshot refresh on a new connection as well.
    [client, gatewayEventEpoch, gatewayState],
  );

  const [source, setSource] = useState<InstallSource>('clawhub');
  const [capabilities, setCapabilities] = useState<SkillInstallCapabilities | null>(null);
  const [capabilitiesError, setCapabilitiesError] = useState<string | null>(null);

  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [searchResults, setSearchResults] = useState<ClawHubSearchResult[] | null>(null);
  const [detail, setDetail] = useState<ClawHubSkillDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [clawhubConfirmOpen, setClawhubConfirmOpen] = useState(false);
  const [clawhubInstalling, setClawhubInstalling] = useState(false);
  const [clawhubResult, setClawhubResult] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [preflightLoading, setPreflightLoading] = useState(false);
  const [preflight, setPreflight] = useState<LocalArchivePreflight | null>(null);
  const [preflightError, setPreflightError] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [forceIds, setForceIds] = useState<Set<string>>(new Set());
  const [localConfirmOpen, setLocalConfirmOpen] = useState(false);
  const [securityAcknowledged, setSecurityAcknowledged] = useState(false);
  const [localInstalling, setLocalInstalling] = useState(false);
  const [progress, setProgress] = useState<Record<string, LocalInstallProgress>>({});
  const [localResults, setLocalResults] = useState<LocalSkillInstallResult[]>([]);

  useEffect(() => {
    let stale = false;
    setCapabilities(null);
    setCapabilitiesError(null);
    if (!adapter) {
      return () => {
        stale = true;
      };
    }
    void adapter.loadCapabilities().then(
      (next) => {
        if (!stale) setCapabilities(next);
      },
      (error) => {
        if (!stale) setCapabilitiesError(errorMessage(error));
      },
    );
    return () => {
      stale = true;
    };
  }, [adapter]);

  const handleSearch = useCallback(async () => {
    const trimmed = query.trim();
    if (!adapter || !trimmed || searching) return;
    setSearching(true);
    setSearchError(null);
    setSearchResults(null);
    setDetail(null);
    try {
      setSearchResults(await adapter.searchClawHub(trimmed));
    } catch (error) {
      setSearchError(errorMessage(error));
    } finally {
      setSearching(false);
    }
  }, [adapter, query, searching]);

  const handleReviewClawHub = useCallback(async (slug: string) => {
    if (!adapter) return;
    setDetailLoading(true);
    setDetailError(null);
    setDetail(null);
    try {
      setDetail(await adapter.loadClawHubDetail(slug));
    } catch (error) {
      setDetailError(errorMessage(error));
    } finally {
      setDetailLoading(false);
    }
  }, [adapter]);

  const handleInstallClawHub = useCallback(async () => {
    const slug = detail?.skill?.slug;
    if (!adapter || !slug) return;
    setClawhubInstalling(true);
    setClawhubResult(null);
    try {
      const result = await adapter.installFromClawHub({
        slug,
        version: detail.latestVersion?.version,
      });
      const resultText =
        result.message ??
        t('extensions.install.clawhub.installedFallback', {
          defaultValue: 'Installed {{slug}}',
          slug,
        });
      setClawhubResult(resultText);
      setClawhubConfirmOpen(false);
      await loadSkills();
      messageApi.success(resultText);
    } catch (error) {
      messageApi.error(errorMessage(error));
    } finally {
      setClawhubInstalling(false);
    }
  }, [adapter, detail, loadSkills, messageApi, t]);

  const handleFile = useCallback(async (file: File) => {
    if (!adapter) return;
    setPreflightLoading(true);
    setPreflight(null);
    setPreflightError(null);
    setLocalResults([]);
    setProgress({});
    try {
      const result = await adapter.preflightLocalArchive(
        file,
        skills.map(({ skillKey, baseDir }) => ({ skillKey, baseDir })),
      );
      setPreflight(result);
      setSelectedIds(new Set(
        result.candidates
          .filter(
            (candidate) =>
              candidate.localScan !== 'blocked' && candidate.conflict.kind === 'none',
          )
          .map((candidate) => candidate.id),
      ));
      setForceIds(new Set());
    } catch (error) {
      const details =
        error instanceof SkillArchiveValidationError && error.issues.length > 0
          ? ` ${error.issues.map((issue) => issue.message).join('; ')}`
          : '';
      setPreflightError(`${errorMessage(error)}${details}`);
    } finally {
      setPreflightLoading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }, [adapter, skills]);

  const updateSelected = useCallback((id: string, selected: boolean) => {
    setSelectedIds((previous) => {
      const next = new Set(previous);
      if (selected) next.add(id);
      else next.delete(id);
      return next;
    });
    if (!selected) {
      setForceIds((previous) => {
        const next = new Set(previous);
        next.delete(id);
        return next;
      });
    }
  }, []);

  const updateForce = useCallback((id: string, force: boolean) => {
    setForceIds((previous) => {
      const next = new Set(previous);
      if (force) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  const selectedCandidates = useMemo(
    () => preflight?.candidates.filter((candidate) => selectedIds.has(candidate.id)) ?? [],
    [preflight, selectedIds],
  );
  const unresolvedConflicts = selectedCandidates.some(
    (candidate) => candidate.conflict.kind === 'existing' && !forceIds.has(candidate.id),
  );

  const handleInstallLocal = useCallback(async () => {
    if (!adapter || !preflight || !securityAcknowledged) return;
    setLocalConfirmOpen(false);
    setLocalInstalling(true);
    setLocalResults([]);
    setProgress({});
    try {
      const results = await adapter.installLocalCandidates(preflight, {
        selectedIds,
        forceIds,
        onProgress: (next) => {
          setProgress((previous) => ({ ...previous, [next.id]: next }));
        },
      });
      setLocalResults(results);
      await loadSkills();
      const installed = results.filter((result) => result.status === 'installed').length;
      const failed = results.length - installed;
      if (failed > 0 && installed > 0) {
        messageApi.warning(
          t('extensions.install.local.partial', {
            defaultValue: '{{installed}} installed, {{failed}} failed',
            installed,
            failed,
          }),
        );
      } else if (failed > 0) {
        messageApi.error(t('extensions.install.local.allFailed', 'No Skills were installed'));
      } else {
        messageApi.success(
          t('extensions.install.local.complete', {
            defaultValue: '{{count}} Skills installed',
            count: installed,
          }),
        );
      }
    } finally {
      setLocalInstalling(false);
      setSecurityAcknowledged(false);
    }
  }, [
    adapter,
    forceIds,
    loadSkills,
    messageApi,
    preflight,
    securityAcknowledged,
    selectedIds,
    t,
  ]);

  const renderClawHub = () => (
    <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
      <Alert
        type="info"
        showIcon
        message={t('extensions.install.clawhub.native', 'Native OpenClaw source')}
        description={t(
          'extensions.install.clawhub.description',
          'Searches ClawHub, loads registry details, then installs through skills.install.',
        )}
      />
      <div style={{ display: 'flex', gap: 8 }}>
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onPressEnter={(event) => {
            if (event.nativeEvent.isComposing) return;
            void handleSearch();
          }}
          placeholder={t('extensions.install.clawhub.searchPlaceholder', 'Search ClawHub skills')}
          prefix={<SearchOutlined />}
          disabled={!adapter}
        />
        <Button
          type="primary"
          onClick={() => void handleSearch()}
          loading={searching}
          disabled={!adapter || !query.trim()}
        >
          {t('extensions.install.search', 'Search')}
        </Button>
      </div>
      {searchError && <Alert type="error" showIcon message={searchError} />}
      {searchResults?.length === 0 && (
        <Text style={{ color: tokens.text.muted }}>
          {t('extensions.install.clawhub.empty', 'No matching Skills found.')}
        </Text>
      )}
      {searchResults?.map((result) => (
        <div
          key={result.slug}
          style={{
            padding: 10,
            border: `1px solid ${tokens.border.default}`,
            borderRadius: 8,
            background: tokens.bg.surface,
            display: 'flex',
            gap: 8,
            alignItems: 'center',
          }}
        >
          <CloudDownloadOutlined style={{ color: tokens.accent.blue }} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <Text strong style={{ color: tokens.text.primary, display: 'block' }}>
              {result.displayName}
            </Text>
            <Text style={{ color: tokens.text.muted, fontSize: 11 }}>
              {result.summary ?? result.slug}
            </Text>
          </div>
          {result.version && <Tag>{result.version}</Tag>}
          <Button size="small" onClick={() => void handleReviewClawHub(result.slug)}>
            {t('extensions.install.review', 'Review')}
          </Button>
        </div>
      ))}
      {detailLoading && <Spin size="small" />}
      {detailError && <Alert type="error" showIcon message={detailError} />}
      {detail?.skill && (
        <div
          style={{
            padding: 12,
            border: `1px solid ${tokens.accent.blue}`,
            borderRadius: 8,
            background: tokens.bg.surfaceHover,
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
            <div>
              <Text strong style={{ color: tokens.text.primary, display: 'block' }}>
                {detail.skill.displayName}
              </Text>
              <Text style={{ color: tokens.text.muted, fontSize: 11 }}>
                {detail.owner?.displayName ?? detail.owner?.handle ?? 'ClawHub'}
              </Text>
            </div>
            <Button type="primary" onClick={() => setClawhubConfirmOpen(true)}>
              {t('extensions.install.install', 'Install')}
            </Button>
          </div>
          {detail.skill.summary && (
            <Paragraph style={{ color: tokens.text.secondary, fontSize: 12, margin: '8px 0' }}>
              {detail.skill.summary}
            </Paragraph>
          )}
          {detail.latestVersion?.changelog && (
            <Text style={{ color: tokens.text.secondary, fontSize: 11 }}>
              {detail.latestVersion.changelog}
            </Text>
          )}
        </div>
      )}
      {clawhubResult && <Alert type="success" showIcon message={clawhubResult} />}
      <Modal
        title={t('extensions.install.clawhub.confirmTitle', 'Confirm Skill installation')}
        open={clawhubConfirmOpen}
        onCancel={() => setClawhubConfirmOpen(false)}
        onOk={() => void handleInstallClawHub()}
        okText={t('extensions.install.installNow', 'Install now')}
        confirmLoading={clawhubInstalling}
      >
        <Paragraph>
          {t(
            'extensions.install.clawhub.confirmDescription',
            'OpenClaw will download, verify, scan, and install this Skill into the current workspace.',
          )}
        </Paragraph>
        <Text strong>{detail?.skill?.displayName}</Text>
        {detail?.latestVersion?.version && <Tag>{detail.latestVersion.version}</Tag>}
      </Modal>
    </div>
  );

  const renderLocal = () => (
    <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
      {adapter && !capabilities && !capabilitiesError && <Spin size="small" />}
      {capabilitiesError && <Alert type="error" showIcon message={capabilitiesError} />}
      {capabilities && !capabilities.uploadedArchives && (
        <Alert
          type="warning"
          showIcon
          message={t(
            'extensions.install.local.disabled',
            'Local archive upload is disabled by the Gateway configuration.',
          )}
          description={t(
            'extensions.install.local.disabledDescription',
            'Enable skills.install.allowUploadedArchives in openclaw.json, then reconnect. You can still inspect a ZIP while installation is blocked.',
          )}
        />
      )}
      <Alert
        type="info"
        showIcon
        icon={<SafetyCertificateOutlined />}
        message={t('extensions.install.local.preflightTitle', 'Local structure preflight')}
        description={t(
          'extensions.install.local.preflightBoundary',
          'This browser check is not a security boundary. Every selected Skill is installed atomically and receives the Gateway security scan during installation.',
        )}
      />
      <input
        ref={fileInputRef}
        type="file"
        accept=".zip,application/zip"
        aria-label={t('extensions.install.local.chooseZip', 'Choose Skill ZIP')}
        style={{ display: 'none' }}
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void handleFile(file);
        }}
      />
      <Button
        icon={<FileZipOutlined />}
        onClick={() => fileInputRef.current?.click()}
        loading={preflightLoading}
      >
        {t('extensions.install.local.chooseZip', 'Choose Skill ZIP')}
      </Button>
      {preflightError && <Alert type="error" showIcon message={preflightError} />}
      {preflight && (
        <>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
            <Text strong style={{ color: tokens.text.primary }}>
              {t('extensions.install.local.skillsFound', {
                defaultValue: '{{count}} Skills found',
                count: preflight.candidates.length,
              })}
            </Text>
            <Tag>
              {preflight.kind === 'multi-skill'
                ? t('extensions.install.local.multiSkillZip', 'Multi-Skill ZIP')
                : t('extensions.install.local.singleSkillZip', 'Single-Skill ZIP')}
            </Tag>
            <Tag style={{ fontFamily: 'var(--font-mono)', fontSize: 9 }}>
              SHA-256 {preflight.sha256.slice(0, 12)}…
            </Tag>
          </div>
          <Alert
            type="warning"
            showIcon
            icon={<WarningOutlined />}
            message={t(
              'extensions.install.local.gatewayScan',
              'Gateway security scan runs during installation.',
            )}
            description={t(
              'extensions.install.local.noPreview',
              'OpenClaw 2026.6.1 has no scan-only verdict RPC, so no pre-install security verdict is fabricated here.',
            )}
          />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {preflight.candidates.map((candidate) => (
              <CandidateCard
                key={candidate.id}
                candidate={candidate}
                selected={selectedIds.has(candidate.id)}
                force={forceIds.has(candidate.id)}
                onSelectedChange={(selected) => updateSelected(candidate.id, selected)}
                onForceChange={(force) => updateForce(candidate.id, force)}
                tokens={tokens}
              />
            ))}
          </div>
          <Button
            type="primary"
            onClick={() => {
              setSecurityAcknowledged(false);
              setLocalConfirmOpen(true);
            }}
            disabled={
              !capabilities?.uploadedArchives ||
              selectedCandidates.length === 0 ||
              unresolvedConflicts ||
              localInstalling
            }
            loading={localInstalling}
          >
            {t('extensions.install.local.review', 'Review installation')}
          </Button>
          {unresolvedConflicts && (
            <Text style={{ color: tokens.accent.amber, fontSize: 11 }}>
              {t(
                'extensions.install.local.resolveConflict',
                'Confirm overwrite for every selected conflicting Skill.',
              )}
            </Text>
          )}
        </>
      )}
      {Object.values(progress).some(
        (entry) => entry.status === 'uploading' || entry.status === 'installing',
      ) && <Spin size="small" />}
      {localResults.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {localResults.map((result) => {
            const candidate = preflight?.candidates.find((entry) => entry.id === result.id);
            const installed = result.status === 'installed';
            return (
              <Alert
                key={result.id}
                type={installed ? 'success' : 'error'}
                showIcon
                message={
                  installed
                    ? t('extensions.install.local.resultInstalled', {
                        defaultValue: 'Installed: {{name}}',
                        name: candidate?.displayName ?? result.slug,
                      })
                    : t('extensions.install.local.resultFailed', {
                        defaultValue: 'Failed: {{name}}',
                        name: candidate?.displayName ?? result.slug,
                      })
                }
                description={result.message}
              />
            );
          })}
        </div>
      )}
      <Modal
        title={t('extensions.install.local.confirmTitle', 'Confirm local Skill installation')}
        open={localConfirmOpen}
        onCancel={() => setLocalConfirmOpen(false)}
        onOk={() => void handleInstallLocal()}
        okText={t('extensions.install.local.installSelected', 'Install selected')}
        confirmLoading={localInstalling}
        okButtonProps={{ disabled: !securityAcknowledged }}
      >
        <Paragraph strong>
          {t('extensions.install.local.selectedCount', {
            defaultValue: '{{count}} Skill selected',
            count: selectedCandidates.length,
          })}
        </Paragraph>
        <Paragraph>
          {t(
            'extensions.install.local.atomicPartial',
            'Skills are installed one by one. If one fails, successful items remain installed and every result is reported separately.',
          )}
        </Paragraph>
        <Checkbox
          checked={securityAcknowledged}
          onChange={(event) => setSecurityAcknowledged(event.target.checked)}
          aria-label={t(
            'extensions.install.local.securityAcknowledge',
            'I understand that the Gateway security verdict is produced during installation.',
          )}
        >
          {t(
            'extensions.install.local.securityAcknowledge',
            'I understand that the Gateway security verdict is produced during installation.',
          )}
        </Checkbox>
      </Modal>
    </div>
  );

  return (
    <div style={{ height: '100%', overflow: 'auto' }}>
      <div style={{ padding: '8px 12px 0' }}>
        <Segmented
          block
          value={source}
          onChange={(value) => setSource(value as InstallSource)}
          options={[
            { label: t('extensions.install.clawhub.tab', 'ClawHub'), value: 'clawhub' },
            { label: t('extensions.install.local.tab', 'Local ZIP'), value: 'local' },
          ]}
        />
      </div>
      {!adapter && (
        <div style={{ padding: '10px 12px 0' }}>
          <Alert
            type="error"
            showIcon
            message={t('extensions.disconnected', 'Connect to gateway to view extensions')}
          />
        </div>
      )}
      {source === 'clawhub' ? renderClawHub() : renderLocal()}
    </div>
  );
}
