/**
 * C12 — the deterministic safety gate must never depend on reviewer MODEL config.
 *
 * The Dashboard's default "inherit the main model" choice saves `supervisorModel: ''`
 * (SettingsPanel: supervisorUseMainModel → ''). If activation requires a non-empty
 * `supervisorModel`, every hook returns early and the whole supervisor — including the
 * model-free quick-check safety gate — is silently off for the default configuration.
 *
 * Contract locked here:
 *  - activation = `enabled && reviewMode !== 'off'` (no model term);
 *  - the deterministic gate (quick check + dangerousToolPolicy) works with NO reviewer
 *    model, an unsupported protocol, or missing credentials;
 *  - at runtime the reviewer uses `supervisorModel || mainModel` — the inherited model is
 *    re-resolved on every config/provider/main-model change and NEVER written back into
 *    config (that would freeze the inherit relation when the main model changes);
 *  - when the inherited model is unusable, deep review degrades OBSERVABLY: startup
 *    log + audit + `rc.supervisor.status` all carry the reason.
 */

import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadPluginFresh } from './harness/plugin-harness.js';

const MAIN_MODEL_REF = 'mainprov/main-model';
const MAIN_URL = 'http://main.local/v1/chat/completions';

/** Global OC config: main model + its provider live OUTSIDE the plugin config (real shape). */
function globalConfig(providerOverrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    agents: { defaults: { model: { primary: MAIN_MODEL_REF } } },
    models: {
      providers: {
        mainprov: {
          api: 'openai-completions',
          baseUrl: MAIN_URL,
          apiKey: 'main-key',
          models: [{ id: 'main-model', maxTokens: 1000 }],
          ...providerOverrides,
        },
      },
    },
  };
}

/** What the Dashboard saves for "继承主模型" (SettingsPanel default): empty supervisorModel. */
const INHERIT_CONFIG = {
  enabled: true,
  supervisorModel: '',
  reviewMode: 'correct',
  toolReviewGateMs: 500, // the floor of the supported range; 300 would be clamped up to it
};

const RM_RF = { toolName: 'exec', params: { command: 'rm -rf /' } };
const CTX = { sessionKey: 'agent:main:c12' };

type AuditEntry = { type: string; action: string; details: string };

async function auditEntries(h: Awaited<ReturnType<typeof loadPluginFresh>>): Promise<AuditEntry[]> {
  const res = (await h.rpc.get('rc.supervisor.log')!({ limit: 200 })) as { entries: AuditEntry[] };
  return res.entries;
}

const origFetch = globalThis.fetch;

afterEach(() => {
  (globalThis as { fetch: unknown }).fetch = origFetch;
  vi.restoreAllMocks();
});

describe('C12 activation does not depend on the reviewer model', () => {
  it('inherit mode (supervisorModel: "") still BLOCKS rm -rf / and records the block', async () => {
    const h = await loadPluginFresh(INHERIT_CONFIG, globalConfig());

    const r = (await h.fire('before_tool_call', RM_RF, CTX)) as { block?: boolean; blockReason?: string };

    expect(r.block).toBe(true);
    expect(r.blockReason).toBeTruthy();
    const blocks = (await auditEntries(h)).filter((e) => e.action === 'block');
    expect(blocks.length).toBeGreaterThanOrEqual(1);
  });

  it('inherit mode sends the real reviewer request to the MAIN model provider/model', async () => {
    const seen: Array<{ url: string; model: unknown }> = [];
    (globalThis as { fetch: unknown }).fetch = vi.fn(async (url: string, init: { body: string }) => {
      seen.push({ url, model: (JSON.parse(init.body) as { model?: unknown }).model });
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: JSON.stringify({ blocked: false }) } }] }),
        text: async () => '',
      };
    });

    const h = await loadPluginFresh(INHERIT_CONFIG, globalConfig());
    // Benign high-risk tool → quick check passes → deep review actually fires.
    await h.fire('before_tool_call', { toolName: 'exec', params: { command: 'ls -la' } }, CTX);

    expect(seen.length).toBeGreaterThanOrEqual(1);
    expect(seen[0].url).toBe(MAIN_URL);
    expect(seen[0].model).toBe('main-model'); // the inherited main model, not a configured reviewer model
  });

  it('unsupported main-model protocol: rm -rf / is STILL blocked and the degrade is observable', async () => {
    const h = await loadPluginFresh(INHERIT_CONFIG, globalConfig({ api: 'openai-chatgpt-responses' }));

    const r = (await h.fire('before_tool_call', RM_RF, CTX)) as { block?: boolean };
    expect(r.block).toBe(true); // deterministic gate is independent of the reviewer protocol

    // Observable degrade: startup log + audit + status all carry the reason.
    expect(h.logs.warn.some((l) => /unsupported/i.test(l))).toBe(true);
    const health = (await auditEntries(h)).filter((e) => e.type === 'reviewer_health');
    expect(health.length).toBe(1);
    expect(health[0].details).toMatch(/openai-chatgpt-responses/);

    const st = (await h.rpc.get('rc.supervisor.status')!({})) as {
      reviewerReady?: boolean;
      reviewerUnavailableReason?: string;
      modelSource?: string;
    };
    expect(st.reviewerReady).toBe(false);
    expect(st.reviewerUnavailableReason).toMatch(/openai-chatgpt-responses/);
    expect(st.modelSource).toBe('unavailable');

    // And the per-call deep-review degrade is recorded for a benign high-risk tool.
    await h.fire('before_tool_call', { toolName: 'exec', params: { command: 'ls -la' } }, CTX);
    const degrades = (await auditEntries(h)).filter((e) => e.type === 'tool_review' && e.action === 'warn');
    expect(degrades.length).toBeGreaterThanOrEqual(1);
  });

  it('missing main-model credentials: rm -rf / is STILL blocked and status exposes the reason', async () => {
    const h = await loadPluginFresh(INHERIT_CONFIG, globalConfig({ apiKey: undefined }));

    const r = (await h.fire('before_tool_call', RM_RF, CTX)) as { block?: boolean };
    expect(r.block).toBe(true);

    const st = (await h.rpc.get('rc.supervisor.status')!({})) as { reviewerReady?: boolean; reviewerUnavailableReason?: string };
    expect(st.reviewerReady).toBe(false);
    expect(st.reviewerUnavailableReason).toMatch(/credential|api key|apiKey/i);
  });

  it('no supervisor model AND no main model: the deterministic gate still blocks', async () => {
    const h = await loadPluginFresh(INHERIT_CONFIG, { models: { providers: {} } });

    const r = (await h.fire('before_tool_call', RM_RF, CTX)) as { block?: boolean };
    expect(r.block).toBe(true);

    const st = (await h.rpc.get('rc.supervisor.status')!({})) as {
      modelSource?: string;
      effectiveSupervisorModel?: string;
      reviewerReady?: boolean;
    };
    expect(st.modelSource).toBe('unavailable');
    expect(st.effectiveSupervisorModel).toBe('');
    expect(st.reviewerReady).toBe(false);
  });
});

describe('C12 only enabled/reviewMode turn supervision off', () => {
  it('enabled: false → the tool gate does not run', async () => {
    const h = await loadPluginFresh({ ...INHERIT_CONFIG, enabled: false }, globalConfig());
    const r = await h.fire('before_tool_call', RM_RF, CTX);
    expect(r).toEqual({});
  });

  it("reviewMode: 'off' → the tool gate does not run", async () => {
    const h = await loadPluginFresh({ ...INHERIT_CONFIG, reviewMode: 'off' }, globalConfig());
    const r = await h.fire('before_tool_call', RM_RF, CTX);
    expect(r).toEqual({});
  });
});

describe('C12 a broken reviewer provider can never take the gate down', () => {
  it('non-string baseUrl in models.providers: register survives and rm -rf / is STILL blocked', async () => {
    // Hand-edited openclaw.json shape: `baseUrl` typed as a number. Readiness resolution
    // runs in the ReviewerClient CONSTRUCTOR, so a throw here escapes register() and takes
    // the whole plugin — including the model-free safety gate — with it.
    let h: Awaited<ReturnType<typeof loadPluginFresh>> | undefined;
    let registerError: unknown = null;
    try {
      h = await loadPluginFresh(INHERIT_CONFIG, globalConfig({ baseUrl: 123 }));
    } catch (e) {
      registerError = e;
    }
    expect(registerError).toBeNull();

    const r = (await h!.fire('before_tool_call', RM_RF, CTX)) as { block?: boolean };
    expect(r.block).toBe(true);

    const st = (await h!.rpc.get('rc.supervisor.status')!({})) as { reviewerReady?: boolean; reviewerUnavailableReason?: string };
    expect(st.reviewerReady).toBe(false);
    // The reason must name the offending config key and what it should be — a leaked JS
    // TypeError ("providerCfg.baseUrl?.trim is not a function") tells the user nothing.
    expect(st.reviewerUnavailableReason).toMatch(/models\.providers\.mainprov\.baseUrl must be a non-empty string/);
  });

  it('fault injection: a provider entry that throws on access degrades instead of killing the plugin', async () => {
    // Not a JSON-reachable shape — this verifies the BACKSTOP itself: readiness resolution
    // must contain any provider failure, so no future provider-shape change can ever
    // propagate an exception out of register() and disable the deterministic gate.
    const hostile = {
      api: 'openai-completions',
      apiKey: 'k',
      get baseUrl(): string {
        throw new Error('hostile provider entry');
      },
    };
    let h: Awaited<ReturnType<typeof loadPluginFresh>> | undefined;
    let registerError: unknown = null;
    try {
      h = await loadPluginFresh(INHERIT_CONFIG, {
        agents: { defaults: { model: { primary: MAIN_MODEL_REF } } },
        models: { providers: { mainprov: hostile } },
      });
    } catch (e) {
      registerError = e;
    }
    expect(registerError).toBeNull();

    const r = (await h!.fire('before_tool_call', RM_RF, CTX)) as { block?: boolean };
    expect(r.block).toBe(true);

    const st = (await h!.rpc.get('rc.supervisor.status')!({})) as { reviewerReady?: boolean; reviewerUnavailableReason?: string };
    expect(st.reviewerReady).toBe(false);
    expect(st.reviewerUnavailableReason).toMatch(/hostile provider entry/);
  });
});

describe('C12 the degrade is reported once per distinct state', () => {
  it('unrelated config saves do not re-emit it, but a changed reason does', async () => {
    const h = await loadPluginFresh(INHERIT_CONFIG, globalConfig({ api: 'openai-chatgpt-responses' }));
    const health = async () => (await auditEntries(h)).filter((e) => e.type === 'reviewer_health');

    expect((await health()).length).toBe(1);

    // Saving unrelated fields re-runs the health report; without dedup the audit log
    // (and the Dashboard panel) would fill with identical rows on every settings save.
    await h.rpc.get('rc.supervisor.config')!({ toolReviewGateMs: 500 });
    await h.rpc.get('rc.supervisor.config')!({ toolReviewGateMs: 900 });
    expect((await health()).length).toBe(1);

    // A genuinely different failure reason must still be reported — dedup must not
    // swallow a state change, or the log would show a stale cause.
    await h.rpc.get('rc.supervisor.config')!({ supervisorModel: 'ghost/model' });
    const rows = await health();
    expect(rows.length).toBe(2);
    expect(rows.some((e) => /ghost/.test(e.details))).toBe(true);
  });
});

describe('C12 the manifest documents the inherit marker truthfully', () => {
  it('supervisorModel description must not claim that an empty value disables supervision', () => {
    const manifest = JSON.parse(readFileSync(new URL('../../openclaw.plugin.json', import.meta.url), 'utf-8')) as {
      configSchema: { properties: { supervisorModel: { description: string } } };
    };
    const desc = manifest.configSchema.properties.supervisorModel.description;

    // An empty value now means "inherit the main model" — supervision stays on and deep
    // review spends MAIN-model tokens. "Leave empty to disable" would be a false promise.
    expect(desc).not.toMatch(/disable/i);
    expect(desc).toMatch(/inherit/i);
  });
});

describe('C12 status reports the model source honestly', () => {
  it('inherited + usable → modelSource "inherited", effective model = main model, ready', async () => {
    const h = await loadPluginFresh(INHERIT_CONFIG, globalConfig());
    const st = (await h.rpc.get('rc.supervisor.status')!({})) as {
      modelSource?: string;
      effectiveSupervisorModel?: string;
      supervisorModel?: string;
      reviewerReady?: boolean;
      reviewerUnavailableReason?: string;
    };
    expect(st.modelSource).toBe('inherited');
    expect(st.effectiveSupervisorModel).toBe(MAIN_MODEL_REF);
    expect(st.supervisorModel).toBe(''); // the config marker stays empty (dynamic inherit)
    expect(st.reviewerReady).toBe(true);
    expect(st.reviewerUnavailableReason).toBeUndefined();
  });

  it('explicit supervisorModel → modelSource "explicit"', async () => {
    const h = await loadPluginFresh(
      {
        ...INHERIT_CONFIG,
        supervisorModel: 'sup/sup-model',
        providers: { sup: { api: 'openai-completions', baseUrl: 'http://sup.local/v1/chat/completions', apiKey: 'k', models: [{ id: 'sup-model' }] } },
      },
      globalConfig(),
    );
    const st = (await h.rpc.get('rc.supervisor.status')!({})) as { modelSource?: string; effectiveSupervisorModel?: string; reviewerReady?: boolean };
    expect(st.modelSource).toBe('explicit');
    expect(st.effectiveSupervisorModel).toBe('sup/sup-model');
    expect(st.reviewerReady).toBe(true);
  });

  it('the inherited model is NEVER written back into the supervisor config', async () => {
    const h = await loadPluginFresh(INHERIT_CONFIG, globalConfig());
    const r = (await h.fire('before_tool_call', RM_RF, CTX)) as { block?: boolean };
    expect(r.block).toBe(true); // the inherit path really ran (guards against a vacuous pass)

    const res = (await h.rpc.get('rc.supervisor.config')!({})) as { config: { supervisorModel: string } };
    // Materializing the main model here would freeze the inherit relation and make the
    // Dashboard read it as an independently configured reviewer.
    expect(res.config.supervisorModel).toBe('');
  });
});
