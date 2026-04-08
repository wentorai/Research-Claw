import React, { useEffect, useMemo, useState } from 'react';
import { Segmented, Space, Typography } from 'antd';
import { useTranslation } from 'react-i18next';
import {
  getProviderVariantGroupByMember,
  inferVariantSelection,
  resolveProviderFromVariant,
  type ProviderVariantRegion,
  type ProviderVariantSelection,
  type ProviderVariantUse,
} from '../../utils/provider-variants';

const { Text } = Typography;

function normalizeSelection(s: ProviderVariantSelection): ProviderVariantSelection {
  return {
    region: s.region,
    use: s.use,
  };
}

export default function ProviderVariantSelector({
  providerId,
  onChangeProviderId,
  compact = true,
}: {
  providerId: string;
  onChangeProviderId: (nextProviderId: string) => void;
  compact?: boolean;
}) {
  const { t } = useTranslation();

  const group = useMemo(() => getProviderVariantGroupByMember(providerId), [providerId]);
  const inferred = useMemo(() => inferVariantSelection(providerId), [providerId]);

  const [selection, setSelection] = useState<ProviderVariantSelection>(() => inferred?.selection ?? {});

  useEffect(() => {
    setSelection(inferred?.selection ?? {});
  }, [inferred?.groupKey, providerId]);

  if (!group) return null;

  const regionOptions = (group.regions ?? []).map((r) => ({
    value: r,
    label: r === 'cn' ? t('providerVariants.regionCn') : t('providerVariants.regionGlobal'),
  }));
  const useOptions = (group.uses ?? []).map((u) => ({
    value: u,
    label: u === 'standard' ? t('providerVariants.useStandard') : t('providerVariants.useCoding'),
  }));

  const handleChange = (next: ProviderVariantSelection) => {
    const normalized = normalizeSelection(next);
    setSelection(normalized);
    const nextProviderId = resolveProviderFromVariant(group.key, normalized);
    if (nextProviderId && nextProviderId !== providerId) {
      onChangeProviderId(nextProviderId);
    }
  };

  return (
    <div style={{ marginTop: compact ? 6 : 8 }}>
      {!compact && (
        <Text type="secondary" style={{ fontSize: 11, display: 'block', marginBottom: 6 }}>
          {t('providerVariants.title')}
        </Text>
      )}

      <Space
        size={8}
        wrap
        style={{
          width: '100%',
          justifyContent: compact ? 'flex-start' : 'flex-start',
        }}
      >
        {regionOptions.length > 0 && (
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            {!compact && (
              <Text type="secondary" style={{ fontSize: 11 }}>
                {t('providerVariants.regionLabel')}
              </Text>
            )}
            <Segmented
              size="small"
              value={(selection.region ?? (group.regions?.[0] as ProviderVariantRegion)) as ProviderVariantRegion}
              options={regionOptions}
              onChange={(v) => handleChange({ ...selection, region: v as ProviderVariantRegion })}
            />
          </div>
        )}

        {useOptions.length > 0 && (
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            {!compact && (
              <Text type="secondary" style={{ fontSize: 11 }}>
                {t('providerVariants.useLabel')}
              </Text>
            )}
            <Segmented
              size="small"
              value={(selection.use ?? (group.uses?.[0] as ProviderVariantUse)) as ProviderVariantUse}
              options={useOptions}
              onChange={(v) => handleChange({ ...selection, use: v as ProviderVariantUse })}
            />
          </div>
        )}
      </Space>
    </div>
  );
}

