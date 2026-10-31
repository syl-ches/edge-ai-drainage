// Procedural Command Center CCTV feeds for the City Camp Lagoon intake (Phase 9B).
//
// One offscreen WebGLRenderer draws the same intake compound as the map (src/intake/compound.ts,
// stock lit materials here) from each camera's registry pose, then a 2D pass turns it into a
// surveillance picture: CCTV colour grade, compression grain, interlace, rain streaks, vignette,
// the Command Center OSD (timestamp + camera name) and the YOLOv8 overlay, whose boxes are the
// projected 3D extents of the rack, debris mat, weir and staff gauge.
import {
  AmbientLight,
  BufferGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DirectionalLight,
  Fog,
  Float32BufferAttribute,
  Group,
  HemisphereLight,
  InstancedMesh,
  LinearSRGBColorSpace,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  Quaternion,
  Scene,
  Vector3,
  WebGLRenderer,
} from 'three';
import { buildIntakeCompound, INTAKE, INTAKE_DATUM_ASL, type IntakeCompound, type IntakeState } from '../intake/compound';
import type { CctvCamera, CctvScene } from '../utils/cctvStreams';
import type { Detection } from './replay';

export const FEED_W = 960;
export const FEED_H = 540;

export interface ScreenBox {
  key: Detection['key'];
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface CctvRenderer {
  update(t: number, s: IntakeState): void;
  /** Renders one camera into the shared WebGL canvas and returns it plus the projected boxes. */
  render(camera: CctvCamera): { image: HTMLCanvasElement; boxes: ScreenBox[] };
  dispose(): void;
}

function hash(i: number, k: number): number {
  const s = Math.sin(i * 127.1 + k * 311.7) * 43758.5453123;
  return s - Math.floor(s);
}

/** Backdrop: outer bank, limestone hillside behind the portal, lagoon bowl bank + water, trees. */
function backdrop(): { group: Group; lagoon: Mesh } {
  const g = new Group();
  const outer = (W: number) => INTAKE.width / 2 + INTAKE.wall + INTAKE.walkway + W;
  const grass = new MeshStandardMaterial({ color: '#5F7A45', roughness: 1 });
  const soil = new MeshStandardMaterial({ color: '#7D7563', roughness: 1 });
  const lime = new MeshStandardMaterial({ color: '#A8A291', roughness: 1 });
  const ground = new Mesh(new PlaneGeometry(110, 150), grass);
  ground.position.set(outer(0) + 55, -40, INTAKE.rimZ - 0.05);
  g.add(ground);
  // Hillside behind the tunnel portal rising to the south (local +y), limestone cut + vegetation.
  const hill = new BufferGeometry();
  const hx0 = -60;
  const hx1 = 120;
  hill.setAttribute(
    'position',
    new Float32BufferAttribute(
      [hx0, 1.2, 5, hx1, 1.2, 5, hx1, 45, 34, hx0, 1.2, 5, hx1, 45, 34, hx0, 45, 34].flat(),
      3,
    ),
  );
  hill.computeVertexNormals();
  g.add(new Mesh(hill, grass));
  const cut = new Mesh(new PlaneGeometry(INTAKE.width + 6, 7), lime);
  cut.rotation.x = Math.PI / 2 - 0.55;
  cut.position.set(0, 3.2, 7.6);
  g.add(cut);
  // Lagoon-side bank sloping into the bowl, and the lagoon surface.
  const bank = new BufferGeometry();
  const bx = -(INTAKE.width / 2 + INTAKE.wall + INTAKE.walkway);
  bank.setAttribute('position', new Float32BufferAttribute([bx, -90, 5, bx, 40, 5, bx - 26, 40, -1.6, bx, -90, 5, bx - 26, 40, -1.6, bx - 26, -90, -1.6], 3));
  bank.computeVertexNormals();
  g.add(new Mesh(bank, soil));
  const lagoon = new Mesh(new PlaneGeometry(200, 200), new MeshStandardMaterial({ color: '#4F6B57', roughness: 0.2, metalness: 0.1 }));
  lagoon.position.set(bx - 100, -40, 0);
  g.add(lagoon);
  // Trees: emerald / sage clusters on the banks and the hillside.
  const n = 70;
  const crowns = new InstancedMesh(new ConeGeometry(2.4, 6.5, 7).rotateX(Math.PI / 2), new MeshStandardMaterial({ color: '#ffffff', roughness: 0.9 }), n);
  const trunks = new InstancedMesh(new CylinderGeometry(0.22, 0.3, 2.4, 6).rotateX(Math.PI / 2), new MeshStandardMaterial({ color: '#6B5440', roughness: 1 }), n);
  const m = new Matrix4();
  const tones = ['#3F6B3F', '#4E7D57', '#5F8A5B', '#6E9768', '#365E3A'].map((c) => new Color(c));
  for (let i = 0; i < n; i++) {
    const onHill = i < 40;
    const x = onHill ? -50 + hash(i, 1) * 160 : outer(14) + hash(i, 2) * 60;
    const y = onHill ? 6 + hash(i, 3) * 36 : -70 + hash(i, 4) * 60;
    const z = onHill ? 5 + ((y - 1.2) / 43.8) * 29 : INTAKE.rimZ;
    const k = 0.7 + hash(i, 5) * 0.8;
    m.compose(new Vector3(x, y, z + 2.4 + 3.2 * k), new Quaternion(), new Vector3(k, k, k));
    crowns.setMatrixAt(i, m);
    crowns.setColorAt(i, tones[i % tones.length]);
    m.compose(new Vector3(x, y, z + 1.2), new Quaternion(), new Vector3(1, 1, 1));
    trunks.setMatrixAt(i, m);
  }
  g.add(crowns, trunks);
  return { group: g, lagoon };
}

export function createCctvRenderer(): CctvRenderer {
  const canvas = document.createElement('canvas');
  const renderer = new WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(1);
  renderer.setSize(FEED_W, FEED_H, false);
  renderer.outputColorSpace = LinearSRGBColorSpace; // hex in = hex out, like the map (ColorManagement off)
  renderer.shadowMap.enabled = true;

  const scene = new Scene();
  scene.background = new Color('#A9B2B6'); // overcast monsoon sky
  scene.fog = new Fog('#A9B2B6', 40, 190);
  // three r172 lights are physical (Lambert diffuse = albedo / π · irradiance): ~π x the legacy values.
  scene.add(new HemisphereLight('#DDE5EA', '#5B5F52', 2.7), new AmbientLight('#ffffff', 0.7));
  const sun = new DirectionalLight('#F4F1EA', 2.2);
  sun.position.set(30, -20, 60);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  Object.assign(sun.shadow.camera, { left: -45, right: 45, top: 45, bottom: -45, far: 160 });
  scene.add(sun);

  const compound: IntakeCompound = buildIntakeCompound((_role, look) => {
    const mat = new MeshStandardMaterial({
      color: look.color,
      roughness: look.rough ?? 0.8,
      metalness: look.metal ?? 0,
      transparent: (look.opacity ?? 1) < 1,
      opacity: look.opacity ?? 1,
      depthWrite: (look.opacity ?? 1) >= 1,
    });
    if (look.emissive) {
      mat.emissive = new Color(look.color);
      mat.emissiveIntensity = look.emissive;
    }
    return mat;
  });
  scene.add(compound.group);
  const bg = backdrop();
  scene.add(bg.group);

  const cams = new Map<CctvScene, PerspectiveCamera>();
  const camFor = (c: CctvCamera) => {
    const key = c.scene!;
    let cam = cams.get(key);
    if (!cam) {
      // Registry FOV is horizontal; three wants the vertical one.
      const vfov = (2 * Math.atan(Math.tan((c.fov_deg * Math.PI) / 360) / (FEED_W / FEED_H)) * 180) / Math.PI;
      cam = new PerspectiveCamera(vfov, FEED_W / FEED_H, 0.2, 400);
      cam.up.set(0, 0, 1);
      const p = c.local_pose!;
      cam.position.set(...p.position);
      cam.lookAt(new Vector3(...p.target));
      cam.updateMatrixWorld();
      cams.set(key, cam);
    }
    return cam;
  };

  const v = new Vector3();
  return {
    update(t, s) {
      compound.update(t, s);
      bg.lagoon.position.z = Math.max(s.waterElevM - INTAKE_DATUM_ASL, -1.5);
    },
    render(camera) {
      const cam = camFor(camera);
      renderer.render(scene, cam);
      const boxes: ScreenBox[] = [];
      compound.group.updateMatrixWorld();
      for (const tgt of compound.detectionTargets()) {
        let x0 = Infinity;
        let y0 = Infinity;
        let x1 = -Infinity;
        let y1 = -Infinity;
        let front = 0;
        for (let i = 0; i < 8; i++) {
          v.set(i & 1 ? tgt.box.max.x : tgt.box.min.x, i & 2 ? tgt.box.max.y : tgt.box.min.y, i & 4 ? tgt.box.max.z : tgt.box.min.z);
          v.applyMatrix4(compound.group.matrixWorld).project(cam);
          if (v.z < 1) front++;
          x0 = Math.min(x0, v.x);
          x1 = Math.max(x1, v.x);
          y0 = Math.min(y0, v.y);
          y1 = Math.max(y1, v.y);
        }
        if (front < 8) continue;
        const cx0 = Math.max(x0, -1);
        const cx1 = Math.min(x1, 1);
        const cy0 = Math.max(y0, -1);
        const cy1 = Math.min(y1, 1);
        if (cx1 - cx0 < 0.01 || cy1 - cy0 < 0.01) continue;
        // A detector only boxes objects that are mostly in frame.
        if (((cx1 - cx0) * (cy1 - cy0)) / ((x1 - x0) * (y1 - y0)) < 0.6) continue;
        boxes.push({ key: tgt.key, x: ((cx0 + 1) / 2) * FEED_W, y: ((1 - cy1) / 2) * FEED_H, w: ((cx1 - cx0) / 2) * FEED_W, h: ((cy1 - cy0) / 2) * FEED_H });
      }
      return { image: canvas, boxes };
    },
    dispose() {
      renderer.dispose();
      scene.traverse((o) => {
        const m = o as Mesh;
        m.geometry?.dispose();
      });
    },
  };
}

// ---------------------------------------------------------------- 2D CCTV post-process + OSD

let grain: HTMLCanvasElement | null = null;
function grainTile(): HTMLCanvasElement {
  if (grain) return grain;
  grain = document.createElement('canvas');
  grain.width = grain.height = 256;
  const g = grain.getContext('2d')!;
  const img = g.createImageData(256, 256);
  for (let i = 0; i < img.data.length; i += 4) {
    const v = Math.floor(hash(i, 0.3) * 255);
    img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
    img.data[i + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  return grain;
}

export const DETECTION_COLORS: Record<Detection['key'], string> = {
  debris: '#F59E0B',
  rack: '#22D3EE',
  weir: '#A78BFA',
  gauge: '#34D399',
};

export interface OsdOptions {
  timestamp: string;
  label: string;
  /** Burned-in provenance tag, e.g. SIMULATED REPLAY (never omitted for procedural frames). */
  tag: string | null;
  rainMmHr: number;
  frame: number;
  detections: { det: Detection; box: ScreenBox }[] | null;
}

/** Draws a source frame (WebGL canvas, video, or nothing) as a CCTV picture into ctx (W x H). */
export function drawCctv(ctx: CanvasRenderingContext2D, W: number, H: number, src: CanvasImageSource | null, o: OsdOptions): void {
  ctx.save();
  ctx.fillStyle = '#0B0E11';
  ctx.fillRect(0, 0, W, H);
  if (src) {
    ctx.filter = 'saturate(0.72) contrast(1.08) brightness(0.97)';
    ctx.drawImage(src, 0, 0, W, H);
    ctx.filter = 'none';
  } else {
    // NO SIGNAL slate
    ctx.fillStyle = '#1F2933';
    for (let y = 0; y < H; y += 4) {
      ctx.globalAlpha = 0.25 + 0.2 * hash(y, o.frame % 97);
      ctx.fillRect(0, y, W, 2);
    }
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#E2E8F0';
    ctx.font = `700 ${Math.round(H / 14)}px ui-monospace, "JetBrains Mono", Consolas, monospace`;
    ctx.textAlign = 'center';
    ctx.fillText('NO SIGNAL', W / 2, H / 2);
    ctx.font = `500 ${Math.round(H / 30)}px ui-monospace, Consolas, monospace`;
    ctx.fillText('VMS stream not configured for this camera', W / 2, H / 2 + H / 16);
    ctx.textAlign = 'left';
  }
  const sx = W / FEED_W;
  const sy = H / FEED_H;
  // Rain streaks (deterministic per frame).
  if (src && o.rainMmHr > 0.5) {
    const n = Math.min(Math.round(o.rainMmHr * 3), 420);
    ctx.strokeStyle = 'rgba(235,240,245,0.32)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const x = hash(i, o.frame * 0.13) * W;
      const y = hash(i + 7, o.frame * 0.17) * H;
      const l = 10 + hash(i, 3.3) * 22;
      ctx.moveTo(x, y);
      ctx.lineTo(x - l * 0.18, y + l);
    }
    ctx.stroke();
  }
  // Compression grain + interlace + vignette.
  if (src) {
    ctx.globalAlpha = 0.08;
    ctx.globalCompositeOperation = 'overlay';
    const g = grainTile();
    const ox = Math.floor(hash(o.frame, 1) * 256);
    const oy = Math.floor(hash(o.frame, 2) * 256);
    for (let x = -ox; x < W; x += 256) for (let y = -oy; y < H; y += 256) ctx.drawImage(g, x, y);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 0.05;
    ctx.fillStyle = '#000';
    for (let y = 0; y < H; y += 3) ctx.fillRect(0, y, W, 1);
    ctx.globalAlpha = 1;
    const vg = ctx.createRadialGradient(W / 2, H / 2, H * 0.35, W / 2, H / 2, H * 0.95);
    vg.addColorStop(0, 'rgba(0,0,0,0)');
    vg.addColorStop(1, 'rgba(0,0,0,0.38)');
    ctx.fillStyle = vg;
    ctx.fillRect(0, 0, W, H);
  }
  // YOLOv8 overlay.
  if (o.detections) {
    ctx.font = `700 ${Math.max(Math.round(13 * sx), 10)}px ui-monospace, "JetBrains Mono", Consolas, monospace`;
    for (const { det, box } of o.detections) {
      const c = DETECTION_COLORS[det.key];
      const x = box.x * sx;
      const y = box.y * sy;
      const w = box.w * sx;
      const h = box.h * sy;
      ctx.strokeStyle = c;
      ctx.lineWidth = Math.max(2 * sx, 1.5);
      ctx.strokeRect(x, y, w, h);
      const text = `${det.label} ${det.confidence.toFixed(2)}`;
      const tw = ctx.measureText(text).width + 10 * sx;
      const th = 18 * sy;
      const ty = y - th < 0 ? y : y - th;
      ctx.fillStyle = c;
      ctx.fillRect(x, ty, tw, th);
      ctx.fillStyle = '#0B0E11';
      ctx.fillText(text, x + 5 * sx, ty + th * 0.72);
    }
  }
  // Command Center OSD: timestamp + camera name, white with a dark outline.
  const fs = Math.max(Math.round(22 * sx), 11);
  ctx.font = `700 ${fs}px ui-monospace, "JetBrains Mono", Consolas, monospace`;
  ctx.lineWidth = Math.max(3 * sx, 2);
  ctx.strokeStyle = 'rgba(0,0,0,0.85)';
  ctx.fillStyle = '#F8FAFC';
  for (const [text, row] of [
    [o.timestamp, 1],
    [o.label, 2],
  ] as const) {
    const y = 14 * sy + row * fs * 1.2;
    ctx.strokeText(text, 16 * sx, y);
    ctx.fillText(text, 16 * sx, y);
  }
  if (o.tag) {
    ctx.font = `700 ${Math.max(Math.round(14 * sx), 10)}px ui-monospace, Consolas, monospace`;
    const tw = ctx.measureText(o.tag).width + 16 * sx;
    ctx.fillStyle = 'rgba(180,83,9,0.92)';
    ctx.fillRect(W - tw - 14 * sx, 14 * sy, tw, 22 * sy);
    ctx.fillStyle = '#FFFBEB';
    ctx.fillText(o.tag, W - tw - 6 * sx, 14 * sy + 16 * sy);
  }
  // REC indicator (drawn shape, not a glyph).
  if (src && o.frame % 30 < 20) {
    ctx.fillStyle = '#DC2626';
    ctx.beginPath();
    ctx.arc(W - 30 * sx, H - 26 * sy, 7 * sx, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}
