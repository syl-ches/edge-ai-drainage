# Hardware & Bench-Top PVC Standpipe Demo Guide
**City Camp Lagoon Edge-AI Stormwater Node — Baguio City build team**

This guide takes you from an empty table to a live demo. You will buy the parts, wire one
Edge-AI manhole node, and build a 1 m clear/white PVC standpipe. When you pour water into the
pipe, the City Camp 3D digital twin sweeps from cyan (0 %) through amber/red (75 %) to flashing
magenta surcharge (115 %).

> Prices are indicative PH retail (late 2026) and change often. Check them before you order.
> The firmware runs without LoRaWAN, Wi-Fi or a gateway: USB-C to the laptop is enough for a demo.

---

## 1. Bill of materials (target ≈ ₱3,364)

| # | Part | Spec / exact name | Qty | ≈ ₱ | Where (PH) |
|---|------|-------------------|-----|-----|-----------|
| 1 | MCU | **Seeed Studio XIAO ESP32-S3** (Xtensa LX7 dual-core, 8 MB PSRAM, USB-C, Li-ion charger on BAT pads) | 1 | 620 | Makerlab Electronics, Circuitrocks |
| 2 | LoRa radio | **Seeed Wio-SX1262 for XIAO** (B2B stack-on, 862–930 MHz, u.FL + 915 MHz antenna) | 1 | 560 | Makerlab, Shopee/Lazada Seeed Official |
| 3 | Ultrasonic | **DFRobot A02YYUW** waterproof ultrasonic, UART 9600, 30–4500 mm, IP67, 4-pin lead | 1 | 1,150 | Makerlab, Circuitrocks, DFRobot store on Lazada |
| 4 | Thermometer | **DS18B20 waterproof probe** (1 m stainless, 3-wire) | 1 | 120 | Circuitrocks, Shopee |
| 5 | Battery | **18650 Li-ion 3,400 mAh** (protected, button-top) + single 18650 holder with leads | 1 | 325 | Shopee/Lazada Mall (Panasonic/LG genuine sellers) |
| 6 | Solar | 6 V 1 W mini panel (field node only; skip for the bench) | 1 | 180 | Shopee |
| 7 | Power switch | **AO3400** N-MOSFET (SOT-23 on breakout) + 100 kΩ gate pull-down | 1 | 15 | Makerlab, Circuitrocks |
| 8 | Resistors | 4.7 kΩ (DS18B20 pull-up), 2 × 220 kΩ (battery divider), 100 nF capacitor | 1 set | 10 | any |
| 9 | Enclosure | IP67 ABS junction box ~ 115 × 90 × 55 mm | 1 | 150 | Ace Hardware, Wilcon, Shopee |
| 10 | Glands | PG7 cable glands | 3 | 60 | Wilcon, Shopee |
| 11 | Build | Perfboard 5 × 7 cm, female headers, Dupont wires, heat-shrink | 1 set | 174 | Makerlab, Circuitrocks |
| | **Total** | | | **≈ 3,364** | |

**PVC standpipe rig (≈ ₱450, hardware store)**

| Part | Qty | ≈ ₱ |
|------|-----|-----|
| 4-inch (100 mm) PVC pipe, 1.0 m cut, **white or clear** | 1 | 250 |
| 4-inch PVC end cap, bottom (solvent-welded) | 1 | 60 |
| ½-inch PVC ball valve + male adapter (drain) | 1 | 80 |
| 4-inch cap for the top (sensor mount), sealant, PVC cement | 1 | 60 |

---

## 2. Wiring

### 2.1 Pin map (matches `firmware/citycamp_edge_node/src/main.cpp`)

| Signal | XIAO pin | GPIO | Goes to |
|--------|----------|------|---------|
| A02YYUW **White (TX)** | D7 (RX) | **GPIO44** | ESP32 UART1 RX: 9600 baud frames `0xFF H L SUM` |
| A02YYUW **Yellow (RX / mode)** | D6 | **GPIO43** | Driven **LOW** during the burst = real-time ~100 ms output |
| A02YYUW **Red (VCC)** | 3V3 | — | 3.3 V (sensor is rated 3.3–5 V) |
| A02YYUW **Black (GND)** | via MOSFET | — | AO3400 drain; source → GND (low-side power switch) |
| MOSFET gate | D3 | **GPIO4** | HIGH = sensor powered; 100 kΩ gate → GND |
| DS18B20 **Yellow (DQ)** | D4 | **GPIO5** | + **4.7 kΩ pull-up to 3V3** |
| DS18B20 Red / Black | 3V3 / GND | — | |
| Battery divider midpoint | A0 | **GPIO1** | BAT+ → 220 kΩ → A0 → 220 kΩ → GND, 100 nF A0→GND |
| 18650 + / − | BAT+ / BAT− pads (underside) | — | XIAO charges it from USB-C |
| Wio-SX1262 | B2B connector | SCK 7, MISO 8, MOSI 9, NSS 41, DIO1 39, RST 42, BUSY 40 | Stack on, then attach the 915 MHz antenna **before** powering the radio |

### 2.2 Breadboard / perfboard layout

```
                 +-----------------------------+
   USB-C  =======|  XIAO ESP32-S3  (top view)  |
                 | D0  A0 <---+         5V  ---|
                 | D1         |        GND  ---+--------------------------+
                 | D2         |        3V3  ---+---------+----------+     |
                 | D3 GPIO4 --|--+      D10    |         |          |     |
                 | D4 GPIO5 --|--|--+   D9     |       4.7k         |     |
                 | D5         |  |  |   D8     |         |          |     |
                 | D6 GPIO43 -|--|--|-----------------------------+ |     |
                 +------------|--|--|----------+         |        | |     |
       [Wio-SX1262 on B2B]    |  |  |                    |        | |     |
                              |  |  +--------------------+-- DQ (yellow)  |
   BAT+ -- 220k --+-- 220k -- GND |        DS18B20  red -> 3V3, black -> GND
                  |               |
                 A0 (+100nF)      |  AO3400:  G <- GPIO4 (100k to GND)
                                  +--------> D <- A02YYUW black
                                             S -> GND
   A02YYUW: red -> 3V3 | white (TX) -> D7/GPIO44 | yellow (RX/mode) -> D6/GPIO43
```

> **Low-side switching note:** when the MOSFET is off, the sensor may still pull a little
> current through its UART lines. The firmware stops UART1 (`Serial1.end()`) before it cuts
> power. For the field build, a high-side P-MOSFET with a level shifter cuts that leakage too.

---

## 3. Building the 1 m PVC standpipe rig

```
          A02YYUW sensor face, pointing DOWN, in a 40 mm hole in the top cap
              |  (seal with silicone; face must sit flush, nothing in the 30 mm blind zone)
        +=====v=====+   <- top cap  (0 mm = transducer face)
        |           |
        |           |   ---- 115 %  (850 mm water)  SURCHARGED (flashing magenta)
        |           |   ---- 100 %  (740 mm)        full bore / surcharge onset
        |           |   ----  94 %  (696 mm)        Q_max (closed-conduit capacity paradox)
        |           |   ----  80 %  (592 mm)        CRITICAL band (red)
        |           |   ----  50 %  (370 mm)        ELEVATED (amber)
        |           |   ----  25 %  (185 mm)        NORMAL (cyan)
        |  4" PVC   |
        |  1.0 m    |
        +=====+=====+   <- bottom cap (solvent-welded)
              |
            [=X=]  ½" ball valve (drain)    ---> bucket
```

1. Solvent-weld the bottom cap. Drill and fit the ½-inch male adapter and ball valve about 3 cm above the bottom.
2. Drill a 40 mm hole in the centre of the top cap. Fit the A02YYUW face-down and seal it.
   The face must be **perpendicular**. A tilted beam bounces off the pipe wall.
3. Mark the graduation lines with a permanent marker, measuring **from the bottom of the pipe**:
   185 / 370 / 592 / 696 / 740 / 850 mm. These match `STANDPIPE_FULL_BORE_FRACTION = 0.74`
   in the firmware: 740 mm of water = h/D 1.00 of the conduit the board represents.
4. Mount the electronics box beside the pipe. Keep the 1 m pipe vertical, using a stand or a
   bucket of sand.

**Two demo gestures**

| Gesture | What you do | What the edge AI sees | Twin result |
|---------|-------------|-----------------------|-------------|
| **Flash surge** | Pour 2–3 L fast from a pail, splashing | steep positive dh/dt + high acoustic variance σ_d² | `FLASH_SURGE` → colours climb, rain intensity in the twin rises |
| **Trash blockage** | Fill to the 80 % line, **close the valve**, wait 10–15 s | deep h/D > 0.60, dh/dt ≈ 0, calm surface σ_d² → 0 | `TRASH_BLOCKAGE`; with vision ≥ 35 % the fusion engine says `CONFIRMED_TRASH_RACK_OCCLUSION`, otherwise `DOWNSTREAM_ROCK_CHOKE_BACKWATER` |
| Recession | Open the valve | negative dh/dt, colours fall back | |

Bench time compression: in standpipe mode, **1 second on the bench counts as 1 minute of
storm**. This puts pouring speeds of a few cm/s on the same dh/dt scale (mm/min) the classifier
uses for real manholes.

---

## 4. Flash and link to the 3D twin in under 2 minutes

### Option A: PlatformIO (recommended)

```bash
cd firmware/citycamp_edge_node
pio run -t upload            # 1. build + flash over USB-C (hold BOOT while plugging in on first flash)
pio device monitor           # 2. watch [EDGE_TX] frames; type commands (below); Ctrl+C to exit
python ../../scripts/serial_bridge.py --node EN-03 --bench    # 3. forward frames to the twin
```

### Option B: Arduino IDE 2.x

1. Under Boards Manager, install **esp32 by Espressif**. Select **XIAO_ESP32S3** and set
   *Tools → USB CDC On Boot: Enabled*.
2. In Library Manager, install **RadioLib** (≥ 7.1), **OneWire**, and **DallasTemperature**.
3. Create a sketch folder `citycamp_edge_node/`. Copy `src/main.cpp` into it as
   `citycamp_edge_node.ino`, and copy the three headers from `include/` next to it.
4. Upload. Then open the Serial Monitor at **115200** with *Newline* line endings.

### Run the twin (laptop)

```bash
# terminal 1 — backend
.venv\Scripts\python -m uvicorn backend.main:app --host 0.0.0.0 --port 8000
# terminal 2 — frontend (opens http://localhost:5173, LAN-reachable for the QR code)
npm run dev
# terminal 3 — the board
python scripts/serial_bridge.py --node EN-03 --bench
```

In the web app, switch the HUD to **LIVE TELEMETRY PREVIEW**. The badge should read
**BACKEND STREAM** and `HW EN-03`. Pour water and watch the twin follow.

### Serial console commands (115200 baud)

| Command | Effect |
|---------|--------|
| `NODE EN-01` … `NODE EN-10` | Which City Camp manhole the board represents (geometry, D, mount height) |
| `SCALE ON` / `SCALE OFF` | Bench standpipe scaling on/off |
| `HEIGHT 1000` | Standpipe height in mm (sensor face → pipe bottom) |
| `BENCH ON` / `BENCH OFF` | 1 s continuous streaming vs low-power deep-sleep FSM |
| `SIM SURGE` / `SIM BLOCKAGE` / `SIM DRY` / `SIM OFF` | Synthetic water column without the sensor (test the chain with no water) |
| `STATUS`, `RESET` | Show / reset RTC state |

### No board yet?

```bash
python scripts/serial_bridge.py --virtual-standpipe                       # pour 0 → 85 cm, drain
python scripts/serial_bridge.py --virtual-standpipe --water-cm 78 --mode surge
python scripts/serial_bridge.py --virtual-standpipe --water-cm 60 --mode blockage --node EN-08
```

This runs the same pipeline as the firmware (`backend/edge_dsp.py::run_cycle`, which matches
`edge_core.hpp` bit-for-bit) and prints identical `[EDGE_TX]` frames.

---

## 5. Live-demo checklist

- [ ] Laptop and phones on the **same Wi-Fi/hotspot**. The QR modal's "LAN IP override" field holds the laptop IP (e.g. `192.168.137.1:5173`)
- [ ] `uvicorn … --host 0.0.0.0` running: `http://<laptop-ip>:8000/api/v1/health` shows `"status":"ok"`
- [ ] `npm run dev`; the HUD shows **BACKEND STREAM** in Live mode
- [ ] Board flashed; `STATUS` prints `bench=ON standpipe=ON`; the bridge prints `HTTP 200 … ms`
- [ ] Standpipe empty, valve closed, pail of water ready, towel down
- [ ] Rehearse: **flash surge → close valve (blockage) → open valve (recession)**
- [ ] Fallback if the sensor misbehaves: type `SIM SURGE` / `SIM BLOCKAGE` and the story still works
- [ ] Fallback if the network drops: the PWA keeps working offline (cached data, procedural grid basemap, local storm playback)

---

## 6. Field deployment notes (after the demo)

- Mount the A02YYUW under the manhole lid, at most 4.4 m above the invert. Deeper shafts such as
  `EN-05` (Kisad, 5.1 m) and `EN-10` (tunnel crown, 26.8 m below the street) need crown mounts. The backend's virtual fleet
  already models this (`backend/twin.py`, `CROWN_MOUNT_CLEARANCE_MM`).
- The lagoon stage (EN-07) spans 1.5–7.0 m, which is more than the A02YYUW's 4.47 m usable range.
  On a 7.3 m mast it reads 2.8–7.3 m, and the permanent pool reads as `below_range`. A full-range
  stage needs a pressure transducer or radar level sensor.
- Copy `include/secrets.example.h` to `include/secrets.h`. Set `LORAWAN_ENABLED 1` and your
  OTAA keys (AS923-3, FPort 10). Point the network server's webhook at
  `POST /api/v1/ingest/lorawan`, which accepts The Things Stack v3 uplinks directly.
