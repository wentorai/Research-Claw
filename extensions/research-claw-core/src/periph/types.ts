/**
 * Peripheral subsystem — shared type definitions.
 *
 * Contract: every field name and type here is referenced by downstream tasks
 * (T4–T19). Do NOT rename without updating all consumers.
 */

export type PeriphKind = 'camera' | 'audio-recorder' | 'lab-instrument' | 'embodied';
export type PeriphDriver = 'browser-camera' | 'mcp-plaud' | 'rtsp' | 'oc-node';
export type PeriphVerdict = 'ok' | 'alert' | 'info' | 'unverified' | 'missed' | 'error';

export interface PeriphDevice {
  id: string;
  name: string;
  kind: PeriphKind;
  driver: PeriphDriver;
  enabled: boolean;
  config: Record<string, unknown>;
  check_prompt: string;
  last_seen_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface PeriphObservation {
  id: string;
  device_id: string;
  monitor_id: string | null;
  kind: 'snapshot' | 'check' | 'note';
  verdict: PeriphVerdict;
  summary: string;
  frame_path: string | null;
  result_json: Record<string, unknown>;
  captured_at: string;
}
