/**
 * OAuthModal — Dashboard-initiated OAuth flow.
 *
 * Replaces the CLI-only "run openclaw models auth login" hint with an
 * interactive modal that works in all environments (native, Docker, WSL2).
 *
 * Flow:
 *   1. Plugin generates PKCE + auth URL
 *   2. User clicks link → authenticates in browser
 *   3. Browser redirects to localhost:1455 (may fail in Docker — that's OK)
 *   4. User pastes the redirect URL from browser address bar
 *   5. Plugin exchanges code for tokens → stores in auth-profiles.json
 */
import { useState } from 'react';
import { Modal, Input, Button, Typography, Steps, Alert, Space, Tooltip } from 'antd';
import { LinkOutlined, CopyOutlined, CheckCircleOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import { useGatewayStore } from '../stores/gateway';
import { oauthProviderLabel } from '../utils/oauth-providers';

const { Text, Paragraph } = Typography;
const { TextArea } = Input;

interface OAuthModalProps {
  open: boolean;
  provider: string;
  onClose: () => void;
  onSuccess?: () => void;
}

export default function OAuthModal({ open, provider, onClose, onSuccess }: OAuthModalProps) {
  const { t } = useTranslation();
  const [step, setStep] = useState(0);
  const [authUrl, setAuthUrl] = useState('');
  const [stateId, setStateId] = useState('');
  const [callbackUrl, setCallbackUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);
  const [copied, setCopied] = useState(false);

  const reset = () => {
    setStep(0);
    setAuthUrl('');
    setStateId('');
    setCallbackUrl('');
    setLoading(false);
    setError('');
    setSuccess(false);
    setCopied(false);
  };

  const handleOpen = () => {
    reset();
    handleInitiate();
  };

  const handleInitiate = async () => {
    const client = useGatewayStore.getState().client;
    if (!client?.isConnected) {
      setError(t('oauth.notConnected'));
      return;
    }

    setLoading(true);
    setError('');
    try {
      const result = await client.request<{ authUrl: string; stateId: string }>(
        'rc.oauth.initiate',
        { provider },
      );
      setAuthUrl(result.authUrl);
      setStateId(result.stateId);
      setStep(1);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  const handleComplete = async () => {
    if (!callbackUrl.trim()) return;

    const client = useGatewayStore.getState().client;
    if (!client?.isConnected) {
      setError(t('oauth.notConnected'));
      return;
    }

    setLoading(true);
    setError('');
    try {
      await client.request('rc.oauth.complete', {
        state_id: stateId,
        callback_url: callbackUrl.trim(),
      });
      setSuccess(true);
      setStep(2);
      onSuccess?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  const handleCopyUrl = () => {
    navigator.clipboard.writeText(authUrl).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  const providerLabel = oauthProviderLabel(provider);

  return (
    <Modal
      title={`${providerLabel} OAuth`}
      open={open}
      onCancel={() => { reset(); onClose(); }}
      footer={null}
      width={520}
      afterOpenChange={(visible) => { if (visible) handleOpen(); }}
      destroyOnClose
    >
      <Steps
        current={step}
        size="small"
        style={{ marginBottom: 20 }}
        items={[
          { title: t('oauth.stepAuth') },
          { title: t('oauth.stepPaste') },
          { title: t('oauth.stepDone') },
        ]}
      />

      {error && (
        <Alert
          type="error"
          message={error}
          showIcon
          closable
          onClose={() => setError('')}
          style={{ marginBottom: 12 }}
        />
      )}

      {step === 0 && (
        <div style={{ textAlign: 'center', padding: '20px 0' }}>
          <Button type="primary" loading={loading} onClick={handleInitiate}>
            {t('oauth.startAuth')}
          </Button>
        </div>
      )}

      {step === 1 && (
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <div>
            <Text strong>{t('oauth.step1Title')}</Text>
            <Paragraph type="secondary" style={{ fontSize: 12, marginTop: 4, marginBottom: 8 }}>
              {t('oauth.step1Desc')}
            </Paragraph>
            <Space>
              <Button
                type="primary"
                icon={<LinkOutlined />}
                onClick={() => window.open(authUrl, '_blank')}
              >
                {t('oauth.openAuthPage')}
              </Button>
              <Tooltip title={copied ? t('oauth.copied') : t('oauth.copyUrl')}>
                <Button icon={<CopyOutlined />} onClick={handleCopyUrl}>
                  {copied ? t('oauth.copied') : t('oauth.copyUrl')}
                </Button>
              </Tooltip>
            </Space>
          </div>

          <div>
            <Text strong>{t('oauth.step2Title')}</Text>
            <Paragraph type="secondary" style={{ fontSize: 12, marginTop: 4, marginBottom: 8 }}>
              {t('oauth.step2Desc')}
            </Paragraph>
            <TextArea
              value={callbackUrl}
              onChange={(e) => setCallbackUrl(e.target.value)}
              placeholder="http://localhost:1455/auth/callback?code=...&state=..."
              autoSize={{ minRows: 2, maxRows: 4 }}
            />
          </div>

          <Button
            type="primary"
            loading={loading}
            disabled={!callbackUrl.trim()}
            onClick={handleComplete}
            block
          >
            {t('oauth.confirmLogin')}
          </Button>
        </Space>
      )}

      {step === 2 && success && (
        <div style={{ textAlign: 'center', padding: '20px 0' }}>
          <CheckCircleOutlined style={{ fontSize: 48, color: '#34d399' }} />
          <Paragraph style={{ marginTop: 12, fontSize: 14 }}>
            {t('oauth.success')}
          </Paragraph>
          <Button onClick={() => { reset(); onClose(); }}>
            {t('oauth.close')}
          </Button>
        </div>
      )}
    </Modal>
  );
}
