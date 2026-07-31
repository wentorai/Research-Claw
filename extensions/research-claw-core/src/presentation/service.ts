import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';

import type {
  FilePresentation,
  PaperBatchPresentationPayload,
  PaperCandidate,
  PaperCandidateGroup,
  PresentationAppendInput,
  PresentationAppendResult,
  PresentationPayload,
  PresentationRunView,
} from './types.js';
import { normalizeArxivId, normalizeDoi } from './paper-adapters.js';

const MAX_RUN_PAPER_CANDIDATES = 100;
const MAX_PRESENTATION_RECORD_BYTES = 256 * 1024;
const MAX_PRESENTATION_RUN_BYTES = 4 * 1024 * 1024;
const MAX_PRESENTATION_RUN_RECORDS = 1_000;
const MAX_PRESENTATION_TOTAL_BYTES = 128 * 1024 * 1024;
const MAX_PRESENTATION_TOTAL_RECORDS = 100_000;

export interface PresentationRetentionTelemetry {
  activeSessions: number;
  scannedRuns: number;
  eligibleOrphanRuns: number;
  deletedRuns: number;
  deletedRecords: number;
  deletedBytes: number;
  totalRunsBefore: number;
  totalRecordsBefore: number;
  totalBytesBefore: number;
  capacityExceeded: boolean;
}

interface RecordRow {
  run_id: string;
  tool_call_id: string;
  source: 'full' | 'persisted';
  record_kind: 'file' | 'paper_batch';
  payload_json: string;
  revision: number;
}

function candidateValuesConflict(a: unknown, b: unknown): boolean {
  if (a === undefined || b === undefined) return false;
  return JSON.stringify(a) !== JSON.stringify(b);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function parsePayload(row: RecordRow): PresentationPayload | null {
  try {
    const value = JSON.parse(row.payload_json) as PresentationPayload;
    if (!value || typeof value !== 'object' || value.kind !== row.record_kind) return null;
    if (value.kind === 'paper_batch') {
      // Compatibility for pre-release v23 records written before batch status
      // was made explicit. Those records came only from successful adapters.
      return {
        ...value,
        status: value.status ?? 'available',
        captureSource: value.captureSource ?? row.source,
      };
    }
    return value;
  } catch {
    return null;
  }
}

export class PresentationService {
  constructor(private readonly db: Database.Database) {}

  append(input: PresentationAppendInput): PresentationAppendResult {
    const observedAt = input.observedAt ?? Date.now();
    const payload = input.payload.kind === 'paper_batch'
      ? this.boundPaperBatchForRun(input.sessionKey, input.runId, input.payload)
      : input.payload;
    const payloadJson = stableJson(payload);
    const payloadBytes = Buffer.byteLength(payloadJson);
    if (payloadBytes > MAX_PRESENTATION_RECORD_BYTES) {
      throw new Error(`presentation record exceeds ${MAX_PRESENTATION_RECORD_BYTES} bytes`);
    }
    const payloadHash = createHash('sha256').update(payloadJson).digest('hex');

    return this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO rc_execution_presentation_runs
          (session_key, run_id, records_revision, updated_at)
        VALUES (?, ?, 0, ?)
        ON CONFLICT(session_key, run_id) DO NOTHING
      `).run(input.sessionKey, input.runId, observedAt);

      const current = this.db.prepare(`
        SELECT records_revision FROM rc_execution_presentation_runs
        WHERE session_key = ? AND run_id = ?
      `).get(input.sessionKey, input.runId) as { records_revision: number };

      // A late persistence hook is a capped fallback, never an authoritative
      // downgrade after the complete full-hook observation committed.
      if (input.source === 'persisted') {
        const complete = this.db.prepare(`
          SELECT 1 FROM rc_execution_presentation_records
          WHERE session_key = ? AND run_id = ? AND tool_call_id = ? AND source = 'full'
          LIMIT 1
        `).get(input.sessionKey, input.runId, input.toolCallId);
        if (complete) return { appended: false, recordsRevision: current.records_revision };
      }

      const duplicate = this.db.prepare(`
        SELECT 1 FROM rc_execution_presentation_records
        WHERE session_key = ? AND run_id = ? AND tool_call_id = ?
          AND source = ? AND payload_hash = ?
        LIMIT 1
      `).get(input.sessionKey, input.runId, input.toolCallId, input.source, payloadHash);
      if (duplicate) return { appended: false, recordsRevision: current.records_revision };

      const runUsage = this.db.prepare(`
        SELECT COUNT(*) record_count,
               COALESCE(SUM(LENGTH(CAST(payload_json AS BLOB))), 0) payload_bytes
        FROM rc_execution_presentation_records
        WHERE session_key = ? AND run_id = ?
      `).get(input.sessionKey, input.runId) as { record_count: number; payload_bytes: number };
      if (
        runUsage.record_count >= MAX_PRESENTATION_RUN_RECORDS
        || runUsage.payload_bytes + payloadBytes > MAX_PRESENTATION_RUN_BYTES
      ) {
        throw new Error('presentation Run capacity exceeded');
      }

      const totalUsage = this.db.prepare(`
        SELECT COUNT(*) record_count,
               COALESCE(SUM(LENGTH(CAST(payload_json AS BLOB))), 0) payload_bytes
        FROM rc_execution_presentation_records
      `).get() as { record_count: number; payload_bytes: number };
      if (
        totalUsage.record_count >= MAX_PRESENTATION_TOTAL_RECORDS
        || totalUsage.payload_bytes + payloadBytes > MAX_PRESENTATION_TOTAL_BYTES
      ) {
        throw new Error('global presentation capacity exceeded; orphan sweep required');
      }

      const nextRevision = current.records_revision + 1;
      const inserted = this.db.prepare(`
        INSERT INTO rc_execution_presentation_records
          (id, session_key, run_id, tool_call_id, tool_name, source, completeness,
           record_kind, payload_json, payload_hash, revision, observed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(session_key, run_id, tool_call_id, source, payload_hash) DO NOTHING
      `).run(
        randomUUID(), input.sessionKey, input.runId, input.toolCallId, input.toolName,
        input.source, input.completeness, payload.kind, payloadJson, payloadHash,
        nextRevision, observedAt,
      );
      if (inserted.changes === 0) {
        return { appended: false, recordsRevision: current.records_revision };
      }
      this.db.prepare(`
        UPDATE rc_execution_presentation_runs
        SET records_revision = ?, updated_at = ?
        WHERE session_key = ? AND run_id = ?
      `).run(nextRevision, observedAt, input.sessionKey, input.runId);
      return { appended: true, recordsRevision: nextRevision };
    })();
  }

  getRuns(sessionKey: string, runIds: string[]): Record<string, PresentationRunView> {
    if (runIds.length === 0) return {};
    const placeholders = runIds.map(() => '?').join(',');
    const runs = this.db.prepare(`
      SELECT run_id, records_revision
      FROM rc_execution_presentation_runs
      WHERE session_key = ? AND run_id IN (${placeholders})
    `).all(sessionKey, ...runIds) as Array<{ run_id: string; records_revision: number }>;
    if (runs.length === 0) return {};
    const presentIds = runs.map((row) => row.run_id);
    const recordPlaceholders = presentIds.map(() => '?').join(',');
    const records = this.db.prepare(`
      SELECT run_id, tool_call_id, source, record_kind, payload_json, revision
      FROM rc_execution_presentation_records
      WHERE session_key = ? AND run_id IN (${recordPlaceholders})
      ORDER BY revision ASC, id ASC
    `).all(sessionKey, ...presentIds) as RecordRow[];

    return Object.fromEntries(runs.map((run) => {
      const files = new Map<string, FilePresentation>();
      const paperRows = records.filter((row) => row.run_id === run.run_id && row.record_kind === 'paper_batch');
      const fullToolCalls = new Set(paperRows.flatMap((row) => {
        const payload = parsePayload(row);
        return row.source === 'full' && payload?.kind === 'paper_batch' && payload.status === 'available'
          ? [row.tool_call_id] : [];
      }));
      const paperBatches: PaperBatchPresentationPayload[] = [];
      for (const row of records) {
        if (row.run_id !== run.run_id) continue;
        const payload = parsePayload(row);
        if (!payload) continue;
        if (payload.kind === 'file') files.set(payload.file.path, payload.file);
        if (
          payload.kind === 'paper_batch'
          && !(row.source === 'persisted' && fullToolCalls.has(row.tool_call_id))
        ) paperBatches.push(payload);
      }
      const paperCandidates = this.mergePaperBatches(paperBatches);
      return [run.run_id, {
        runId: run.run_id,
        recordsRevision: run.records_revision,
        files: Array.from(files.values()),
        paperBatches,
        ...(paperCandidates ? { paperCandidates } : {}),
      }];
    }));
  }

  hasRun(sessionKey: string, runId: string): boolean {
    return Boolean(this.db.prepare(`
      SELECT 1 FROM rc_execution_presentation_runs WHERE session_key = ? AND run_id = ?
    `).get(sessionKey, runId));
  }

  hasForeignRun(sessionKey: string, runId: string): boolean {
    return Boolean(this.db.prepare(`
      SELECT 1 FROM rc_execution_presentation_runs WHERE session_key <> ? AND run_id = ? LIMIT 1
    `).get(sessionKey, runId));
  }

  deleteSession(sessionKey: string): number {
    return this.db.transaction(() => {
      const records = this.db.prepare(`
        DELETE FROM rc_execution_presentation_records WHERE session_key = ?
      `).run(sessionKey).changes;
      this.db.prepare(`
        DELETE FROM rc_execution_presentation_runs WHERE session_key = ?
      `).run(sessionKey);
      return records;
    })();
  }

  /**
   * Bounded startup sweep. A registry read failure must prevent the caller from
   * invoking this method; an empty but successfully read registry is valid.
   * Recent orphan candidates remain through the grace period, while any Run
   * still named by OC Session truth is retained regardless of age/capacity.
   */
  sweepOrphans(
    activeSessionKeys: ReadonlySet<string>,
    options: {
      now?: number;
      graceMs?: number;
      maxScanRuns?: number;
      maxDeleteRuns?: number;
    } = {},
  ): PresentationRetentionTelemetry {
    const now = options.now ?? Date.now();
    const graceMs = Math.max(60_000, options.graceMs ?? 7 * 24 * 60 * 60_000);
    const maxScanRuns = Math.max(1, Math.min(options.maxScanRuns ?? 2_000, 10_000));
    const maxDeleteRuns = Math.max(1, Math.min(options.maxDeleteRuns ?? 100, 500));
    const total = this.db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM rc_execution_presentation_runs) run_count,
        COUNT(*) record_count,
        COALESCE(SUM(LENGTH(CAST(payload_json AS BLOB))), 0) payload_bytes
      FROM rc_execution_presentation_records
    `).get() as { run_count: number; record_count: number; payload_bytes: number };
    const rows = this.db.prepare(`
      SELECT r.session_key, r.run_id, r.updated_at,
             COUNT(p.id) record_count,
             COALESCE(SUM(LENGTH(CAST(p.payload_json AS BLOB))), 0) payload_bytes
      FROM rc_execution_presentation_runs r
      LEFT JOIN rc_execution_presentation_records p
        ON p.session_key = r.session_key AND p.run_id = r.run_id
      WHERE r.updated_at < ?
      GROUP BY r.session_key, r.run_id, r.updated_at
      ORDER BY r.updated_at ASC, r.session_key ASC, r.run_id ASC
      LIMIT ?
    `).all(now - graceMs, maxScanRuns) as Array<{
      session_key: string;
      run_id: string;
      updated_at: number;
      record_count: number;
      payload_bytes: number;
    }>;
    const eligible = rows.filter((row) => !activeSessionKeys.has(row.session_key));
    const selected = eligible.slice(0, maxDeleteRuns);
    if (selected.length > 0) {
      this.db.transaction(() => {
        const remove = this.db.prepare(`
          DELETE FROM rc_execution_presentation_runs WHERE session_key = ? AND run_id = ?
        `);
        for (const row of selected) remove.run(row.session_key, row.run_id);
      })();
    }
    return {
      activeSessions: activeSessionKeys.size,
      scannedRuns: rows.length,
      eligibleOrphanRuns: eligible.length,
      deletedRuns: selected.length,
      deletedRecords: selected.reduce((sum, row) => sum + row.record_count, 0),
      deletedBytes: selected.reduce((sum, row) => sum + row.payload_bytes, 0),
      totalRunsBefore: total.run_count,
      totalRecordsBefore: total.record_count,
      totalBytesBefore: total.payload_bytes,
      capacityExceeded: total.record_count >= MAX_PRESENTATION_TOTAL_RECORDS
        || total.payload_bytes >= MAX_PRESENTATION_TOTAL_BYTES,
    };
  }

  private boundPaperBatchForRun(
    sessionKey: string,
    runId: string,
    batch: PaperBatchPresentationPayload,
  ): PaperBatchPresentationPayload {
    const existing = this.getRuns(sessionKey, [runId])[runId]?.paperCandidates?.candidates ?? [];
    let uniqueCount = existing.length;
    const knownAliases = new Set(existing.flatMap((candidate) => candidate.strongAliases));
    const candidates: PaperCandidate[] = [];
    let runCapped = false;
    for (const candidate of batch.candidates) {
      const sharesKnownAlias = candidate.strongAliases.some((alias) => knownAliases.has(alias));
      if (!sharesKnownAlias && uniqueCount >= MAX_RUN_PAPER_CANDIDATES) {
        runCapped = true;
        continue;
      }
      candidates.push(candidate);
      if (!sharesKnownAlias) uniqueCount += 1;
      for (const alias of candidate.strongAliases) knownAliases.add(alias);
    }
    return {
      ...batch,
      stored: candidates.length,
      runCapped: batch.runCapped || runCapped,
      candidates,
    };
  }

  private mergePaperBatches(batches: PaperBatchPresentationPayload[]): PaperCandidateGroup | undefined {
    if (batches.length === 0) return undefined;
    const availableBatches = batches.filter((batch) => batch.status === 'available');
    const merged: PaperCandidate[] = [];
    const aliasOwners = new Map<string, number>();
    for (const batch of availableBatches) {
      for (const incoming of batch.candidates) {
        const ownerIndexes = new Set(incoming.strongAliases.flatMap((alias) => {
          const owner = aliasOwners.get(alias);
          return owner === undefined ? [] : [owner];
        }));
        // Never use title/year as a merge key. Multiple strong aliases pointing
        // to different existing candidates are also left separate: guessing a
        // transitive merge would conceal an upstream identity conflict.
        if (ownerIndexes.size !== 1) {
          const index = merged.length;
          merged.push({
            ...incoming,
            sources: [incoming.provider],
            sourcePositions: [{ provider: incoming.provider, returnIndex: incoming.returnIndex }],
          });
          for (const alias of incoming.strongAliases) {
            if (!aliasOwners.has(alias)) aliasOwners.set(alias, index);
          }
          continue;
        }
        const index = [...ownerIndexes][0];
        const current = merged[index];
        const conflictingFields = new Set(current.conflictingFields ?? []);
        for (const field of ['title', 'authors', 'year', 'venue', 'doi', 'arxivId', 'url', 'pdfUrl'] as const) {
          if (candidateValuesConflict(current[field], incoming[field])) conflictingFields.add(field);
        }
        const strongAliases = [...new Set([...current.strongAliases, ...incoming.strongAliases])];
        merged[index] = {
          ...current,
          strongAliases,
          actionable: current.actionable || incoming.actionable,
          sources: [...new Set([...(current.sources ?? [current.provider]), incoming.provider])],
          sourcePositions: [
            ...(current.sourcePositions ?? [{ provider: current.provider, returnIndex: current.returnIndex }]),
            { provider: incoming.provider, returnIndex: incoming.returnIndex },
          ].filter((position, positionIndex, positions) => positions.findIndex(
            (candidate) => candidate.provider === position.provider
              && candidate.returnIndex === position.returnIndex,
          ) === positionIndex),
          ...(conflictingFields.size ? { conflictingFields: [...conflictingFields].sort() } : {}),
          // Fill absent metadata only; conflicting full facts remain explicit in
          // conflictingFields instead of silently overwriting one provider.
          ...Object.fromEntries(Object.entries(incoming).filter(([key, value]) => (
            value !== undefined && (current as unknown as Record<string, unknown>)[key] === undefined
          ))),
        } as PaperCandidate;
        for (const alias of strongAliases) aliasOwners.set(alias, index);
      }
    }
    this.enrichLibraryState(merged);
    const matchedValues = availableBatches.flatMap((batch) => batch.matchedTotal === undefined ? [] : [batch.matchedTotal]);
    const queries = [...new Set(batches.flatMap((batch) => batch.query ? [batch.query] : []))];
    const providers = [...new Set(availableBatches.map((batch) => batch.provider))];
    const partialProviders = [...new Set(availableBatches
      .filter((batch) => batch.captureSource === 'persisted' || batch.persistedDetailsTruncated)
      .map((batch) => batch.provider))];
    const unavailableProviders = [...new Set(batches
      .filter((batch) => batch.status === 'unavailable')
      .map((batch) => batch.provider))]
      .filter((provider) => !providers.includes(provider));
    return {
      semantic: 'retrieved',
      label: '检索结果·尚未筛选',
      queries,
      queryUnavailable: batches.some((batch) => batch.queryUnavailable),
      hasAvailableResults: availableBatches.length > 0,
      providers,
      partialProviders,
      unavailableProviders,
      ...(matchedValues.length ? { matchedTotal: matchedValues.reduce((sum, value) => sum + value, 0) } : {}),
      returned: availableBatches.reduce((sum, batch) => sum + batch.returned, 0),
      eligible: availableBatches.reduce((sum, batch) => sum + batch.eligible, 0),
      stored: availableBatches.reduce((sum, batch) => sum + batch.stored, 0),
      unique: merged.length,
      shown: Math.min(3, merged.length),
      candidates: merged,
    };
  }

  private enrichLibraryState(candidates: PaperCandidate[]): void {
    if (candidates.length === 0) return;
    const rows = this.db.prepare(`
      SELECT id, doi, arxiv_id, source, source_id FROM rc_papers
      WHERE doi IS NOT NULL OR arxiv_id IS NOT NULL OR (source IS NOT NULL AND source_id IS NOT NULL)
    `).all() as Array<{
      id: string;
      doi: string | null;
      arxiv_id: string | null;
      source: string | null;
      source_id: string | null;
    }>;
    const aliases = new Map<string, string>();
    for (const row of rows) {
      const doi = normalizeDoi(row.doi);
      const arxiv = normalizeArxivId(row.arxiv_id);
      if (doi) aliases.set(`doi:${doi}`, row.id);
      if (arxiv) aliases.set(`arxiv:${arxiv.toLowerCase()}`, row.id);
      if (row.source && row.source_id) aliases.set(`provider:${row.source}:${row.source_id}`, row.id);
    }
    for (const candidate of candidates) {
      const libraryId = candidate.strongAliases.map((alias) => aliases.get(alias)).find(Boolean);
      if (libraryId) candidate.libraryId = libraryId;
    }
  }
}
