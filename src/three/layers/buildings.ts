import { Group, LineSegments, Mesh, Vector2, type Vector3 } from 'three';
import type { Building } from '../../types/twin';
import { Z_REF_M, type LocalFrame } from '../frame';
import { buildingGeometries, createBuildingMaterials, type Footprint, type ShadingMode } from '../materials/buildingMaterials';

export interface BuildingsLayer {
  group: Group;
  footprints: Footprint[];
  setMode(mode: ShadingMode): void;
  setVisible(on: boolean): void;
}

/**
 * 84 footprints merged into one solid geometry + one edge set, drawn with one of three
 * shading modes (Solid Concrete / Holo Wireframe / Fresnel Glass). Every 6th larger
 * footprint is a civic block with a green roof.
 */
export function buildBuildings(buildings: Building[], frame: LocalFrame, cameraPos: Vector3): BuildingsLayer {
  const footprints: Footprint[] = buildings.map((b, i) => ({
    ring: b.coordinates[0].slice(0, -1).map(([lng, lat]) => {
      const p = frame.toLocal(lng, lat);
      return new Vector2(p.x, p.y);
    }),
    baseZ: b.ground_elev_m - Z_REF_M,
    height: b.height_m,
    greenRoof: b.footprint_area_m2 > 120 && i % 6 === 2,
  }));
  const geo = buildingGeometries(footprints);
  const mats = createBuildingMaterials(cameraPos);

  const solid = new Mesh(geo.solid, mats.solid);
  solid.renderOrder = 19;
  const glass = new Mesh(geo.solid, mats.glass);
  glass.renderOrder = 20;
  const wireFill = new Mesh(geo.solid, mats.wireFill);
  wireFill.renderOrder = 20;
  const edges = new LineSegments(geo.edges, mats.edges);
  edges.renderOrder = 21;

  const group = new Group();
  group.name = 'buildings';
  group.add(solid, glass, wireFill, edges);
  group.traverse((o) => (o.frustumCulled = false));

  const layer: BuildingsLayer = {
    group,
    footprints,
    setMode(mode) {
      solid.visible = mode === 'solid';
      glass.visible = mode === 'glass';
      wireFill.visible = mode === 'wire';
      mats.setMode(mode);
    },
    setVisible(on) {
      group.visible = on;
    },
  };
  layer.setMode('glass');
  return layer;
}
