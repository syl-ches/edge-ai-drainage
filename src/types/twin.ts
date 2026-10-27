// Mirrors public/data/*.json exactly (schema_version 1.0.0, see CLAUDE.md §6 and §9).

export type LngLat = [number, number];
export type LngLatZ = [number, number, number];

export type SourceType = 'SYNTHETIC_OSMNX' | 'LGU_FIELD_VERIFIED' | 'DPWH_AS_BUILT_CAD';
export type NodeType = 'JUNCTION' | 'STORAGE' | 'OUTFALL';
export type NetworkKind = 'ARTERIAL' | 'FEEDER' | 'LATERAL' | 'TUNNEL' | 'STORAGE';
export type ConduitShape = 'RECT_CLOSED' | 'CIRCULAR' | 'ARCH';
export type SegmentClass = 'UNFINISHED_ROCK_CHOKE' | 'CONCRETED_TRANSITION' | 'CONCRETED_LINED';

export interface Provenance {
  source_type: SourceType;
  is_active: boolean;
}

export interface TwinNode extends Provenance {
  id: string;
  type: NodeType;
  name: string;
  barangay: string;
  network: NetworkKind;
  coordinates: LngLatZ; // z = rim / ground elevation
  rim_elev_m: number;
  invert_elev_m: number;
  max_depth_m: number;
  catchment_area_ha: number;
  runoff_coeff: number | null;
  utm51n_en: [number, number];
  ptm3_en: [number, number];
  surface_area_m2?: number;
  permanent_pool_depth_m?: number;
}

export interface ConduitGeometry {
  rise_m: number;
  span_m: number;
  diameter_m: number | null;
  haunch_m: number | null;
  area_full_m2: number;
}

export interface Conduit extends Provenance {
  id: string;
  link_type: 'CONDUIT';
  name: string;
  road: string;
  barangay: string;
  network: NetworkKind;
  from_node: string;
  to_node: string;
  shape: ConduitShape;
  material: string;
  geometry: ConduitGeometry;
  coordinates: [LngLatZ, LngLatZ]; // z = invert elevation
  coordinates_ref: 'INVERT';
  inlet_invert_m: number;
  outlet_invert_m: number;
  inlet_offset_m: number;
  outlet_offset_m: number;
  length_m: number;
  length_3d_m: number;
  slope: number;
  slope_eff_sin: number;
  manning_n: number;
  q_full_cms: number;
  q_max_cms: number;
  y_at_qmax_ratio: number;
  tc_min: number;
  segment_class?: SegmentClass;
  spec_reference?: string;
}

export interface Orifice extends Provenance {
  id: string;
  link_type: 'ORIFICE';
  name: string;
  from_node: string;
  to_node: string;
  coordinates: LngLatZ; // z = sill elevation
  sill_elev_m: number;
  width_m: number;
  height_m: number;
  gross_area_m2: number;
  discharge_coeff: number;
  bar_thickness_m: number;
  bar_clear_spacing_m: number;
  bar_angle_deg: number;
  kirschmer_beta: number;
  bar_open_ratio: number;
  xi_clean: number;
}

export interface StageStoragePoint {
  depth_m: number;
  surface_area_m2: number;
  volume_m3: number;
}

export interface Lagoon extends Provenance {
  node_id: string;
  polygon: LngLat[][];
  area_m2: number;
  invert_elev_m: number;
  rim_elev_m: number;
  max_depth_m: number;
  permanent_pool_depth_m: number;
  bottom_area_m2: number;
  full_volume_m3: number;
  stage_storage: StageStoragePoint[];
  geology: string;
}

export interface Building extends Provenance {
  id: string;
  barangay: string;
  levels: number;
  height_m: number;
  ground_elev_m: number;
  footprint_area_m2: number;
  coordinates: LngLat[][];
  generator: 'BUILTIN_FALLBACK' | 'OSMNX';
}

export type SensorRole =
  | 'HILLSIDE_TRIBUTARY'
  | 'ARTERIAL_BOX_CULVERT'
  | 'LAGOON_BOWL'
  | 'TRASH_RACK_ULTRASONIC'
  | 'TRASH_RACK_VISION'
  | 'TUNNEL_CHOKE_TRANSITION';
export type SensorHardware = 'XIAO_ESP32S3_A02YYUW' | 'JETSON_YOLO_TRASHRACK';

export interface Sensor extends Provenance {
  sensor_id: string;
  name: string;
  role: SensorRole;
  hardware: SensorHardware;
  device_eui: string;
  attached_kind: 'CONDUIT' | 'STORAGE' | 'ORIFICE';
  attached_to: string;
  mount_node: string;
  coordinates: LngLatZ; // z = mount (rim / ground) elevation
  pipe_geometry: Record<string, number | string>;
  vbat_v: number;
  radio?: { lorawan_region: string; band_mhz: [number, number]; transceiver: string };
  sensors?: string[];
  vision?: { model: string; output: string; range: [number, number] };
  payload_note?: string;
}

export interface NetworkMeta {
  project: string;
  schema_version: string;
  generator: string;
  rng_seed: number;
  anchor: { lon: number; lat: number; utm51n_en: [number, number] };
  crs: Record<string, unknown>;
  vertical_exaggeration: number;
  conventions: Record<string, string>;
  buildings_source: string;
  counts: {
    nodes: number;
    conduits: number;
    orifices: number;
    buildings: number;
    sensors: number;
    conduits_by_shape: Record<ConduitShape, number>;
    nodes_by_type: Record<NodeType, number>;
  };
  disclaimer: string;
}

export interface NetworkFile {
  meta: NetworkMeta;
  nodes: TwinNode[];
  conduits: Conduit[];
  orifices: Orifice[];
  lagoon: Lagoon;
  buildings: Building[];
  sensors: Sensor[];
}

// ---------------------------------------------------------------- simulation_lut.json
export type ConduitStatus = 'NORMAL' | 'ELEVATED' | 'CRITICAL' | 'SURCHARGED';
export type FlowRegime = 'SUBCRITICAL' | 'SUPERCRITICAL' | 'PRESSURIZED';
export type DepthControl = 'NORMAL' | 'BACKWATER' | 'SELF_SURCHARGE';
export type AnomalyClass =
  | 'NORMAL'
  | 'FLASH_SURGE'
  | 'TRASH_BLOCKAGE'
  | 'SUPERCRITICAL'
  | 'SURCHARGED'
  | 'SENSOR_FAULT'
  | 'LOW_BATTERY';

export interface ConduitResult {
  flow_cms: number;
  water_depth_m: number;
  velocity_ms: number;
  froude_number: number | null; // null when pressurized
  capacity_ratio: number;
  status: ConduitStatus;
  flow_regime: FlowRegime;
  hydraulic_jump: boolean;
  depth_control: DepthControl;
}

export interface NodeResult {
  hgl_m: number;
  is_flooding: boolean;
}

export interface LagoonResult {
  lagoon_water_depth_m: number;
  lagoon_surface_elev_m: number;
  inundation_radius_m: number;
  inundation_area_m2: number;
  orifice_head_loss_m: number;
  orifice_flow_cms: number;
  rack_capacity_cms: number;
  lagoon_inflow_cms: number;
  spill_flow_cms: number;
  lagoon_dh_dt_mm_min: number;
  outflow_control: 'NONE' | 'TRASH_RACK' | 'TUNNEL_CHOKE';
  is_overflowing: boolean;
  estimated_time_to_overflow_min: number | null;
  xi_rack: number;
  depth_series_m: number[];
}

export interface SensorTelemetry {
  depth_mm: number;
  dh_dt_mm_min: number;
  turbulence_index: number;
  froude_number: number | null;
  capacity_pct: number;
  anomaly_class: AnomalyClass;
  anomaly_code: number;
  vbat_v: number;
  payload_uint32: number;
  payload_hex: string;
  payload_bytes_be: string;
  saturated_fields: string[];
  blockage_ratio_p?: number; // JETSON_YOLO_TRASHRACK only
}

export interface Scenario {
  key: string;
  rainfall_mm_hr: number;
  trash_rack_blockage_pct: number;
  lagoon: LagoonResult;
  status_counts: Record<ConduitStatus, number>;
  conduits: Record<string, ConduitResult>;
  nodes: Record<string, NodeResult>;
  sensors: Record<string, SensorTelemetry>;
}

export interface LutFile {
  meta: {
    schema_version: string;
    network_file: string;
    storm_duration_min: number;
    overflow_horizon_min: number;
    sim_dt_s: number;
    series_step_min: number;
    tunnel_conveyance_limit_cms: number;
    status_thresholds: Record<string, number | string>;
    capacity_ratio_cap: number;
    anomaly_codes: Record<AnomalyClass, number>;
    payload_layout: Record<string, string>;
    model: string[];
  };
  axes: { rainfall_mm_hr: number[]; trash_rack_blockage_pct: number[] };
  index: Record<string, number>;
  scenarios: Scenario[];
  reference_scenarios: Scenario[];
}
