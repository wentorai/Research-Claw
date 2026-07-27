import React, { useEffect, useState } from 'react';
import { Button, Typography } from 'antd';
import { BookOutlined, EditOutlined, FieldTimeOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import { useChatStore } from '../../stores/chat';
import { useConfigStore } from '../../stores/config';
import { useOnboardingStore } from '../../stores/onboarding';
import { getThemeTokens } from '../../styles/theme';
import { RC_VERSION } from '../../version';
import { FEISHU_TUTORIAL_URL } from '../../constants/links';

const { Text, Link } = Typography;

/** Data/terminal font stack — DESIGN_LANGUAGE §4 (数字/代码/终端用 Fira Code). */
const MONO_FONT = "'Fira Code', 'JetBrains Mono', Consolas, monospace";

/**
 * Actual text sent to the model when the user clicks the init CTA. The hidden
 * [Research-Claw] block tells the model to skip its self-intro (the card
 * already did it) and start the BOOTSTRAP flow directly at asking how to
 * address the user. The block format matches utils/intraview-prompt.ts so
 * sanitizeUserMessage strips it on every history reload and the bubble keeps
 * showing only the first line. Must stay in sync with the Context note in
 * BOOTSTRAP.md.example.
 */
export const WELCOME_INIT_PROMPT = [
  '开始初始化',
  '',
  '[Research-Claw] 初始化引导',
  '  - 界面欢迎卡已完成自我介绍并展示了飞书使用教程链接',
  '  - 不要重复自我介绍，直接从询问称呼开始',
].join('\n');

/** What the user sees as their own bubble after clicking the CTA. */
export const WELCOME_INIT_DISPLAY_TEXT = '开始初始化';

function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  } catch {
    return false;
  }
}

/** Char-by-char reveal for the greeting line; instant when reduced motion is set. */
function useTypewriter(text: string, charIntervalMs = 70): string {
  const [count, setCount] = useState(() => (prefersReducedMotion() ? text.length : 0));

  useEffect(() => {
    if (prefersReducedMotion()) {
      setCount(text.length);
      return;
    }
    setCount(0);
    const timer = setInterval(() => {
      setCount((c) => {
        if (c + 1 >= text.length) clearInterval(timer);
        return Math.min(c + 1, text.length);
      });
    }, charIntervalMs);
    return () => clearInterval(timer);
  }, [text, charIntervalMs]);

  return text.slice(0, count);
}

/**
 * First-run hero card — rendered by ChatView in place of the plain bubble for
 * the synthetic localKind === 'welcome' message (see stores/onboarding.ts).
 */
export default function WelcomeCard() {
  const { t } = useTranslation();
  const theme = useConfigStore((s) => s.theme);
  const tokens = getThemeTokens(theme);
  // CTA disappears for good once the user has said anything in this session,
  // and never re-arms once the server stops reporting first-run (guards the
  // "/clear resurrects the persisted welcome card after onboarding" path —
  // the retired BOOTSTRAP.md could no longer back the init flow).
  const hasUserMessage = useChatStore((s) => s.messages.some((m) => m.role === 'user'));
  const serverFirstRun = useOnboardingStore((s) => s.status?.firstRun === true);
  const [ctaCollapsed, setCtaCollapsed] = useState(false);
  const showCta = serverFirstRun && !ctaCollapsed && !hasUserMessage;
  const reducedMotion = prefersReducedMotion();

  // Re-validate a stale in-memory verdict when the card mounts with the CTA
  // armed: within one WS connection, "complete onboarding → /clear" resurrects
  // the persisted card while status still holds the boot-time firstRun=true
  // (fetchStatus otherwise only re-runs on reconnect). Fail-safe: any probe
  // error flips to NOT first-run and hides the CTA. The debug-forced verdict
  // (__RC_WELCOME__.show()) is exempt so console previews keep the full card.
  useEffect(() => {
    const { status } = useOnboardingStore.getState();
    if (status?.firstRun === true && status.signals?.__debugForced !== true) {
      void useOnboardingStore.getState().fetchStatus();
    }
  }, []);

  const greeting = t('welcome.greeting');
  const typedGreeting = useTypewriter(greeting);

  const handleStart = () => {
    void useChatStore.getState().send(WELCOME_INIT_PROMPT, undefined, {
      displayText: WELCOME_INIT_DISPLAY_TEXT,
    });
  };

  const pills = [
    { icon: <BookOutlined />, label: t('welcome.pillLibrary') },
    { icon: <EditOutlined />, label: t('welcome.pillWriting') },
    { icon: <FieldTimeOutlined />, label: t('welcome.pillMonitor') },
  ];

  return (
    <div className="chat-turn" data-testid="welcome-card">
      <div
        role="article"
        style={{
          background: tokens.bg.surface,
          border: `1px solid ${tokens.border.default}`,
          borderLeft: `3px solid ${tokens.accent.red}`,
          borderRadius: 8,
          padding: '20px 24px',
          maxWidth: 640,
          fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
        }}
      >
        {/* Typewriter greeting + blinking terminal cursor */}
        <div
          role="heading"
          aria-level={3}
          aria-label={greeting}
          style={{
            // Heading treatment per DESIGN_LANGUAGE §4: heavy weight + negative
            // tracking is where the "精密" feel comes from (h3 weight = 700).
            fontSize: 20,
            fontWeight: 700,
            letterSpacing: '-0.02em',
            color: tokens.text.primary,
            minHeight: 30,
            lineHeight: '30px',
          }}
        >
          <span aria-hidden="true">{typedGreeting}</span>
          <span
            aria-hidden="true"
            style={{
              display: 'inline-block',
              width: 2,
              height: 18,
              background: tokens.accent.red,
              marginLeft: 3,
              verticalAlign: 'baseline',
              animation: reducedMotion ? undefined : 'blink 0.8s step-end infinite',
            }}
          />
        </div>

        <Text type="secondary" style={{ fontSize: 13 }}>
          {t('welcome.subtitle')} ·{' '}
          {/* Version is data → mono, per DESIGN_LANGUAGE §4 (数字/token 值). */}
          <span style={{ fontFamily: MONO_FONT, fontSize: 12 }}>v{RC_VERSION}</span>
        </Text>

        {/* Capability pills */}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, margin: '14px 0 12px' }}>
          {pills.map((pill) => (
            <span
              key={pill.label}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                padding: '4px 12px',
                borderRadius: 9999,
                border: `1px solid ${tokens.border.default}`,
                background: tokens.bg.surfaceHover,
                color: tokens.text.secondary,
                fontSize: 12,
                fontFamily: MONO_FONT,
              }}
            >
              {/* Icon carries the "信息" semantic → Academic Blue (DESIGN_LANGUAGE §1). */}
              <span aria-hidden="true" style={{ display: 'inline-flex', color: tokens.accent.blue }}>
                {pill.icon}
              </span>
              {pill.label}
            </span>
          ))}
        </div>

        <div style={{ color: tokens.text.primary, fontSize: 14, lineHeight: 1.7 }}>
          {t('welcome.intro')}
        </div>

        {/* CTA section — hidden after "先自己看看" or the first user message */}
        {showCta && (
          <div style={{ marginTop: 16 }}>
            {/*
             * House primary-CTA pattern (SetupWizard start button): default-size
             * antd primary button, so the theme's Button.borderRadius = 8 applies
             * (DESIGN_LANGUAGE §5 标准圆角 8px). size="large" was pulling antd's
             * borderRadiusLG = 12 — the off-language rounding. Presence comes from
             * padding + weight + the pulse-glow breathing, not from size.
             */}
            <Button
              type="primary"
              onClick={handleStart}
              style={{
                fontWeight: 600,
                paddingInline: 20,
                animation: reducedMotion ? undefined : 'pulse-glow 2s ease-in-out infinite',
              }}
            >
              {t('welcome.ctaStart')}
            </Button>
            <div style={{ marginTop: 6 }}>
              <Text type="secondary" style={{ fontSize: 12 }}>
                {t('welcome.ctaCaption')}
              </Text>
            </div>
          </div>
        )}

        {/* Secondary row — tutorial link stays available even after collapse */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginTop: 14 }}>
          {/*
           * Links are 信息 → Academic Blue (DESIGN_LANGUAGE §9.2: 红=行动/蓝=信息,
           * 别拿红做链接). antd ≥5.10 derives colorLink from colorPrimary (Lobster
           * Red here), so the color must be pinned to the brand-secondary token.
           */}
          <Link
            href={FEISHU_TUTORIAL_URL}
            target="_blank"
            rel="noreferrer"
            style={{ fontSize: 13, color: tokens.accent.blue }}
          >
            {t('welcome.tutorialLink')}
          </Link>
          {showCta && (
            <Button
              type="text"
              size="small"
              onClick={() => setCtaCollapsed(true)}
              style={{ fontSize: 13, color: tokens.text.secondary }}
            >
              {t('welcome.browseFirst')}
            </Button>
          )}
        </div>

        <div
          style={{
            marginTop: 12,
            paddingTop: 10,
            borderTop: `1px solid ${tokens.border.default}`,
            display: 'flex',
            alignItems: 'baseline',
            gap: 6,
          }}
        >
          {/* Terminal prompt glyph — same mono/terminal register as the cursor. */}
          <span
            aria-hidden="true"
            style={{ fontFamily: MONO_FONT, fontSize: 12, color: tokens.text.muted }}
          >
            ❯
          </span>
          <Text type="secondary" style={{ fontSize: 12 }}>
            {t('welcome.footerHint')}
          </Text>
        </div>
      </div>
    </div>
  );
}
