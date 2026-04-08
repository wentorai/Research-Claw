import { PROVIDER_PRESETS } from './provider-presets';

export type ProviderVariantRegion = 'cn' | 'global';
export type ProviderVariantUse = 'standard' | 'coding';

export type ProviderVariantSelection = {
  region?: ProviderVariantRegion;
  use?: ProviderVariantUse;
};

export type ProviderVariantGroupKey =
  | 'zai'
  | 'moonshot'
  | 'minimax'
  | 'modelstudio'
  | 'volcengine'
  | 'byteplus';

type GroupDef = {
  key: ProviderVariantGroupKey;
  /** Representative provider id shown in picker */
  representativeId: string;
  /** If true, supports region toggle */
  regions?: ProviderVariantRegion[];
  /** If true, supports use toggle */
  uses?: ProviderVariantUse[];
  /** Map selection to concrete provider id */
  resolve: (sel: ProviderVariantSelection) => string;
  /** Infer selection from a concrete provider id */
  infer: (providerId: string) => ProviderVariantSelection | null;
  /** Provider ids that belong to this group (including representative) */
  members: string[];
};

export const PROVIDER_VARIANT_GROUPS: GroupDef[] = [
  {
    key: 'zai',
    representativeId: 'zai',
    regions: ['cn', 'global'],
    uses: ['standard', 'coding'],
    members: ['zai', 'zai-global', 'zai-coding', 'zai-coding-global'],
    resolve: (sel) => {
      const region = sel.region ?? 'cn';
      const use = sel.use ?? 'standard';
      if (use === 'coding') return region === 'cn' ? 'zai-coding' : 'zai-coding-global';
      return region === 'cn' ? 'zai' : 'zai-global';
    },
    infer: (id) => {
      if (id === 'zai') return { region: 'cn', use: 'standard' };
      if (id === 'zai-global') return { region: 'global', use: 'standard' };
      if (id === 'zai-coding') return { region: 'cn', use: 'coding' };
      if (id === 'zai-coding-global') return { region: 'global', use: 'coding' };
      return null;
    },
  },
  {
    key: 'moonshot',
    representativeId: 'moonshot-cn',
    regions: ['cn', 'global'],
    uses: ['standard'],
    members: ['moonshot-cn', 'moonshot'],
    resolve: (sel) => (sel.region ?? 'cn') === 'cn' ? 'moonshot-cn' : 'moonshot',
    infer: (id) => {
      if (id === 'moonshot-cn') return { region: 'cn', use: 'standard' };
      if (id === 'moonshot') return { region: 'global', use: 'standard' };
      return null;
    },
  },
  {
    key: 'minimax',
    representativeId: 'minimax-cn',
    regions: ['cn', 'global'],
    uses: ['standard'],
    members: ['minimax-cn', 'minimax'],
    resolve: (sel) => (sel.region ?? 'cn') === 'cn' ? 'minimax-cn' : 'minimax',
    infer: (id) => {
      if (id === 'minimax-cn') return { region: 'cn', use: 'standard' };
      if (id === 'minimax') return { region: 'global', use: 'standard' };
      return null;
    },
  },
  {
    key: 'modelstudio',
    representativeId: 'modelstudio-cn',
    regions: ['cn', 'global'],
    uses: ['standard'],
    members: ['modelstudio-cn', 'modelstudio'],
    resolve: (sel) => (sel.region ?? 'cn') === 'cn' ? 'modelstudio-cn' : 'modelstudio',
    infer: (id) => {
      if (id === 'modelstudio-cn') return { region: 'cn', use: 'standard' };
      if (id === 'modelstudio') return { region: 'global', use: 'standard' };
      return null;
    },
  },
  {
    key: 'volcengine',
    representativeId: 'volcengine',
    uses: ['standard', 'coding'],
    members: ['volcengine', 'volcengine-plan'],
    resolve: (sel) => (sel.use ?? 'standard') === 'coding' ? 'volcengine-plan' : 'volcengine',
    infer: (id) => {
      if (id === 'volcengine') return { use: 'standard' };
      if (id === 'volcengine-plan') return { use: 'coding' };
      return null;
    },
  },
  {
    key: 'byteplus',
    representativeId: 'byteplus',
    uses: ['standard', 'coding'],
    members: ['byteplus', 'byteplus-plan'],
    resolve: (sel) => (sel.use ?? 'standard') === 'coding' ? 'byteplus-plan' : 'byteplus',
    infer: (id) => {
      if (id === 'byteplus') return { use: 'standard' };
      if (id === 'byteplus-plan') return { use: 'coding' };
      return null;
    },
  },
];

export function getProviderVariantGroupByMember(providerId: string): GroupDef | null {
  return PROVIDER_VARIANT_GROUPS.find((g) => g.members.includes(providerId)) ?? null;
}

export function isVariantMember(providerId: string): boolean {
  return Boolean(getProviderVariantGroupByMember(providerId));
}

export function isRepresentative(providerId: string): boolean {
  const g = PROVIDER_VARIANT_GROUPS.find((x) => x.representativeId === providerId);
  return Boolean(g);
}

/**
 * Build the list of provider ids shown in the picker:
 * - For grouped providers, only show the representative id (hide other variants).
 * - For all others, show as-is.
 */
export function providerIdsForPicker(): string[] {
  // Variants are now selected directly in the picker (grouped by region),
  // so we keep *all* preset ids visible there.
  return PROVIDER_PRESETS.map((p) => p.id);
}

export function inferVariantSelection(providerId: string): { groupKey: ProviderVariantGroupKey; selection: ProviderVariantSelection } | null {
  const g = getProviderVariantGroupByMember(providerId);
  if (!g) return null;
  const selection = g.infer(providerId) ?? {};
  return { groupKey: g.key, selection };
}

export function resolveProviderFromVariant(groupKey: ProviderVariantGroupKey, selection: ProviderVariantSelection): string {
  const g = PROVIDER_VARIANT_GROUPS.find((x) => x.key === groupKey);
  if (!g) return groupKey;
  return g.resolve(selection);
}

