// Copy to secrets.h (git-ignored) and fill in. Without secrets.h the firmware builds with
// these placeholders: LoRaWAN stays disabled and the node streams over USB serial only.
// Every value can also be overridden with -D build flags in platformio.ini.
#pragma once

// ---- LoRaWAN AS923-3 (The Things Stack / ChirpStack OTAA, LoRaWAN 1.1 keys) --------------
#ifndef LORAWAN_ENABLED
#define LORAWAN_ENABLED 0
#endif
#ifndef LORAWAN_JOIN_EUI
#define LORAWAN_JOIN_EUI 0x0000000000000000ULL
#endif
#ifndef LORAWAN_DEV_EUI
#define LORAWAN_DEV_EUI 0x02BA6C1000000008ULL      // must match the node profile you deploy
#endif
#ifndef LORAWAN_APP_KEY
#define LORAWAN_APP_KEY {0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00}
#endif
#ifndef LORAWAN_NWK_KEY
#define LORAWAN_NWK_KEY {0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00}
#endif

// ---- Wi-Fi direct demo transport (laptop hotspot; no gateway needed indoors) --------------
#ifndef WIFI_SSID
#define WIFI_SSID ""                                 // empty == Wi-Fi transport off
#endif
#ifndef WIFI_PASSWORD
#define WIFI_PASSWORD ""
#endif
#ifndef INGEST_URL
#define INGEST_URL "http://192.168.137.1:8000/api/v1/ingest/lorawan"   // laptop IP on the hotspot
#endif

// ---- Default node identity / bench settings (all changeable from the serial console) ------
#ifndef DEFAULT_NODE
#define DEFAULT_NODE "EN-08"
#endif
#ifndef DEFAULT_PIPE_HEIGHT_MM
#define DEFAULT_PIPE_HEIGHT_MM 1000.0f
#endif
