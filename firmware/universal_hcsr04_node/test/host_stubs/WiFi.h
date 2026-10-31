// Host-side stub (see Arduino.h in this folder).
#pragma once
#include <cstdint>
#define WL_NO_SSID_AVAIL 1
#define WL_CONNECTED 3
#define WL_CONNECT_FAILED 4
#define WIFI_STA 1
#define WIFI_POWER_8_5dBm 34
struct IPAddress {
  uint8_t operator[](int) const { return 0; }
};
struct WiFiClass {
  int status() { return WL_CONNECTED; }
  void mode(int) {}
  void begin(const char *, const char *) {}
  bool setTxPower(int) { return true; }
  IPAddress localIP() { return IPAddress{}; }
  int RSSI() { return -50; }
};
static WiFiClass WiFi;
