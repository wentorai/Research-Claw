/** Research-Claw root package version (injected at build from repo `package.json`). */
export const RC_APP_VERSION =
  typeof import.meta.env.VITE_RC_APP_VERSION === 'string' && import.meta.env.VITE_RC_APP_VERSION
    ? import.meta.env.VITE_RC_APP_VERSION
    : '0.0.0';
