# CLAUDE.md — Edge-AI Stormwater Digital Twin, City Camp Lagoon Catchment (Baguio City)

The single source of truth for architecture, geometry, CRS, physics and the telemetry
contract. If code and this file disagree, either fix the code or update this file in
the same change. Never let them drift.

## 1. Project & phase status

**Edge-AI Stormwater Capacity Detection & 3D Subsurface Digital Twin** for the City Camp
Lagoon endorheic karst catchment (`16.4093° N, 120.5863° E`, ~1,430 m ASL).

| Phase | Scope | Status |
|---|---|---|
| 1 | Procedural 3D GIS topology + pre-computed hydraulic LUT (`scripts/`, `public/data/`) | **Done** |
| 2 | 60 FPS "X-Ray" WebGL engine: MapLibre + Three.js custom layer (`src/three/`) | **Done** |
| 3 | HUD, bilinear LUT scrubbing, GPU rain, deep-link URL + QR, PWA (`src/components/`, `src/utils/`) | **Done** |
| 4 | FastAPI live backend: virtual Edge-AI fleet, fusion, nowcast, WS stream, ingest (`backend/`) | **Done** |
| 5 | XIAO ESP32-S3 firmware + C++ core, serial bridge, bench standpipe guide (`firmware/`, `docs/`) | **Done** |
| 6 | Visual overhaul: daylight diorama theme, shading modes, dual-shell pipes, node gauges, Cross-Section Simulator, Subsurface Utility Inspector (§16) | **Done** |

**All Phase 1 geometry is synthetic**, laid out by hand around the real lagoon centroid
(`source_type: SYNTHETIC_OSMNX`). Road alignments, catchment areas, inverts and the tunnel
alignment are plausible stand-ins, not surveyed data. Don't present them as as-built.

## 2. Non-negotiable rules

1. **Determinism.** The generator must produce byte-identical output on every run (seeded
   RNG `20240917`, no timestamps, no network by default). Any change to outputs is a
   deliberate, reviewable diff of `public/data/*.json`.
2. **Offline first.** Nothing in Phase 1 may need an API key or network access. `osmnx` is
   opt-in (`--osmnx`) and must fall back silently to built-in data.
3. **Compute in meters, export in degrees.** All geometry, lengths, slopes and areas are
   computed in `EPSG:32651`. Only the export step converts to `EPSG:4326`.
4. **No vertical exaggeration.** Elevations are true meters ASL (`exaggeration = 1.0`) so
   pipe inverts line up with manhole rims.
5. **Hybrid geometry is mandatory.** Never render generic cylinders for everything. Draw
   `RECT_CLOSED` box culverts, `CIRCULAR` pipes and `ARCH` rock chokes as their real shapes.
6. **Provenance on every feature.** Every node, link, building, sensor and the lagoon carries
   `source_type` ∈ {`SYNTHETIC_OSMNX`, `LGU_FIELD_VERIFIED`, `DPWH_AS_BUILT_CAD`} and
   `is_active`. Hot-swap rule: to replace a synthetic feature, insert the official record and
   set the synthetic one's `is_active: false`. Don't delete it. Consumers filter on `is_active`.
7. **One telemetry contract.** Firmware, backend decoder and generator all implement §8
   bit-for-bit. Change it only with a version bump in all three.
8. **Physics in one place.** Hydraulic equations live in the generator and in
   `backend/edge_dsp.py`, which `firmware/.../edge_core.hpp` mirrors. The frontend only reads
   and interpolates the LUT, apart from the structure-preserving outflow reconstruction defined
   in §9 (`min(Q_rack, Q_choke)` plus the Kirschmer formula). It never solves hydraulics.

## 3. Repository layout

```
edge-ai-drainage/
├── CLAUDE.md                          # this file
├── requirements.txt                   # Python deps (generator needs only numpy)
├── package.json, vite.config.ts       # Vite 6 + React 19 + TS 5.7 + Tailwind 4 frontend (repo root)
├── index.html
├── scripts/
│   └── generate_citycamp_twin_data.py # Phase 1 deterministic generator (self-checking)
├── public/data/                       # generated, committed, served statically at /data/
│   ├── city_camp_network.json         # topology, lagoon, buildings, sensors
│   └── simulation_lut.json            # 48 grid scenarios + 2 reference scenarios
├── src/
│   ├── types/twin.ts                  # TS mirror of both JSON schemas (keep in step with §6/§9)
│   ├── data/loadTwin.ts               # fetch + is_active filter, findScenario(), presets
│   ├── map/basemap.ts                 # zero-key OpenFreeMap style in two themes + procedural grid
│   ├── three/
│   │   ├── frame.ts                   # LocalFrame + Z_REF_M datum (1420 m)
│   │   ├── TwinEngine.ts              # CustomLayerInterface, render loop, picking, theme/layers/shading
│   │   ├── theme.ts                   # Theme type, lighting rig, shared uDay/light uniforms, palettes
│   │   ├── palette.ts                 # per-theme capacity bands, anomaly colours, rack colour
│   │   ├── vegetationLayer.ts         # instanced trees (one draw call)
│   │   ├── materials/buildingMaterials.ts  # solid / wire / Fresnel-glass building shader factory
│   │   ├── shaders/                   # ramp (capacity GLSL), conduit (core + glass shell), water, shaft
│   │   └── layers/                    # terrain, roads, buildings, conduits, lagoon, rack, nodes, sensors (gauges), weather
│   ├── utils/                         # lutInterpolator, payloadCodec, fusion, urlState, fullness
│   ├── live/telemetry.ts              # LIVE mode: WS /ws/live client + local storm playback fallback
│   ├── types/live.ts                  # TwinFrame contract (mirrors backend/schemas.py)
│   └── components/                    # MapView, TwinControlHUD, TopBar, ShaderModeBar, SensorBadges,
│                                      # AssetInspectorDrawer, CrossSectionSimulator (+ crossSection/draw.ts),
│                                      # SubsurfaceInspector, Legend, QrShareModal, ...
├── public/manifest.webmanifest, sw.js, icons/   # PWA (installable, offline-capable)
├── backend/                           # Phase 4 FastAPI app
│   ├── main.py                        # REST + WS /ws/live + /api/v1/ingest/lorawan
│   ├── twin.py                        # closed-loop runtime: virtual fleet, hardware drive, frames
│   ├── edge_dsp.py                    # REFERENCE edge pipeline (firmware must match bit-for-bit)
│   ├── intelligence.py                # fusion arbitrator, FEWS fusion, graph nowcaster
│   └── lut.py, schemas.py             # numpy LUT interpolator; pydantic contracts
├── firmware/citycamp_edge_node/       # Phase 5 PlatformIO project (XIAO ESP32-S3 + Wio-SX1262)
│   ├── include/edge_core.hpp          # header-only, zero-heap C++17 port of edge_dsp.py
│   ├── include/node_profiles.hpp      # GENERATED by scripts/gen_firmware_profiles.py
│   ├── src/main.cpp                   # Arduino firmware: sensing, FSM deep sleep, LoRaWAN/Wi-Fi/USB
│   └── test/                          # native harness + Arduino/RadioLib API stubs
├── scripts/
│   ├── serial_bridge.py               # USB serial -> FastAPI bridge (+ --virtual-standpipe)
│   ├── test_phase4_backend.py         # backend suite (22 tests)
│   ├── test_phase5_firmware.py        # native C++ build + C++/Python differential suite
│   └── gen_firmware_profiles.py
├── tests/frontend/                    # vitest: interpolator + codec parity, URL state, node fullness
└── docs/HARDWARE_BENCH_DEMO_GUIDE.md  # BOM, wiring, PVC standpipe rig, demo checklist
```

## 4. Commands

```bash
npm start            # one command: installs npm + .venv deps on first run, runs backend :8000 + frontend :5173
npm run setup        # install only; also start:frontend (no Python), start:prod (build + preview :4173)
start.bat / start.sh # double-click wrappers for npm start (scripts/start.mjs)

pip install -r requirements.txt
python scripts/generate_citycamp_twin_data.py            # writes public/data/*.json + summary
python scripts/generate_citycamp_twin_data.py --osmnx    # optional OSM building footprints
python scripts/generate_citycamp_twin_data.py --out-dir /tmp/x --quiet

npm install          # Node >= 20
npm run dev          # http://localhost:5173 (also on the LAN for QR sharing)
npm run build        # tsc -b (strict) + vite build: must stay at zero errors
npm run typecheck    # tsc -b --noEmit
npm test             # vitest: LUT interpolator + payload codec parity, URL state, fullness
npm run generate:data

python -m venv .venv && .venv/Scripts/pip install -r requirements.txt   # (bin/ on Linux/macOS)
.venv/Scripts/python -m uvicorn backend.main:app --host 0.0.0.0 --port 8000
.venv/Scripts/python scripts/test_phase4_backend.py
.venv/Scripts/python scripts/test_phase5_firmware.py [--cxx "zig c++"]   # needs g++/clang++/zig, else PARTIAL
.venv/Scripts/python scripts/serial_bridge.py --virtual-standpipe        # no hardware needed
.venv/Scripts/python scripts/gen_firmware_profiles.py                    # after any network regeneration
```

Debug handle: `window.__cityCampTwin = { map, engine }` (e.g. `engine.pick(x, y)`,
`engine.flyTo('choke')`). It is used by automated screenshot checks.

The generator runs built-in self-checks before writing and aborts on failure. The checks
cover: circular `Q_max` at `h/D = 0.938`, UTM/PTM round-trips, Helmert inverse < 5 mm, lagoon
area = 30,000 m² ± 0.1 %, 2,000-sample payload pack/unpack round-trip, building count 60–100,
no adverse slopes, and tunnel crown below ground.

## 5. Coordinate reference systems

| Role | CRS | Notes |
|---|---|---|
| Metric computation | `EPSG:32651` WGS84 / UTM 51N | Local x/y = UTM offsets from lagoon centroid (`ORIGIN_E/N`) |
| Cadastral / DPWH CAD | `EPSG:3123` PRS92 / Philippines zone III | TM, CM 121°E, k₀ 0.99995, FE 500 000, Clarke 1866 |
| WebGL export | `EPSG:4326` | `[lon, lat, elevation_m_ASL]`, 7 decimals (~1 cm) |

**PRS92 ⇄ WGS84 Helmert, read carefully.** The generator stores the EPSG:4683 / PROJ
`+towgs84` set (**Position-Vector** convention, PRS92 → WGS84):

```
tx=-127.62153 ty=-67.24339 tz=-47.04738 m   rx=+3.06803 ry=-4.90297 rz=-1.57807 "   ds=-1.06002 ppm
```

The project brief listed `+127.62153, +67.24339, +47.04738, -3.06803", +4.90297", +1.57807", +1.06002 ppm`.
That is the exact sign-negation of every term, which is the **WGS84 → PRS92** direction
(first-order inverse). The generator applies it with `helmert_position_vector(..., inverse=True)`.
Never mix conventions: Coordinate-Frame (EPSG method 9607) flips the rotation signs only.
Verify against a NAMRIA control point before ingesting DPWH CAD.

Every node exports `utm51n_en` and `ptm3_en` alongside lon/lat, so CAD overlays can be
checked directly. Elevations are orthometric (ASL). The Helmert step treats them as
ellipsoidal heights, which causes negligible horizontal error (< 1 mm).

## 6. Data model (`public/data/city_camp_network.json`)

Top-level keys: `meta`, `nodes`, `conduits`, `orifices`, `lagoon`, `buildings`, `sensors`.

**Z conventions:** node `coordinates[2]` = **rim/ground** (manhole lid); conduit
`coordinates[*][2]` = **invert** (`coordinates_ref: "INVERT"`); storage `coordinates[2]` = rim,
see `invert_elev_m`. To place a conduit mesh, offset by `rise_m / 2` from the invert line to get its centroid.

- **Nodes:** `type` ∈ `JUNCTION | STORAGE | OUTFALL`; `network` ∈ `ARTERIAL | FEEDER |
  LATERAL | TUNNEL | STORAGE`; `rim_elev_m`, `invert_elev_m`, `max_depth_m`,
  `catchment_area_ha`, `runoff_coeff`.
- **Conduits:** `link_type: CONDUIT`, `shape`, `geometry{rise_m, span_m, diameter_m, haunch_m,
  area_full_m2}`, inlet/outlet inverts and offsets (drop manholes have `outlet_offset_m > 0`),
  `slope`, `slope_eff_sin`, `manning_n`, `q_full_cms`, `q_max_cms`, `y_at_qmax_ratio`,
  `tc_min`. Tunnel links also carry `segment_class` and `spec_reference`.
- **Orifices:** the trash rack is a **link** (`link_type: ORIFICE`), not a node. It runs
  `CITY_CAMP_LAGOON_STORAGE → TUN-J00` (intake drop shaft).
- **Lagoon:** 96-vertex bowl polygon (exactly 3.0 ha), stage–storage table.
- **Buildings:** GeoJSON-style `coordinates: [ring]`, `height_m`, `levels`, `ground_elev_m`
  (lowest corner, so boxes never float on slopes), `barangay`.
- **Sensors:** `sensor_id`, `device_eui` (locally-administered `02BA6C10xxxxxxxx`), `hardware`,
  `role`, `attached_kind/attached_to`, `mount_node`, `pipe_geometry`, radio/vision block.

ID scheme: `{CORRIDOR}-J{nn}` nodes, `{CORRIDOR}-C{nn}` conduits (numbered downstream).
Corridors: `LGD` Legarda, `DHR` Dominican Hill, `KSD` Kisad, `QOP` Queen of Peace (arterial
RCBC); `GSF` Guisad Surong, `LEF` Lourdes Ext., `CCP` City Camp Proper, `CCC` City Camp
Central, `URQ` Upper Rock Quarry, `MRQ` Middle Rock Quarry (feeder RCPC); `LRQ` Lower Rock
Quarry lateral; `TUN` main tunnel.

## 7. Drainage geometry (DPWH BCDEO basis)

| Element | Shape | Size | n | Notes |
|---|---|---|---|---|
| Arterial collectors (Legarda, Dominican Hill, Kisad, Queen of Peace) | `RECT_CLOSED` | 3.0×1.8 m → 3.5×2.0 m | 0.013 | Precast RCBC, 229/305 mm corner haunches, 1.0 m cover |
| Residential feeders | `CIRCULAR` | D 0.6 / 0.9 / 1.2 m | 0.013 | RCPC, 1.2 m cover |
| Lagoon | `STORAGE` | 3 ha, invert 1426.5, max depth 6.5 m | — | Frustum (1.2 ha floor), 1.5 m permanent pool |
| Trash rack | `ORIFICE` link | 3.0×2.0 m, sill 1428.0 | C_d 0.60 | 12 mm bars @ 50 mm clear, 75°, β 2.42 |
| Tunnel, concreted | `RECT_CLOSED` | 2.5 W × 2.7 H | 0.013 | 21 MPa PCC, 1.3 % grade (0.5 % transition apron) |
| Tunnel, unfinished choke | `ARCH` | 1.5 W × 1.7 H | 0.030 | Vertical walls + semicircular crown, 1.0 % grade |

Tunnel (2,400 m, intake invert 1418.0 → Crystal Cave outfall ≈1388.5):
`C220 · T80 · A160 · C300 · A120 · C250 · A90 · C260 ‖ LRQ joins ‖ C320 · C350 · C250`.
Lower Rock Quarry (~1,420 m) lies **below the lagoon invert**, so it drains into the
tunnel at `TUN-J08` through a drop structure, not into the bowl.

## 8. Hydraulic model (generator, and later the shared backend module)

- **Peak inflow:** rational method `Q = C·i·A/360` (i mm/h, A ha → m³/s), plus
  0.0005 m³/s/ha baseflow. `t_c` = 5 min inlet time + Kirpich along the longest upstream path.
- **Manning on steep slopes:** `Q = (1/n)·A·R^(2/3)·√S` with **`S = sin(atan(S₀))`**.
- **Sections** are tabulated exactly (4,001 depth samples). The maximum of conveyance below
  the crown gives the **closed-conduit paradox**: circular `Q_max = 1.076·Q_full` at
  `h/D = 0.938`. RCBC soffit contact ramps in over the last 2 % of rise. If `Q > Q_max` there
  is no free-surface solution and the conduit is **self-surcharged** (pressurized).
- **Froude:** `Fr = V / √(g·A/T)`. It is `null` when pressurized (no free surface).
- **Backwater HGL pass**, upstream from boundaries: lagoon WSE for bowl tributaries, normal
  depth at the free Crystal Cave outfall. Outlet depth = max(normal depth, downstream HGL −
  outlet invert). `HGL_in = max(inv_in + y_n, HGL_out + S_f·L)`. ARCH inlets add `0.5·V²/2g`
  contraction loss. Node HGL is capped at the rim (`is_flooding: true` when exceeded).
  `hydraulic_jump` is set where supercritical normal flow meets subcritical backwater.
- **Trash rack:** below the soffit it acts as a weir, above it as an orifice
  (`Q = C_d·A_eff·√(2gH)`), blended over 0.2·H. Here `A_eff = A_gross·φ·(1−p)` and
  `φ = b/(b+s) = 0.806`. Kirschmer loss `ΔH = ξ(p)·V²/2g`, with
  `ξ(p) = β(s/b)^(4/3)·sinθ / (1−p)²` (ξ_clean = 0.349). The `(1−p)⁻²` growth (16× at
  p = 0.75, 400× at 0.95) follows from bar velocity scaling with the open area. Q is solved
  by bisection.
- **Lagoon:** explicit mass balance (dt 30 s). Inflow = tributaries ramped over `t_c` +
  direct rain + baseflow. Outflow = `min(Q_rack, Q_tunnel)` − 0.01 m³/s seepage − rim spill
  weir (60 m, C_w 1.70). The tunnel accepts at most the free-surface `Q_max` of its tightest
  choke (**4.44 m³/s**). This is conservative: pressurized tunnel flow is not modelled.
- **Status:** `SURCHARGED` (pressurized / HGL ≥ crown) › `CRITICAL` (ratio ≥ 0.85) ›
  `ELEVATED` (≥ 0.50) › `NORMAL`.
  `capacity_ratio = min(1.27, max(Q/Q_full, y/rise, 1 + surcharge_head/rise if pressurized))`.

**Key behavior the twin must show:** with this geometry the unfinished rock choke, not
the rack, governs outflow until blockage reaches ~90 %. Under 25 mm/h with a clean rack,
the lagoon still ponds to ~2.9 m against the choke.

## 9. Simulation LUT (`public/data/simulation_lut.json`)

- Axes: `rainfall_mm_hr = [0,25,50,75,100,150,200,250]`,
  `trash_rack_blockage_pct = [0,25,50,75,90,95]`. Key format `R{rain}_B{blockage}`, and
  `index[key]` gives the position in `scenarios`.
- Each scenario holds the state at the end of a **180-min constant-intensity burst**:
  `lagoon{…}`, `status_counts`, `conduits{id: flow_cms, water_depth_m, velocity_ms,
  froude_number, capacity_ratio, status, flow_regime, hydraulic_jump, depth_control}`,
  `nodes{id: hgl_m, is_flooding}`, `sensors{id: telemetry}`.
- `estimated_time_to_overflow_min` assumes the rain **continues**, with a 12 h horizon
  (`null` = no overflow).
- `depth_series_m` holds lagoon depth every 10 min from 0 to 180 min. Use it for animation.
- `reference_scenarios` holds off-grid cases (`R25_B0`, `R200_B85`) for validation.
- **Interpolation rules** (`src/utils/lutInterpolator.ts` and `backend/lut.py`, which must match):
  - Interpolate numeric fields bilinearly. Interpolate flags (pressurized, flooding, jump) as
    corner weights and threshold them at 0.5. Re-derive `status` with the generator's rule:
    pressurized ≥ 0.5 → `SURCHARGED`, then 0.85 / 0.50 on `capacity_ratio`.
  - `froude_number` uses only non-null corners, and is null when < 50 % of the weight is
    non-null.
  - **Outflow keeps its physical structure:** `Q_out = min(Q_rack, 4.437)`, with `Q_rack`
    interpolated as `Q_rack/(1−p)`. The Kirschmer ΔH is rebuilt as `ξ_clean(1−p)⁻²·V²/2g`
    from that Q and the interpolated stage. The tunnel reach fed purely by `Q_out` (TUN-C01…C07)
    reads its state off per-conduit flow-indexed curves. The choke↔rack hand-over between grid
    columns is therefore not smeared. The off-grid R200_B85 error is 0.025 capacity (it was
    0.17 with naïve bilinear).
  - Time-to-overflow interpolates the **rate** 1/t (null → 0).
  - **Never interpolate payloads.** Re-pack them with the §10 codec. Anomaly classes are
    re-derived with the §10 rules.
  - Grid cells reproduce exactly. `npm test` checks every cell's values, status, anomaly and
    payload hex.
- **Publish-then-derive:** each LUT sensor record is classified and packed from the *rounded*
  values it publishes, so re-deriving from the JSON gives identical bits.

## 10. Edge node & telemetry contract (v1)

Hardware: Seeed XIAO ESP32-S3 (ESP-NN SIMD), DFRobot A02YYUW ultrasonic (UART 9600, 30 mm
blind zone), DS18B20, Wio-SX1262 on LoRaWAN **AS923-3 (915–918 MHz)**. BOM ₱3,364. The rack
vision node is a Jetson running YOLOv8 and outputs the blockage ratio `p ∈ [0, 0.95]`.

On-device pipeline: thermal compensation `d = d_raw·(331.3 + 0.606·T)/343.2` → 5-point
median (`d_med`, `σ_d²`) → adaptive Kalman `R = R_base + α·σ_d²` (state `h`, `dh/dt`) →
steep-slope Manning + Froude → INT8 1D-conv autoencoder/classifier.

**Uplink: one `uint32`, big-endian (MSB first on air):**

| Bits | Field | Type | Scale | Range |
|---|---|---|---|---|
| 31:22 | `depth_code` | u10 | 5 mm/LSB | 0–5115 mm |
| 21:14 | `dh_dt_code` | s8 (two's complement) | 1 mm/min | −128…+127 |
| 13:7 | `cap_code` | u7 | 1 % | 0–127 % |
| 6:4 | `anom_code` | u3 | enum | 0–7 |
| 3:0 | `vbat_code` | u4 | 3.00 V + 0.08 V/LSB | 3.00–4.20 V |

`anom_code`: 0 NORMAL, 1 FLASH_SURGE, 2 TRASH_BLOCKAGE, 3 SUPERCRITICAL, 4 SURCHARGED,
5 SENSOR_FAULT, 6 LOW_BATTERY, 7 reserved.

Rules:
- Encoders **saturate** (clamp) every field. They never wrap. Rounding is **round-half-up**
  (`floorf(x + 0.5f)` in C), and firmware must match it.
- Reference vectors: `pack(5115, -1, 127, 7, 4.20) = 0xFFFFFFFF`;
  `pack(0, -128, 0, 0, 3.00) = 0x00200000`.
- **Known saturation:** lagoon depth exceeds 5,115 mm above ~5.1 m (rim is 6.5 m). Fast
  surges can exceed 127 mm/min. The LUT lists these per record in `saturated_fields`.
- **Jetson exception:** for `JETSON_YOLO_TRASHRACK`, `cap_code` carries the **visual blockage
  %** (0–95), not pipe capacity. Decoders must branch on the device's `hardware`.
- Classifier decision surface, mirrored in the generator in this priority order:
  `SURCHARGED` (pressurized or h/D ≥ 1)
  › `TRASH_BLOCKAGE` (h/D > 0.60, |dh/dt| < 15 mm/min, turbulence < 0.25)
  › `FLASH_SURGE` (dh/dt ≥ 15, turbulence ≥ 0.45)
  › `SUPERCRITICAL` (Fr > 1, h/D ≥ 0.05)
  › `NORMAL`.
  `TRASH_BLOCKAGE` really means a **stagnant-backwater signature**. A tunnel-choke backwater
  (e.g. EN-10 at `R25_B0`) looks identical to an ultrasonic sensor. The backend must fuse
  EN-08/EN-10 with the EN-09 vision `p` before alerting "blocked rack".
- **Edge classifier (firmware + virtual fleet)** uses the same priority order on INT8-quantised
  features: `q_h = h/D×100`, `q_v = dh/dt`, `q_s = ln(1+σ_d²)×16`, `q_e = He×16`. Its surface
  feature is the **acoustic** variance, not the LUT's hydraulic turbulence index. Ponding is
  `q_h > 60 ∧ |q_v| < 15 ∧ q_s < 58` (σ ≲ 6 mm). Surge is `q_v ≥ 15 ∧ q_s ≥ 74` (σ ≳ 10 mm).
  Priority: `SENSOR_FAULT > SURCHARGED > TRASH_BLOCKAGE > FLASH_SURGE > SUPERCRITICAL >
  LOW_BATTERY > NORMAL`. A low battery never masks a hydraulic alarm.
- Kalman: constant-velocity model, `KF_Q = 9 mm²/min³`, `R = 25 + 0.5·σ_d²`. This gives
  dh/dt noise σ ≈ 1.8 mm/min and flags a 40 mm/min surge in ≈ 1.7 min. The 16 KB INT8
  tensor arena in the firmware is reserved for the future trained 1D-conv autoencoder.
- `dh_dt_mm_min` in the LUT is a rising-limb signature. For locally governed depth it is
  `(y − y_dry)/t_c`. For backwater it is the boundary's rate. For lagoon-fed tunnel flow it
  is `dy/dQ · dQ_out/dt`.

Sensor roster: EN-01 GSF-C02 and EN-02 URQ-C02 (hillside), EN-03 LGD-C07, EN-04 DHR-C04,
EN-05 KSD-C03 and EN-06 QOP-C06 (RCBC), EN-07 lagoon stage, EN-08 rack ultrasonic, EN-09 rack
vision (Jetson), EN-10 TUN-C02 (choke transition).

## 11. WebGL engine rules (Phase 2, restyled in Phase 6)

- **Stack:** MapLibre GL JS 6 (named exports; its tile worker ships as a `?url` asset via
  `setWorkerUrl`) plus **one** Three.js scene in one `CustomLayerInterface`
  (`renderingMode: '3d'`). It shares MapLibre's WebGL2 context, with `autoClear = false` and
  `resetState()` every frame. The projection is
  `defaultProjectionData.mainMatrix × LocalFrame.sceneMatrix` (float64 on the CPU), and
  every object keeps an identity world matrix.
- **Datum:** the scene works in metres, with x east, y north and z = `elev_m − Z_REF_M`
  (`Z_REF_M = 1420`) from the lagoon anchor. This equals
  `MercatorCoordinate.fromLngLat(lngLat, elev − 1420)`. Underground features sit below
  MapLibre's ground plane, which the 2D basemap never occludes. Vertical scale is **1.0**.
- **Handedness and colour:** the mercator mapping mirrors y, so custom materials are
  `DoubleSide`. Three.js colour management is off: hex in = hex out, for both GLSL and basic
  materials.
- **Conduits:** `RECT_CLOSED` (chamfered haunches) and `ARCH` use `THREE.ExtrudeGeometry` of
  the true cross-section, baked into **one merged mesh** plus one edge-line set. `CIRCULAR`
  uses **one `InstancedMesh`**. Per-conduit state lives in a float `DataTexture`
  (r = capacity_ratio, g = velocity, b = depth/rise, a = status). Scenario switches never
  rebuild geometry. The "2.5× visibility" toggle scales cross-sections about the conduit axis
  in the vertex shader (`uPipeScale`).
- **Dual-shell conduits:** each conduit draws twice from the same geometry. The opaque
  **water core** (inset 0.9, `renderOrder` 10) discards fragments above `depth/rise` plus a
  small wave, so its height shows the water level. The transparent **Fresnel glass shell**
  (`renderOrder` 13, no depth write, alpha clamped 0.06–0.62) shows the structure. Edges are
  drawn at 14. Circular pipes use two `InstancedMesh`es (core and shell) on one cylinder.
- **Capacity ramp** (by `capacity_ratio`, `palette.ts` ≡ `shaders/ramp.ts`), per theme:
  - **Daylight:** 0–0.45 `#10B981`→`#06B6D4`, 0.45–0.75 `#84CC16`→`#F59E0B`, 0.75–0.94
    `#F97316`, above that a pulsing `#EF4444`.
  - **X-ray:** ≤0.40 `#12B5CB`, ≤0.75 `#FCC934`, ≤0.94 `#FA903E`, above that a pulsing
    `#F538A0`.
  - Both: `SURCHARGED` always pulses. Chevrons point downstream and scroll at
    ∝ `velocity_ms`.
- **Lighting:** the mirrored mercator handedness breaks Three's lit materials, so studio
  light is computed in GLSL (`STUDIO_LIGHT_GLSL`). It uses a hemisphere light (sky `#FFFFFF`,
  ground `#D8E8D4`, 1.15) and a sun (`#FFFBEB`, 1.35). The `HemisphereLight`/`DirectionalLight`
  objects in the scene only carry these values; every custom material reads the shared
  `LIGHT_UNIFORMS`.
- **Buildings** (`materials/buildingMaterials.ts`, shared with the Utility Inspector) have
  three shading modes, switched by `TwinEngine.setShadingMode`:
  - **Solid Concrete:** studio-lit white walls with storey window strips. Every 6th large
    roof is a green roof.
  - **Holo Wireframe:** edges only, emerald→slate by height, over a 4 % fill.
  - **Fresnel Glass** (default): core `(0.96,0.99,0.97)`, rim `(0.06,0.72,0.50)`, base opacity
    0.14, rim power 2.6, alpha clamped 0.10–0.58. X-ray uses a navy/sky variant.

  Translucent modes are `transparent` with **`depthWrite: false`** and draw after conduits
  (`renderOrder` 20–21). The Fresnel eye position is `inverse(MVP)·(0,0,1,0)`.
- **Terrain, roads, vegetation:**
  - The DEM surface carries a park mask (`aGreen`): the lagoon belt, wooded slopes over 13–22 %
    grade, and 14 pocket parks. Roads and buildings are cleared out of the mask.
  - `layers/roads.ts` drapes arterial (4.5 m half-width plus casing) and feeder strips on it.
  - `vegetationLayer.ts` places 560 trees (minimum spacing 5.5 m, deterministic hash) in one
    `InstancedMesh`, swaying with rainfall.
- **Drop structures** are tunnel nodes fed from the surface: the rack intake shaft, and tunnel
  junctions receiving a non-tunnel conduit with `outlet_offset_m > 1` (LRQ → `TUN-J08`).
  Surface feeder → box offsets are ordinary manholes.
- **Picking is screen-space:** conduit axes, shaft segments, beacon masts and the rack anchor
  are projected with the same MVP. The nearest hit within a pixel radius wins, with
  sensor > rack > node > conduit priority. Don't use `Raycaster` with the custom projection.
- **Basemap:** OpenFreeMap vector tiles (OpenMapTiles schema) with label-free layers
  in two paint sets (`BASEMAP_PAINT[theme]`, switched with `setPaintProperty`):
  - daylight: land `#F3F4EE`, parks `#CBE8BA`, roads `#D9DDD2` with white casings;
  - X-ray: obsidian over `#090D16`.

  A GeoJSON 100 m grid sits on top. No glyphs or sprites are used, so offline the
  grid, contours and 3D scene still render. CARTO raster tiles now return an "API key
  required" placeholder, so don't use them.
- **Performance:** `pixelRatio: min(devicePixelRatio, 1.75)` on the map. The 3D content is
  about 95 draw calls (measured). Half of them are the 10 node gauges, and every bulk layer
  (trees, buildings, conduits, circular pipes) is merged or instanced. `triggerRepaint()` runs every frame because flow and water animate
  continuously. Per-frame DOM work is limited to the 10 sensor badges (CSS transforms only,
  no React re-render).

## 12. HUD, live mode, deep links & PWA (Phase 3)

- `App` owns `rain`/`clog`, and `LutInterpolator.evaluate()` (~43 µs) runs on every slider
  event. The engine's `applyState()` uploads textures and uniforms only. HUD, drawer and badges
  re-render from one mutated `TwinState` keyed by `state.rev`.
- **LIVE mode** connects to `ws://<host>:8000/ws/live` (or `?api=` override). It falls back to a
  local typhoon playback with the same `stormProfile` as the backend, and retries every 5 s.
  Backend edge-DSP results override LUT sensor values (the edge is the source of truth).
- Fusion (`src/utils/fusion.ts` ≡ `backend/intelligence.py::arbitrate`): EN-08 ponding plus
  vision ≥ 35 % → `CONFIRMED_TRASH_RACK_OCCLUSION`. EN-08 ponding plus vision < 35 % plus EN-10
  ≥ 50 % → `DOWNSTREAM_ROCK_CHOKE_BACKWATER` (false alarm suppressed). Lagoon overflow beats
  everything.
- URL state: `lat,lng,z,pitch,bearing,rain,clog,scale,theme=day|xray,shader=solid|wire|glass,
  bld,veg,net,badges (0/1),sim=node|profile,simnode=EN-xx,sel=kind:id,mode=live,api`.
  - The legacy `xray=0` maps to `bld=0`.
  - It is written with a debounced `replaceState` and parsed on load, and the camera flies to
    the link.
  The QR modal uses `uqr` with a LAN-host override, and the dev server listens on the LAN.
- GPU rain: 6,000 `LineSegments` streaks, all motion in the vertex shader, density gated by a
  per-streak rank versus `uDensity`.
  - Daylight: `#0284C7`/`#0EA5E9` at opacity 0.65 over a bright haze, plus splash rings on the
    lagoon and street.
  - X-ray: a full-screen darkening quad first.

  Surcharge
  rings fade in from 100 % to 110 % of the max connected-conduit capacity. The lagoon goes from
  teal to crimson within 15 cm above the 1433.0 m rim.
- PWA: `manifest.webmanifest` (fullscreen) and a network-first `sw.js`, registered in
  production builds only.
- Rainfall intensity badges are project-defined (Dry / Light < 50 / Moderate–Heavy < 100 /
  Heavy ≤ 200 / Torrential). They are **not** PAGASA's rainfall-warning thresholds
  (Yellow 7.5–15, Orange 15–30, Red > 30 mm/hr).

## 13. Live backend (Phase 4)

`uvicorn backend.main:app --host 0.0.0.0 --port 8000` (no Docker). CORS is open because the PWA
is opened from LAN phones.

| Endpoint | Purpose |
|---|---|
| `WS /ws/live` | `TwinFrame` JSON at 2 Hz (`CITYCAMP_FRAME_HZ`; 0 = no ticker). Clients may send `{"type":"scenario",…}` |
| `GET /api/v1/health`, `/state`, `/network`, `/lut/meta`, `/sensors/{id}` | Status and latest data |
| `POST /api/v1/scenario` | `{"mode":"PLAYBACK"\|"SCENARIO", "rainfall_mm_hr", "trash_rack_blockage_pct"}` |
| `POST /api/v1/ingest/lorawan` | Physical uplink: direct JSON (`device_eui` = `EN-xx` or EUI, `payload_hex`/`payload_b64` + diagnostics), or a The Things Stack v3 webhook (`uplink_message.frm_payload`) |
| `POST /api/v1/decode` | Decode a 4-byte payload |

- `TwinFrame` (`backend/schemas.py` ≡ `src/types/live.ts`): `scenario`, `lagoon`,
  `sensors{EN-xx: LiveSensor}` (raw burst, raw vs Kalman depth, σ_d², h/D, Q/V/Fr/He,
  capacity, anomaly plus scores, payload hex/b64, FSM state, current, LoRa link), `fusion`,
  `nowcast` (4 FEWS stations, sub-catchments, +15/+30/+60 min horizons), `hardware_override`.
- Modes: `PLAYBACK` (120 s loop = 12 h typhoon, 6 storm-min per wall-s), `SCENARIO` (pinned),
  and `HARDWARE`. Any non-vision uplink in the last 30 s drives the twin: the measured capacity
  is inverted through the LUT to the rainfall that reproduces it. A Jetson uplink sets the
  blockage.
- Virtual fleet mounts: manhole lid when ≤ 4.4 m above the invert, otherwise crown-mounted
  (EN-05 at 5.1 m, EN-10 in the tunnel). The EN-07 mast is 7.3 m and the EN-08 mast is 5.9 m.
  The A02YYUW 4.47 m usable span cannot cover the lagoon's full 1.5–7.0 m stage; out of range
  is flagged `below_range`.
- LoRa: AS923-3 channels 916.6–918.0 MHz, log-distance (n = 2.9) link budget from the highest
  ridge manhole gateway, and ADR SF7–SF10 under the 400 ms dwell limit. Time-on-air (Semtech
  AN1200.13, 17-byte PHY): SF7 51.5 ms … SF10 329.7 ms.
- Nowcast: damped rainfall-trend extrapolation, per-conduit concentration-time lag, LUT
  pressurized fraction, and a 31-member ensemble, with downstream→upstream backwater risk
  propagation (γ = 0.6). It is a physics-weighted message-passing scaffold with **no trained
  weights**.
- The ingest fast path (no frame recompute) forwards in ~3–4 ms. The ticker broadcasts the
  full frame.

## 14. Firmware (Phase 5)

- `edge_core.hpp` is a line-by-line port of `backend/edge_dsp.py`: header-only, no heap, no
  exceptions, no STL containers. It compiles as `float` on the ESP32-S3 and as `double`
  (`EDGE_CORE_USE_DOUBLE`) on the host. **Any change to `edge_dsp.py` must be mirrored**, and
  `scripts/test_phase5_firmware.py` must pass. It diff-tests ~8,300 random vectors through
  every function (integers bit-exact, reals to 1e-9) and statically checks shared constants.
- `node_profiles.hpp` is generated from the backend fleet. Never hand-edit it.
- Bench standpipe: 740 mm of water = h/D 1.00 (`STANDPIPE_FULL_BORE_FRACTION`), so 850 mm →
  115 %. **Bench time compression:** in standpipe mode the Kalman dt is ×60 (1 bench-second =
  1 storm-minute), so pouring speeds land on the same mm/min scale as real manholes.
- Pins: A02YYUW RX GPIO44 / mode GPIO43 (LOW = real-time) / power MOSFET GPIO4, DS18B20
  GPIO5, battery ADC GPIO1 (1:2), Wio-SX1262 SPI 7/8/9, NSS 41, DIO1 39, RST 42, BUSY 40.
  Kalman state and the LoRaWAN session live in `RTC_DATA_ATTR`.
- Transports: LoRaWAN FPort 10, Wi-Fi POST, and USB `[EDGE_TX] {json}` (schema identical to
  `edge_dsp.edge_tx_record`). Console: `NODE`, `SCALE`, `HEIGHT`, `BENCH`, `SIM`, `STATUS`.
- `src/main.cpp` is compile-checked on the host against API stubs. It has **not** been built
  with the real ESP32 toolchain in this environment, so run `pio run` before field use.

## 15. Conventions

- Python ≥ 3.10, type-light, standard library + numpy in the generator. SI units everywhere.
  Field names carry units (`_m`, `_cms`, `_ms`, `_mm_min`, `_pct`).
- Round exports: lon/lat 7 dp, elevations/depths 3 dp. `null` means "not defined"
  (e.g. Froude under pressure). It never means zero.
- Regenerate `public/data/` and commit it with any generator change. Review the JSON diff
  and the CLI summary. Then run `gen_firmware_profiles.py`, `npm test` and both Python suites.
- Contracts that must move together: §10 codec (generator, `payloadCodec.ts`, `edge_dsp.py`,
  `edge_core.hpp`), `TwinFrame` (`schemas.py` ↔ `live.ts`), the interpolation rules
  (`lutInterpolator.ts` ↔ `lut.py`), the capacity ramp (`palette.ts` bands ↔
  `shaders/ramp.ts` GLSL), and the sensor mount rules (`fullness.ts` ↔ `backend/twin.py`).

## 16. Visual system & tools (Phase 6)

- **Two themes, one switch.** `Theme = 'daylight' | 'xray'`, with daylight the default.
  `TwinEngine.setTheme` writes the shared `THEME_UNIFORMS.uDay` (every shader blends on it),
  re-tints the layers and repaints the basemap. The DOM flips through
  `html[data-theme="daylight"]` in `index.css`. That block re-points Tailwind's colour
  variables: slate inverted, `white` → ink, sky → emerald, pale status tones deepened. So
  components use one set of classes and **never branch on theme for colour**. Exceptions:
  canvas and WebGL colours come from `PALETTES[theme]`, `bandsFor(theme)` and
  `capacityColor(r, theme)`.
- **Layer toggles** (`TopBar`, `TwinEngine.setLayers`):
  - buildings;
  - vegetation, which also hides the terrain park tint and the basemap `landcover`/`park`
    layers;
  - drainage network (conduits, shafts, rack; surcharge rings stay);
  - node badges and their 3D gauges.
- **Node fullness** (`src/utils/fullness.ts`) is the single source for the gauges, badges,
  simulator and inspector.
  - Conduit, lagoon and EN-08 nodes use `capacityPct`. The Jetson (EN-09) uses rack stage h/D.
    All are clamped to the u7 `cap_code` scale (0–127 %). EN-09's badge also shows its own
    visual blockage %.
  - Mount geometry mirrors `backend/twin.py`: lid ≤ 4.4 m, else crown +0.3 m; EN-07 mast
    7.3 m; EN-08 mast 5.9 m.
  - Status bands are 45 / 75 / 94 %.
- **Cross-Section Simulator** (`CrossSectionSimulator.tsx` + `crossSection/draw.ts`, Canvas 2D,
  values smoothed with `1 − e^(−3.2·dt)`):
  - **Node Cutaway** draws the true pipe, box, basin or rack dimensions, the A02YYUW (3 cm
    blind zone), the ESP32-S3, the gateway, and the h/D 0.60 "Blockage Surge" line. Water is
    turbulent for `FLASH_SURGE`, flat for ponding, and pools above the street over 100 %.
  - **Catchment Profile** runs hillside → lagoon bowl → rack → tunnel (2.5×2.7 concrete →
    1.5×1.7 choke).
  - **Drain Pipe** eases rain to 0 over 2.4 s.
  - The sliders write the same `rain`/`clog` as the HUD; in LIVE mode they drop to SIM first.
  - Docked height is `SIM_DOCK_VH`/`SIM_DOCK_MIN_PX`; the shader bar is offset by the same
    amount.
- **Subsurface Utility Inspector** (`SubsurfaceInspector.tsx`) is a separate `WebGLRenderer` +
  `OrbitControls` block view (84 m slab, a 3.0×1.8 box culvert and a Ø0.9 pipe). It uses the
  shared building materials, so the shading segmented control drives both views. Its water
  levels follow the selected (or representative EN-03 / EN-01) node's h/D.
