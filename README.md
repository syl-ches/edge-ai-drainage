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

Open **http://localhost:5173**. Press **Ctrl+C** in the terminal to stop.

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
    key. The top-bar pill shows mm/hr, °C, the condition and the sync status.
  - "Live pitch scenarios" (monsoon, typhoon) and **historical storm replays** push a demo
    storm to the sensor fleet. The replays are Typhoon Ompong 2018, Kristine/Egay, an afternoon
    cloudburst and the Habagat monsoon, all synthetic design hyetographs.
  - A real sensor uplink overrides everything.
- **Simulation Mode** (top bar): manual rainfall and trash-rack blockage sliders over 48
  precomputed storm scenarios, with presets up to an Ondoy-scale 200 mm/h typhoon.
- **Top bar:**
  - switch between the Daylight Diorama and Dark X-Ray themes;
  - toggle buildings, vegetation, the drainage network and node badges;
  - open the Cross-Section Simulator and the Subsurface Utility Inspector.
- **Bottom bar:** shade buildings as Solid Concrete, Holo Wireframe or Fresnel Glass to see
  the pipes underneath.
- **Sensor markers:** a pin over each manhole turns amber at 45 % full. At 80 % it **blinks
  red**, with ripples on the street and its drain pipe pulsing red.
- **Click a sensor pill** (`● EN-08 88% ▸`) to see:
  - its decoded 4-byte LoRaWAN payload;
  - the Kalman-filtered depth;
  - the Edge-AI anomaly class;
  - a cutaway animation of its manhole.
- **ST-GNN forecast panel** (left HUD): +15 / +30 / +60 min lagoon level with a 90 % band,
  time to overflow, surcharge probability and the next critical bottleneck sensor.
  - It comes from the backend when connected, otherwise it is computed in the browser.
  - It is a physics-informed graph model with no trained weights.
- **Live Telemetry** streams the FastAPI backend: the virtual sensor fleet, sensor fusion and
  the forecast.
- **Share:** the QR button opens the exact view on a phone on the same Wi-Fi.

## Arduino / ESP32 & aquarium demo

1. Run `npm start` and open the map.
2. Click **Open Arduino & Aquarium Sim ↗** in the top bar. A second tab opens at
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
   - a **LIVE HARDWARE SENSOR ALERT** banner appears with **Focus Camera** and
     **Disconnect Sim**.
5. **Full Catchment Coupling Mode** scales the whole catchment to the tank instead of a single
   sensor.

**Real hardware:** flash
[firmware/arduino_aquarium_demo/arduino_aquarium_demo.ino](firmware/arduino_aquarium_demo/arduino_aquarium_demo.ino)
(Arduino IDE, any Uno / Nano / Mega / ESP32).
- **Sensor:** set `SENSOR_TYPE` for an HC-SR04 / JSN-SR04T or an A02YYUW.
- **Tank:** set `TANK_HEIGHT_MM` to the sensor-to-floor distance; the tank is 100 % full at 74 %
  of that height.
- **Connect:** plug the board in by USB, open the simulator (or the map's HUD) in **Chrome or
  Edge**, and click **Connect Physical USB Arduino / ESP32**. Any sketch that prints distances
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
| "Connect Physical USB" is greyed out | Web Serial needs desktop Chrome or Edge. Use the aquarium simulator, or `scripts/serial_bridge.py`. |
| The map doesn't react to the aquarium tab | Both tabs must be the same address (e.g. both `localhost:5173`), and "Map sync" must be ON in the simulator. |

## Data note

All drainage geometry is **synthetic**: plausible stand-ins laid out around the real lagoon
centroid. It is not surveyed or as-built data. See `CLAUDE.md` §1.
