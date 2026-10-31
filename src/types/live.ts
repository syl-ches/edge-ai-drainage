// WS /ws/live frame contract (Phase 4 backend → frontend). Mirrors backend/schemas.py
// (`TwinFrame`). Keep both in lock-step; see CLAUDE.md §12.

import type { Forecast } from '../forecast/stgnn';
import type { AnomalyClass } from './twin';

export type FsmState = 'STATE_DRY' | 'STATE_ACTIVE_RAIN' | 'STATE_CRITICAL_SURGE';
export type TelemetryOrigin = 'VIRTUAL' | 'HARDWARE';

export interface LoraLink {
  region: 'AS923-3';
  channel_mhz: number;
  spreading_factor: number;
  data_rate: string;
  time_on_air_ms: number;
  rssi_dbm: number;
  snr_db: number;
  fport: number;
}

export interface LiveSensor {
  sensor_id: string;
  device_eui: string;
  origin: TelemetryOrigin;
  /** 'WIFI' when a board posted this record directly to the backend */
  transport?: string | null;
  dist_mm?: number | null;
  temperature_c: number;
  raw_burst_mm: number[];
  raw_unfiltered_depth_mm: number;
  median_depth_mm: number;
  kalman_filtered_depth_mm: number;
  true_depth_mm: number;
  dh_dt_mm_min: number;
  sigma_d2_mm2: number;
  turbulence_index: number;
  h_over_d: number;
  flow_cms: number | null;
  velocity_ms: number | null;
  froude_number: number | null;
  specific_energy_m: number | null;
  capacity_pct: number;
  anomaly_class: AnomalyClass;
  anomaly_code: number;
  anomaly_scores: Record<string, number>;
  saturated_fields: string[];
  vbat_v: number;
  payload_hex: string;
  payload_b64: string;
  payload_uint32: number;
  fsm_state: FsmState;
  current_ua: number;
  next_wake_s: number;
  uplink_interval_s: number;
  lora: LoraLink;
  blockage_pct?: number;
}

export type RootCause =
  | 'NOMINAL'
  | 'CONFIRMED_TRASH_RACK_OCCLUSION'
  | 'DOWNSTREAM_ROCK_CHOKE_BACKWATER'
  | 'DEBRIS_ACCUMULATING_NO_BACKWATER'
  | 'INTAKE_SURCHARGE_OVERFLOW';

export interface FusionVerdict {
  root_cause: RootCause;
  severity: 'INFO' | 'WARNING' | 'CRITICAL';
  action: string;
  confidence: number;
  evidence: string[];
  suppressed_false_alarm: boolean;
}

export interface NowcastHorizon {
  minutes: number;
  rainfall_mm_hr: number;
  lagoon_depth_m: number;
  surcharge_probability_pct: number;
  time_to_overflow_min: number | null;
  surcharged_conduits: number;
}

export interface FewsStation {
  station: string;
  elevation_m: number;
  rainfall_mm_hr: number;
}

export interface Nowcast {
  generated_at: string;
  basin_rainfall_mm_hr: number;
  fews: FewsStation[];
  subcatchments: Record<string, number>;
  horizons: NowcastHorizon[];
}

export interface TwinFrame {
  type: 'twin_frame';
  seq: number;
  ts: string;
  mode: 'PLAYBACK' | 'SCENARIO' | 'HARDWARE';
  storm_clock_s: number;
  storm_period_s: number;
  scenario: { rainfall_mm_hr: number; trash_rack_blockage_pct: number };
  lagoon: {
    depth_m: number;
    surface_elev_m: number;
    time_to_overflow_min: number | null;
    bottleneck: string;
    orifice_head_loss_m: number;
  };
  sensors: Record<string, LiveSensor>;
  fusion: FusionVerdict;
  nowcast: Nowcast;
  hardware_override: { sensor_id: string; age_s: number; scope?: 'single_node' | 'full_catchment' } | null;
  /** Phase 7B: precipitation source driving the twin + forecast, and the replayed storm */
  precip_source: 'LIVE_FEED' | 'HISTORICAL' | 'TWIN';
  storm_id: string;
  /** Phase 7B: ST-GNN +15/+30/+60 min forecast (backend/stgnn.py, mirrored by src/forecast/stgnn.ts) */
  forecast: Forecast;
}
