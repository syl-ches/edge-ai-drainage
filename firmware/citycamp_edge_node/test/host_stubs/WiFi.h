#pragma once
#define WL_CONNECTED 3
#define WIFI_STA 1
struct WiFiClass { int status() { return 0; } void mode(int) {} void begin(const char*, const char*) {} void disconnect(bool) {} };
extern WiFiClass WiFi;
