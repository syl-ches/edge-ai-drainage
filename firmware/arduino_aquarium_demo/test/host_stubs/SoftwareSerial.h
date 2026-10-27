// Host-side stub (see Arduino.h in this folder).
#pragma once
#include "Arduino.h"

struct SoftwareSerial : Stream {
  SoftwareSerial(int, int) {}
};
