import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useGatewayStore } from './gateway';
import { usePromptPresetStore, type PromptPreset } from './prompt-presets';

const first: PromptPreset = {
  id: 'a',
  name: '梳理',
  content: '请梳理',
  category: '',
  favorite: false,
  sort_order: 0,
  use_count: 0,
  last_used_at: null,
  created_at: '2026-01-01',
  updated_at: '2026-01-01',
};

describe('prompt preset store', () => {
  const request = vi.fn();

  beforeEach(() => {
    request.mockReset();
    useGatewayStore.setState({
      client: { isConnected: true, request } as never,
      state: 'connected',
    });
    usePromptPresetStore.setState({ presets: [], loaded: false, loading: false });
  });

  it('uses the stable CRUD contract and keeps local state in sync', async () => {
    request.mockResolvedValueOnce({ presets: [first] });
    await usePromptPresetStore.getState().load();
    expect(usePromptPresetStore.getState().presets).toEqual([first]);

    const created = { ...first, id: 'b', name: '审稿', sort_order: 1 };
    request.mockResolvedValueOnce({ preset: created });
    await usePromptPresetStore.getState().create({ name: created.name, content: created.content });
    expect(usePromptPresetStore.getState().presets).toHaveLength(2);

    request.mockResolvedValueOnce({ preset: { ...created, favorite: true } });
    await usePromptPresetStore.getState().update('b', { favorite: true });
    expect(usePromptPresetStore.getState().presets[1].favorite).toBe(true);

    request.mockResolvedValueOnce({ deleted: true });
    await usePromptPresetStore.getState().remove('a');
    expect(usePromptPresetStore.getState().presets.map((preset) => preset.id)).toEqual(['b']);
  });
});
