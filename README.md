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

- **Rainfall and trash-rack blockage sliders** (left panel) replay 48 precomputed storm
  scenarios. The panel also has presets, up to an Ondoy-scale 200 mm/h typhoon.
- **Top bar:**
  - switch between the Daylight Diorama and Dark X-Ray themes;
  - toggle buildings, vegetation, the drainage network and node badges;
  - open the Cross-Section Simulator and the Subsurface Utility Inspector.
- **Bottom bar:** shade buildings as Solid Concrete, Holo Wireframe or Fresnel Glass to see
  the pipes underneath.
- **Click a sensor badge** (EN-01 … EN-10) to see:
  - its decoded 4-byte LoRaWAN payload;
  - the Kalman-filtered depth;
  - the Edge-AI anomaly class;
  - a cutaway animation of its manhole.
- **Live Telemetry** mode streams the FastAPI backend: the virtual sensor fleet, sensor
  fusion and the flood nowcast.
- **Share:** the QR button opens the exact view on a phone on the same Wi-Fi.

## Project layout

```
src/                 React + MapLibre + Three.js web app (the 3D twin)
public/data/         generated network + simulation lookup table (committed)
backend/             FastAPI live backend: virtual sensor fleet, fusion, nowcast, WebSocket
firmware/            XIAO ESP32-S3 sensor-node firmware (PlatformIO)
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
| Phone can't open the LAN link | Same Wi-Fi network only. Allow Node.js through the Windows Firewall when prompted. |
| Python packages changed | Nothing to do: `npm start` re-installs when `requirements.txt` changes. |

## Data note

All drainage geometry is **synthetic**: plausible stand-ins laid out around the real lagoon
centroid. It is not surveyed or as-built data. See `CLAUDE.md` §1.
