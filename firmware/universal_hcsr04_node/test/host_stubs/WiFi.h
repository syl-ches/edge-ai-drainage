// Host-side stub (see Arduino.h in this folder).
#pragma once
#define WL_CONNECTED 3
#define WIFI_STA 1
struct WiFiClass {
  int status() { return WL_CONNECTED; }
  void mode(int) {}
  void begin(const char *, const char *) {}
};
static WiFiClass WiFi;
