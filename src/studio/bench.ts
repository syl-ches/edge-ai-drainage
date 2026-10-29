// Ultra-HD Pitch Studio, Mode B: glass test aquarium + HC-SR04 bridge + Arduino Uno / ESP32-S3
// rig with wired jumpers and green / yellow / red LEDs, on a lab bench. Real-world metres; the
// group is placed away from the cutaway (BENCH_ORIGIN). Bench-standpipe scale: the transducer face
// sits TANK_SENSOR_M above the tank floor and 100 % fill = 74 % of that height.
import {
  AdditiveBlending,
  BoxGeometry,
  BufferAttribute,
  CatmullRomCurve3,
  Color,
  CylinderGeometry,
  DoubleSide,
  Group,
  LatheGeometry,
  Mesh,
  MeshBasicMaterial,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  PlaneGeometry,
  PointLight,
  SphereGeometry,
  Sprite,
  SpriteMaterial,
  TorusGeometry,
  TubeGeometry,
  Vector2,
  Vector3,
  type Material,
} from 'three';
import { AcousticBouncer } from './acoustic';
import { STUDIO_WATER, studioWaterTone } from './tankSim';
import { haloTexture, labelTexture, streamTexture } from './textures';
import { alarmBlink } from '../utils/fullness';

export const BENCH_ORIGIN = new Vector3(40, 0, 0);
export const TANK = { L: 0.8, H: 0.38, D: 0.4, glass: 0.012, floorY: 0.93 } as const;
export const TANK_SENSOR_M = 0.3;
export type BoardKind = 'ESP32_S3' | 'UNO';

export interface BenchState {
  fill: number;
  pouring: boolean;
  draining: boolean;
  chopMm: number;
  board: BoardKind;
  sensor: 'HC-SR04' | 'A02YYUW';
}

export interface Bench {
  group: Group;
  sensorAnchor: Vector3;
  update(t: number, dt: number, s: BenchState): { airGapMm: number; waterDepthM: number };
}

/** Water height above the tank floor for a fill % (bench standpipe scale). */
export function benchWaterHeight(fillPct: number): number {
  return Math.max(fillPct, 0) / 100 * 0.74 * TANK_SENSOR_M;
}

function box(w: number, h: number, d: number, m: Material, x: number, y: number, z: number, shadow = true) {
  const mesh = new Mesh(new BoxGeometry(w, h, d), m);
  mesh.position.set(x, y, z);
  mesh.castShadow = shadow;
  mesh.receiveShadow = true;
  return mesh;
}

export function buildBench(): Bench {
  const g = new Group();
  g.name = 'bench';
  g.position.copy(BENCH_ORIGIN);
  const F = TANK.floorY;

  // lab bench
  const top = new MeshPhysicalMaterial({ color: '#e7e5e4', roughness: 0.45, clearcoat: 0.5 });
  const steel = new MeshStandardMaterial({ color: '#94a3b8', metalness: 0.85, roughness: 0.3 });
  g.add(box(2.6, 0.05, 1.2, top, 0.35, F - 0.025, 0));
  for (const [x, z] of [
    [-0.9, -0.55],
    [1.6, -0.55],
    [-0.9, 0.55],
    [1.6, 0.55],
  ])
    g.add(box(0.05, F - 0.05, 0.05, steel, x, (F - 0.05) / 2, z));
  g.add(box(4, 0.02, 3, new MeshStandardMaterial({ color: '#111827', roughness: 0.9 }), 0.35, -0.01, 0, false));

  // glass aquarium: five thick panes + black trim
  const glass = new MeshPhysicalMaterial({ color: '#e0f2fe', transmission: 1, roughness: 0.02, thickness: TANK.glass, ior: 1.5, transparent: true, opacity: 0.35, side: DoubleSide });
  const trim = new MeshStandardMaterial({ color: '#0f172a', roughness: 0.4, metalness: 0.3 });
  const { L, H, D, glass: t } = TANK;
  g.add(box(L, t, D, glass, 0, F + t / 2, 0, false));
  g.add(box(L, H, t, glass, 0, F + H / 2, D / 2 - t / 2, false));
  g.add(box(L, H, t, glass, 0, F + H / 2, -D / 2 + t / 2, false));
  g.add(box(t, H, D, glass, -L / 2 + t / 2, F + H / 2, 0, false));
  g.add(box(t, H, D, glass, L / 2 - t / 2, F + H / 2, 0, false));
  for (const y of [F + 0.006, F + H - 0.006]) {
    g.add(box(L + 0.01, 0.014, 0.014, trim, 0, y, D / 2), box(L + 0.01, 0.014, 0.014, trim, 0, y, -D / 2));
    g.add(box(0.014, 0.014, D + 0.01, trim, -L / 2, y, 0), box(0.014, 0.014, D + 0.01, trim, L / 2, y, 0));
  }
  // laser-etched graduations on the front pane
  const etch = new MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.9 });
  const marks: [number, string, string][] = [
    [0, '0% Dry', '#ffffff'],
    [45, '45% Elevated', '#fde68a'],
    [80, '80% Critical Alarm', '#fca5a5'],
    [100, '100% Full', '#ffffff'],
  ];
  for (const [pct, text, col] of marks) {
    const y = F + t + benchWaterHeight(pct);
    g.add(box(L * 0.82, 0.0025, 0.001, etch, -0.02, y, D / 2 + 0.001, false));
    const lab = new Mesh(new PlaneGeometry(0.2, 0.04), new MeshBasicMaterial({ map: labelTexture([text], { w: 512, h: 100, fg: col }), transparent: true }));
    lab.position.set(L / 2 - 0.09, y + 0.014, D / 2 + 0.002);
    g.add(lab);
  }

  // water volume + 128 x 128 wave surface
  const waterMat = new MeshPhysicalMaterial({ color: '#06B6D4', emissive: '#06B6D4', emissiveIntensity: 0.2, transmission: 0.45, roughness: 0.05, clearcoat: 1, transparent: true, opacity: 0.82, side: DoubleSide });
  const water = new Mesh(new BoxGeometry(1, 1, 1), waterMat);
  const iL = L - 2 * t - 0.002;
  const iD = D - 2 * t - 0.002;
  const surfGeo = new PlaneGeometry(iL, iD, 128, 128);
  surfGeo.rotateX(-Math.PI / 2);
  const surfBase = Float32Array.from((surfGeo.getAttribute('position') as BufferAttribute).array);
  const surf = new Mesh(surfGeo, waterMat);
  g.add(water, surf);

  // sensor bridge + ultrasonic module (transducer face TANK_SENSOR_M above the floor)
  const faceY = F + t + TANK_SENSOR_M;
  const alu = new MeshStandardMaterial({ color: '#cbd5e1', metalness: 0.9, roughness: 0.25 });
  g.add(box(0.05, 0.02, D + 0.06, alu, 0, F + H + 0.012, 0));
  g.add(box(0.012, F + H + 0.012 - faceY, 0.012, alu, 0, (F + H + faceY) / 2 + 0.01, 0));
  const pcb = box(0.045, 0.002, 0.021, new MeshStandardMaterial({ color: '#1d4ed8', roughness: 0.5 }), 0, faceY + 0.014, 0);
  const tx = (z: number) => {
    const m = new Mesh(new CylinderGeometry(0.008, 0.008, 0.012, 32), new MeshStandardMaterial({ color: '#e2e8f0', metalness: 0.9, roughness: 0.2 }));
    m.position.set(0, faceY + 0.007, z);
    return m;
  };
  const hc = new Group();
  hc.add(pcb, tx(-0.012), tx(0.012));
  const a02 = new Group();
  const a02Body = new Mesh(new CylinderGeometry(0.016, 0.02, 0.03, 32), new MeshStandardMaterial({ color: '#111827', roughness: 0.4 }));
  a02Body.position.set(0, faceY + 0.016, 0);
  a02.add(a02Body);
  g.add(hc, a02);

  // microcontroller board on the bench (1.6x scale for legibility)
  const boardG = new Group();
  boardG.position.set(0.85, F + 0.002, 0.05);
  boardG.scale.setScalar(1.6);
  const unoMat = new MeshStandardMaterial({ color: '#00979c', roughness: 0.55 });
  const espMat = new MeshStandardMaterial({ color: '#111827', roughness: 0.5 });
  const pcbBoard = box(0.069, 0.0016, 0.053, unoMat, 0, 0.0008, 0);
  const silkUno = labelTexture(['ARDUINO UNO', 'USB NODE'], { w: 512, h: 384, fg: '#ffffff' });
  const silkEsp = labelTexture(['ESP32-S3', 'WIRELESS NODE'], { w: 512, h: 384, fg: '#34d399' });
  const silk = new Mesh(new PlaneGeometry(0.04, 0.03), new MeshBasicMaterial({ map: silkUno, transparent: true }));
  silk.rotation.x = -Math.PI / 2;
  silk.position.set(0.006, 0.0018, 0.004);
  const chip = box(0.018, 0.003, 0.012, new MeshStandardMaterial({ color: '#1f2937', roughness: 0.4 }), -0.012, 0.003, -0.012);
  const usb = box(0.012, 0.009, 0.016, new MeshStandardMaterial({ color: '#cbd5e1', metalness: 0.9, roughness: 0.3 }), -0.034, 0.005, 0.012);
  const header = box(0.05, 0.007, 0.0025, new MeshStandardMaterial({ color: '#0b0b0b' }), 0.005, 0.005, 0.024);
  const header2 = box(0.05, 0.007, 0.0025, new MeshStandardMaterial({ color: '#0b0b0b' }), 0.005, 0.005, -0.024);
  boardG.add(pcbBoard, silk, chip, usb, header, header2);
  g.add(boardG);
  // breadboard + three LEDs
  const bread = box(0.12, 0.01, 0.06, new MeshStandardMaterial({ color: '#f8fafc', roughness: 0.6 }), 0.85, F + 0.005, -0.2);
  g.add(bread);
  const halo = haloTexture();
  const leds = (['#22c55e', '#facc15', '#ef4444'] as const).map((c, i) => {
    const mat = new MeshPhysicalMaterial({ color: c, emissive: c, emissiveIntensity: 0.05, transmission: 0.3, roughness: 0.15, transparent: true, opacity: 0.95 });
    const dome = new Mesh(new SphereGeometry(0.0065, 24, 16, 0, Math.PI * 2, 0, Math.PI / 2), mat);
    const body = new Mesh(new CylinderGeometry(0.0065, 0.0065, 0.008, 24), mat);
    const x = 0.81 + i * 0.04;
    body.position.set(x, F + 0.014, -0.2);
    dome.position.set(x, F + 0.018, -0.2);
    const glow = new Sprite(new SpriteMaterial({ map: halo, color: c, transparent: true, blending: AdditiveBlending, depthWrite: false, opacity: 0 }));
    glow.position.set(x, F + 0.02, -0.2);
    glow.scale.setScalar(0.07);
    g.add(body, dome, glow);
    return { mat, glow };
  });
  const redLight = new PointLight('#ef4444', 0, 0.6, 2);
  redLight.position.set(0.89, F + 0.04, -0.2);
  g.add(redLight);
  // jumper wires (VCC red, GND black, TRIG yellow, ECHO green) board -> sensor, board -> LEDs
  const wire = (from: Vector3, to: Vector3, color: string, lift: number) => {
    const mid = from.clone().lerp(to, 0.5);
    mid.y += lift;
    const curve = new CatmullRomCurve3([from, from.clone().add(new Vector3(0, lift * 0.4, 0)), mid, to.clone().add(new Vector3(0, lift * 0.3, 0)), to]);
    const m = new Mesh(new TubeGeometry(curve, 64, 0.0018, 8, false), new MeshStandardMaterial({ color, roughness: 0.5 }));
    m.castShadow = true;
    g.add(m);
  };
  const pinBase = new Vector3(0.85 + 0.005 * 1.6, F + 0.012, 0.05 + 0.024 * 1.6);
  const sensorPin = new Vector3(0.02, faceY + 0.02, 0);
  (['#dc2626', '#111827', '#facc15', '#16a34a'] as const).forEach((c, i) => wire(pinBase.clone().add(new Vector3(-0.03 + i * 0.012, 0, 0)), sensorPin.clone().add(new Vector3(0, 0, -0.009 + i * 0.006)), c, 0.28 + i * 0.015));
  [0, 1, 2].forEach((i) => wire(new Vector3(0.85 - 0.03 + i * 0.012, F + 0.012, 0.05 - 0.024 * 1.6), new Vector3(0.81 + i * 0.04, F + 0.012, -0.18), ['#22c55e', '#facc15', '#ef4444'][i], 0.04));

  // pitcher + pour stream, drain valve + outflow
  const pitcher = new Mesh(
    new LatheGeometry([new Vector2(0.0, 0), new Vector2(0.06, 0), new Vector2(0.065, 0.02), new Vector2(0.07, 0.14), new Vector2(0.075, 0.15)], 48),
    new MeshPhysicalMaterial({ color: '#e0f2fe', transmission: 0.9, roughness: 0.05, thickness: 0.004, transparent: true, opacity: 0.5, side: DoubleSide }),
  );
  const pitcherG = new Group();
  pitcherG.add(pitcher);
  pitcherG.position.set(-0.22, F + H + 0.12, 0.02);
  g.add(pitcherG);
  const stream = streamTexture();
  const pour = new Mesh(new CylinderGeometry(0.008, 0.012, 1, 16, 1, true), new MeshPhysicalMaterial({ map: stream, color: '#7dd3fc', transparent: true, opacity: 0.75, roughness: 0.1 }));
  g.add(pour);
  const brass = new MeshStandardMaterial({ color: '#b45309', metalness: 1, roughness: 0.3 });
  const valvePipe = new Mesh(new CylinderGeometry(0.012, 0.012, 0.09, 24), brass);
  valvePipe.rotation.z = Math.PI / 2;
  valvePipe.position.set(L / 2 + 0.045, F + 0.025, 0.1);
  const handle = new Mesh(new TorusGeometry(0.02, 0.004, 10, 32), new MeshStandardMaterial({ color: '#dc2626', roughness: 0.4 }));
  handle.position.set(L / 2 + 0.05, F + 0.055, 0.1);
  const out = new Mesh(new CylinderGeometry(0.007, 0.01, F, 16, 1, true), new MeshPhysicalMaterial({ map: stream, color: '#7dd3fc', transparent: true, opacity: 0.7 }));
  out.position.set(L / 2 + 0.09, F / 2, 0.1);
  const bucket = new Mesh(new CylinderGeometry(0.12, 0.1, 0.2, 40, 1, true), new MeshStandardMaterial({ color: '#334155', side: DoubleSide, roughness: 0.6 }));
  bucket.position.set(L / 2 + 0.09, 0.1, 0.1);
  g.add(valvePipe, handle, out, bucket);

  // acoustic rings
  const ringGeo = new TorusGeometry(1, 0.0012, 8, 64);
  ringGeo.rotateX(Math.PI / 2);
  const mk = () => {
    const m = new Mesh(ringGeo, new MeshBasicMaterial({ color: '#22D3EE', transparent: true, blending: AdditiveBlending, depthWrite: false }));
    m.visible = false;
    g.add(m);
    return m;
  };
  const rings = Array.from({ length: 14 }, mk);
  const impacts = Array.from({ length: 6 }, mk);
  const bouncer = new AcousticBouncer(0.32);
  const tmp = new Color();

  return {
    group: g,
    sensorAnchor: BENCH_ORIGIN.clone().add(new Vector3(0, faceY + 0.06, 0)),
    update(time, dt, s) {
      const hw = benchWaterHeight(s.fill);
      const wy = F + t + hw;
      const tone = studioWaterTone(s.fill);
      const [a, b] = STUDIO_WATER[tone];
      tmp.set(a).lerp(new Color(b), tone === 'alarm' ? alarmBlink(time) : 0.3);
      waterMat.color.copy(tmp);
      waterMat.emissive.copy(tmp);
      water.visible = surf.visible = hw > 0.001;
      water.scale.set(iL, Math.max(hw, 0.0005), iD);
      water.position.set(0, F + t + hw / 2, 0);
      const amp = 0.0008 + (s.chopMm / 16) * 0.006;
      const arr = (surfGeo.getAttribute('position') as BufferAttribute).array as Float32Array;
      for (let i = 0; i < arr.length; i += 3) {
        const x = surfBase[i];
        const z = surfBase[i + 2];
        const d = Math.hypot(x + 0.2, z) * 60;
        arr[i + 1] =
          wy +
          amp * Math.sin(x * 40 - time * 4) +
          amp * 0.6 * Math.sin(z * 55 + x * 20 + time * 5.5) +
          (s.pouring ? amp * 1.4 * Math.sin(d - time * 14) * Math.exp(-d / 30) : 0);
      }
      surfGeo.getAttribute('position').needsUpdate = true;
      surfGeo.computeVertexNormals();
      // sensor model swap
      hc.visible = s.sensor === 'HC-SR04';
      a02.visible = !hc.visible;
      // board label swap
      const espBoard = s.board === 'ESP32_S3';
      pcbBoard.material = espBoard ? espMat : unoMat;
      (silk.material as MeshBasicMaterial).map = espBoard ? silkEsp : silkUno;
      // LEDs: green < 45, yellow 45-79, red >= 80 blinking at 3 Hz with halo + light
      const blinkOn = Math.sin(time * 2 * Math.PI * 3) > 0;
      const on = [s.fill < 45, s.fill >= 45 && s.fill < 80, s.fill >= 80 && blinkOn];
      leds.forEach((l, i) => {
        l.mat.emissiveIntensity = on[i] ? 3.2 : 0.05;
        (l.glow.material as SpriteMaterial).opacity = on[i] ? 0.95 : 0;
      });
      redLight.intensity = on[2] ? 0.35 : 0;
      // pour + drain animation
      pitcherG.rotation.z = s.pouring ? -1.0 : -0.15;
      pour.visible = s.pouring;
      const lip = new Vector3(-0.15, F + H + 0.2, 0.02);
      pour.scale.y = Math.max(lip.y - wy, 0.01);
      pour.position.set(-0.15, (lip.y + wy) / 2, 0.02);
      stream.offset.y = (-time * 2.2) % 1;
      handle.rotation.y = s.draining ? Math.PI / 2 : 0;
      out.visible = s.draining && hw > 0.002;
      // acoustic bounce inside the tank
      bouncer.update(dt, faceY, wy);
      rings.forEach((m, i) => {
        const r = bouncer.rings[i];
        m.visible = !!r;
        if (!r) return;
        m.position.set(0, r.y, 0);
        m.scale.setScalar(Math.min(0.006 + r.travelled * 0.12, 0.06));
        const mat = m.material as MeshBasicMaterial;
        mat.color.set(r.dir === 'down' ? '#22D3EE' : '#FACC15');
        mat.opacity = Math.max(0.95 - r.travelled * 2, 0.35);
      });
      impacts.forEach((m, i) => {
        const im = bouncer.impacts[i];
        m.visible = !!im;
        if (!im) return;
        m.position.set(0, im.y + 0.001, 0);
        m.scale.setScalar(0.01 + im.age * 0.12);
        (m.material as MeshBasicMaterial).color.set('#34D399');
        (m.material as MeshBasicMaterial).opacity = Math.max(1 - im.age / 0.6, 0);
      });
      return { airGapMm: Math.max(faceY - wy, 0) * 1000, waterDepthM: hw };
    },
  };
}
