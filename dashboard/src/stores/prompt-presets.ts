import { create } from 'zustand';
import { useGatewayStore } from './gateway';

export interface PromptPreset {
  id: string;
  name: string;
  content: string;
  category: string;
  favorite: boolean;
  sort_order: number;
  use_count: number;
  last_used_at: string | null;
  created_at: string;
  updated_at: string;
}

interface PromptPresetState {
  presets: PromptPreset[];
  loaded: boolean;
  loading: boolean;
  load: () => Promise<void>;
  create: (input: Pick<PromptPreset, 'name' | 'content'> & Partial<Pick<PromptPreset, 'category' | 'favorite'>>) => Promise<PromptPreset>;
  update: (id: string, patch: Partial<Pick<PromptPreset, 'name' | 'content' | 'category' | 'favorite'>>) => Promise<PromptPreset>;
  remove: (id: string) => Promise<boolean>;
  reorder: (ids: string[]) => Promise<void>;
  markUsed: (id: string) => Promise<void>;
}

function connectedClient() {
  const client = useGatewayStore.getState().client;
  if (!client?.isConnected) throw new Error('Gateway is not connected');
  return client;
}

export const usePromptPresetStore = create<PromptPresetState>()((set) => ({
  presets: [],
  loaded: false,
  loading: false,

  load: async () => {
    set({ loading: true });
    try {
      const result = await connectedClient().request<{ presets: PromptPreset[] }>(
        'rc.prompt-presets.list',
        {},
      );
      set({ presets: result.presets, loaded: true, loading: false });
    } catch (err) {
      set({ loading: false });
      throw err;
    }
  },

  create: async (input) => {
    const result = await connectedClient().request<{ preset: PromptPreset }>(
      'rc.prompt-presets.create',
      input,
    );
    set((state) => ({ presets: [...state.presets, result.preset] }));
    return result.preset;
  },

  update: async (id, patch) => {
    const result = await connectedClient().request<{ preset: PromptPreset }>(
      'rc.prompt-presets.update',
      { id, ...patch },
    );
    set((state) => ({
      presets: state.presets.map((preset) => preset.id === id ? result.preset : preset),
    }));
    return result.preset;
  },

  remove: async (id) => {
    const result = await connectedClient().request<{ deleted: boolean }>(
      'rc.prompt-presets.delete',
      { id },
    );
    if (result.deleted) {
      set((state) => ({ presets: state.presets.filter((preset) => preset.id !== id) }));
    }
    return result.deleted;
  },

  reorder: async (ids) => {
    const result = await connectedClient().request<{ presets: PromptPreset[] }>(
      'rc.prompt-presets.reorder',
      { ids },
    );
    set({ presets: result.presets });
  },

  markUsed: async (id) => {
    const result = await connectedClient().request<{ preset: PromptPreset }>(
      'rc.prompt-presets.mark-used',
      { id },
    );
    set((state) => ({
      presets: state.presets.map((preset) => preset.id === id ? result.preset : preset),
    }));
  },
}));
