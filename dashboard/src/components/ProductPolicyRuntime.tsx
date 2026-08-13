import PeriphCaptureListener from './PeriphCaptureListener';
import SupervisorReviewListener from './SupervisorReviewListener';
import MonitorPolicyReconciler from './MonitorPolicyReconciler';
import { useProductPolicyStore } from '../stores/product-policy';
import {
  shouldMountPeripheralsListener,
  shouldMountSupervisorUiHydration,
} from '../utils/profile-policy';

/** App-level listeners whose mount semantics differ from panel visibility. */
export default function ProductPolicyRuntime() {
  const status = useProductPolicyStore((s) => s.status);
  const policy = useProductPolicyStore((s) => s.policy);
  if (status !== 'ready' || !policy) return null;

  return (
    <>
      <MonitorPolicyReconciler />
      {shouldMountPeripheralsListener(policy) && <PeriphCaptureListener />}
      {shouldMountSupervisorUiHydration(policy) && <SupervisorReviewListener />}
    </>
  );
}
