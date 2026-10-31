// A lit material for ordinary meshes inside the MapLibre custom layer.
//
// Three's lit materials break under the mirrored mercator projection (CLAUDE.md §11), so this
// ShaderMaterial evaluates the shared studio hemisphere + sun in GLSL, like the building
// shaders. It mimics the bits of MeshStandardMaterial the procedural models use: `color`
// (a THREE.Color, settable at runtime), `opacity`, instancing and per-instance colours. In
// X-ray the albedo fades to a dark slate (`xray`) so surface models never outshine the drainage.
import { Color, DoubleSide, ShaderMaterial, type ColorRepresentation } from 'three';
import { LIGHT_UNIFORMS, STUDIO_LIGHT_GLSL, THEME_UNIFORMS } from '../theme';

const vertex = /* glsl */ `
varying vec3 vNormal;
varying vec3 vTint;
void main() {
  vec4 p = vec4(position, 1.0);
  vec3 n = normal;
  #ifdef USE_INSTANCING
    p = instanceMatrix * p;
    n = mat3(instanceMatrix) * n;
  #endif
  vTint = vec3(1.0);
  #ifdef USE_INSTANCING_COLOR
    vTint = instanceColor;
  #endif
  vNormal = normalize(mat3(modelMatrix) * n);
  gl_Position = projectionMatrix * modelViewMatrix * p;
}`;

const fragment = /* glsl */ `
uniform float uDay;
uniform vec3 uColor;
uniform vec3 uXray;
uniform float uOpacity;
uniform float uEmissive;
varying vec3 vNormal;
varying vec3 vTint;
${STUDIO_LIGHT_GLSL}
void main() {
  vec3 albedo = mix(uXray, uColor * vTint, uDay);
  vec3 lit = studioLight(albedo, vNormal);
  vec3 col = mix(lit, albedo, uEmissive);
  gl_FragColor = vec4(min(col, vec3(1.0)), uOpacity);
}`;

export interface StudioMaterialOptions {
  color: ColorRepresentation;
  /** X-ray albedo (default slate) */
  xray?: ColorRepresentation;
  opacity?: number;
  /** 0 = fully lit, 1 = unlit flat colour (water jets, glowing bands) */
  emissive?: number;
  depthWrite?: boolean;
}

export class StudioMaterial extends ShaderMaterial {
  constructor(o: StudioMaterialOptions) {
    const opacity = o.opacity ?? 1;
    super({
      vertexShader: vertex,
      fragmentShader: fragment,
      uniforms: {
        uDay: THEME_UNIFORMS.uDay,
        uColor: { value: new Color(o.color) },
        uXray: { value: new Color(o.xray ?? '#1E293B') },
        uOpacity: { value: opacity },
        uEmissive: { value: o.emissive ?? 0 },
        ...LIGHT_UNIFORMS,
      },
      transparent: opacity < 1,
      depthWrite: o.depthWrite ?? opacity >= 1,
      side: DoubleSide,
    });
  }

  /** Albedo, mutable like MeshStandardMaterial.color. */
  get color(): Color {
    return this.uniforms.uColor.value as Color;
  }

  setOpacity(v: number): void {
    this.uniforms.uOpacity.value = v;
  }
}
