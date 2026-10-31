// Copy this file to node_config.h in this folder and fill it in. node_config.h is git-ignored,
// so your Wi-Fi password stays out of the repository. The Arduino IDE picks it up automatically.
#pragma once

#define WIFI_SSID "your-2.4GHz-network"   // the ESP32-S3 joins 2.4 GHz only, never 5 GHz
#define WIFI_PASSWORD "your-password"
#define SERVER_IP "192.168.0.154"         // the PC running `npm start`: `ipconfig`, Wi-Fi adapter, IPv4 Address

#define DEVICE_EUI "EN-08"                // map sensor this rig represents (EN-01 .. EN-10)
#define NODE_FULL_SCALE_M 2.0             // full-scale depth of that map node (EN-08 rack opening 2.0 m)
#define TANK_HEIGHT_MM 300.0              // measured: HC-SR04 face -> tank floor
#define AIR_TEMP_C 20.0                   // room temperature, used for the speed of sound
#define UPLINK_SCOPE "single_node"        // "full_catchment" makes this sensor drive the whole twin
