import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import React from 'react';
import MarkdownBody from '../components/MarkdownBody';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k, i18n: { changeLanguage: vi.fn() } }),
  initReactI18next: { type: '3rdParty', init: vi.fn() },
}));

const TREE = ['project/', '├── src/', '│   ├── a.ts', '│   └── b.ts', '└── README.md'].join('\n');

describe('language-less fenced code blocks', () => {
  it('renders a multi-line no-language fence as a block (not inline code)', () => {
    const { container } = render(<MarkdownBody>{'```\n' + TREE + '\n```'}</MarkdownBody>);
    // Block path renders a <pre> (Shiki fallback); inline path never does.
    expect(container.querySelector('pre')).not.toBeNull();
    expect(container.textContent).toContain('├──');
  });

  it('does not leak a `node` attribute onto any rendered element', () => {
    const { container } = render(<MarkdownBody>{'```\n' + TREE + '\n```'}</MarkdownBody>);
    expect(container.querySelector('[node]')).toBeNull();
  });

  it('still renders true inline code as inline (no <pre>) and no node leak', () => {
    const { container } = render(<MarkdownBody>{'use `npm run dev` here'}</MarkdownBody>);
    expect(container.querySelector('pre')).toBeNull();
    const code = container.querySelector('code');
    expect(code).not.toBeNull();
    expect(code!.getAttribute('node')).toBeNull();
  });

  it('does not regress language-tagged fences', () => {
    const { container } = render(<MarkdownBody>{'```bash\necho hi\n```'}</MarkdownBody>);
    expect(container.querySelector('pre')).not.toBeNull();
    expect(container.textContent).toContain('echo hi');
  });
});

describe('UI card regression (must keep working)', () => {
  it('renders a paper_card fenced JSON as a card', () => {
    const json = JSON.stringify({ type: 'paper_card', title: 'Attention Is All You Need', authors: ['Vaswani'] });
    const { container } = render(<MarkdownBody>{'```paper_card\n' + json + '\n```'}</MarkdownBody>);
    expect(container.textContent).toContain('Attention Is All You Need');
  });

  it('renders a card even with an info-string after the language tag', () => {
    const json = JSON.stringify({ type: 'paper_card', title: 'X Title', authors: ['Y'] });
    const { container } = render(<MarkdownBody>{'```paper_card foo=bar\n' + json + '\n```'}</MarkdownBody>);
    expect(container.textContent).toContain('X Title');
  });

  it('shows a placeholder for incomplete streaming card JSON', () => {
    const { container } = render(<MarkdownBody>{'```task_card\n{ "type": "task_card", "tit'}</MarkdownBody>);
    // Incomplete JSON must NOT dump raw braces as a normal code block.
    expect(container.textContent).not.toContain('"tit');
  });
});
