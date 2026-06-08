/** Max visible composer textarea height before internal scroll kicks in. */
export const MAX_COMPOSER_INPUT_HEIGHT = 120;

export function resizeComposerInput(el: HTMLTextAreaElement): void {
  el.style.height = 'auto';
  const capped = Math.min(el.scrollHeight, MAX_COMPOSER_INPUT_HEIGHT);
  el.style.height = `${capped}px`;
  el.style.overflowY = el.scrollHeight > MAX_COMPOSER_INPUT_HEIGHT ? 'auto' : 'hidden';
}
