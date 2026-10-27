#!/usr/bin/env python3
"""
Deterministic 3D GIS topology + pre-computed hydraulic LUT generator for the
City Camp Lagoon Catchment digital twin (Baguio City, Philippines).

Outputs (default directory: <repo>/public/data/):
  city_camp_network.json  nodes, conduits, trash-rack orifice, lagoon bowl,
                          building footprints and the 10 Edge-AI sensor nodes
  simulation_lut.json     hydraulic results for every (rainfall, trash-rack
                          blockage) grid cell, incl. packed 32-bit telemetry

Runs fully offline with numpy + the standard library. `--osmnx` optionally
replaces the synthetic building footprints with OpenStreetMap footprints when
osmnx/geopandas are installed and the network is reachable.

All geometry is SYNTHETIC (source_type = SYNTHETIC_OSMNX) and anchored on the
lagoon centroid; it is a plausible stand-in to be hot-swapped with
LGU_FIELD_VERIFIED / DPWH_AS_BUILT_CAD records. See CLAUDE.md for the rules.

Usage:
  python scripts/generate_citycamp_twin_data.py [--out-dir DIR] [--osmnx] [--quiet]
"""
from __future__ import annotations

import argparse
import json
import math
import sys
from functools import lru_cache
from pathlib import Path

import numpy as np

SCHEMA_VERSION = "1.0.0"
G = 9.80665

# ---------------------------------------------------------------------------
# Site constants
# ---------------------------------------------------------------------------
LAGOON_LON, LAGOON_LAT = 120.5863, 16.4093
LAGOON_NODE_ID = "CITY_CAMP_LAGOON_STORAGE"
TRASH_RACK_ID = "CITY_CAMP_TRASH_RACK"
LAGOON_INVERT_M = 1426.5
LAGOON_MAX_DEPTH_M = 6.5
LAGOON_RIM_M = LAGOON_INVERT_M + LAGOON_MAX_DEPTH_M
LAGOON_AREA_M2 = 30_000.0           # 3 ha at the rim
LAGOON_BOTTOM_AREA_M2 = 12_000.0    # bowl floor (frustum stage-storage)
LAGOON_PERMANENT_POOL_M = 1.5       # dead storage below rack sill (sealed karst pores)
LAGOON_SEEPAGE_CMS = 0.01           # residual percolation through silted doline floor
SPILL_CREST_LENGTH_M = 60.0         # low point of the bowl rim (street overflow)
SPILL_WEIR_COEFF = 1.70             # broad-crested weir, SI units
FLOOD_SHEET_DEPTH_M = 0.30          # mean street-flooding depth once the rim spills

RACK_SILL_ELEV_M = LAGOON_INVERT_M + LAGOON_PERMANENT_POOL_M
RACK_WIDTH_M = 3.0
RACK_HEIGHT_M = 2.0
RACK_BAR_THICKNESS_M = 0.012
RACK_BAR_SPACING_M = 0.050
RACK_BAR_ANGLE_DEG = 75.0
RACK_BAR_SHAPE_FACTOR = 2.42        # Kirschmer beta, sharp-edged rectangular bars
RACK_CD = 0.60
RACK_OPEN_RATIO = RACK_BAR_SPACING_M / (RACK_BAR_SPACING_M + RACK_BAR_THICKNESS_M)
XI_CLEAN = (RACK_BAR_SHAPE_FACTOR
            * (RACK_BAR_THICKNESS_M / RACK_BAR_SPACING_M) ** (4.0 / 3.0)
            * math.sin(math.radians(RACK_BAR_ANGLE_DEG)))

TUNNEL_INTAKE_INVERT_M = 1418.0     # bottom of the intake drop shaft
TUNNEL_BEARING_MATH_RAD = math.radians(210.0)   # toward Crystal Cave (WSW)

BOX_COVER_M = 1.0
PIPE_COVER_M = 1.2
MIN_SLOPE = 0.005
BASEFLOW_CMS_PER_HA = 0.0005
INLET_TIME_MIN = 5.0
ARCH_ENTRANCE_K = 0.5

RAINFALL_GRID = [0, 25, 50, 75, 100, 150, 200, 250]
BLOCKAGE_GRID = [0, 25, 50, 75, 90, 95]
REFERENCE_SCENARIOS = [(25, 0), (200, 85)]
STORM_DURATION_MIN = 180            # LUT reports the state at the end of this burst
OVERFLOW_HORIZON_MIN = 720          # time-to-overflow search horizon (sustained rain)
SIM_DT_S = 30.0
SERIES_STEP_MIN = 10

SOURCE_TYPE = "SYNTHETIC_OSMNX"
RNG_SEED = 20240917
TARGET_BUILDINGS = 84

STATUS_THRESHOLDS = {"ELEVATED": 0.50, "CRITICAL": 0.85}
CAPACITY_RATIO_CAP = 1.27

ANOMALY_CODES = {
    "NORMAL": 0, "FLASH_SURGE": 1, "TRASH_BLOCKAGE": 2, "SUPERCRITICAL": 3,
    "SURCHARGED": 4, "SENSOR_FAULT": 5, "LOW_BATTERY": 6,
}
ANOMALY_NAMES = {v: k for k, v in ANOMALY_CODES.items()}
FLASH_DHDT_MM_MIN = 15.0
FLASH_TURBULENCE = 0.45
BLOCKAGE_H_RATIO = 0.60
BLOCKAGE_TURBULENCE = 0.25

# ---------------------------------------------------------------------------
# Geodesy: Transverse Mercator (Krueger n-series), ECEF, 7-parameter Helmert
# ---------------------------------------------------------------------------
WGS84 = (6378137.0, 1.0 / 298.257223563)
CLARKE_1866 = (6378206.4, (6378206.4 - 6356583.8) / 6378206.4)

# PRS92 -> WGS84, PROJ "+towgs84" Position-Vector convention (EPSG:4683 definition).
# Rotations in arc-seconds, scale in ppm. The inverse (WGS84 -> PRS92) is the exact
# sign negation of all seven terms to first order (sub-mm at this magnitude).
PRS92_TO_WGS84 = (-127.62153, -67.24339, -47.04738, 3.06803, -4.90297, -1.57807, -1.06002)


class TransverseMercator:
    def __init__(self, ellipsoid, lon0_deg, k0, false_e, false_n):
        a, f = ellipsoid
        n = f / (2.0 - f)
        self.k0, self.fe, self.fn = k0, false_e, false_n
        self.lon0 = math.radians(lon0_deg)
        self.e = math.sqrt(f * (2.0 - f))
        self.A = a / (1.0 + n) * (1.0 + n**2 / 4.0 + n**4 / 64.0)
        self.alpha = (n / 2 - 2 * n**2 / 3 + 5 * n**3 / 16 + 41 * n**4 / 180,
                      13 * n**2 / 48 - 3 * n**3 / 5 + 557 * n**4 / 1440,
                      61 * n**3 / 240 - 103 * n**4 / 140,
                      49561 * n**4 / 161280)
        self.beta = (n / 2 - 2 * n**2 / 3 + 37 * n**3 / 96 - n**4 / 360,
                     n**2 / 48 + n**3 / 15 - 437 * n**4 / 1440,
                     17 * n**3 / 480 - 37 * n**4 / 840,
                     4397 * n**4 / 161280)
        self.delta = (2 * n - 2 * n**2 / 3 - 2 * n**3 + 116 * n**4 / 45,
                      7 * n**2 / 3 - 8 * n**3 / 5 - 227 * n**4 / 45,
                      56 * n**3 / 15 - 136 * n**4 / 35,
                      4279 * n**4 / 630)

    def forward(self, lon_deg, lat_deg):
        phi, dlam = math.radians(lat_deg), math.radians(lon_deg) - self.lon0
        sp = math.sin(phi)
        t = math.sinh(math.atanh(sp) - self.e * math.atanh(self.e * sp))
        xi_p = math.atan2(t, math.cos(dlam))
        eta_p = math.atanh(math.sin(dlam) / math.sqrt(1.0 + t * t))
        xi, eta = xi_p, eta_p
        for j, a in enumerate(self.alpha, start=1):
            xi += a * math.sin(2 * j * xi_p) * math.cosh(2 * j * eta_p)
            eta += a * math.cos(2 * j * xi_p) * math.sinh(2 * j * eta_p)
        return self.fe + self.k0 * self.A * eta, self.fn + self.k0 * self.A * xi

    def inverse(self, easting, northing):
        xi = (northing - self.fn) / (self.k0 * self.A)
        eta = (easting - self.fe) / (self.k0 * self.A)
        xi_p, eta_p = xi, eta
        for j, b in enumerate(self.beta, start=1):
            xi_p -= b * math.sin(2 * j * xi) * math.cosh(2 * j * eta)
            eta_p -= b * math.cos(2 * j * xi) * math.sinh(2 * j * eta)
        chi = math.asin(math.sin(xi_p) / math.cosh(eta_p))
        phi = chi + sum(d * math.sin(2 * j * chi) for j, d in enumerate(self.delta, start=1))
        lam = self.lon0 + math.atan2(math.sinh(eta_p), math.cos(xi_p))
        return math.degrees(lam), math.degrees(phi)


UTM51N = TransverseMercator(WGS84, 123.0, 0.9996, 500000.0, 0.0)        # EPSG:32651
PTM_ZONE3 = TransverseMercator(CLARKE_1866, 121.0, 0.99995, 500000.0, 0.0)  # EPSG:3123


def geodetic_to_ecef(lon_deg, lat_deg, h, ellipsoid):
    a, f = ellipsoid
    e2 = f * (2 - f)
    phi, lam = math.radians(lat_deg), math.radians(lon_deg)
    nu = a / math.sqrt(1 - e2 * math.sin(phi) ** 2)
    return ((nu + h) * math.cos(phi) * math.cos(lam),
            (nu + h) * math.cos(phi) * math.sin(lam),
            (nu * (1 - e2) + h) * math.sin(phi))


def ecef_to_geodetic(x, y, z, ellipsoid):
    a, f = ellipsoid
    e2 = f * (2 - f)
    lam = math.atan2(y, x)
    p = math.hypot(x, y)
    phi = math.atan2(z, p * (1 - e2))
    for _ in range(8):
        nu = a / math.sqrt(1 - e2 * math.sin(phi) ** 2)
        h = p / math.cos(phi) - nu
        phi = math.atan2(z, p * (1 - e2 * nu / (nu + h)))
    nu = a / math.sqrt(1 - e2 * math.sin(phi) ** 2)
    return math.degrees(lam), math.degrees(phi), p / math.cos(phi) - nu


def helmert_position_vector(xyz, params, inverse=False):
    tx, ty, tz, rx, ry, rz, s_ppm = params
    sign = -1.0 if inverse else 1.0
    sec = math.pi / (180.0 * 3600.0)
    rx, ry, rz = sign * rx * sec, sign * ry * sec, sign * rz * sec
    tx, ty, tz, s = sign * tx, sign * ty, sign * tz, 1.0 + sign * s_ppm * 1e-6
    x, y, z = xyz
    return (tx + s * (x - rz * y + ry * z),
            ty + s * (rz * x + y - rx * z),
            tz + s * (-ry * x + rx * y + z))


def wgs84_to_ptm3(lon, lat, h):
    xyz = helmert_position_vector(geodetic_to_ecef(lon, lat, h, WGS84), PRS92_TO_WGS84, inverse=True)
    plon, plat, _ = ecef_to_geodetic(*xyz, CLARKE_1866)
    return PTM_ZONE3.forward(plon, plat)


ORIGIN_E, ORIGIN_N = UTM51N.forward(LAGOON_LON, LAGOON_LAT)


def local_to_lonlat(x, y):
    """Local metres (offsets in EPSG:32651 from the lagoon centroid) -> lon/lat."""
    return UTM51N.inverse(ORIGIN_E + x, ORIGIN_N + y)


# ---------------------------------------------------------------------------
# Terrain (synthetic DEM of the karst bowl, ridges and the SW Rock Quarry descent)
# ---------------------------------------------------------------------------
def smoothstep(e0, e1, x):
    t = min(max((x - e0) / (e1 - e0), 0.0), 1.0)
    return t * t * (3.0 - 2.0 * t)


def angdiff(a, b):
    return (a - b + math.pi) % (2.0 * math.pi) - math.pi


def ground_elev(x, y):
    r, th = math.hypot(x, y), math.atan2(y, x)
    bowl = (LAGOON_RIM_M + 42.0 * smoothstep(120.0, 360.0, r)
            + 3.0 * math.sin(3.0 * th + 0.7) * smoothstep(150.0, 450.0, r))
    southwest = (LAGOON_RIM_M + 9.0 * smoothstep(110.0, 260.0, r)
                 - 19.0 * smoothstep(300.0, 1300.0, r)
                 - 30.0 * smoothstep(1350.0, 2500.0, r))
    w = math.exp(-(angdiff(th, TUNNEL_BEARING_MATH_RAD) / math.radians(40.0)) ** 2)
    return (1.0 - w) * bowl + w * southwest


# ---------------------------------------------------------------------------
# Lagoon bowl polygon & stage-storage
# ---------------------------------------------------------------------------
def _lagoon_shape(th):
    return 1.0 + 0.10 * math.sin(2.0 * th + 0.6) + 0.06 * math.cos(3.0 * th - 0.4)


def _shoelace(pts):
    return 0.5 * abs(sum(x0 * y1 - x1 * y0 for (x0, y0), (x1, y1) in zip(pts, pts[1:] + pts[:1])))


_LAGOON_VERTS = 96
_unit = [(_lagoon_shape(2 * math.pi * k / _LAGOON_VERTS) * math.cos(2 * math.pi * k / _LAGOON_VERTS),
          _lagoon_shape(2 * math.pi * k / _LAGOON_VERTS) * math.sin(2 * math.pi * k / _LAGOON_VERTS))
         for k in range(_LAGOON_VERTS)]
LAGOON_R0 = math.sqrt(LAGOON_AREA_M2 / _shoelace(_unit))


def lagoon_radius(th):
    return LAGOON_R0 * _lagoon_shape(th)


def rim_point(az_deg, outward_m=0.0):
    th = math.radians(az_deg)
    r = lagoon_radius(th) + outward_m
    return r * math.cos(th), r * math.sin(th)


def lagoon_surface_area(h):
    if h >= LAGOON_MAX_DEPTH_M:
        return LAGOON_AREA_M2
    return LAGOON_BOTTOM_AREA_M2 + (LAGOON_AREA_M2 - LAGOON_BOTTOM_AREA_M2) * max(h, 0.0) / LAGOON_MAX_DEPTH_M


_FRUSTUM_A = (LAGOON_AREA_M2 - LAGOON_BOTTOM_AREA_M2) / (2.0 * LAGOON_MAX_DEPTH_M)
LAGOON_FULL_VOLUME_M3 = LAGOON_BOTTOM_AREA_M2 * LAGOON_MAX_DEPTH_M + _FRUSTUM_A * LAGOON_MAX_DEPTH_M**2


def lagoon_volume(h):
    if h <= LAGOON_MAX_DEPTH_M:
        return LAGOON_BOTTOM_AREA_M2 * h + _FRUSTUM_A * h * h
    return LAGOON_FULL_VOLUME_M3 + LAGOON_AREA_M2 * (h - LAGOON_MAX_DEPTH_M)


def lagoon_depth(volume):
    if volume <= LAGOON_FULL_VOLUME_M3:
        b = LAGOON_BOTTOM_AREA_M2
        return (-b + math.sqrt(b * b + 4.0 * _FRUSTUM_A * max(volume, 0.0))) / (2.0 * _FRUSTUM_A)
    return LAGOON_MAX_DEPTH_M + (volume - LAGOON_FULL_VOLUME_M3) / LAGOON_AREA_M2


# ---------------------------------------------------------------------------
# Cross-section hydraulics (tabulated, shape-exact)
# ---------------------------------------------------------------------------
SECTION_SAMPLES = 4001


class Section:
    """Depth-tabulated geometry for CIRCULAR, RECT_CLOSED (haunched) and ARCH conduits.

    Conveyance K(y) = A * R^(2/3); Manning Q = K * sqrt(S) / n. The maximum of K
    below the crown gives the closed-conduit capacity paradox (h/D = 0.938 for a
    circle); flows above Q_max have no free-surface solution and surcharge.
    """

    def __init__(self, shape, rise, span, haunch=0.0):
        self.shape, self.rise, self.span, self.haunch = shape, rise, span, haunch
        y = np.linspace(0.0, rise, SECTION_SAMPLES)
        a, p, t = self._props(y)
        r = np.divide(a, p, out=np.zeros_like(a), where=p > 0)
        k = a * r ** (2.0 / 3.0)
        self._y, self._a, self._t, self._k = y, a, t, k
        self.i_max = int(np.argmax(k))
        self._k_rising = np.maximum.accumulate(k[: self.i_max + 1])
        self.k_max = float(k[self.i_max])
        self.y_qmax = float(y[self.i_max])
        self.k_full = float(k[-1])
        self.a_full = float(a[-1])

    def _props(self, y):
        H, b, hh = self.rise, self.span, self.haunch
        if self.shape == "CIRCULAR":
            theta = 2.0 * np.arccos(np.clip(1.0 - 2.0 * y / H, -1.0, 1.0))
            return (H * H / 8.0 * (theta - np.sin(theta)), H * theta / 2.0, H * np.sin(theta / 2.0))
        if self.shape == "RECT_CLOSED":
            bot = np.minimum(y, hh)
            mid = np.clip(np.minimum(y, H - hh) - hh, 0.0, None)
            top = np.clip(y - (H - hh), 0.0, None)
            area = b * y - 2.0 * (hh * bot - bot**2 / 2.0) - top**2
            width = b - 2.0 * np.clip(hh - y, 0.0, None) - 2.0 * top
            # Soffit contact ramps in over the last 2 % of rise (avoids a perimeter step).
            closure = np.clip((y - 0.98 * H) / (0.02 * H), 0.0, 1.0)
            perim = (b - 2.0 * hh) + 2.0 * (math.sqrt(2.0) * bot + mid + math.sqrt(2.0) * top) \
                + closure * (b - 2.0 * hh)
            return area, perim, width
        if self.shape == "ARCH":
            rc = b / 2.0
            hw = H - rc
            yr = np.minimum(y, hw)
            z = np.clip(y - hw, 0.0, rc)
            area = b * yr + z * np.sqrt(rc * rc - z * z) + rc * rc * np.arcsin(z / rc)
            perim = b + 2.0 * yr + 2.0 * rc * np.arcsin(z / rc)
            width = np.where(y <= hw, b, 2.0 * np.sqrt(np.clip(rc * rc - z * z, 0.0, None)))
            return area, perim, width
        raise ValueError(f"unknown shape {self.shape}")

    def q_full(self, n, s):
        return self.k_full * math.sqrt(s) / n

    def q_max(self, n, s):
        return self.k_max * math.sqrt(s) / n

    def normal_depth(self, q, n, s):
        if q <= 0.0:
            return 0.0
        k_req = q * n / math.sqrt(s)
        if k_req > self.k_max:
            return None
        return float(np.interp(k_req, self._k_rising, self._y[: self.i_max + 1]))

    def area(self, y):
        return float(np.interp(y, self._y, self._a))

    def top_width(self, y):
        return float(np.interp(y, self._y, self._t))

    def conveyance(self, y):
        return float(np.interp(y, self._y, self._k))

    def froude(self, q, y):
        a, t = self.area(y), self.top_width(y)
        if q <= 0.0 or a <= 1e-9:
            return 0.0
        if t <= 1e-4:
            return None
        return (q / a) / math.sqrt(G * a / t)


@lru_cache(maxsize=None)
def get_section(shape, rise, span, haunch):
    return Section(shape, rise, span, haunch)


def steep_slope(s0):
    """Energy slope term for steep channels: S = sin(atan(S0))."""
    return math.sin(math.atan(s0))


def kirpich_tc_min(length_m, slope):
    return INLET_TIME_MIN + 0.0195 * max(length_m, 1.0) ** 0.77 * max(slope, MIN_SLOPE) ** -0.385


# ---------------------------------------------------------------------------
# Network definition (synthetic, geographically anchored layout)
# ---------------------------------------------------------------------------
BOX_30x18 = ("RECT_CLOSED", 1.8, 3.0, 0.229)
BOX_35x20 = ("RECT_CLOSED", 2.0, 3.5, 0.305)
TUNNEL_BOX = ("RECT_CLOSED", 2.7, 2.5, 0.152)
TUNNEL_ARCH = ("ARCH", 1.7, 1.5, 0.0)


def pipe(d):
    return ("CIRCULAR", d, d, 0.0)


# x = east, y = north, metres from the lagoon centroid (EPSG:32651 offsets).
# outlet: ("STORAGE", rim azimuth deg) | ("JOIN", corridor code, waypoint index)
CORRIDORS = [
    dict(code="LGD", road="Legarda Road", barangay="City Camp Central", kind="ARTERIAL",
         waypoints=[(560, 470), (470, 400), (390, 345), (320, 290), (250, 235), (190, 175), (140, 120)],
         outlet=("STORAGE", 42.0), sections=(BOX_30x18, BOX_35x20), area_ha=18.0, runoff_c=0.85),
    dict(code="DHR", road="Dominican Hill Road", barangay="Lourdes Subdivision Extension", kind="ARTERIAL",
         waypoints=[(-620, 240), (-525, 215), (-435, 182), (-350, 150), (-270, 115), (-190, 75), (-135, 40)],
         outlet=("STORAGE", 160.0), sections=(BOX_30x18, BOX_30x18), area_ha=14.0, runoff_c=0.82),
    dict(code="KSD", road="Kisad Road", barangay="City Camp Proper", kind="ARTERIAL",
         waypoints=[(60, 640), (40, 545), (18, 455), (-2, 365), (0, 280), (8, 200), (12, 135)],
         outlet=("STORAGE", 92.0), sections=(BOX_30x18, BOX_30x18), area_ha=12.0, runoff_c=0.85),
    dict(code="QOP", road="Queen of Peace Road", barangay="Middle Rock Quarry", kind="ARTERIAL",
         waypoints=[(430, -520), (372, -432), (308, -348), (244, -272), (182, -202), (125, -138)],
         outlet=("STORAGE", -48.0), sections=(BOX_30x18, BOX_35x20), area_ha=16.0, runoff_c=0.85),
    dict(code="GSF", road="Guisad Surong Feeder", barangay="Guisad Surong", kind="FEEDER",
         waypoints=[(-66, 392), (-60, 340), (-52, 295), (-44, 251)],
         outlet=("JOIN", "KSD", 5), sections=(pipe(0.6), pipe(0.9)), area_ha=10.0, runoff_c=0.80),
    dict(code="LEF", road="Lourdes Extension Feeder", barangay="Lourdes Subdivision Extension", kind="FEEDER",
         waypoints=[(-560, 470), (-505, 385), (-455, 305), (-405, 225)],
         outlet=("JOIN", "DHR", 3), sections=(pipe(0.9), pipe(0.9)), area_ha=5.0, runoff_c=0.80),
    dict(code="CCP", road="City Camp Proper Feeder", barangay="City Camp Proper", kind="FEEDER",
         waypoints=[(-390, -40), (-315, 5), (-250, 40)],
         outlet=("JOIN", "DHR", 5), sections=(pipe(0.6), pipe(0.6)), area_ha=3.0, runoff_c=0.85),
    dict(code="CCC", road="City Camp Central Feeder", barangay="City Camp Central", kind="FEEDER",
         waypoints=[(450, 70), (370, 100), (290, 140)],
         outlet=("JOIN", "LGD", 5), sections=(pipe(0.9), pipe(0.9)), area_ha=5.0, runoff_c=0.85),
    dict(code="URQ", road="Upper Rock Quarry Feeder", barangay="Upper Rock Quarry", kind="FEEDER",
         waypoints=[(138, -380), (123, -338), (108, -296), (92, -254)],
         outlet=("JOIN", "QOP", 5), sections=(pipe(0.6), pipe(0.9)), area_ha=10.0, runoff_c=0.80),
    dict(code="MRQ", road="Middle Rock Quarry Feeder", barangay="Middle Rock Quarry", kind="FEEDER",
         waypoints=[(520, -190), (430, -185), (340, -195), (260, -200)],
         outlet=("JOIN", "QOP", 4), sections=(pipe(0.6), pipe(0.6)), area_ha=4.0, runoff_c=0.82),
]

# Lower Rock Quarry (~1,423 m ASL) sits below the lagoon invert, so it cannot drain
# into the bowl: it drops into the tunnel at TUN-J08 instead.
LRQ_CORRIDOR = dict(code="LRQ", road="Lower Rock Quarry Lateral", barangay="Lower Rock Quarry",
                    kind="LATERAL", offsets=[(190, 330), (130, 225), (65, 115)],
                    outlet=("JOIN", "TUN", 8), sections=(pipe(1.2), pipe(1.2)), area_ha=8.0, runoff_c=0.80)

# (length m, kind, slope) — C concreted box, T concreted transition apron, A unfinished rock arch
TUNNEL_PLAN = [(220, "C", 0.013), (80, "T", 0.005), (160, "A", 0.010), (300, "C", 0.013),
               (120, "A", 0.010), (250, "C", 0.013), (90, "A", 0.010), (260, "C", 0.013),
               (320, "C", 0.013), (350, "C", 0.013), (250, "C", 0.013)]
TUNNEL_LATERAL_NODE = 8

SENSOR_PLAN = [
    ("EN-01", "Guisad Surong hillside tributary", "HILLSIDE_TRIBUTARY", "CONDUIT", "GSF-C02", 4.12),
    ("EN-02", "Upper Rock Quarry hillside tributary", "HILLSIDE_TRIBUTARY", "CONDUIT", "URQ-C02", 4.04),
    ("EN-03", "Legarda Rd RCBC lagoon outlet", "ARTERIAL_BOX_CULVERT", "CONDUIT", "LGD-C07", 3.96),
    ("EN-04", "Dominican Hill Rd RCBC mid-reach", "ARTERIAL_BOX_CULVERT", "CONDUIT", "DHR-C04", 4.08),
    ("EN-05", "Kisad Rd RCBC mid-reach", "ARTERIAL_BOX_CULVERT", "CONDUIT", "KSD-C03", 3.88),
    ("EN-06", "Queen of Peace Rd RCBC lagoon outlet", "ARTERIAL_BOX_CULVERT", "CONDUIT", "QOP-C06", 3.92),
    ("EN-07", "City Camp Lagoon bowl stage", "LAGOON_BOWL", "STORAGE", LAGOON_NODE_ID, 4.16),
    ("EN-08", "Trash rack intake ultrasonic", "TRASH_RACK_ULTRASONIC", "ORIFICE", TRASH_RACK_ID, 3.84),
    ("EN-09", "Trash rack YOLOv8 vision", "TRASH_RACK_VISION", "ORIFICE", TRASH_RACK_ID, 4.20),
    ("EN-10", "Rock tunnel choke transition", "TUNNEL_CHOKE_TRANSITION", "CONDUIT", "TUN-C02", 3.80),
]


def _record_conduit(conduits, cid, name, road, barangay, kind, frm, to, p0, p1, sec, n):
    shape, rise, span, haunch = sec
    conduits[cid] = dict(id=cid, name=name, road=road, barangay=barangay, kind=kind,
                         from_node=frm, to_node=to, p0=p0, p1=p1, shape=shape, rise=rise,
                         span=span, haunch=haunch, manning_n=n,
                         section=get_section(shape, rise, span, haunch))


def build_network():
    nodes, conduits = {}, {}

    def add_node(nid, ntype, name, barangay, xy, area_ha=0.0, c=0.0, invert=None, kind=None):
        nodes[nid] = dict(id=nid, type=ntype, name=name, barangay=barangay, xy=xy,
                          ground=ground_elev(*xy), area_ha=area_ha, runoff_c=c, invert=invert, kind=kind)

    nodes[LAGOON_NODE_ID] = dict(id=LAGOON_NODE_ID, type="STORAGE", name="City Camp Lagoon (karst doline)",
                                 barangay="City Camp Central", xy=(0.0, 0.0), ground=LAGOON_RIM_M,
                                 area_ha=LAGOON_AREA_M2 / 1e4, runoff_c=1.0, invert=LAGOON_INVERT_M,
                                 kind="STORAGE")

    # --- Main City Camp -> Crystal Cave tunnel (inverts fixed by design grade)
    rack_xy = rim_point(math.degrees(TUNNEL_BEARING_MATH_RAD))
    intake_xy = rim_point(math.degrees(TUNNEL_BEARING_MATH_RAD), 10.0)
    ux, uy = math.cos(TUNNEL_BEARING_MATH_RAD), math.sin(TUNNEL_BEARING_MATH_RAD)
    px, py = -uy, ux
    total = sum(seg[0] for seg in TUNNEL_PLAN)

    def tunnel_xy(s):
        bend = 35.0 * math.sin(2.0 * math.pi * s / total)
        return intake_xy[0] + ux * s + px * bend, intake_xy[1] + uy * s + py * bend

    s, inv = 0.0, TUNNEL_INTAKE_INVERT_M
    add_node("TUN-J00", "JUNCTION", "Trash-rack intake drop shaft", "City Camp Central", intake_xy,
             invert=inv, kind="TUNNEL")
    for i, (length, kind, slope) in enumerate(TUNNEL_PLAN, start=1):
        s += length
        inv_next = inv - slope * length
        last = i == len(TUNNEL_PLAN)
        nid = "TUN-OUT" if last else f"TUN-J{i:02d}"
        label = ("Crystal Cave tunnel outfall portal" if last else
                 "Lower Rock Quarry lateral junction" if i == TUNNEL_LATERAL_NODE else
                 f"Tunnel station {s:.0f} m")
        add_node(nid, "OUTFALL" if last else "JUNCTION", label,
                 "Lower Rock Quarry" if s > 900 else "City Camp Central", tunnel_xy(s), invert=inv_next,
                 kind="TUNNEL")
        sec, n, desc = ((TUNNEL_ARCH, 0.030, "unfinished bedrock choke (ARCH)") if kind == "A" else
                        (TUNNEL_BOX, 0.013, "concreted transition apron") if kind == "T" else
                        (TUNNEL_BOX, 0.013, "concreted lined segment"))
        cid = f"TUN-C{i:02d}"
        frm = "TUN-J00" if i == 1 else f"TUN-J{i - 1:02d}"
        _record_conduit(conduits, cid, f"City Camp-Crystal Cave tunnel {desc} {i}", "Main Drainage Tunnel",
                        nodes[nid]["barangay"], "TUNNEL", frm, nid, nodes[frm]["xy"], nodes[nid]["xy"], sec, n)
        conduits[cid]["inv_in"], conduits[cid]["inv_out"] = inv, inv_next
        conduits[cid]["segment_class"] = {"A": "UNFINISHED_ROCK_CHOKE", "T": "CONCRETED_TRANSITION",
                                          "C": "CONCRETED_LINED"}[kind]
        inv = inv_next

    # --- Surface collectors and feeders
    lrq_join = nodes[f"TUN-J{TUNNEL_LATERAL_NODE:02d}"]["xy"]
    lrq = dict(LRQ_CORRIDOR, waypoints=[(lrq_join[0] + dx, lrq_join[1] + dy) for dx, dy in LRQ_CORRIDOR["offsets"]])
    for cor in CORRIDORS + [lrq]:
        code, wps = cor["code"], cor["waypoints"]
        share = cor["area_ha"] / len(wps)
        for i, xy in enumerate(wps):
            add_node(f"{code}-J{i:02d}", "JUNCTION", f"{cor['road']} MH-{i + 1:02d}", cor["barangay"], xy,
                     area_ha=share, c=cor["runoff_c"], kind=cor["kind"])
        ids = [f"{code}-J{i:02d}" for i in range(len(wps))]
        pts = list(wps)
        if cor["outlet"][0] == "STORAGE":
            ids.append(LAGOON_NODE_ID)
            pts.append(rim_point(cor["outlet"][1]))
        else:
            _, jcode, jidx = cor["outlet"]
            jid = f"{jcode}-J{jidx:02d}"
            ids.append(jid)
            pts.append(nodes[jid]["xy"])
        n_seg = len(ids) - 1
        for i in range(n_seg):
            sec = cor["sections"][0] if i < n_seg / 2 else cor["sections"][1]
            label = "RCBC" if sec[0] == "RECT_CLOSED" else "RCPC"
            _record_conduit(conduits, f"{code}-C{i + 1:02d}", f"{cor['road']} {label} segment {i + 1}",
                            cor["road"], cor["barangay"], cor["kind"], ids[i], ids[i + 1],
                            pts[i], pts[i + 1], sec, 0.013)

    orifice = dict(id=TRASH_RACK_ID, from_node=LAGOON_NODE_ID, to_node="TUN-J00", xy=rack_xy)
    order = topological_order(nodes, conduits, orifice)
    assign_surface_inverts(nodes, conduits, order)
    finalize_conduits(nodes, conduits, order)
    return dict(nodes=nodes, conduits=conduits, orifice=orifice, order=order)


def topological_order(nodes, conduits, orifice):
    indeg = {nid: 0 for nid in nodes}
    succ = {nid: [] for nid in nodes}
    edges = [(c["from_node"], c["to_node"]) for c in conduits.values()]
    edges.append((orifice["from_node"], orifice["to_node"]))
    for a, b in edges:
        succ[a].append(b)
        indeg[b] += 1
    ready = sorted(nid for nid, d in indeg.items() if d == 0)
    order = []
    while ready:
        nid = ready.pop(0)
        order.append(nid)
        for b in sorted(succ[nid]):
            indeg[b] -= 1
            if indeg[b] == 0:
                ready.append(b)
        ready.sort()
    if len(order) != len(nodes):
        raise RuntimeError("network contains a cycle")
    return order


def _out_conduit(conduits):
    out = {}
    for c in conduits.values():
        if c["from_node"] in out:
            raise RuntimeError(f"node {c['from_node']} has more than one outgoing conduit")
        out[c["from_node"]] = c
    return out


def _in_conduits(conduits):
    inc = {}
    for c in conduits.values():
        inc.setdefault(c["to_node"], []).append(c)
    return inc


def assign_surface_inverts(nodes, conduits, order):
    out, inc = _out_conduit(conduits), _in_conduits(conduits)
    for nid in order:
        node = nodes[nid]
        if node["kind"] in ("TUNNEL", "STORAGE"):
            continue
        c = out[nid]
        cover = BOX_COVER_M if c["shape"] == "RECT_CLOSED" else PIPE_COVER_M
        candidates = [node["ground"] - cover - c["rise"]]
        candidates += [ci["inv_out"] for ci in inc.get(nid, [])]
        node["invert"] = min(candidates)
        length = math.dist(c["p0"], c["p1"])
        c["inv_in"] = node["invert"]
        c["inv_out"] = min(ground_elev(*c["p1"]) - cover - c["rise"], c["inv_in"] - MIN_SLOPE * length)
        if c["to_node"] == LAGOON_NODE_ID and c["inv_out"] < LAGOON_INVERT_M:
            raise RuntimeError(f"{c['id']} outlet below lagoon invert")


def finalize_conduits(nodes, conduits, order):
    inc = _in_conduits(conduits)
    path_len, src_elev = {}, {}
    for nid in order:
        node = nodes[nid]
        node["rim"] = node["ground"]
        ups = inc.get(nid, [])
        if nid == "TUN-J00":
            ups_len, ups_src = path_len.get(LAGOON_NODE_ID, 0.0), src_elev.get(LAGOON_NODE_ID, node["ground"])
        elif ups:
            ups_len = max(path_len[c["from_node"]] + c["length_3d_m"] for c in ups)
            ups_src = max(src_elev[c["from_node"]] for c in ups)
        else:
            ups_len, ups_src = 0.0, node["invert"]
        path_len[nid], src_elev[nid] = ups_len, ups_src
        for c in conduits.values():
            if c["from_node"] != nid:
                continue
            plan = math.dist(c["p0"], c["p1"])
            dz = c["inv_in"] - c["inv_out"]
            c["length_m"] = plan
            c["length_3d_m"] = math.hypot(plan, dz)
            c["slope"] = dz / plan
            c["s_eff"] = steep_slope(max(c["slope"], 1e-4))
            c["q_full"] = c["section"].q_full(c["manning_n"], c["s_eff"])
            c["q_max"] = c["section"].q_max(c["manning_n"], c["s_eff"])
            reach = ups_len + c["length_3d_m"]
            c["tc_min"] = kirpich_tc_min(reach, (ups_src - c["inv_out"]) / reach)


# ---------------------------------------------------------------------------
# Hydrology & hydraulics
# ---------------------------------------------------------------------------
def accumulate_flows(net, rain_mm_hr, intake_inflow_cms):
    nodes, conduits = net["nodes"], net["conduits"]
    out = _out_conduit(conduits)
    total = {nid: 0.0 for nid in nodes}
    for nid in net["order"]:
        node = nodes[nid]
        if node["kind"] != "STORAGE":
            total[nid] += node["area_ha"] * (node["runoff_c"] * rain_mm_hr / 360.0 + BASEFLOW_CMS_PER_HA)
        if nid == "TUN-J00":
            total[nid] += intake_inflow_cms
        c = out.get(nid)
        if c is not None:
            c_q = total[nid]
            total[c["to_node"]] += c_q
    q = {}
    for nid in net["order"]:
        c = out.get(nid)
        if c is not None:
            q[c["id"]] = total[nid]
    return q


def xi_rack(p):
    """Kirschmer coefficient referenced to the gross approach velocity, with blockage p.

    Bars see V / (1 - p), so the loss grows as (1 - p)^-2: 16x at p = 0.75, 400x at 0.95.
    """
    return XI_CLEAN / (1.0 - p) ** 2


def _rack_direct(h, p):
    if h <= 0.0:
        return 0.0
    b_eff = RACK_WIDTH_M * RACK_OPEN_RATIO * (1.0 - p)
    weir = (2.0 / 3.0) * RACK_CD * math.sqrt(2.0 * G) * b_eff * h**1.5
    if h <= RACK_HEIGHT_M:
        return weir
    orifice = RACK_CD * b_eff * RACK_HEIGHT_M * math.sqrt(2.0 * G * (h - RACK_HEIGHT_M / 2.0))
    w = min((h - RACK_HEIGHT_M) / (0.2 * RACK_HEIGHT_M), 1.0)
    return (1.0 - w) * weir + w * orifice


def rack_head_loss(q, h, p):
    if q <= 0.0 or h <= 0.0:
        return 0.0
    v_app = q / (RACK_WIDTH_M * min(h, RACK_HEIGHT_M))
    return xi_rack(p) * v_app**2 / (2.0 * G)


def rack_flow(h, p):
    """Solve Q = Q_orifice/weir(h - dH_kirschmer(Q)) by bisection (monotone residual)."""
    hi = _rack_direct(h, p)
    if hi <= 0.0:
        return 0.0
    lo = 0.0
    for _ in range(60):
        mid = 0.5 * (lo + hi)
        if mid - _rack_direct(h - rack_head_loss(mid, h, p), p) > 0.0:
            hi = mid
        else:
            lo = mid
    return 0.5 * (lo + hi)


@lru_cache(maxsize=None)
def rack_table(p):
    hs = np.linspace(0.0, 9.0, 721)
    return hs, np.array([rack_flow(h, p) for h in hs])


def tunnel_conveyance_limit(net):
    lim = math.inf
    for i in range(1, TUNNEL_LATERAL_NODE + 1):
        c = net["conduits"][f"TUN-C{i:02d}"]
        lim = min(lim, c["q_max"])
    return lim


def simulate_lagoon(q_storm_peak, q_base, tc_min, rain, p, q_tunnel):
    hs_tab, q_tab = rack_table(p)

    def outflows(h):
        hs = h - LAGOON_PERMANENT_POOL_M
        q_rack = float(np.interp(hs, hs_tab, q_tab)) if hs > 0 else 0.0
        q_spill = SPILL_WEIR_COEFF * SPILL_CREST_LENGTH_M * (h - LAGOON_MAX_DEPTH_M) ** 1.5 \
            if h > LAGOON_MAX_DEPTH_M else 0.0
        return q_rack, min(q_rack, q_tunnel), q_spill

    def inflow(t_min, h):
        ramp = min(t_min / tc_min, 1.0) if tc_min > 0 else 1.0
        return q_base + q_storm_peak * ramp + rain / 3.6e6 * lagoon_surface_area(h)

    h = LAGOON_PERMANENT_POOL_M
    vol = lagoon_volume(h)
    spilled, t_overflow, report, series, prev_q_out = 0.0, None, None, [], 0.0
    steps = int(OVERFLOW_HORIZON_MIN * 60 / SIM_DT_S)
    for k in range(steps + 1):
        t_min = k * SIM_DT_S / 60.0
        q_in = inflow(t_min, h)
        q_rack, q_out, q_spill = outflows(h)
        net_q = q_in - q_out - q_spill - LAGOON_SEEPAGE_CMS
        if t_min <= STORM_DURATION_MIN and abs(t_min % SERIES_STEP_MIN) < 1e-9:
            series.append(round(h, 3))
        if t_overflow is None and h >= LAGOON_MAX_DEPTH_M:
            t_overflow = t_min
        if abs(t_min - STORM_DURATION_MIN) < 1e-9:
            hs = h - LAGOON_PERMANENT_POOL_M
            report = dict(depth=h, q_in=q_in, q_out=q_out, q_rack=q_rack, q_spill=q_spill,
                          dh_dt_mm_min=net_q / lagoon_surface_area(h) * 60_000.0,
                          head_loss=rack_head_loss(q_out, hs, p), spilled=spilled,
                          q_out_rate=(q_out - prev_q_out) / (SIM_DT_S / 60.0))
        prev_q_out = q_out
        vol = max(vol + net_q * SIM_DT_S, 0.0)
        spilled += q_spill * SIM_DT_S
        h = lagoon_depth(vol)
    report["t_overflow"] = t_overflow
    report["series"] = series
    if report["depth"] <= LAGOON_MAX_DEPTH_M:
        area = lagoon_surface_area(report["depth"])
    else:
        area = LAGOON_AREA_M2 + report["spilled"] / FLOOD_SHEET_DEPTH_M
    report["inundation_area"] = area
    report["inundation_radius"] = math.sqrt(area / math.pi)
    if report["depth"] <= LAGOON_PERMANENT_POOL_M + 1e-6:
        control = "NONE"
    else:
        control = "TRASH_RACK" if report["q_rack"] < q_tunnel else "TUNNEL_CHOKE"
    report["control"] = control
    return report


def status_for(ratio, pressurized):
    if pressurized:
        return "SURCHARGED"
    if ratio >= STATUS_THRESHOLDS["CRITICAL"]:
        return "CRITICAL"
    if ratio >= STATUS_THRESHOLDS["ELEVATED"]:
        return "ELEVATED"
    return "NORMAL"


def solve_conduit(c, q, hgl_down, rate_down, y_dry, q_rate=None):
    sec, n, s = c["section"], c["manning_n"], c["s_eff"]
    rise, inv_in, inv_out, length = c["rise"], c["inv_in"], c["inv_out"], c["length_3d_m"]
    crown_out = inv_out + rise
    yn = sec.normal_depth(q, n, s)

    def rising(y):
        """Rising-limb rate (m/min): onset signature, or dy/dQ * dQ/dt for lagoon-fed tunnel flow."""
        if q_rate is None:
            return max(y - y_dry, 0.0) / c["tc_min"]
        y_next = sec.normal_depth(max(q + q_rate, 0.0), n, s)
        return ((rise if y_next is None else y_next) - y) if yn is not None else 0.0

    if yn is None:
        pressurized, governed = True, "SELF_SURCHARGE"
        hgl_out = max(hgl_down, crown_out)
        hgl_in = hgl_out + (q * n / sec.k_full) ** 2 * length
        depth, area, rate = rise, sec.a_full, rising(rise)
    else:
        y_bw = hgl_down - inv_out
        if y_bw > yn + 1e-6:
            governed = "BACKWATER"
            if y_bw >= rise:
                pressurized, depth, area = True, rise, sec.a_full
                k = sec.k_full
            else:
                pressurized, depth = False, y_bw
                area, k = sec.area(depth), sec.conveyance(depth)
            sf = (q * n / k) ** 2 if k > 0 else 0.0
            hgl_out = hgl_down
            hgl_in = max(inv_in + yn, hgl_down + sf * length)
            rate = rate_down if hgl_in > inv_in + yn + 1e-6 else rising(yn)
            rate_out = rate_down
        else:
            pressurized, governed, depth = False, "NORMAL", yn
            area, hgl_out, hgl_in = sec.area(yn), inv_out + yn, inv_in + yn
            rate = rising(yn)
            rate_out = rate
    if governed == "SELF_SURCHARGE":
        rate_out = rate
    v = q / area if area > 1e-9 else 0.0
    if c["shape"] == "ARCH":
        hgl_in += ARCH_ENTRANCE_K * v * v / (2.0 * G)
    fr = None if pressurized else sec.froude(q, depth)
    fr_normal = sec.froude(q, yn) if yn is not None else None
    jump = (governed == "BACKWATER" and fr_normal is not None and fr_normal > 1.0
            and (fr is None or fr < 1.0))
    ratio = max(q / c["q_full"], depth / rise)
    if pressurized:
        ratio = max(ratio, 1.0 + max(hgl_out - crown_out, 0.0) / rise)
    ratio = min(ratio, CAPACITY_RATIO_CAP)
    regime = "PRESSURIZED" if pressurized else ("SUPERCRITICAL" if (fr or 0.0) > 1.0 else "SUBCRITICAL")
    return dict(q=q, depth=depth, v=v, fr=fr, ratio=ratio, pressurized=pressurized, governed=governed,
                jump=jump, regime=regime, status=status_for(ratio, pressurized), hgl_in=hgl_in,
                hgl_out=hgl_out, rate_out=rate_out, rate_in=rate)


def run_scenario(net, rain, blockage_pct, q_tunnel, y_dry):
    nodes, conduits = net["nodes"], net["conduits"]
    p = blockage_pct / 100.0
    q_surface = accumulate_flows(net, rain, 0.0)
    q_dry = accumulate_flows(net, 0.0, 0.0)
    into_lagoon = [c for c in conduits.values() if c["to_node"] == LAGOON_NODE_ID]
    q_base = sum(q_dry[c["id"]] for c in into_lagoon)
    q_storm = sum(q_surface[c["id"]] for c in into_lagoon) - q_base
    tc_lagoon = max(c["tc_min"] for c in into_lagoon)
    lag = simulate_lagoon(q_storm, q_base, tc_lagoon, rain, p, q_tunnel)
    q = accumulate_flows(net, rain, lag["q_out"])

    wse = LAGOON_INVERT_M + lag["depth"]
    hgl = {LAGOON_NODE_ID: wse}
    rate = {LAGOON_NODE_ID: lag["dh_dt_mm_min"] / 1000.0}
    out = _out_conduit(conduits)
    results, node_results = {}, {}
    for nid in reversed(net["order"]):
        node = nodes[nid]
        c = out.get(nid)
        if c is None:
            if node["type"] == "OUTFALL":
                hgl[nid], rate[nid] = -math.inf, 0.0
            continue
        q_rate = lag["q_out_rate"] if c["kind"] == "TUNNEL" else None
        res = solve_conduit(c, q[c["id"]], hgl[c["to_node"]], rate[c["to_node"]], y_dry[c["id"]], q_rate)
        results[c["id"]] = res
        raw = res["hgl_in"]
        hgl[nid] = min(raw, node["rim"])
        rate[nid] = res["rate_in"]
        node_results[nid] = dict(hgl=hgl[nid], flooding=raw > node["rim"] + 1e-6)
    for nid in nodes:
        if nodes[nid]["type"] == "OUTFALL":
            c = next(cc for cc in conduits.values() if cc["to_node"] == nid)
            hgl[nid] = results[c["id"]]["hgl_out"]
            node_results[nid] = dict(hgl=hgl[nid], flooding=False)
    node_results[LAGOON_NODE_ID] = dict(hgl=wse, flooding=lag["depth"] > LAGOON_MAX_DEPTH_M)
    return dict(rain=rain, blockage_pct=blockage_pct, p=p, lagoon=lag, conduits=results,
                nodes=node_results, hgl=hgl)


# ---------------------------------------------------------------------------
# Edge telemetry contract (32-bit big-endian bit-packed uplink)
# ---------------------------------------------------------------------------
def _round_half_up(x):
    return int(math.floor(x + 0.5))


def pack_telemetry_payload(depth_mm, dh_dt_mm_min, cap_pct, anom_code, vbat_v):
    """Pack one uplink word.

    [31:22] depth_code  10 b unsigned, 5 mm/LSB  (0..5115 mm, saturating)
    [21:14] dh_dt_code   8 b two's complement, 1 mm/min/LSB (-128..+127, saturating)
    [13:7]  cap_code     7 b unsigned, 1 %/LSB   (0..127 %, saturating)
    [6:4]   anom_code    3 b unsigned            (see ANOMALY_CODES)
    [3:0]   vbat_code    4 b unsigned, 0.08 V/LSB from 3.00 V (3.00..4.20 V)
    Transmitted big-endian (MSB first). Rounding is round-half-up (floorf(x + 0.5f)).
    """
    if not 0 <= int(anom_code) <= 7:
        raise ValueError("anom_code must fit in 3 bits")
    depth_code = min(max(_round_half_up(depth_mm / 5.0), 0), 0x3FF)
    dh_code = min(max(_round_half_up(dh_dt_mm_min), -128), 127) & 0xFF
    cap_code = min(max(_round_half_up(cap_pct), 0), 0x7F)
    vbat_code = min(max(_round_half_up((vbat_v - 3.00) / 0.08), 0), 0xF)
    return (depth_code << 22) | (dh_code << 14) | (cap_code << 7) | (int(anom_code) << 4) | vbat_code


def unpack_telemetry_payload(word):
    dh = (word >> 14) & 0xFF
    return dict(depth_mm=((word >> 22) & 0x3FF) * 5,
                dh_dt_mm_min=dh - 256 if dh & 0x80 else dh,
                cap_pct=(word >> 7) & 0x7F,
                anom_code=(word >> 4) & 0x7,
                vbat_v=round(3.00 + (word & 0xF) * 0.08, 2))


def turbulence_index(fr, v, pressurized):
    """Proxy for normalised acoustic range variance sigma_d^2 (0 calm .. 1 violent)."""
    if pressurized:
        return 0.08
    fr = fr or 0.0
    return 1.0 - math.exp(-(0.6 * fr * fr + 0.05 * v * v))


def classify(h_ratio, dh_dt, ti, fr, pressurized):
    """Deterministic stand-in for the on-device INT8 classifier (same decision surface)."""
    if pressurized or h_ratio >= 1.0:
        return "SURCHARGED"
    if h_ratio > BLOCKAGE_H_RATIO and abs(dh_dt) < FLASH_DHDT_MM_MIN and ti < BLOCKAGE_TURBULENCE:
        return "TRASH_BLOCKAGE"
    if dh_dt >= FLASH_DHDT_MM_MIN and ti >= FLASH_TURBULENCE:
        return "FLASH_SURGE"
    if fr is not None and fr > 1.0 and h_ratio >= 0.05:
        return "SUPERCRITICAL"
    return "NORMAL"


def sensor_telemetry(sensor, net, scen):
    kind, ref, vbat = sensor["attached_kind"], sensor["attached_to"], sensor["vbat_v"]
    lag = scen["lagoon"]
    rain = scen["rain"]
    blockage_ratio = None
    if kind == "CONDUIT":
        c, res = net["conduits"][ref], scen["conduits"][ref]
        level = max(res["depth"], scen["hgl"][c["to_node"]] - c["inv_out"])
        depth_m, rise = max(level, 0.0), c["rise"]
        dh_dt = res["rate_out"] * 1000.0
        ti = turbulence_index(res["fr"], res["v"], res["pressurized"])
        fr = res["fr"]
        forced = res["pressurized"]
        cap_pct = max(res["ratio"], min(depth_m / rise, CAPACITY_RATIO_CAP)) * 100.0
    elif kind == "STORAGE":
        depth_m, rise = lag["depth"], LAGOON_MAX_DEPTH_M
        dh_dt = lag["dh_dt_mm_min"]
        ti, fr = min(0.02 + 0.0006 * rain, 1.0), None
        forced = lag["depth"] > LAGOON_MAX_DEPTH_M
        cap_pct = min(depth_m / rise, CAPACITY_RATIO_CAP) * 100.0
    else:
        depth_m, rise = max(lag["depth"] - LAGOON_PERMANENT_POOL_M, 0.0), RACK_HEIGHT_M
        dh_dt = lag["dh_dt_mm_min"]
        v_app = lag["q_out"] / (RACK_WIDTH_M * min(depth_m, RACK_HEIGHT_M)) if depth_m > 0 else 0.0
        ti, fr = turbulence_index(None, v_app, False) + min(0.0006 * rain, 0.2), None
        forced = lag["depth"] > LAGOON_MAX_DEPTH_M
        if sensor["hardware"] == "JETSON_YOLO_TRASHRACK":
            blockage_ratio = scen["p"]
            cap_pct = blockage_ratio * 100.0
        else:
            cap_pct = min(depth_m / rise, CAPACITY_RATIO_CAP) * 100.0
    # Publish-then-derive: classification and packing use exactly the rounded values stored in
    # the record, so any consumer re-deriving anomaly/payload from the JSON gets identical bits.
    depth_mm = round(depth_m * 1000.0, 1)
    dh_dt = round(dh_dt, 2)
    ti = round(min(ti, 1.0), 4)
    fr = None if fr is None else round(fr, 3)
    cap_pct = round(cap_pct, 1)
    h_ratio = depth_mm / 1000.0 / rise
    if blockage_ratio is not None:
        anomaly = "SURCHARGED" if forced else "TRASH_BLOCKAGE" if blockage_ratio >= 0.5 else "NORMAL"
    else:
        anomaly = classify(h_ratio, dh_dt, ti, fr, forced or h_ratio >= 1.0)
    word = pack_telemetry_payload(depth_mm, dh_dt, cap_pct, ANOMALY_CODES[anomaly], vbat)
    saturated = [name for name, flag in (("depth_mm", depth_mm > 5115.0),
                                         ("dh_dt_mm_min", dh_dt > 127.0 or dh_dt < -128.0),
                                         ("cap_pct", cap_pct > 127.0)) if flag]
    rec = dict(depth_mm=depth_mm, dh_dt_mm_min=dh_dt, turbulence_index=ti, froude_number=fr,
               capacity_pct=cap_pct, anomaly_class=anomaly,
               anomaly_code=ANOMALY_CODES[anomaly], vbat_v=vbat,
               payload_uint32=word, payload_hex=f"0x{word:08X}",
               payload_bytes_be=word.to_bytes(4, "big").hex(" ").upper(),
               saturated_fields=saturated)
    if blockage_ratio is not None:
        rec["blockage_ratio_p"] = round(blockage_ratio, 3)
    return rec


# ---------------------------------------------------------------------------
# Building footprints
# ---------------------------------------------------------------------------
def _point_segment_distance(px, py, a, b):
    ax, ay = a
    bx, by = b
    dx, dy = bx - ax, by - ay
    t = 0.0 if dx == dy == 0 else max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)))
    return math.hypot(px - (ax + t * dx), py - (ay + t * dy))


def generate_buildings(net, rng):
    surface = [c for c in net["conduits"].values() if c["kind"] != "TUNNEL"]
    candidates = []
    for c in surface:
        (x0, y0), (x1, y1) = c["p0"], c["p1"]
        length = math.dist(c["p0"], c["p1"])
        ux, uy = (x1 - x0) / length, (y1 - y0) / length
        for t in (0.3, 0.7):
            for side in (-1.0, 1.0):
                off = rng.uniform(14.0, 26.0)
                candidates.append((x0 + (x1 - x0) * t - side * uy * off, y0 + (y1 - y0) * t + side * ux * off,
                                   math.atan2(uy, ux), c["barangay"]))
    for k in range(28):
        th = 2.0 * math.pi * k / 28 + rng.uniform(-0.05, 0.05)
        r = lagoon_radius(th) + rng.uniform(24.0, 48.0)
        candidates.append((r * math.cos(th), r * math.sin(th), th + math.pi / 2.0,
                           "City Camp Central" if math.sin(th) >= 0 else "City Camp Proper"))
    accepted = []
    for idx in rng.permutation(len(candidates)):
        cx, cy, ang, brgy = candidates[int(idx)]
        w, d = rng.uniform(8.0, 18.0), rng.uniform(7.0, 14.0)
        levels = int(rng.integers(2, 7))
        parapet = rng.uniform(0.0, 1.2)
        if len(accepted) >= TARGET_BUILDINGS:
            continue
        ca, sa = math.cos(ang), math.sin(ang)
        corners = [(cx + ca * u - sa * v, cy + sa * u + ca * v)
                   for u, v in ((-w / 2, -d / 2), (w / 2, -d / 2), (w / 2, d / 2), (-w / 2, d / 2))]
        if any(math.hypot(x, y) < lagoon_radius(math.atan2(y, x)) + 8.0 for x, y in corners):
            continue
        half_diag = math.hypot(w, d) / 2.0
        if any(math.hypot(cx - b["cx"], cy - b["cy"]) < half_diag + b["half_diag"] + 2.0 for b in accepted):
            continue
        if any(_point_segment_distance(cx, cy, c["p0"], c["p1"]) < half_diag + 3.0 for c in surface):
            continue
        accepted.append(dict(cx=cx, cy=cy, half_diag=half_diag, corners=corners, levels=levels,
                             height=levels * 3.0 + parapet, barangay=brgy, generator="BUILTIN_FALLBACK"))
    return accepted


def osmnx_buildings(limit):
    try:
        import osmnx as ox  # noqa: F401  (optional dependency)
    except ImportError:
        return None, "osmnx not installed"
    try:
        ox.settings.requests_timeout = 25
        fetch = getattr(ox, "features_from_point", None) or getattr(ox, "geometries_from_point")
        gdf = fetch((LAGOON_LAT, LAGOON_LON), tags={"building": True}, dist=650)
    except Exception as exc:  # network / Overpass failures fall back to the built-in set
        return None, f"osmnx fetch failed: {exc}"
    out = []
    for _, row in gdf.iterrows():
        geom = row.geometry
        if geom is None:
            continue
        if geom.geom_type == "MultiPolygon":
            geom = max(geom.geoms, key=lambda g: g.area)
        if geom.geom_type != "Polygon":
            continue
        corners = []
        for lon, lat in list(geom.exterior.coords)[:-1]:
            e, n = UTM51N.forward(lon, lat)
            corners.append((e - ORIGIN_E, n - ORIGIN_N))
        cx = sum(x for x, _ in corners) / len(corners)
        cy = sum(y for _, y in corners) / len(corners)
        if math.hypot(cx, cy) < lagoon_radius(math.atan2(cy, cx)) + 5.0:
            continue
        levels_raw = row.get("building:levels")
        try:
            levels = max(1, int(float(levels_raw)))
        except (TypeError, ValueError):
            levels = 3
        try:
            height = float(str(row.get("height")).replace("m", "").strip())
        except (TypeError, ValueError):
            height = levels * 3.0
        out.append(dict(cx=cx, cy=cy, corners=corners, levels=levels, height=height,
                        barangay="City Camp (OSM)", generator="OSMNX", dist=math.hypot(cx, cy)))
    if len(out) < 10:
        return None, f"osmnx returned only {len(out)} usable footprints"
    out.sort(key=lambda b: b["dist"])
    return out[:limit], f"osmnx: {min(len(out), limit)} OSM footprints"


# ---------------------------------------------------------------------------
# Export helpers
# ---------------------------------------------------------------------------
def r3(x):
    return None if x is None else round(float(x), 3)


def lonlat(xy, nd=7):
    lon, lat = local_to_lonlat(*xy)
    return [round(lon, nd), round(lat, nd)]


def export_network(net, buildings, sensors, building_note):
    nodes, conduits, orifice = net["nodes"], net["conduits"], net["orifice"]
    node_out = []
    for nid in net["order"]:
        nd = nodes[nid]
        lon, lat = local_to_lonlat(*nd["xy"])
        e, n = ORIGIN_E + nd["xy"][0], ORIGIN_N + nd["xy"][1]
        pe, pn = wgs84_to_ptm3(lon, lat, nd["rim"])
        rec = dict(id=nid, type=nd["type"], name=nd["name"], barangay=nd["barangay"], network=nd["kind"],
                   coordinates=[round(lon, 7), round(lat, 7), r3(nd["rim"])],
                   rim_elev_m=r3(nd["rim"]), invert_elev_m=r3(nd["invert"]),
                   max_depth_m=r3(nd["rim"] - nd["invert"]),
                   catchment_area_ha=r3(nd["area_ha"]) if nd["type"] != "STORAGE" else 0.0,
                   runoff_coeff=nd["runoff_c"] if nd["type"] != "STORAGE" else None,
                   utm51n_en=[round(e, 3), round(n, 3)], ptm3_en=[round(pe, 3), round(pn, 3)],
                   source_type=SOURCE_TYPE, is_active=True)
        if nd["type"] == "STORAGE":
            rec.update(surface_area_m2=LAGOON_AREA_M2, max_depth_m=LAGOON_MAX_DEPTH_M,
                       permanent_pool_depth_m=LAGOON_PERMANENT_POOL_M)
        node_out.append(rec)

    shape_spec = {"RECT_CLOSED": "Precast RCBC (closed box, haunched)", "CIRCULAR": "RCPC",
                  "ARCH": "Excavated limestone bedrock (unlined)"}
    conduit_out = []
    for c in conduits.values():
        sec = c["section"]
        rec = dict(id=c["id"], link_type="CONDUIT", name=c["name"], road=c["road"], barangay=c["barangay"],
                   network=c["kind"], from_node=c["from_node"], to_node=c["to_node"],
                   shape=c["shape"], material=shape_spec[c["shape"]],
                   geometry=dict(rise_m=c["rise"], span_m=c["span"],
                                 diameter_m=c["rise"] if c["shape"] == "CIRCULAR" else None,
                                 haunch_m=c["haunch"] if c["shape"] == "RECT_CLOSED" else None,
                                 area_full_m2=r3(sec.a_full)),
                   coordinates=[lonlat(c["p0"]) + [r3(c["inv_in"])], lonlat(c["p1"]) + [r3(c["inv_out"])]],
                   coordinates_ref="INVERT",
                   inlet_invert_m=r3(c["inv_in"]), outlet_invert_m=r3(c["inv_out"]),
                   inlet_offset_m=r3(c["inv_in"] - nodes[c["from_node"]]["invert"]),
                   outlet_offset_m=r3(c["inv_out"] - nodes[c["to_node"]]["invert"]),
                   length_m=round(c["length_m"], 2), length_3d_m=round(c["length_3d_m"], 2),
                   slope=round(c["slope"], 5), slope_eff_sin=round(c["s_eff"], 5),
                   manning_n=c["manning_n"], q_full_cms=r3(c["q_full"]), q_max_cms=r3(c["q_max"]),
                   y_at_qmax_ratio=round(sec.y_qmax / sec.rise, 4), tc_min=round(c["tc_min"], 2),
                   source_type=SOURCE_TYPE, is_active=True)
        if "segment_class" in c:
            rec["segment_class"] = c["segment_class"]
            rec["spec_reference"] = "DPWH BCDEO Contracts 18PD0020 & 19PD0032"
        conduit_out.append(rec)

    rack_lon, rack_lat = local_to_lonlat(*orifice["xy"])
    orifice_out = [dict(
        id=TRASH_RACK_ID, link_type="ORIFICE", name="City Camp tunnel intake trash rack",
        from_node=orifice["from_node"], to_node=orifice["to_node"],
        coordinates=[round(rack_lon, 7), round(rack_lat, 7), RACK_SILL_ELEV_M],
        sill_elev_m=RACK_SILL_ELEV_M, width_m=RACK_WIDTH_M, height_m=RACK_HEIGHT_M,
        gross_area_m2=RACK_WIDTH_M * RACK_HEIGHT_M, discharge_coeff=RACK_CD,
        bar_thickness_m=RACK_BAR_THICKNESS_M, bar_clear_spacing_m=RACK_BAR_SPACING_M,
        bar_angle_deg=RACK_BAR_ANGLE_DEG, kirschmer_beta=RACK_BAR_SHAPE_FACTOR,
        bar_open_ratio=round(RACK_OPEN_RATIO, 4), xi_clean=round(XI_CLEAN, 4),
        source_type=SOURCE_TYPE, is_active=True)]

    ring = [lonlat(rim_point(360.0 * k / _LAGOON_VERTS)) for k in range(_LAGOON_VERTS)]
    ring.append(ring[0])
    stage = [dict(depth_m=round(h, 2), surface_area_m2=round(lagoon_surface_area(h), 1),
                  volume_m3=round(lagoon_volume(h), 1))
             for h in np.arange(0.0, LAGOON_MAX_DEPTH_M + 0.001, 0.5)]
    lagoon = dict(node_id=LAGOON_NODE_ID, polygon=[ring], area_m2=LAGOON_AREA_M2,
                  invert_elev_m=LAGOON_INVERT_M, rim_elev_m=LAGOON_RIM_M, max_depth_m=LAGOON_MAX_DEPTH_M,
                  permanent_pool_depth_m=LAGOON_PERMANENT_POOL_M, bottom_area_m2=LAGOON_BOTTOM_AREA_M2,
                  full_volume_m3=round(LAGOON_FULL_VOLUME_M3, 1), stage_storage=stage,
                  geology="Endorheic karst doline, Mirador Limestone / Kennon Formation; pores sealed by silt",
                  source_type=SOURCE_TYPE, is_active=True)

    bldg_out = []
    for i, b in enumerate(buildings, start=1):
        ring = [lonlat(pt) for pt in b["corners"]]
        ring.append(ring[0])
        local = list(b["corners"])
        bldg_out.append(dict(id=f"BLDG-{i:03d}", barangay=b["barangay"], levels=b["levels"],
                             height_m=round(b["height"], 2),
                             ground_elev_m=r3(min(ground_elev(x, y) for x, y in local)),
                             footprint_area_m2=round(_shoelace(local), 1), coordinates=[ring],
                             generator=b["generator"], source_type=SOURCE_TYPE, is_active=True))

    counts = dict(nodes=len(node_out), conduits=len(conduit_out), orifices=1, buildings=len(bldg_out),
                  sensors=len(sensors),
                  conduits_by_shape={s: sum(1 for c in conduit_out if c["shape"] == s)
                                     for s in ("RECT_CLOSED", "CIRCULAR", "ARCH")},
                  nodes_by_type={t: sum(1 for n in node_out if n["type"] == t)
                                 for t in ("JUNCTION", "STORAGE", "OUTFALL")})
    meta = dict(
        project="Edge-AI Stormwater Capacity Detection & 3D Subsurface Digital Twin — City Camp Lagoon Catchment",
        schema_version=SCHEMA_VERSION, generator="scripts/generate_citycamp_twin_data.py", rng_seed=RNG_SEED,
        anchor=dict(lon=LAGOON_LON, lat=LAGOON_LAT, utm51n_en=[round(ORIGIN_E, 3), round(ORIGIN_N, 3)]),
        crs=dict(export="EPSG:4326 [lon, lat, elevation_m_ASL]", metric="EPSG:32651",
                 cadastral="EPSG:3123 (PRS92 / Philippines zone III)",
                 prs92_to_wgs84_towgs84=list(PRS92_TO_WGS84),
                 helmert_convention="Position Vector (PROJ +towgs84); WGS84->PRS92 = negated terms"),
        vertical_exaggeration=1.0,
        conventions=dict(node_z="rim/ground elevation (manhole lid)", conduit_z="invert elevation",
                         storage_z="rim elevation; see invert_elev_m"),
        buildings_source=building_note, counts=counts,
        disclaimer="Synthetic, geographically anchored topology. Replace with LGU/DPWH records via source_type.")
    return dict(meta=meta, nodes=node_out, conduits=conduit_out, orifices=orifice_out, lagoon=lagoon,
                buildings=bldg_out, sensors=sensors)


def build_sensors(net):
    sensors = []
    for i, (sid, name, role, kind, ref, vbat) in enumerate(SENSOR_PLAN, start=1):
        hw = "JETSON_YOLO_TRASHRACK" if role == "TRASH_RACK_VISION" else "XIAO_ESP32S3_A02YYUW"
        if kind == "CONDUIT":
            c = net["conduits"][ref]
            xy, z = c["p1"], ground_elev(*c["p1"])
            geom = dict(shape=c["shape"], rise_m=c["rise"], span_m=c["span"], manning_n=c["manning_n"],
                        slope=round(c["slope"], 5), invert_elev_m=r3(c["inv_out"]),
                        q_full_cms=r3(c["q_full"]), q_max_cms=r3(c["q_max"]))
            mount_node = c["to_node"] if c["to_node"] != LAGOON_NODE_ID else f"{ref}-OUTLET-HEADWALL"
        elif kind == "STORAGE":
            xy, z = rim_point(-110.0), LAGOON_RIM_M
            geom = dict(shape="STORAGE", max_depth_m=LAGOON_MAX_DEPTH_M, invert_elev_m=LAGOON_INVERT_M,
                        surface_area_m2=LAGOON_AREA_M2)
            mount_node = LAGOON_NODE_ID
        else:
            xy, z = net["orifice"]["xy"], LAGOON_RIM_M
            geom = dict(shape="ORIFICE", width_m=RACK_WIDTH_M, height_m=RACK_HEIGHT_M,
                        sill_elev_m=RACK_SILL_ELEV_M, discharge_coeff=RACK_CD)
            mount_node = TRASH_RACK_ID
        rec = dict(sensor_id=sid, name=name, role=role, hardware=hw,
                   device_eui=f"02BA6C10{i:08X}", attached_kind=kind, attached_to=ref, mount_node=mount_node,
                   coordinates=lonlat(xy) + [r3(z)], pipe_geometry=geom, vbat_v=vbat,
                   source_type=SOURCE_TYPE, is_active=True)
        if hw == "XIAO_ESP32S3_A02YYUW":
            rec["radio"] = dict(lorawan_region="AS923-3", band_mhz=[915.0, 918.0], transceiver="Wio-SX1262")
            rec["sensors"] = ["DFRobot A02YYUW (UART 9600, 30 mm blind zone)", "DS18B20"]
        else:
            rec["vision"] = dict(model="YOLOv8", output="blockage_ratio_p", range=[0.0, 0.95])
            rec["payload_note"] = "cap_code carries visual blockage % (0-95) for this hardware class"
        sensors.append(rec)
    return sensors


def export_scenario(net, scen, sensors):
    lag = scen["lagoon"]
    conduits = {}
    for cid, res in scen["conduits"].items():
        conduits[cid] = dict(flow_cms=round(res["q"], 4), water_depth_m=r3(res["depth"]),
                             velocity_ms=r3(res["v"]),
                             froude_number=None if res["fr"] is None else r3(res["fr"]),
                             capacity_ratio=r3(res["ratio"]), status=res["status"],
                             flow_regime=res["regime"], hydraulic_jump=res["jump"],
                             depth_control=res["governed"])
    nodes = {nid: dict(hgl_m=r3(v["hgl"]), is_flooding=v["flooding"]) for nid, v in scen["nodes"].items()}
    lagoon = dict(lagoon_water_depth_m=r3(lag["depth"]),
                  lagoon_surface_elev_m=r3(LAGOON_INVERT_M + lag["depth"]),
                  inundation_radius_m=round(lag["inundation_radius"], 1),
                  inundation_area_m2=round(lag["inundation_area"], 1),
                  orifice_head_loss_m=r3(lag["head_loss"]), orifice_flow_cms=r3(lag["q_out"]),
                  rack_capacity_cms=r3(lag["q_rack"]), lagoon_inflow_cms=r3(lag["q_in"]),
                  spill_flow_cms=r3(lag["q_spill"]), lagoon_dh_dt_mm_min=round(lag["dh_dt_mm_min"], 2),
                  outflow_control=lag["control"], is_overflowing=lag["depth"] > LAGOON_MAX_DEPTH_M,
                  estimated_time_to_overflow_min=None if lag["t_overflow"] is None
                  else round(lag["t_overflow"], 1),
                  xi_rack=round(xi_rack(scen["p"]), 3), depth_series_m=lag["series"])
    sensor_out = {s["sensor_id"]: sensor_telemetry(s, net, scen) for s in sensors}
    status_counts = {k: sum(1 for c in conduits.values() if c["status"] == k)
                     for k in ("NORMAL", "ELEVATED", "CRITICAL", "SURCHARGED")}
    return dict(key=f"R{scen['rain']}_B{scen['blockage_pct']}", rainfall_mm_hr=scen["rain"],
                trash_rack_blockage_pct=scen["blockage_pct"], lagoon=lagoon, status_counts=status_counts,
                conduits=conduits, nodes=nodes, sensors=sensor_out)


# ---------------------------------------------------------------------------
# Self-checks
# ---------------------------------------------------------------------------
def self_checks(net, buildings):
    circ = get_section("CIRCULAR", 1.0, 1.0, 0.0)
    assert abs(circ.y_qmax - 0.938) < 0.002, f"circular Q_max depth ratio {circ.y_qmax:.4f}"
    assert 1.07 < circ.k_max / circ.k_full < 1.08, "circular Q_max/Q_full outside 1.07-1.08"
    lon, lat = UTM51N.inverse(*UTM51N.forward(LAGOON_LON, LAGOON_LAT))
    assert abs(lon - LAGOON_LON) < 1e-9 and abs(lat - LAGOON_LAT) < 1e-9, "UTM round trip"
    pe, pn = PTM_ZONE3.forward(LAGOON_LON, LAGOON_LAT)
    assert abs(PTM_ZONE3.inverse(pe, pn)[1] - LAGOON_LAT) < 1e-9, "PTM round trip"
    xyz = geodetic_to_ecef(LAGOON_LON, LAGOON_LAT, 1430.0, WGS84)
    back = helmert_position_vector(helmert_position_vector(xyz, PRS92_TO_WGS84, True), PRS92_TO_WGS84)
    assert math.dist(xyz, back) < 0.005, "Helmert inverse round trip > 5 mm"
    ring = [rim_point(360.0 * k / _LAGOON_VERTS) for k in range(_LAGOON_VERTS)]
    assert abs(_shoelace(ring) - LAGOON_AREA_M2) / LAGOON_AREA_M2 < 0.001, "lagoon area"
    rng = np.random.default_rng(7)
    for _ in range(2000):
        d, dh, cap = rng.uniform(0, 5115), rng.uniform(-128, 127), rng.uniform(0, 127)
        an, vb = int(rng.integers(0, 7)), 3.0 + 0.08 * int(rng.integers(0, 16))
        u = unpack_telemetry_payload(pack_telemetry_payload(d, dh, cap, an, vb))
        assert abs(u["depth_mm"] - d) <= 2.5 and abs(u["dh_dt_mm_min"] - dh) <= 0.5
        assert abs(u["cap_pct"] - cap) <= 0.5 and u["anom_code"] == an and abs(u["vbat_v"] - vb) < 1e-6
    assert pack_telemetry_payload(5115, -1, 127, 7, 4.20) == 0xFFFFFFFF
    assert pack_telemetry_payload(5115, 127, 127, 7, 4.20) == 0xFFDFFFFF
    assert pack_telemetry_payload(0, -128, 0, 0, 3.00) == 0x00200000
    assert 60 <= len(buildings) <= 100, f"{len(buildings)} buildings"
    for c in net["conduits"].values():
        assert c["slope"] > 0, f"{c['id']} adverse slope"
        if c["kind"] == "TUNNEL":
            assert ground_elev(*c["p1"]) > c["inv_out"] + c["rise"], f"{c['id']} crown above ground"


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------
def _fmt(v, nd=3):
    return "-" if v is None else f"{v:.{nd}f}"


def print_summary(net, network_json, lut, ref_scens, building_note):
    m = network_json["meta"]["counts"]
    line = "=" * 94
    print(line)
    print(" City Camp Lagoon Digital Twin - Phase 1 generator summary")
    print(line)
    print(f" Nodes      : {m['nodes']:>4}  {m['nodes_by_type']}")
    print(f" Conduits   : {m['conduits']:>4}  {m['conduits_by_shape']}")
    lengths = {}
    for c in net["conduits"].values():
        lengths[c["shape"]] = lengths.get(c["shape"], 0.0) + c["length_m"]
    print(f" Length (m) : " + "  ".join(f"{k} {v:,.0f}" for k, v in lengths.items()))
    print(f" Orifices   : {m['orifices']:>4}  ({TRASH_RACK_ID}, xi_clean = {XI_CLEAN:.3f})")
    print(f" Buildings  : {m['buildings']:>4}  ({building_note})")
    print(f" Sensors    : {m['sensors']:>4}")
    print(f" LUT        : {len(lut['scenarios'])} grid scenarios "
          f"({len(RAINFALL_GRID)} rainfall x {len(BLOCKAGE_GRID)} blockage) + "
          f"{len(lut['reference_scenarios'])} reference")
    feeders = [c for c in net["conduits"].values() if c["kind"] == "FEEDER"]
    arts = [c for c in net["conduits"].values() if c["kind"] == "ARTERIAL"]
    print(f" Slopes     : feeders {min(c['slope'] for c in feeders):.1%}-{max(c['slope'] for c in feeders):.1%}, "
          f"arterials {min(c['slope'] for c in arts):.1%}-{max(c['slope'] for c in arts):.1%}")
    print(f" Tunnel     : free-surface conveyance limit (choke) = {tunnel_conveyance_limit(net):.2f} m3/s")
    print(line)

    a, b = ref_scens
    hdr = f" {'Lagoon metric':<34}{a['key'] + ' (light, clean)':>28}{b['key'] + ' (typhoon, clogged)':>30}"
    print(hdr)
    print("-" * 94)
    for label, key, nd in (("Water depth (m)", "lagoon_water_depth_m", 2),
                           ("Surface elevation (m ASL)", "lagoon_surface_elev_m", 2),
                           ("Inflow (m3/s)", "lagoon_inflow_cms", 2),
                           ("Orifice outflow (m3/s)", "orifice_flow_cms", 2),
                           ("Rack capacity (m3/s)", "rack_capacity_cms", 2),
                           ("Kirschmer head loss (m)", "orifice_head_loss_m", 3),
                           ("Outflow control", "outflow_control", None),
                           ("dh/dt (mm/min)", "lagoon_dh_dt_mm_min", 2),
                           ("Inundation radius (m)", "inundation_radius_m", 1),
                           ("Time to overflow (min)", "estimated_time_to_overflow_min", 1)):
        va, vb = a["lagoon"][key], b["lagoon"][key]
        fa = va if nd is None else ("never (<12 h)" if va is None and "overflow" in key else _fmt(va, nd))
        fb = vb if nd is None else ("never (<12 h)" if vb is None and "overflow" in key else _fmt(vb, nd))
        print(f" {label:<34}{fa:>28}{fb:>30}")
    print("-" * 94)
    print(f" {'Conduit':<10}{'shape':<12}{'scenario':<12}{'Q m3/s':>9}{'y m':>8}{'V m/s':>8}{'Fr':>8}"
          f"{'ratio':>8}{'status':>12}{'jump':>6}")
    for cid in ("GSF-C02", "URQ-C02", "LGD-C07", "QOP-C06", "TUN-C02", "TUN-C03", "TUN-C05"):
        for s in (a, b):
            r = s["conduits"][cid]
            print(f" {cid:<10}{net['conduits'][cid]['shape']:<12}{s['key']:<12}{r['flow_cms']:>9.3f}"
                  f"{r['water_depth_m']:>8.3f}{r['velocity_ms']:>8.2f}{_fmt(r['froude_number'], 2):>8}"
                  f"{r['capacity_ratio']:>8.3f}{r['status']:>12}{'Y' if r['hydraulic_jump'] else '':>6}")
    print("-" * 94)
    print(f" {'Sensor':<7}{'role':<26}{a['key'] + ' payload':<30}{b['key'] + ' payload':<30}")
    for sid in a["sensors"]:
        ta, tb = a["sensors"][sid], b["sensors"][sid]
        role = next(s["role"] for s in network_json["sensors"] if s["sensor_id"] == sid)
        print(f" {sid:<7}{role:<26}{ta['payload_hex'] + ' ' + ta['anomaly_class']:<30}"
              f"{tb['payload_hex'] + ' ' + tb['anomaly_class']:<30}")
    print(line)


def main(argv=None):
    repo = Path(__file__).resolve().parent.parent
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--out-dir", type=Path, default=repo / "public" / "data")
    ap.add_argument("--osmnx", action="store_true", help="try OpenStreetMap building footprints via osmnx")
    ap.add_argument("--quiet", action="store_true")
    args = ap.parse_args(argv)

    net = build_network()
    rng = np.random.default_rng(RNG_SEED)
    buildings, note = None, "built-in synthetic footprints"
    if args.osmnx:
        buildings, note = osmnx_buildings(TARGET_BUILDINGS)
        if buildings is None:
            print(f"[warn] {note}; using built-in footprints", file=sys.stderr)
            note = "built-in synthetic footprints (osmnx fallback)"
    if buildings is None:
        buildings = generate_buildings(net, rng)
    self_checks(net, buildings if not args.osmnx else generate_buildings(net, np.random.default_rng(RNG_SEED)))

    sensors = build_sensors(net)
    network_json = export_network(net, buildings, sensors, note)

    q_tunnel = tunnel_conveyance_limit(net)
    q_dry = accumulate_flows(net, 0.0, 0.0)
    y_dry = {cid: (net["conduits"][cid]["section"].normal_depth(q, net["conduits"][cid]["manning_n"],
                                                                 net["conduits"][cid]["s_eff"]) or 0.0)
             for cid, q in q_dry.items()}
    scenarios = [export_scenario(net, run_scenario(net, r, b, q_tunnel, y_dry), sensors)
                 for r in RAINFALL_GRID for b in BLOCKAGE_GRID]
    refs = [export_scenario(net, run_scenario(net, r, b, q_tunnel, y_dry), sensors)
            for r, b in REFERENCE_SCENARIOS]
    lut = dict(
        meta=dict(schema_version=SCHEMA_VERSION, network_file="city_camp_network.json",
                  storm_duration_min=STORM_DURATION_MIN, overflow_horizon_min=OVERFLOW_HORIZON_MIN,
                  sim_dt_s=SIM_DT_S, series_step_min=SERIES_STEP_MIN,
                  tunnel_conveyance_limit_cms=round(q_tunnel, 3),
                  status_thresholds=dict(STATUS_THRESHOLDS, SURCHARGED="pressurized / HGL above crown"),
                  capacity_ratio_cap=CAPACITY_RATIO_CAP, anomaly_codes=ANOMALY_CODES,
                  payload_layout={"depth_code": "[31:22] u10 x5 mm", "dh_dt_code": "[21:14] s8 mm/min",
                                  "cap_code": "[13:7] u7 %", "anom_code": "[6:4] u3",
                                  "vbat_code": "[3:0] u4 3.00 V + 0.08 V/LSB"},
                  model=["Rational method peak inflow Q = C*i*A/360 (A in ha), Kirpich tc + 5 min inlet time",
                         "Manning with steep-slope S = sin(atan(S0)); tabulated exact sections",
                         "Backwater HGL pass from lagoon WSE and free outfall; pressurized when HGL >= crown",
                         "Trash rack: weir/orifice with A_eff = A_gross*phi*(1-p) + Kirschmer dH = xi(p)V^2/2g",
                         "Lagoon: frustum stage-storage, 30 s explicit mass balance, rim spill weir",
                         "Tunnel accepts at most the free-surface Q_max of its tightest choke"]),
        axes=dict(rainfall_mm_hr=RAINFALL_GRID, trash_rack_blockage_pct=BLOCKAGE_GRID),
        index={s["key"]: i for i, s in enumerate(scenarios)},
        scenarios=scenarios, reference_scenarios=refs)

    args.out_dir.mkdir(parents=True, exist_ok=True)
    net_path, lut_path = args.out_dir / "city_camp_network.json", args.out_dir / "simulation_lut.json"
    net_path.write_text(json.dumps(network_json, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    lut_path.write_text(json.dumps(lut, separators=(",", ":"), ensure_ascii=False) + "\n", encoding="utf-8")
    if not args.quiet:
        print_summary(net, network_json, lut, refs, note)
        print(f" wrote {net_path} ({net_path.stat().st_size / 1024:,.0f} KiB)")
        print(f" wrote {lut_path} ({lut_path.stat().st_size / 1024:,.0f} KiB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
