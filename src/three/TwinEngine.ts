import type { CustomLayerInterface, CustomRenderMethodInput, Map as MapLibreMap } from 'maplibre-gl';
import {
  Camera,
  ColorManagement,
  DirectionalLight,
  HemisphereLight,
  LinearSRGBColorSpace,
  Matrix4,
  Scene,
  Vector3,
  Vector4,
  WebGLRenderer,
} from 'three';
import type { TwinData } from '../data/loadTwin';
import type { TwinState } from '../utils/lutInterpolator';
import { LocalFrame } from './frame';
import { buildBuildings, type BuildingsLayer } from './layers/buildings';
import { buildConduits, type ConduitsLayer } from './layers/conduits';
import { buildLagoon, type LagoonLayer } from './layers/lagoon';
import { buildNodes, ShaftKind, type NodesLayer } from './layers/nodes';
import { buildRack, type RackLayer } from './layers/rack';
import { buildSensors, type SensorsLayer } from './layers/sensors';
import { buildRoads, type RoadsLayer } from './layers/roads';
import { buildTerrain, type TerrainLayer } from './layers/terrain';
import { buildWeather, type WeatherLayer } from './layers/weather';
import { applyBasemapTheme, setBasemapParks } from '../map/basemap';
import type { ShadingMode } from './materials/buildingMaterials';
import { LIGHTING, setThemeUniforms, type Theme } from './theme';
import { buildVegetation, type VegetationLayer } from './vegetationLayer';

// Raw hex in = raw hex out: the custom GLSL and the basic materials stay consistent.
ColorManagement.enabled = false;

export type PickKind = 'conduit' | 'node' | 'sensor' | 'rack';
export interface PickHit {
  kind: PickKind;
  id: string;
}

export interface ScreenPoint {
  x: number;
  y: number;
  visible: boolean;
}

export interface LayerVisibility {
  buildings: boolean;
  vegetation: boolean;
  network: boolean;
  badges: boolean;
}

export type CameraPresetId = 'overview' | 'intake' | 'choke' | 'drop';
export interface CameraPreset {
  id: CameraPresetId;
  label: string;
  center: [number, number];
  zoom: number;
  pitch: number;
  bearing: number;
}

const PICK_RADIUS_PX: Record<PickKind, number> = { sensor: 18, rack: 22, node: 9, conduit: 9 };
const PICK_BONUS_PX: Record<PickKind, number> = { sensor: 8, rack: 6, node: 3, conduit: 0 };

/**
 * MapLibre CustomLayerInterface hosting one Three.js scene in MapLibre's WebGL2
 * context. Geometry is built once; scenarios only touch uniforms, data textures
 * and a handful of transforms (CLAUDE.md §11).
 */
export class TwinEngine implements CustomLayerInterface {
  readonly id = 'city-camp-xray';
  readonly type = 'custom' as const;
  readonly renderingMode = '3d' as const;

  readonly frame: LocalFrame;
  readonly presets: CameraPreset[];
  readonly conduits: ConduitsLayer;
  readonly nodes: NodesLayer;
  readonly sensors: SensorsLayer;
  readonly rack: RackLayer;
  readonly buildings: BuildingsLayer;
  readonly lagoon: LagoonLayer;
  readonly weather: WeatherLayer;
  readonly terrain: TerrainLayer;
  readonly roads: RoadsLayer;
  readonly vegetation: VegetationLayer;
  theme: Theme = 'daylight';
  private lastRain = 0;

  private map?: MapLibreMap;
  private renderer?: WebGLRenderer;
  private readonly scene = new Scene();
  private readonly camera = new Camera();
  private readonly mvp = new Matrix4();
  private readonly main = new Matrix4();
  readonly cameraPos: Vector3 = new Vector3(0, -800, 600);
  private readonly focus = new Vector3();
  private readonly tmp4 = new Vector4();
  private readonly t0 = performance.now();
  private frameListeners = new Set<() => void>();
  private frames = 0;
  private fpsWindowStart = performance.now();
  private hover: PickHit | null = null;
  private selected: PickHit | null = null;
  fps = 0;

  constructor(private readonly data: TwinData) {
    const { network } = data;
    this.frame = new LocalFrame(network.meta.anchor.lon, network.meta.anchor.lat);
    const rackDef = network.orifices[0];
    const intakeShaft = network.nodes.find((n) => n.id === rackDef.to_node)!;

    this.terrain = buildTerrain(network, this.frame);
    this.roads = buildRoads(network.conduits, this.frame, this.terrain.sampleElevation);
    this.vegetation = buildVegetation(network, this.frame, this.terrain.sampleElevation, this.terrain.greenAt);
    this.conduits = buildConduits(network.conduits, this.frame, this.cameraPos);
    this.nodes = buildNodes(network.nodes, network.conduits, network.orifices, this.frame);
    this.rack = buildRack(rackDef, intakeShaft, this.frame);
    this.lagoon = buildLagoon(network.lagoon, this.frame, this.cameraPos);
    this.sensors = buildSensors(network.sensors, network.conduits, network.lagoon, rackDef, this.frame, this.cameraPos);
    this.buildings = buildBuildings(network.buildings, this.frame, this.cameraPos);
    this.weather = buildWeather();
    // Studio look-dev lights (stock materials); the custom shaders read the same values.
    const hemi = new HemisphereLight(LIGHTING.skyColor, LIGHTING.groundColor, LIGHTING.hemiIntensity);
    const sun = new DirectionalLight(LIGHTING.sunColor, LIGHTING.sunIntensity);
    sun.position.copy(LIGHTING.sunDirection).multiplyScalar(1000);
    this.scene.add(
      hemi,
      sun,
      this.terrain.group,
      this.roads.group,
      this.vegetation.group,
      this.lagoon.group,
      this.conduits.group,
      this.nodes.group,
      this.rack.group,
      this.sensors.group,
      this.buildings.group,
      this.weather.group,
    );
    this.scene.matrixAutoUpdate = true;
    this.presets = this.buildPresets();
  }

  private buildPresets(): CameraPreset[] {
    const { network } = this.data;
    const anchor: [number, number] = [network.meta.anchor.lon, network.meta.anchor.lat];
    const rack = network.orifices[0].coordinates;
    const choke = network.conduits.find((c) => c.segment_class === 'UNFINISHED_ROCK_CHOKE')!;
    const drop = this.nodes.shafts.find(
      (s) => s.kind === ShaftKind.DropShaft && s.id !== network.orifices[0].to_node,
    );
    const dropNode = network.nodes.find((n) => n.id === drop?.id) ?? network.nodes[0];
    // Choke: oblique side-on, 55° off the tunnel axis. Intake: face the grate from the lagoon side.
    const [c0, c1] = choke.coordinates;
    const axisBearing = (Math.atan2(c1[0] - c0[0], c1[1] - c0[1]) * 180) / Math.PI;
    const intakeBearing = (Math.atan2(rack[0] - anchor[0], rack[1] - anchor[1]) * 180) / Math.PI;
    return [
      { id: 'overview', label: 'Overview Bowl', center: anchor, zoom: 15.8, pitch: 62, bearing: -25 },
      { id: 'intake', label: 'Tunnel Intake & Trash Rack', center: [rack[0], rack[1]], zoom: 21.2, pitch: 58, bearing: intakeBearing + 20 },
      {
        id: 'choke',
        label: `${choke.geometry.span_m}m×${choke.geometry.rise_m}m Rock Choke`,
        center: [c0[0], c0[1]],
        zoom: 20.2,
        pitch: 66,
        bearing: axisBearing + 55,
      },
      {
        id: 'drop',
        label: 'Lower Rock Quarry Drop Shaft',
        center: [dropNode.coordinates[0], dropNode.coordinates[1]],
        zoom: 18.6,
        pitch: 72,
        bearing: -60,
      },
    ];
  }

  // ---------------------------------------------------------------- CustomLayerInterface
  onAdd(map: MapLibreMap, gl: WebGLRenderingContext | WebGL2RenderingContext): void {
    this.map = map;
    this.renderer = new WebGLRenderer({ canvas: map.getCanvas(), context: gl as WebGL2RenderingContext, antialias: true });
    this.renderer.autoClear = false;
    this.renderer.outputColorSpace = LinearSRGBColorSpace;
  }

  onRemove(): void {
    this.renderer?.dispose();
    this.renderer = undefined;
    this.map = undefined;
  }

  render(gl: WebGLRenderingContext | WebGL2RenderingContext, args: CustomRenderMethodInput): void {
    const renderer = this.renderer;
    if (!renderer || !this.map) return;
    this.main.fromArray(args.defaultProjectionData.mainMatrix as ArrayLike<number> as number[]);
    this.mvp.multiplyMatrices(this.main, this.frame.sceneMatrix);
    this.camera.projectionMatrix.copy(this.mvp);
    this.camera.projectionMatrixInverse.copy(this.mvp).invert();

    // Eye position in scene metres: inverse(MVP) * (0, 0, 1, 0), dehomogenised.
    this.tmp4.set(0, 0, 1, 0).applyMatrix4(this.camera.projectionMatrixInverse);
    if (Math.abs(this.tmp4.w) > 1e-12) this.cameraPos.set(this.tmp4.x, this.tmp4.y, this.tmp4.z).divideScalar(this.tmp4.w);
    const t = (performance.now() - this.t0) / 1000;
    this.conduits.setTime(t);
    this.nodes.setTime(t);
    this.lagoon.setTime(t);
    this.rack.setTime(t);
    this.sensors.setTime(t);
    this.terrain.setTime(t);
    this.vegetation.setTime(t);
    const c = this.map.getCenter();
    const f = this.frame.toLocal(c.lng, c.lat);
    this.focus.copy(f);
    this.weather.update(t, this.focus, this.cameraPos.distanceTo(this.focus));

    renderer.resetState();
    renderer.setViewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    renderer.render(this.scene, this.camera);

    this.frameListeners.forEach((fn) => fn());
    this.tickFps();
    this.map.triggerRepaint(); // flow chevrons + water animate continuously
  }

  private tickFps() {
    this.frames++;
    const now = performance.now();
    if (now - this.fpsWindowStart >= 500) {
      this.fps = (this.frames * 1000) / (now - this.fpsWindowStart);
      this.frames = 0;
      this.fpsWindowStart = now;
    }
  }

  // ---------------------------------------------------------------- state
  /** Push an interpolated LUT state (or a live backend frame mapped onto it) to the GPU. */
  applyState(st: TwinState): void {
    this.conduits.applyState(st);
    this.nodes.applyState(st);
    this.lagoon.applyState(st.lagoon);
    this.rack.applyBlockage(st.blockagePct);
    this.sensors.applyState(st.sensors);
    this.weather.setRain(st.rain);
    this.terrain.setRain(st.rain);
    this.lagoon.setRain(st.rain);
    this.vegetation.setWind(st.rain);
    this.lastRain = st.rain;
    this.map?.triggerRepaint();
  }

  /** Daylight Diorama <-> Dark X-Ray: one shared uniform + basemap paint, no rebuilds. */
  setTheme(theme: Theme): void {
    this.theme = theme;
    setThemeUniforms(theme);
    this.terrain.setTheme(theme);
    this.roads.setTheme(theme);
    this.lagoon.setTheme(theme);
    this.sensors.setTheme(theme);
    this.weather.setRain(this.lastRain);
    if (this.map) applyBasemapTheme(this.map, theme);
    this.map?.triggerRepaint();
  }

  setShadingMode(mode: ShadingMode): void {
    this.buildings.setMode(mode);
    this.map?.triggerRepaint();
  }

  setLayers(v: LayerVisibility): void {
    this.buildings.setVisible(v.buildings);
    this.vegetation.setVisible(v.vegetation);
    this.terrain.setParks(v.vegetation);
    if (this.map) setBasemapParks(this.map, v.vegetation);
    this.conduits.group.visible = v.network;
    this.nodes.setVisible(v.network);
    this.rack.group.visible = v.network;
    this.sensors.setGaugesVisible(v.badges);
    this.map?.triggerRepaint();
  }

  setPipeScale(k: number): void {
    this.conduits.setPipeScale(k);
    this.nodes.setPipeScale(k);
    this.rack.setPipeScale(k);
  }

  setHover(hit: PickHit | null): void {
    this.hover = hit;
    this.applyHighlight();
  }

  setSelected(hit: PickHit | null): void {
    this.selected = hit;
    this.applyHighlight();
  }

  private applyHighlight() {
    const idx = (kind: PickKind, map: Map<string, number>) => {
      const h = this.hover?.kind === kind ? map.get(this.hover.id) : undefined;
      const s = this.selected?.kind === kind ? map.get(this.selected.id) : undefined;
      return { h: h ?? -1, s: s ?? -1 };
    };
    const c = idx('conduit', this.conduits.indexOf);
    this.conduits.setHover(c.h);
    this.conduits.setSelected(c.s);
    const n = idx('node', this.nodes.indexOf);
    this.nodes.setHover(n.h);
    this.nodes.setSelected(n.s);
    const sensorId = this.hover?.kind === 'sensor' ? this.hover.id : this.selected?.kind === 'sensor' ? this.selected.id : null;
    this.sensors.setHover(sensorId);
    this.rack.setHighlight(this.hover?.kind === 'rack' || this.selected?.kind === 'rack');
  }

  addFrameListener(fn: () => void): () => void {
    this.frameListeners.add(fn);
    return () => this.frameListeners.delete(fn);
  }

  flyTo(id: CameraPresetId): void {
    const p = this.presets.find((x) => x.id === id);
    if (!p || !this.map) return;
    this.map.flyTo({ center: p.center, zoom: p.zoom, pitch: p.pitch, bearing: p.bearing, duration: 2200, essential: true });
  }

  // ---------------------------------------------------------------- picking (screen space)
  project(v: Vector3): ScreenPoint {
    const canvas = this.map?.getCanvas();
    if (!canvas) return { x: 0, y: 0, visible: false };
    this.tmp4.set(v.x, v.y, v.z, 1).applyMatrix4(this.mvp);
    if (this.tmp4.w <= 0) return { x: 0, y: 0, visible: false };
    const nx = this.tmp4.x / this.tmp4.w;
    const ny = this.tmp4.y / this.tmp4.w;
    return {
      x: ((nx + 1) / 2) * canvas.clientWidth,
      y: ((1 - ny) / 2) * canvas.clientHeight,
      visible: Math.abs(nx) <= 1.2 && Math.abs(ny) <= 1.2,
    };
  }

  pick(px: number, py: number): PickHit | null {
    let best: PickHit | null = null;
    let bestScore = Infinity;
    const consider = (kind: PickKind, id: string, d: number) => {
      if (d > PICK_RADIUS_PX[kind]) return;
      const score = d - PICK_BONUS_PX[kind];
      if (score < bestScore) {
        bestScore = score;
        best = { kind, id };
      }
    };
    const segDist = (a: Vector3, b: Vector3) => {
      const pa = this.project(a);
      const pb = this.project(b);
      if (!pa.visible && !pb.visible) return Infinity;
      const dx = pb.x - pa.x;
      const dy = pb.y - pa.y;
      const len2 = dx * dx + dy * dy;
      const t = len2 > 0 ? Math.min(Math.max(((px - pa.x) * dx + (py - pa.y) * dy) / len2, 0), 1) : 0;
      return Math.hypot(px - (pa.x + t * dx), py - (pa.y + t * dy));
    };
    for (const b of this.sensors.beacons) consider('sensor', b.id, segDist(b.base, b.top));
    const r = this.project(this.rack.anchor);
    if (r.visible) consider('rack', this.data.network.orifices[0].id, Math.hypot(px - r.x, py - r.y));
    for (const s of this.nodes.shafts) {
      if (s.kind === ShaftKind.TunnelStation) continue;
      consider('node', s.id, segDist(s.bottom, s.top));
    }
    for (const a of this.conduits.axes) consider('conduit', a.id, segDist(a.a, a.b));
    for (const s of this.nodes.shafts) {
      if (s.kind === ShaftKind.TunnelStation) consider('node', s.id, segDist(s.bottom, s.top) + 4);
    }
    return best;
  }
}
