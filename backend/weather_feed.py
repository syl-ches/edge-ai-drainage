"""Precipitation ingestion for the ST-GNN forecaster (Phase 7B).

Three selectable sources (POST /api/v1/live/control):
  LIVE_FEED   Baguio City real-time rate + 0-60 min trajectory from Open-Meteo (`current`,
              `minutely_15`, `hourly`), or Tomorrow.io 1-min nowcast when TOMORROW_IO_API_KEY is
              set. 10-min in-memory + disk cache (.cache/weather_feed.json); fetched on a
              background thread so the frame ticker never blocks; last good / dry fallback.
  HISTORICAL  time-indexed Baguio storm hyetographs from public/data/precip_library.json,
              replayed on the storm clock (6 storm-min per wall-s).
  TWIN        the twin's current scenario rainfall (pinned pitch / hardware drive), persisted.
The 4-station FEWS orographic weighting is applied on top of every source by the forecaster.
"""
from __future__ import annotations

import json
import math
import os
import threading
import time
import urllib.request
from datetime import datetime, timedelta
from pathlib import Path

from .stgnn import DATA_DIR, STEPS

ROOT = Path(__file__).resolve().parents[1]
CACHE_PATH = ROOT / ".cache" / "weather_feed.json"
CACHE_TTL_S = 600.0
LAT, LON = 16.4093, 120.5863
OPEN_METEO_URL = (
    f"https://api.open-meteo.com/v1/forecast?latitude={LAT}&longitude={LON}"
    "&current=temperature_2m,precipitation,rain,showers,weather_code,wind_speed_10m"
    "&minutely_15=precipitation&hourly=precipitation&forecast_minutely_15=8&forecast_hours=3"
    "&timezone=Asia%2FManila"
)
TOMORROW_URL = f"https://api.tomorrow.io/v4/weather/forecast?location={LAT},{LON}&timesteps=1m&units=metric"
SOURCES = ("LIVE_FEED", "HISTORICAL", "TWIN")
DESIGN_STORM_ID = "DESIGN_TYPHOON_12H"


def load_library(data_dir: Path = DATA_DIR) -> dict:
    return json.loads((data_dir / "precip_library.json").read_text(encoding="utf-8"))


def hyetograph_rate(storm: dict, minute: float) -> float:
    """Linear interpolation of the 10-min hyetograph; the storm loops after its duration."""
    rates = storm["rate_mm_hr"]
    dur = storm["duration_min"]
    m = minute % dur if dur > 0 else 0.0
    x = m / storm["step_min"]
    i = min(int(math.floor(x)), len(rates) - 2)
    f = x - i
    return rates[i] + (rates[i + 1] - rates[i]) * f


def hyetograph_trajectory(storm: dict, minute: float) -> list[float]:
    return [hyetograph_rate(storm, minute + t) for t in range(STEPS + 1)]


def _parse_local(ts: str) -> datetime:
    return datetime.fromisoformat(ts.replace("Z", ""))


def parse_open_meteo(payload: dict) -> dict:
    """Current rate + per-minute 0..60 trajectory. `minutely_15[i]` is the total over the 15 min
    ending at time[i] (x4 -> mm/hr); beyond it the hourly total is already mm/hr."""
    cur = payload["current"]
    interval = cur.get("interval") or 900
    total = max(cur.get("precipitation") or 0.0, (cur.get("rain") or 0.0) + (cur.get("showers") or 0.0), 0.0)
    now_rate = min(total * 3600.0 / interval, 250.0)
    now = _parse_local(cur["time"])
    m15 = payload.get("minutely_15") or {}
    q = [(_parse_local(t), (v or 0.0) * 4.0) for t, v in zip(m15.get("time", []), m15.get("precipitation", []))]
    hr = payload.get("hourly") or {}
    h = [(_parse_local(t), v or 0.0) for t, v in zip(hr.get("time", []), hr.get("precipitation", []))]
    traj = [now_rate]
    last = now_rate
    for t in range(1, STEPS + 1):
        at = now + timedelta(minutes=t)
        rate = next((v for end, v in q if end >= at and end - timedelta(minutes=15) < at), None)
        if rate is None:
            rate = next((v for end, v in h if end >= at and end - timedelta(hours=1) < at), None)
        last = last if rate is None else min(max(rate, 0.0), 250.0)
        traj.append(last)
    return dict(provider="OPEN_METEO", observed_at=cur["time"], current_mm_hr=round(now_rate, 3),
                temperature_c=cur.get("temperature_2m"), weather_code=cur.get("weather_code"),
                trajectory_mm_hr=[round(x, 3) for x in traj])


def parse_tomorrow(payload: dict) -> dict:
    mins = (payload.get("timelines") or {}).get("minutely") or []
    if not mins:
        raise ValueError("Tomorrow.io: no minutely timeline")
    vals = [min(max(float(m["values"].get("precipitationIntensity") or 0.0), 0.0), 250.0) for m in mins[: STEPS + 1]]
    while len(vals) < STEPS + 1:
        vals.append(vals[-1])
    first = mins[0]["values"]
    return dict(provider="TOMORROW_IO", observed_at=mins[0].get("time"), current_mm_hr=round(vals[0], 3),
                temperature_c=first.get("temperature"), weather_code=None, trajectory_mm_hr=[round(x, 3) for x in vals])


def _http_json(url: str, headers: dict | None = None, timeout: float = 8.0) -> dict:
    req = urllib.request.Request(url, headers={"User-Agent": "citycamp-digital-twin/0.7", **(headers or {})})
    with urllib.request.urlopen(req, timeout=timeout) as r:  # noqa: S310 (fixed https URLs)
        return json.loads(r.read().decode("utf-8"))


class LiveFeed:
    """Cached real-time precipitation feed. `snapshot()` never blocks."""

    def __init__(self, cache_path: Path = CACHE_PATH, fetch=_http_json):
        self.cache_path = cache_path
        self.fetch = fetch
        self.data: dict | None = None
        self.fetched_at = 0.0
        self.error: str | None = None
        self._lock = threading.Lock()
        self._inflight = False
        self._load_disk()

    def _load_disk(self) -> None:
        try:
            blob = json.loads(self.cache_path.read_text(encoding="utf-8"))
            self.data, self.fetched_at = blob["data"], float(blob["fetched_at"])
        except (OSError, ValueError, KeyError):
            pass

    def refresh(self) -> None:
        """Blocking fetch (Tomorrow.io first when a key is set, then Open-Meteo)."""
        key = os.environ.get("TOMORROW_IO_API_KEY")
        data, err = None, None
        if key:
            try:
                data = parse_tomorrow(self.fetch(TOMORROW_URL, {"apikey": key, "accept": "application/json"}))
            except Exception as exc:  # fall through to Open-Meteo
                err = f"tomorrow.io: {exc}"
        if data is None:
            try:
                data = parse_open_meteo(self.fetch(OPEN_METEO_URL))
            except Exception as exc:
                err = f"{err + '; ' if err else ''}open-meteo: {exc}"
        with self._lock:
            if data is not None:
                self.data, self.fetched_at, self.error = data, time.time(), None
                try:
                    self.cache_path.parent.mkdir(parents=True, exist_ok=True)
                    self.cache_path.write_text(json.dumps(dict(fetched_at=self.fetched_at, data=data)), encoding="utf-8")
                except OSError:
                    pass
            else:
                self.error = err
            self._inflight = False

    def refresh_async(self) -> None:
        with self._lock:
            if self._inflight or (self.data is not None and time.time() - self.fetched_at < CACHE_TTL_S and self.error is None):
                return
            self._inflight = True
        threading.Thread(target=self.refresh, daemon=True).start()

    def snapshot(self) -> dict:
        """Latest trajectory with status LIVE (fresh), STALE (cached, older than TTL) or OFFLINE."""
        self.refresh_async()
        with self._lock:
            if self.data is None:
                return dict(status="OFFLINE", provider=None, observed_at=None, current_mm_hr=None,
                            trajectory_mm_hr=None, error=self.error)
            age = time.time() - self.fetched_at
            return dict(self.data, status="LIVE" if age < CACHE_TTL_S else "STALE", age_s=round(age, 1), error=self.error)
