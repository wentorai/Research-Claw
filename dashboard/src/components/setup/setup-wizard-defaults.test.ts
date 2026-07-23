import { describe, it, expect } from 'vitest';
import { WIZARD_DEFAULT_PROVIDER, WIZARD_DEFAULT_MODEL } from './SetupWizard';
import { getPreset } from '../../utils/provider-presets';

/**
 * Pins the first-run SetupWizard preselection (there was previously no test
 * guarding the default — it silently changed between providers).
 */
describe('SetupWizard first-run defaults', () => {
  it('preselects DeepSeek V4 Pro for first-time users', () => {
    expect(WIZARD_DEFAULT_PROVIDER).toBe('deepseek');
    expect(WIZARD_DEFAULT_MODEL).toBe('deepseek-v4-pro');
  });

  it('default model actually exists in the default provider preset', () => {
    const preset = getPreset(WIZARD_DEFAULT_PROVIDER);
    expect(preset.id).toBe(WIZARD_DEFAULT_PROVIDER);
    expect(preset.models.some((m) => m.id === WIZARD_DEFAULT_MODEL)).toBe(true);
  });

  it('default model is NOT simply models[0] — the explicit pin matters', () => {
    // deepseek preset lists v4-flash first; the wizard must still preselect
    // v4-pro via the explicit WIZARD_DEFAULT_MODEL lookup.
    const preset = getPreset(WIZARD_DEFAULT_PROVIDER);
    const resolved =
      preset.models.find((m) => m.id === WIZARD_DEFAULT_MODEL)?.id
      ?? preset.models[0]?.id
      ?? '';
    expect(resolved).toBe('deepseek-v4-pro');
  });
});
