import { useEffect } from 'react';
import { useGatewayStore } from '../stores/gateway';
import { useSupervisorStore } from '../stores/supervisor';
import { useProductPolicyStore } from '../stores/product-policy';
import { shouldMountSupervisorUiHydration } from '../utils/profile-policy';

export default function SupervisorReviewListener() {
  const client = useGatewayStore((state) => state.client);
  const supervisorUiVisible = useProductPolicyStore((state) => (
    state.status === 'ready' && state.policy
      ? shouldMountSupervisorUiHydration(state.policy)
      : false
  ));

  useEffect(() => {
    if (!client?.isConnected || !supervisorUiVisible) return;
    const hydrateFromDatabase = () => {
      const supervisor = useSupervisorStore.getState();
      void Promise.all([
        supervisor.loadStatus(),
        supervisor.loadAuditLog({ limit: 200 }),
      ]);
    };

    // Initial hydration also gives the plugin this live connection's gateway
    // request context, whose broadcast function is used only as a change signal.
    hydrateFromDatabase();
    const unsubscribeUpdated = client.subscribe('plugin.supervisor.review.updated', () => {
      hydrateFromDatabase();
    });
    const unsubscribeCleared = client.subscribe('plugin.supervisor.review.cleared', () => {
      hydrateFromDatabase();
    });
    return () => {
      unsubscribeUpdated();
      unsubscribeCleared();
    };
  }, [client, supervisorUiVisible]);

  return null;
}
