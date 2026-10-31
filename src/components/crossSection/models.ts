// Smoothed drawing models for the node cutaway and the catchment profile (draw.ts), shared by the
// Cross-Section Simulator and the right-dock SECTION panel (Phase 9A). Values ease towards the
// twin state with 1 - e^(-3.2·dt) so scenario jumps animate instead of snapping.
import type { NetworkFile } from '../../types/twin';
import type { LutInterpolator, TwinState } from '../../utils/lutInterpolator';
import { nodeDepthM, nodeFullnessPct, sensorGeometry } from '../../utils/fullness';
import type { NodeModel, ProfileModel } from './draw';

export class SectionSmoother {
  depth = 0;
  full = 0;
  lagoon = 0;
  hill = 0;
  tunnel = 0;
  choke = 0;
  down = 0;
  private init = false;
  private node = '';

  private fillOf(st: TwinState, interp: LutInterpolator, net: NetworkFile, id: string): number {
    const i = interp.conduitIndex.get(id) ?? -1;
    return i >= 0 ? st.conduits.depth[i] / net.conduits[i].geometry.rise_m : 0;
  }

  /** Advance the smoothed values by dt seconds towards the state (snaps on the first call / a new node). */
  update(dt: number, st: TwinState, interp: LutInterpolator, net: NetworkFile, nodeId: string): void {
    const sen = st.sensors[interp.sensorIndex.get(nodeId) ?? 0];
    const target = {
      depth: nodeDepthM(sen),
      full: nodeFullnessPct(sen),
      lagoon: st.lagoon.depthM,
      hill: Math.max(nodeFullnessPct(st.sensors[0]), nodeFullnessPct(st.sensors[1])) / 100,
      tunnel: this.fillOf(st, interp, net, 'TUN-C01'),
      choke: this.fillOf(st, interp, net, 'TUN-C03'),
      down: this.fillOf(st, interp, net, 'TUN-C09'),
    };
    const k = !this.init || this.node !== nodeId ? 1 : 1 - Math.exp(-Math.min(dt, 0.1) * 3.2);
    if (this.node !== nodeId) {
      this.depth = target.depth;
      this.full = target.full;
    }
    this.init = true;
    this.node = nodeId;
    this.depth += (target.depth - this.depth) * k;
    this.full += (target.full - this.full) * k;
    this.lagoon += (target.lagoon - this.lagoon) * k;
    this.hill += (target.hill - this.hill) * k;
    this.tunnel += (target.tunnel - this.tunnel) * k;
    this.choke += (target.choke - this.choke) * k;
    this.down += (target.down - this.down) * k;
  }

  nodeModel(st: TwinState, interp: LutInterpolator, net: NetworkFile, nodeId: string, draining: boolean): NodeModel {
    const sen = st.sensors[interp.sensorIndex.get(nodeId) ?? 0];
    const g = sensorGeometry(sen.sensor, net);
    const conduitI = sen.sensor.attached_kind === 'CONDUIT' ? (interp.conduitIndex.get(sen.sensor.attached_to) ?? -1) : -1;
    const lidDepth =
      g.shape === 'STORAGE'
        ? net.lagoon.max_depth_m
        : g.shape === 'ORIFICE'
          ? net.lagoon.rim_elev_m - net.orifices[0].sill_elev_m
          : sen.sensor.coordinates[2] - Number(sen.sensor.pipe_geometry.invert_elev_m);
    return {
      id: sen.id,
      title: `${g.structureLabel} (${sen.id})`,
      kind: g.shape,
      rise: g.fullScaleM,
      span: g.spanM,
      lidDepth,
      mount: g.mountM,
      crownMounted: g.crownMounted,
      depth: this.depth,
      fullPct: this.full,
      velocity: conduitI >= 0 ? st.conduits.velocity[conduitI] : 0.3,
      anomaly: sen.anomaly,
      turbulence: Math.min(sen.turbulence, 1),
      rain: st.rain,
      blockagePct: st.blockagePct,
      draining,
      isVision: sen.sensor.hardware === 'JETSON_YOLO_TRASHRACK',
    };
  }

  profileModel(st: TwinState, interp: LutInterpolator, net: NetworkFile, draining: boolean): ProfileModel {
    const tun = interp.conduitIndex.get('TUN-C01') ?? -1;
    return {
      rain: st.rain,
      hillFill: this.hill,
      arterialFill: this.fillOf(st, interp, net, 'LGD-C07'),
      lagoonDepth: this.lagoon,
      lagoonMax: net.lagoon.max_depth_m,
      blockagePct: st.blockagePct,
      tunnelFill: this.tunnel,
      chokeFill: this.choke,
      downstreamFill: this.down,
      tunnelVelocity: tun >= 0 ? st.conduits.velocity[tun] : 0,
      hillAnomaly: st.sensors[0].anomaly,
      draining,
    };
  }
}
