'use strict';

const REQUIRED_MAJOR = 22;
const REQUIRED_MINOR = 16;
const REQUIRED_ABI = '127';

function evaluateRuntime(versions) {
  const version = String(versions?.node || '');
  const modules = String(versions?.modules || '');
  const [major, minor] = version.split('.').map(Number);
  const compatible = major === REQUIRED_MAJOR
    && minor >= REQUIRED_MINOR
    && modules === REQUIRED_ABI;
  return {
    version,
    modules,
    compatible,
    expected: `Node ${REQUIRED_MAJOR}.${REQUIRED_MINOR}+ <23 (ABI ${REQUIRED_ABI})`,
  };
}

module.exports = {
  REQUIRED_MAJOR,
  REQUIRED_MINOR,
  REQUIRED_ABI,
  evaluateRuntime,
};
