#pragma once
#include <cstdint>
enum esp_sleep_wakeup_cause_t { ESP_SLEEP_WAKEUP_UNDEFINED = 0, ESP_SLEEP_WAKEUP_TIMER = 4 };
inline esp_sleep_wakeup_cause_t esp_sleep_get_wakeup_cause() { return ESP_SLEEP_WAKEUP_UNDEFINED; }
inline void esp_sleep_enable_timer_wakeup(uint64_t) {}
inline void esp_deep_sleep_start() {}
