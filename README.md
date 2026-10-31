# Edge-AI Stormwater Digital Twin: City Camp Lagoon, Baguio City

A 3D subsurface digital twin of the City Camp Lagoon drainage catchment. It shows the
storm drains, the lagoon and the drainage tunnel under a sunlit 3D city model. Live
"Edge-AI" sensor nodes report how full each pipe is, and the twin predicts when the lagoon
will overflow.

## Quick start

### 1. Install the prerequisites (once)

| Software | Version | Needed for | Download |
|---|---|---|---|
| **Node.js** (LTS) | **20 or newer** | the web app (**required**) | https://nodejs.org (keep "Add to PATH" ticked) |
| **Python** | 3.10 or newer | the live sensor backend (optional but recommended) | https://www.python.org/downloads/ (Windows: tick **"Add python.exe to PATH"**) |
| **Git** | any | downloading the project | https://git-scm.com/downloads |
| A modern browser | Chrome, Edge or Firefox with WebGL2 | viewing the twin | |

To check what you already have, open a terminal (PowerShell on Windows) and run:

```bash
node --version     # must print v20.x or newer
python --version   # 3.10 or newer (on Windows, "py --version" also works)
```

### 2. Get the code

```bash
git clone https://gitlab.com/2240958/edge-ai-drainage.git
cd edge-ai-drainage
```

### 3. Run it

**Windows:** double-click **`start.bat`**. **Any OS:**

```bash
npm start
```

The first run installs everything automatically: npm packages, a Python `.venv` and its
packages. It takes about 1–2 minutes. After that it starts both servers and prints:

```
[start]   Open in your browser:  http://localhost:5173
[start]   On your phone (same Wi-Fi):  http://192.168.x.x:5173
[start]   Live backend API:  http://localhost:8000/docs
```

Open ** **. Press **Ctrl+C** in the terminal to stop.

The launcher also handles these cases for you:
- **No Python?** The web app still runs. LIVE mode falls back to a built-in typhoon playback.
- **Port 5173 busy?** It picks the next free port.
- **Backend already running on :8000?** It reuses that backend.

### Other ways to run

| Command | What it does |
|---|---|
| `npm start` | Install if needed, then run backend (:8000) + frontend (:5173) |
| `npm run setup` | Install everything, then exit |
| `npm run start:frontend` | Frontend only (no Python needed) |
| `npm run start:prod` | Production build served on :4173 |
| `npm run check` | Typecheck + frontend tests |

---

## What you can do in the app

- **Live Weather mode (default):**
  - The twin starts on the current Baguio City rainfall, fetched from Open-Meteo with no API
    key. The left sidebar's TELEMETRY · WEATHER card shows mm/hr, °C, wind and the sync status.
  - "Live pitch scenarios" (monsoon, typhoon) and **historical storm replays** push a demo
    storm to the sensor fleet. The replays are Typhoon Ompong 2018, Kristine/Egay, an afternoon
    cloudburst and the Habagat monsoon, all synthetic design hyetographs.
  - A real sensor uplink overrides everything.
- **Storm Sim** (left sidebar or the SIMULATION menu): manual rainfall and trash-rack occlusion
  scrubbers over 48 precomputed storm scenarios, with Normal, Typhoon Surge, Trash Clog and Rock
  Choke Backwater presets.
- **Header:** daylight / dark theme, SOLID | X-RAY, 2D | 3D, and menus for the Cross-Section
  Simulator, the Subsurface Utility Inspector, the hardware rigs, the **Ultra-HD Pitch Studio**,
  CCTV and exports. Layers and building massing (Solid / Wire / Glass) are in the LAYER card.
- **Sensor markers:** a pin over each manhole turns amber at 45 % full. At 80 % it **blinks
  red**, with ripples on the street and its drain pipe pulsing red.
- **Click a sensor pill** (`EN-08 88%`) to see, in the right dock:
  - its decoded 4-byte LoRaWAN payload;
  - the Kalman-filtered depth;
  - the Edge-AI anomaly class;
  - a cutaway animation of its manhole.
- **ST-GNN forecast** (LGU REPORT tile, or Forecast & PDF on a phone): +15 / +30 / +60 min lagoon level with a 90 % band,
  time to overflow, surcharge probability and the next critical bottleneck sensor.
  - It comes from the backend when connected, otherwise it is computed in the browser.
  - It is a physics-informed graph model with no trained weights.
- **Live Telemetry** streams the FastAPI backend: the virtual sensor fleet, sensor fusion and
  the forecast.
- **Share:** the QR button opens the exact view on a phone on the same Wi-Fi.

## The workspace at a glance

The app is **Baguio Flood Intelligence**: a header bar, a left sidebar, the 3D map in the middle
and an analysis dock on the right (both side panels collapse with their arrow tabs).
- It opens on the **surface** (Solid Concrete). Click **X-RAY** in the header, or the X-RAY tile,
  to see the drainage pipes underground; **2D | 3D** flattens or tilts the camera.
- **Left sidebar:** search for a sensor or pipe, frame the Basin Bowl / Tunnel Choke / Full Grid,
  switch **Live Weather | Storm Sim**, and turn layers on or off.
- **Right dock:** NETWORK, X-RAY, CAPACITY, CCTV VMS, SECTION (live profile or manhole cutaway)
  and LGU REPORT. Click a sensor on the map to see its details here.
- **On a phone** (scan the QR code): the map fills the screen; a bottom sheet holds Live Nodes,
  Cross-Section and Forecast & PDF.

## Command Center CCTV & the City Camp Lagoon intake

- **Intake compound:** fly to **Tunnel Intake & Trash Rack** to see the sunken channel, maintenance
  ramp, drop-weir, staff gauge, the sloped trash rack under its steel cage, and the covered court,
  station and shed beside it. Debris piles onto the rack as blockage rises.
- **Command Center CCTV** (CCTV VMS in the header or dock, the EN-09 pill, or **View Nearest Command Center CCTV** in a
  sensor's drawer) shows the two nearest city cameras for that sensor:
  - a 60-minute storm replay with play / pause, ±15 s, 0.5x / 1x / 2x speed and a timeline;
  - three presets: dry baseline, typhoon debris on the rack, and clean rack with rock-choke
    backwater;
  - the YOLOv8 overlay, the multi-sensor fusion verdict, and evidence snapshot / clip downloads.
- **Real footage:** no camera streams are configured in this repository, so the feeds are a
  **simulated replay** of the 3D model and say so on screen and in every export. To show real video:
  - set `CITYCAMP_CCTV_STREAMS` for the backend (HLS / MP4 URLs from the city's video gateway), or
  - drop an `.mp4` / `.webm` on a viewport, or list clips in `public/cctv/manifest.json`.

## Analytics Command Center & black-box recovery

**EXPORT PDF -> Analytics Command Center** (or the CAPACITY / LGU REPORT tiles) opens a full-screen
view with:
- the lagoon hydrograph with the +15 / +30 / +60 min forecast;
- a sortable table of all 63 pipes;
- the raw-vs-Kalman noise audit;
- the CDRRMO / CEPMO / DPWH action matrix;
- PDF, CSV and JSON exports.

Telemetry is saved in the browser (IndexedDB) and, when `npm start` is running, in
`backend/data/baguio_flood_telemetry.db`. On first open the browser database is filled with 24 h of
**synthetic** storm data so the charts are not empty.

**Black-box demo:**
1. **Simulate Typhoon Comms Blackout.**
2. **Restore Link & Trigger SD Burst Sync.**
3. **Backfill Hydrograph Gap.**

With an ESP32 / Uno running the universal sketch on USB, step 2 asks the board for its log
(`DUMP_SD_LOG`). Without one, the browser keeps its own copy. The ESP32 logs to a microSD card on
CS GPIO10 and falls back to internal flash if the card or a wire fails.

## Ultra-HD Pitch Studio

Open **HARDWARE → Ultra-HD Pitch Studio** in the header (or open `http://localhost:5173/?view=pitch-studio`).
It is a high-definition 3D presentation scene for pitches and demos:
- **3D Subsurface Terrain Cutaway:** a sliced street block showing the road, grates, buildings
  and rain above, soil and limestone layers on the cut faces, and the manhole shaft, box culvert
  and outflow pipe below. The water rises and changes colour (cyan → amber → blinking red at
  80 %), and you can watch the ultrasonic pings bounce off the surface.
- **3D Aquarium & Arduino Bench:** the same water level in a glass tank, with an HC-SR04, an
  Arduino Uno or ESP32-S3, jumper wires and green / yellow / red LEDs.
- **Split Dual-View** shows both side by side.
- **Controls:** pick the map sensor (default EN-08), drag the water level, **Hold / Click to
  Pour (+15% Surge)**, **Drain**, set the rainfall, or use the presets (**Critical 85% [Trigger
  Red Blink]** turns the map sensor red). Five camera presets and **Ultra-HD 2x
  Supersampling** sharpen the view for screenshots.
- The studio feeds the map live: the targeted sensor blinks red and a **LIVE SENSOR ALERT**
  banner offers **Jump to Sensor**. **Connect Physical USB Arduino / ESP32** lets a real board
  drive the 3D tank instead.

## Arduino / ESP32 & aquarium demo

1. Run `npm start` and open the map.
2. Open **HARDWARE → Aquarium Serial Rig** in the header. A second tab opens at
   `/?view=hardware-sim`.
3. In that tab, pick the map sensor the tank stands for (default **EN-08**). Then use the
   controls:
   - **Water level** slider: drag it to raise or lower the water;
   - **Pour Water (+15% Surge)**: shows a FLASH_SURGE;
   - **Hold to Pour**: fills continuously while held;
   - presets, from **Empty (0%)** to **Almost Full — Trigger Red Blink (85%)** and
     **Simulate Trash Clog Backwater (82% Flat Pool)**;
   - **Open Drain Valve**: empties the tank.
4. The map tab reacts instantly, with no backend needed:
   - that sensor's pill, pin, street ring and pipe follow the tank and **blink red at ≥ 80 %**;
   - a **LIVE SENSOR ALERT** banner appears with **Jump to Sensor** and
     **Disconnect Sim**.
5. **Full Catchment Coupling Mode** scales the whole catchment to the tank instead of a single
   sensor.

**Analytics & PDF report:** open **EXPORT PDF → Official LGU PDF report** in the header (or the LGU REPORT tile).
- It previews a 3-page official report and downloads it as
  `Baguio_City_Camp_Drainage_Analytics_Report.pdf`, built in the browser.
- **Contents:**
  - a four-agency header;
  - a plain-language summary;
  - charts of sensor fullness, raw vs Kalman readings, the lagoon forecast and conduit
    capacity;
  - a 10-sensor payload audit table.
- **Typography:** one font at one size throughout, with no colons or em dashes.

**Universal ESP32-S3 / Arduino Uno node:** flash
[firmware/universal_hcsr04_node/universal_hcsr04_node.ino](firmware/universal_hcsr04_node/universal_hcsr04_node.ino).
It needs no libraries.
- **Wiring:**

  | | TRIG | ECHO | LED green | LED yellow | LED red |
  |---|---|---|---|---|---|
  | ESP32-S3 | 5 | 6 | 7 | 8 | 9 |
  | Uno | 9 | 10 | 4 | 5 | 6 |
- **What it does:** it runs the full edge pipeline on the board and lights green/yellow, with
  red blinking at 3 Hz from 80 % full.
- **Output:** `[EDGE_TX]` frames over USB. On the ESP32-S3, set `WIFI_SSID`, `WIFI_PASSWORD`
  and `SERVER_IP` (your PC) and it posts to the backend over Wi-Fi every 500 ms, so it can run
  on a battery.
- **Safety:**
  - Use a 3.3 V HC-SR04 (HC-SR04P) or a voltage divider on ECHO with the ESP32-S3; its pins are
    not 5 V tolerant.
  - Use LED modules with built-in resistors, or add 220–330 Ω resistors.

**Other boards / sensors:** flash
[firmware/arduino_aquarium_demo/arduino_aquarium_demo.ino](firmware/arduino_aquarium_demo/arduino_aquarium_demo.ino)
(Arduino IDE, any Uno / Nano / Mega / ESP32).
- **Sensor:** set `SENSOR_TYPE` for an HC-SR04 / JSN-SR04T or an A02YYUW.
- **Tank:** set `TANK_HEIGHT_MM` to the sensor-to-floor distance; the tank is 100 % full at 74 %
  of that height.
- **Connect:** plug the board in by USB, open the simulator (or **HARDWARE → Connect USB Arduino / ESP32** on the map) in **Chrome or
  Edge**, and click **Connect USB Arduino / ESP32**. Any sketch that prints distances
  (`DIST_MM:240`, `24 cm`, `FILL_PCT:85`) or our `[EDGE_TX]` frames works.
- **Other browsers:** run `.venv/Scripts/python scripts/serial_bridge.py` instead.

## Project layout

```
src/                 React + MapLibre + Three.js web app (the 3D twin)
public/data/         generated network + simulation lookup table (committed)
backend/             FastAPI live backend: virtual sensor fleet, fusion, ST-GNN forecast, weather feeds, WebSocket
firmware/            XIAO ESP32-S3 sensor-node firmware (PlatformIO) + Arduino aquarium demo sketch
scripts/             data generator, launcher, serial bridge, test suites
docs/                hardware bench demo guide (BOM, wiring, PVC standpipe rig)
tests/frontend/      vitest suites
CLAUDE.md            full technical specification (geometry, CRS, hydraulics, telemetry contract)
```

## Development commands

```bash
npm run dev                  # frontend only, hot reload
npm run build                # strict typecheck + production bundle
npm test                     # frontend tests (vitest)

# Python (after `npm run setup` has created .venv)
.venv/Scripts/python -m uvicorn backend.main:app --host 0.0.0.0 --port 8000   # backend alone
.venv/Scripts/python scripts/test_phase4_backend.py                           # backend tests
.venv/Scripts/python scripts/test_phase5_firmware.py                          # firmware tests (needs g++/clang++/zig)
.venv/Scripts/python scripts/serial_bridge.py --virtual-standpipe             # simulated hardware node
.venv/Scripts/python scripts/generate_citycamp_twin_data.py                   # regenerate public/data
.venv/Scripts/python scripts/gen_frontend_goldens.py                          # after forecaster / edge DSP changes
```

On macOS/Linux, use `.venv/bin/python` instead of `.venv/Scripts/python`.

**Hardware (optional):** to flash a real sensor node you also need
[PlatformIO](https://platformio.org/install). See
[docs/HARDWARE_BENCH_DEMO_GUIDE.md](docs/HARDWARE_BENCH_DEMO_GUIDE.md).

## Troubleshooting

| Problem | Fix |
|---|---|
| `'node' is not recognized` / `command not found` | Install Node.js, then **close and reopen** the terminal so PATH updates. |
| `Python >= 3.10 not found` | Install Python with "Add to PATH" ticked, reopen the terminal, then run `npm start` again. The frontend works without it. |
| Blank map or "WebGL2" error | Use an up-to-date Chrome or Edge and turn on hardware acceleration in the browser settings. |
| Basemap streets missing | The street tiles need internet. Offline, the grid, contours and 3D twin still render. |
| Weather pill says "Offline" | Open-Meteo is unreachable. The twin uses the last synced reading, or dry weather. Click "Simulation Mode" to drive it by hand. |
| Phone can't open the LAN link | Same Wi-Fi network only. Allow Node.js through the Windows Firewall when prompted. |
| Python packages changed | Nothing to do: `npm start` re-installs when `requirements.txt` changes. |
| "Connect USB Arduino / ESP32" is greyed out | Web Serial needs desktop Chrome or Edge. Use the aquarium simulator, or `scripts/serial_bridge.py`. |
| The map doesn't react to the aquarium tab | Both tabs must be the same address (e.g. both `localhost:5173`), and "Map sync" must be ON in the simulator. |

## Data note

All drainage geometry is **synthetic**: plausible stand-ins laid out around the real lagoon
centroid. It is not surveyed or as-built data. See `CLAUDE.md` §1.
