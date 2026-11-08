import { create } from 'zustand';
export const useTeamsStore = create<{ open: boolean; setOpen: (open: boolean) => void }>(set => ({
  open: false, setOpen: open => set({ open }),
}));
