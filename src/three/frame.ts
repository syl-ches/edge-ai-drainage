import { MercatorCoordinate } from 'maplibre-gl';
import { Matrix4, Vector3 } from 'three';

/**
 * Local elevation datum. MapLibre's ground plane is altitude 0, Baguio sits at
 * ~1,420-1,475 m ASL, so every elevation is rendered as (elev_m - Z_REF_M).
 * Equivalent to MercatorCoordinate.fromLngLat(lngLat, elev_m - Z_REF_M).
 */
export const Z_REF_M = 1420.0;

/**
 * Scene frame: x = east (m), y = north (m), z = up (m above Z_REF_M), origin at the
 * lagoon anchor. One float64 scene matrix maps it into MapLibre mercator space, so
 * float32 vertex data stays small (no jitter).
 */
export class LocalFrame {
  readonly origin: MercatorCoordinate;
  readonly unitsPerMeter: number;
  readonly sceneMatrix: Matrix4;

  constructor(lng: number, lat: number) {
    this.origin = MercatorCoordinate.fromLngLat([lng, lat], 0);
    this.unitsPerMeter = this.origin.meterInMercatorCoordinateUnits();
    const s = this.unitsPerMeter;
    // Mercator y grows south: the (s, -s, s) scale mirrors the scene, so materials use DoubleSide.
    this.sceneMatrix = new Matrix4()
      .makeTranslation(this.origin.x, this.origin.y, 0)
      .scale(new Vector3(s, -s, s));
  }

  toLocal(lng: number, lat: number, elevM: number = Z_REF_M): Vector3 {
    const m = MercatorCoordinate.fromLngLat([lng, lat], 0);
    return new Vector3(
      (m.x - this.origin.x) / this.unitsPerMeter,
      -(m.y - this.origin.y) / this.unitsPerMeter,
      elevM - Z_REF_M,
    );
  }

  toLngLat(x: number, y: number): [number, number] {
    const ll = new MercatorCoordinate(
      this.origin.x + x * this.unitsPerMeter,
      this.origin.y - y * this.unitsPerMeter,
      0,
    ).toLngLat();
    return [ll.lng, ll.lat];
  }
}
