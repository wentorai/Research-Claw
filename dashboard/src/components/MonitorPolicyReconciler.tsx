import { useEffect } from 'react';

import { useMonitorStore } from '../stores/monitor';
import { useProductPolicyStore } from '../stores/product-policy';

/** Hydrate monitor state only after this connection epoch's policy is ready. */
export default function MonitorPolicyReconciler() {
  const policyReady = useProductPolicyStore((state) => state.status === 'ready');
  const loadMonitors = useMonitorStore((state) => state.loadMonitors);

  useEffect(() => {
    if (policyReady) void loadMonitors();
  }, [loadMonitors, policyReady]);

  return null;
}
