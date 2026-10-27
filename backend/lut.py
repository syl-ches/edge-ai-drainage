"""Backend twin of src/utils/lutInterpolator.ts (bilinear over rainfall x blockage).

Vectorised with numpy; also supplies the ST-GNN forecaster's initial conduit state.
Same rules as the frontend: physical outflow structure Q_out = min(Q_rack, Q_choke) with rack
capacity interpolated per unit open area, Kirschmer loss rebuilt from that Q, and the
time-to-overflow interpolated as a rate.
"""
from __future__ import annotations

import json
import math
from dataclasses import dataclass
from pathlib import Path

import numpy as np

DATA_DIR = Path(__file__).resolve().parents[1] / "public" / "data"
G = 9.80665


@dataclass
class LagoonEval:
    depth_m: float
    surface_elev_m: float
    orifice_flow_cms: float
    rack_capacity_cms: float
    head_loss_m: float
    time_to_overflow_min: float | None
    bottleneck: str
    control: str
    is_overflowing: bool


class TwinLut:
    def __init__(self, data_dir: Path = DATA_DIR):
        self.network = json.loads((data_dir / "city_camp_network.json").read_text(encoding="utf-8"))
        self.lut = json.loads((data_dir / "simulation_lut.json").read_text(encoding="utf-8"))
        self.rain_axis = np.array(self.lut["axes"]["rainfall_mm_hr"], float)
        self.block_axis = np.array(self.lut["axes"]["trash_rack_blockage_pct"], float)
        self.conduit_ids = [c["id"] for c in self.network["conduits"] if c["is_active"]]
        self.sensor_ids = [s["sensor_id"] for s in self.network["sensors"] if s["is_active"]]
        self.tunnel_limit = float(self.lut["meta"]["tunnel_conveyance_limit_cms"])
        self.rack = self.network["orifices"][0]
        lag = self.network["lagoon"]
        self.pool = lag["permanent_pool_depth_m"]
        self.max_depth = lag["max_depth_m"]
        self.invert = lag["invert_elev_m"]
        nr, nb = len(self.rain_axis), len(self.block_axis)
        grid = np.empty((nr, nb), object)
        for i, r in enumerate(self.rain_axis):
            for j, b in enumerate(self.block_axis):
                grid[i, j] = self.lut["scenarios"][self.lut["index"][f"R{int(r)}_B{int(b)}"]]
        self._cap = np.array([[[grid[i, j]["conduits"][c]["capacity_ratio"] for c in self.conduit_ids]
                               for j in range(nb)] for i in range(nr)])
        self._flow = np.array([[[grid[i, j]["conduits"][c]["flow_cms"] for c in self.conduit_ids]
                                for j in range(nb)] for i in range(nr)])
        self._vel = np.array([[[grid[i, j]["conduits"][c]["velocity_ms"] for c in self.conduit_ids]
                               for j in range(nb)] for i in range(nr)])
        self._press = np.array([[[1.0 if grid[i, j]["conduits"][c]["flow_regime"] == "PRESSURIZED" else 0.0
                                  for c in self.conduit_ids] for j in range(nb)] for i in range(nr)])
        self._s_depth = np.array([[[grid[i, j]["sensors"][s]["depth_mm"] for s in self.sensor_ids]
                                   for j in range(nb)] for i in range(nr)])
        self._s_cap = np.array([[[grid[i, j]["sensors"][s]["capacity_pct"] for s in self.sensor_ids]
                                 for j in range(nb)] for i in range(nr)])
        self._s_turb = np.array([[[grid[i, j]["sensors"][s]["turbulence_index"] for s in self.sensor_ids]
                                  for j in range(nb)] for i in range(nr)])
        L = lambda k: np.array([[grid[i, j]["lagoon"][k] for j in range(nb)] for i in range(nr)], float)  # noqa: E731
        self._depth = L("lagoon_water_depth_m")
        p = self.block_axis[None, :] / 100.0
        self._rack_n = L("rack_capacity_cms") / (1.0 - p)
        self._lag_q = L("orifice_flow_cms")
        t = np.array([[grid[i, j]["lagoon"]["estimated_time_to_overflow_min"] or 0.0 for j in range(nb)]
                      for i in range(nr)], float)
        self._rate = np.where(t > 0, 1.0 / np.maximum(t, 1e-3), 0.0)

    # ------------------------------------------------------------------ core
    def _weights(self, rain, block):
        rain = np.clip(np.asarray(rain, float), self.rain_axis[0], self.rain_axis[-1])
        block = np.clip(np.asarray(block, float), self.block_axis[0], self.block_axis[-1])
        ri = np.clip(np.searchsorted(self.rain_axis, rain, side="right") - 1, 0, len(self.rain_axis) - 2)
        bi = np.clip(np.searchsorted(self.block_axis, block, side="right") - 1, 0, len(self.block_axis) - 2)
        rt = (rain - self.rain_axis[ri]) / (self.rain_axis[ri + 1] - self.rain_axis[ri])
        bt = (block - self.block_axis[bi]) / (self.block_axis[bi + 1] - self.block_axis[bi])
        return ri, bi, np.clip(rt, 0, 1), np.clip(bt, 0, 1), block

    def _bilinear(self, arr, ri, bi, rt, bt):
        rt = np.expand_dims(rt, -1) if arr.ndim == 3 and np.ndim(rt) else rt
        bt = np.expand_dims(bt, -1) if arr.ndim == 3 and np.ndim(bt) else bt
        return ((1 - rt) * (1 - bt) * arr[ri, bi] + rt * (1 - bt) * arr[ri + 1, bi]
                + (1 - rt) * bt * arr[ri, bi + 1] + rt * bt * arr[ri + 1, bi + 1])

    # ------------------------------------------------------------------ public
    def conduit_capacity(self, rain, block) -> np.ndarray:
        ri, bi, rt, bt, _ = self._weights(rain, block)
        return self._bilinear(self._cap, ri, bi, rt, bt)

    def conduit_state(self, rain: float, block: float) -> tuple[list[float], list[float], list[float]]:
        """(flow_cms, velocity_ms, capacity_ratio) per active conduit: the forecaster's initial state."""
        ri, bi, rt, bt, _ = self._weights(rain, block)
        f = self._bilinear(self._flow, ri, bi, rt, bt)
        v = self._bilinear(self._vel, ri, bi, rt, bt)
        c = self._bilinear(self._cap, ri, bi, rt, bt)
        return [float(x) for x in f], [float(x) for x in v], [float(x) for x in c]

    def conduit_pressurized(self, rain, block) -> np.ndarray:
        """Corner-weighted pressurized fraction (>= 0.5 == SURCHARGED, the LUT status rule)."""
        ri, bi, rt, bt, _ = self._weights(rain, block)
        return self._bilinear(self._press, ri, bi, rt, bt)

    def sensor_truth(self, rain: float, block: float) -> dict[str, dict]:
        ri, bi, rt, bt, _ = self._weights(rain, block)
        d = self._bilinear(self._s_depth, ri, bi, rt, bt)
        c = self._bilinear(self._s_cap, ri, bi, rt, bt)
        t = self._bilinear(self._s_turb, ri, bi, rt, bt)
        return {s: dict(depth_mm=float(d[k]), capacity_pct=float(c[k]), turbulence=float(t[k]))
                for k, s in enumerate(self.sensor_ids)}

    def lagoon(self, rain: float, block: float) -> LagoonEval:
        ri, bi, rt, bt, b = self._weights(rain, block)
        p = float(b) / 100.0
        depth = float(self._bilinear(self._depth, ri, bi, rt, bt))
        rack_cap = float(self._bilinear(self._rack_n, ri, bi, rt, bt)) * (1 - p)
        stage = depth - self.pool
        q = min(rack_cap, self.tunnel_limit) if stage > 0 else float(self._bilinear(self._lag_q, ri, bi, rt, bt))
        xi = self.rack["xi_clean"] / (1 - p) ** 2
        v = q / (self.rack["width_m"] * min(stage, self.rack["height_m"])) if stage > 0 else 0.0
        rate = float(self._bilinear(self._rate, ri, bi, rt, bt))
        if stage <= 1e-6:
            control, bottleneck = "NONE", "NONE"
        elif rack_cap < self.tunnel_limit:
            control, bottleneck = "TRASH_RACK", "TRASH_RACK_ORIFICE"
        else:
            control, bottleneck = "TUNNEL_CHOKE", f"ROCK_TUNNEL_CHOKE_{self.tunnel_limit:.2f}_CMS"
        return LagoonEval(depth, self.invert + depth, q, rack_cap, xi * v * v / (2 * G),
                          (1.0 / rate) if rate > 1e-6 else None, bottleneck, control, depth > self.max_depth)

    def invert_rain_for_sensor(self, sensor_id: str, capacity_pct: float, block: float) -> float:
        """Rainfall whose LUT state best reproduces a measured sensor capacity (hardware drive)."""
        k = self.sensor_ids.index(sensor_id)
        rains = np.linspace(0.0, 250.0, 501)
        ri, bi, rt, bt, _ = self._weights(rains, np.full_like(rains, block))
        caps = self._bilinear(self._s_cap, ri, bi, rt, bt)[:, k]
        err = np.abs(caps - capacity_pct)
        return float(rains[int(np.argmin(err))])


def haversine_m(a: tuple[float, float], b: tuple[float, float]) -> float:
    lon1, lat1, lon2, lat2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    h = math.sin((lat2 - lat1) / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin((lon2 - lon1) / 2) ** 2
    return 2 * 6371008.8 * math.asin(math.sqrt(h))
