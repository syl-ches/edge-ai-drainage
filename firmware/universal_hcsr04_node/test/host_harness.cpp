// Differential harness: runs the sketch's own edge pipeline (double precision) on a distance
// stream from stdin and prints one result line per sample for scripts/test_phase5_firmware.py.
//   stdin:  "<tank_mm> <full_scale_m> <temp_c> <vbat_v>" then "<raw_dist_mm> <dt_s>" per sample
//   stdout: "<payload_hex> <depth_mm> <dh_dt_mm_min> <cap_pct> <anomaly_code> <fault_payload_hex>"
#define UNIVERSAL_USE_DOUBLE 1
#include "../universal_hcsr04_node.ino"

int main() {
  double tank = 0, fs = 0, temp = 0, vbat = 0;
  if (std::scanf("%lf %lf %lf %lf", &tank, &fs, &temp, &vbat) != 4) return 2;
  edge::Kalman k;
  edge::kalman_reset(&k);
  edge::Window w;
  w.n = 0;
  double d = 0, dt_s = 0;
  while (std::scanf("%lf %lf", &d, &dt_s) == 2) {
    edge::window_push(&w, d);
    double burst[edge::BURST_LEN];
    edge::window_burst(&w, burst);
    edge::Result r = edge::cycle(&k, burst, temp, dt_s / 60.0, tank, fs, vbat);
    char hex[11];
    edge::hex32(r.payload, hex);
    edge::Result f = r;
    edge::mark_sensor_fault(&f, vbat);
    char fault_hex[11];
    edge::hex32(f.payload, fault_hex);
    std::printf("%s %.9f %.9f %.9f %d %s\n", hex, r.depth_mm, r.dh_dt_mm_min, r.cap_pct, r.anomaly_code, fault_hex);
  }
  return 0;
}
