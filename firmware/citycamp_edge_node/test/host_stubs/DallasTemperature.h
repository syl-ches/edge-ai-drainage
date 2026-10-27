#pragma once
#include "OneWire.h"
#define DEVICE_DISCONNECTED_C -127
struct DallasTemperature {
  explicit DallasTemperature(OneWire*) {}
  void begin() {}
  void setResolution(int) {}
  void requestTemperatures() {}
  float getTempCByIndex(int) { return 14.0f; }
};
