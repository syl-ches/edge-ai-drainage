// Copy this file to node_config.h in this folder and fill it in. node_config.h is git-ignored,
// so your Wi-Fi password stays out of the repository.
#pragma once

#define WIFI_SSID "your-2.4GHz-network"   // the ESP32-S3 joins 2.4 GHz only, never 5 GHz
#define WIFI_PASSWORD "your-password"

// Production URL of the Vercel project: https, ending exactly in /api/esp32, no trailing slash.
// Preview URLs (the ones with a random hash) answer 401 under Vercel's default protection.
#define VERCEL_URL "https://YOUR-PROJECT.vercel.app/api/esp32"

#define DEVICE_ID "EN-08"
#define TANK_HEIGHT_MM 169.4f             // measured: HC-SR04 face -> tank floor
#define WARNING_PCT 45.0f                 // fill % at which level becomes WARNING
#define ALARM_PCT 80.0f                   // fill % at which level becomes ALARM
