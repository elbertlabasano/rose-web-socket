// Original ESP32 LILYGO T-A7670E. Requires ESP32 core 3.3.12,
// ArduinoJson 7 and WebSockets by Markus Sattler (Links2004).
#include <Arduino.h>
#include <PPP.h>
#include <Preferences.h>
#include <ArduinoJson.h>
#include <WebSocketsClient.h>
#include <NetworkClientSecure.h>
#include <esp_modem_api.h>
#include <time.h>
#include "RootCA.h"
#if __has_include("Config.h")
#include "Config.h"
#else
#include "Config.example.h"
#endif

// PPP/CMUX gives LTE data and SMS separate logical channels on UART1.
// Only the worker task issues AT commands once the connection is started.
struct Job { int slot; char to[17]; char body[161]; };
struct Outcome { int slot; char status[12]; char error[160]; };
struct Record {
  uint32_t version;
  char id[37];
  char status[12];
  char error[160];
  bool acked;
};
constexpr int HISTORY = 16;
Record records[HISTORY] = {};
Preferences journal;
WebSocketsClient socketClient;
QueueHandle_t jobs, outcomes;
bool active = false, storageHealthy = false, serverReady = false;
bool socketStarted = false;
uint32_t retryMs = 5000, lastReplay = 0, noDataSince = 0;
String authHeader, wsPath;

bool saveRecord(int slot) {
  String key = "r" + String(slot);
  bool ok = journal.putBytes(key.c_str(), &records[slot], sizeof(Record)) == sizeof(Record);
  if (!ok) {
    storageHealthy = false;
    Serial.println("Flash journal write failed. Sending disabled; do not erase flash to retry a job.");
  }
  return ok;
}

void publishRecord(int slot) {
  if (!serverReady || records[slot].acked || !records[slot].id[0]) return;
  JsonDocument result;
  result["type"] = "sms.result";
  result["messageId"] = records[slot].id;
  result["status"] = records[slot].status;
  if (records[slot].error[0]) result["error"] = records[slot].error;
  String payload;
  serializeJson(result, payload);
  socketClient.sendTXT(payload);
}

bool validId(const char *id) {
  if (!id || strlen(id) != 36) return false;
  for (int i = 0; i < 36; ++i) {
    if (i == 8 || i == 13 || i == 18 || i == 23) {
      if (id[i] != '-') return false;
    } else if (!isxdigit(static_cast<unsigned char>(id[i]))) return false;
  }
  return true;
}

bool validSms(const char *to, const char *body) {
  if (!to || !body || to[0] != '+' || to[1] < '1' || to[1] > '9') return false;
  size_t n = strlen(to), b = strlen(body);
  if (n < 8 || n > 16 || b == 0 || b > 160) return false;
  for (size_t i = 1; i < n; ++i) if (to[i] < '0' || to[i] > '9') return false;
  // A conservative single-part GSM subset; excludes escape-table characters,
  // backtick (different GSM mapping), Unicode and modem control bytes.
  for (size_t i = 0; i < b; ++i) {
    unsigned char c = body[i];
    if (c < 32 || c > 126 || strchr("^{}\\[~]|`", c)) return false;
  }
  return true;
}

void receiveJob(JsonDocument &event) {
  const char *id = event["messageId"] | "";
  if (!validId(id)) return;
  for (int i = 0; i < HISTORY; ++i) {
    if (strcmp(records[i].id, id) == 0) {
      if (!active) { records[i].acked = false; saveRecord(i); publishRecord(i); }
      return; // Never submit an existing message ID again.
    }
  }
  if (active || !storageHealthy) return; // Server normally sends only one job at a time.
  int slot = -1;
  for (int i = 0; i < HISTORY; ++i) if (!records[i].id[0]) { slot = i; break; }
  if (slot < 0) {
    // Bounded history: retain unacknowledged results, rotate acknowledged ones.
    uint32_t cursor = journal.getUInt("cursor", 0) % HISTORY;
    for (int i = 0; i < HISTORY; ++i) {
      int candidate = (cursor + i) % HISTORY;
      if (records[candidate].acked) { slot = candidate; break; }
    }
    if (slot >= 0) journal.putUInt("cursor", (slot + 1) % HISTORY);
  }
  if (slot < 0) { Serial.println("Result journal full; no SMS submitted."); return; }
  records[slot] = {};
  records[slot].version = 1;
  strlcpy(records[slot].id, id, sizeof(records[slot].id));
  strlcpy(records[slot].status, "unknown", sizeof(records[slot].status));
  strlcpy(records[slot].error, "Power lost before send result was stored; do not automatically resend", sizeof(records[slot].error));
  const char *to = event["to"] | "";
  const char *body = event["body"] | "";
  if (!event["to"].is<const char *>() || !event["body"].is<const char *>() ||
      event["to"].as<JsonString>().size() != strlen(to) ||
      event["body"].as<JsonString>().size() != strlen(body) || !validSms(to, body)) {
    strlcpy(records[slot].status, "failed", sizeof(records[slot].status));
    strlcpy(records[slot].error, "Requires international number and 1-160 plain GSM characters; Unicode and multipart SMS unsupported", sizeof(records[slot].error));
    if (saveRecord(slot)) publishRecord(slot);
    return;
  }
  // Durable BEFORE submission: a reset can never cause an automatic resend.
  if (!saveRecord(slot)) return;
  Job job = {};
  job.slot = slot;
  strlcpy(job.to, to, sizeof(job.to));
  strlcpy(job.body, body, sizeof(job.body));
  active = true;
  if (xQueueSend(jobs, &job, 0) != pdTRUE) {
    active = false;
    strlcpy(records[slot].status, "failed", sizeof(records[slot].status));
    strlcpy(records[slot].error, "Local worker queue unavailable; SMS not submitted", sizeof(records[slot].error));
    if (saveRecord(slot)) publishRecord(slot);
  }
}

void onSocketEvent(WStype_t type, uint8_t *payload, size_t length) {
  if (type == WStype_DISCONNECTED) {
    serverReady = false;
    socketClient.setReconnectInterval(retryMs);
    uint32_t scheduledRetry = retryMs;
    retryMs = min(retryMs * 2, uint32_t(60000));
    Serial.print("WebSocket disconnected: ");
    if (payload && length) Serial.write(payload, length);
    else Serial.print("No reason reported (check TLS, DNS and LTE connection)");
    Serial.printf(". Retry in %lu seconds.\n", static_cast<unsigned long>(scheduledRetry / 1000));
    return;
  }
  if (type == WStype_CONNECTED) {
    Serial.println("WebSocket handshake complete; waiting for device.ready.");
    return;
  }
  if (type != WStype_TEXT || length > 16384) return;
  JsonDocument event;
  if (deserializeJson(event, payload, length)) return;
  const char *kind = event["type"] | "";
  if (!strcmp(kind, "device.ready")) {
    serverReady = true;
    retryMs = 5000;
    socketClient.setReconnectInterval(retryMs);
    lastReplay = millis() - 5000;
    Serial.println("Server authenticated device. Waiting for SMS jobs.");
  } else if (!strcmp(kind, "sms.send") && serverReady) {
    receiveJob(event);
  } else if (!strcmp(kind, "sms.result.ack")) {
    for (int i = 0; i < HISTORY; ++i) {
      if (!strcmp(records[i].id, event["messageId"] | "") &&
          !strcmp(records[i].status, event["status"] | "") && !records[i].acked) {
        records[i].acked = true;
        if (saveRecord(i)) Serial.println("Server confirmed result stored.");
      }
    }
  } else if (!strcmp(kind, "error")) {
    Serial.printf("Server error: %s\n", event["error"] | "unknown");
  }
}

void smsWorker(void *) {
  Job job;
  for (;;) {
    if (xQueueReceive(jobs, &job, portMAX_DELAY) != pdTRUE) continue;
    Outcome outcome = {};
    outcome.slot = job.slot;
    strlcpy(outcome.status, "failed", sizeof(outcome.status));
    esp_err_t result = esp_modem_sms_txt_mode(PPP.handle(), true);
    if (result == ESP_OK) result = esp_modem_sms_character_set(PPP.handle());
    if (result != ESP_OK) {
      strlcpy(outcome.error, "Cannot configure modem SMS mode; message not submitted", sizeof(outcome.error));
    } else {
      // Waits for the modem send response, not just UART write completion.
      // Runs off the Arduino loop so WebSocket ping/pong remains responsive.
      result = esp_modem_send_sms(PPP.handle(), job.to, job.body);
      if (result == ESP_OK) {
        strlcpy(outcome.status, "sent", sizeof(outcome.status));
      } else {
        // Conservative: the API cannot always prove whether submission occurred.
        strlcpy(outcome.status, "unknown", sizeof(outcome.status));
        strlcpy(outcome.error, "Modem did not confirm sending; check recipient before a new request", sizeof(outcome.error));
      }
    }
    xQueueSend(outcomes, &outcome, portMAX_DELAY);
  }
}

void halt(const char *message) {
  Serial.println(message);
  for (;;) delay(1000);
}

bool probeModem(HardwareSerial &probe) {
  while (probe.available()) probe.read();
  probe.print("AT\r\n");
  String reply;
  uint32_t start = millis();
  while (millis() - start < 1000) {
    while (probe.available()) reply += char(probe.read());
    if (reply.indexOf("OK") >= 0) return true;
    delay(1);
  }
  return false;
}

void diagnoseTls() {
  // No authentication or WebSocket upgrade: cannot claim a queued SMS job.
  NetworkClientSecure probe;
  probe.setCACert(ROOT_CA);
  probe.setHandshakeTimeout(30);
  Serial.println("TLS diagnostic: connecting to server on port 443 (30-second timeout)...");
  uint32_t started = millis();
  if (!probe.connect(WS_HOST, 443, 30000)) {
    char detail[256] = {};
    int error = probe.lastError(detail, sizeof(detail));
    Serial.printf("TLS diagnostic FAILED after %lu ms: %d %s\n",
                  static_cast<unsigned long>(millis() - started), error, detail);
    Serial.println("Enable Tools > Core Debug Level > Verbose for socket/DNS details if error is 0.");
    probe.stop();
    return;
  }
  Serial.printf("TLS diagnostic OK after %lu ms.\n", static_cast<unsigned long>(millis() - started));
  probe.printf("GET /health HTTP/1.1\r\nHost: %s\r\nConnection: close\r\n\r\n", WS_HOST);
  probe.setTimeout(15000);
  String statusLine = probe.readStringUntil('\n');
  statusLine.trim();
  Serial.println("HTTPS diagnostic: " + statusLine);
  probe.stop();
}

void setup() {
  Serial.begin(115200);
  pinMode(12, OUTPUT); digitalWrite(12, HIGH);
  pinMode(25, OUTPUT); digitalWrite(25, LOW);
  pinMode(4, OUTPUT); digitalWrite(4, LOW);
  delay(2000);
  if (strstr(DEVICE_TOKEN, "REPLACE") || strstr(MODEM_APN, "REPLACE"))
    halt("Set APN, device ID and DEVICE token in Config.h first.");
  for (const char *p = DEVICE_ID; *p; ++p)
    if (!isalnum(static_cast<unsigned char>(*p)) && *p != '_' && *p != '-') halt("Invalid device ID.");
  if (!DEVICE_ID[0] || strlen(DEVICE_ID) > 100) halt("Invalid device ID length.");
  if (!journal.begin("rose-sms", false)) halt("Cannot open durable SMS journal.");
  for (int i = 0; i < HISTORY; ++i) {
    String key = "r" + String(i);
    size_t size = journal.getBytesLength(key.c_str());
    if (size && (size != sizeof(Record) || journal.getBytes(key.c_str(), &records[i], sizeof(Record)) != sizeof(Record) || records[i].version != 1))
      halt("Invalid journal. Investigate before resetting storage; SMS may already be sent.");
  }
  storageHealthy = true;
  // Reset the modem to leave any CMUX session from a previous ESP32 boot.
  pinMode(5, OUTPUT); digitalWrite(5, LOW); delay(100);
  digitalWrite(5, HIGH); delay(2600); digitalWrite(5, LOW); delay(3000);
  HardwareSerial probe(1);
  probe.begin(115200, SERIAL_8N1, 27, 26);
  if (!probeModem(probe)) {
    digitalWrite(4, HIGH); delay(1000); digitalWrite(4, LOW);
    uint32_t bootStart = millis();
    while (!probeModem(probe)) {
      if (millis() - bootStart > 30000) halt("Modem not responding; check board variant and power.");
      delay(500);
    }
  }
  probe.end(); // PPP must be the only owner of UART1 from this point onward.
  PPP.setApn(MODEM_APN);
  if (SIM_PIN[0]) PPP.setPin(SIM_PIN);
  PPP.setPins(26, 27);
  if (!PPP.begin(PPP_MODEM_SIM7600, 1, 115200)) halt("PPP modem init failed; reset board and check power/firmware.");
  String reply;
  if (!PPP.cmd("ATE0", reply, 3000)) halt("Cannot disable modem command echo; reset to retry.");
  PPP.cmd("AT+CMEE=2", reply, 3000);
  PPP.cmd("AT+CFUN=1", reply, 10000);
  Serial.println("Waiting for SIM and LTE attachment...");
  uint32_t start = millis();
  while (!PPP.attached()) {
    if (millis() - start > 180000) halt("No LTE attachment. Check SIM PIN, antenna, coverage and data plan; reset to retry.");
    delay(1000);
  }
  if (!PPP.mode(ESP_MODEM_MODE_CMUX)) halt("CMUX failed: modem firmware must support PPP plus SMS.");
  if (!PPP.waitStatusBits(ESP_NETIF_CONNECTED_BIT, 60000)) halt("LTE data failed. Check carrier APN/data plan and reset.");
  PPP.setDefault();
  Serial.println("LTE data connected. Synchronizing clock for TLS...");
  configTime(0, 0, "pool.ntp.org", "time.google.com");
  start = millis();
  while (time(nullptr) < 1767225600) {
    if (millis() - start > 60000) halt("NTP clock sync failed; TLS connection disabled. Reset to retry.");
    delay(100);
  }
  jobs = xQueueCreate(1, sizeof(Job));
  outcomes = xQueueCreate(1, sizeof(Outcome));
  if (!jobs || !outcomes || xTaskCreate(smsWorker, "sms-worker", 8192, nullptr, 1, nullptr) != pdPASS)
    halt("Cannot start SMS worker.");
  wsPath = String("/device?deviceId=") + DEVICE_ID;
  Serial.printf("Connecting to wss://%s%s\n", WS_HOST, wsPath.c_str());
  Serial.printf("TLS clock (Unix seconds): %lld\n", static_cast<long long>(time(nullptr)));
  diagnoseTls();
  authHeader = String("Authorization: Bearer ") + DEVICE_TOKEN;
  socketClient.beginSslWithCA(WS_HOST, 443, wsPath.c_str(), ROOT_CA, "");
  socketClient.setExtraHeaders(authHeader.c_str());
  socketClient.onEvent(onSocketEvent);
  socketClient.setReconnectInterval(5000);
  socketClient.enableHeartbeat(15000, 10000, 2);
  socketStarted = true;
}

void loop() {
  if (!socketStarted) { delay(10); return; }
  socketClient.loop();
  Outcome outcome;
  if (xQueueReceive(outcomes, &outcome, 0) == pdTRUE) {
    int slot = outcome.slot;
    strlcpy(records[slot].status, outcome.status, sizeof(records[slot].status));
    strlcpy(records[slot].error, outcome.error, sizeof(records[slot].error));
    bool stored = saveRecord(slot);
    if (stored) publishRecord(slot);
    Serial.printf("SMS job %s: %s\n", records[slot].id, records[slot].status);
    active = false;
    if (!strcmp(outcome.status, "unknown")) {
      if (!stored) halt("Ambiguous SMS and journal failure. Investigate before resetting.");
      // A timeout can leave the modem in its SMS prompt. Reset that session
      // before accepting another job; replay the saved result after reconnect.
      Serial.println("Resetting modem session after ambiguous send; SMS will not be retried.");
      socketClient.disconnect();
      delay(100); ESP.restart();
    }
  }
  if (storageHealthy && serverReady && !active && millis() - lastReplay >= 5000) {
    lastReplay = millis();
    for (int i = 0; i < HISTORY; ++i) publishRecord(i);
  }
  if (!PPP.connected()) {
    if (!noDataSince) noDataSince = millis();
    if (!active && storageHealthy && millis() - noDataSince > 60000) {
      Serial.println("LTE data lost for 60 seconds. Restarting; saved jobs will not be resent.");
      delay(100); ESP.restart();
    }
  } else noDataSince = 0;
  delay(2);
}
