# LTE WebSocket SMS gateway

Original ESP32 LILYGO T-A7670E only. Keeps the standalone `../SmsTest` sketch intact. Uses LTE mobile data for WSS and the same SIM for SMS, with PPP/CMUX providing separate logical data and AT channels. No Wi-Fi is used. The modem must support PPP and CMUX with the SIM7600-compatible command profile; this must be verified on your A7670E firmware.

## Configure and upload

1. Install **esp32 by Espressif Systems 3.3.12**, **ArduinoJson 7**, and **WebSockets by Markus Sattler 2.7.2** through Arduino IDE managers. PPP and Preferences are included in the ESP32 core. Do not install an unrelated WebSocket library.
2. Copy `Config.example.h` to `Config.h` if it does not already exist. Set the carrier's APN (obtain it from your carrier), device ID and **device token** returned by `POST /devices`. The API bearer token is only for your backend; do not place it in the board. `Config.h` is gitignored. An active SIM needs both mobile data and SMS service. PIN is optional; APNs requiring PPP username/password authentication are not implemented.
3. The configured endpoint is `wss://sms.jathnier.com/device?deviceId=tablet-1`. Keep the server and any proxy/tunnel running. If the hostname changes, update `WS_HOST` and verify the root CA still matches. `RootCA.h` contains ISRG Root X1 for the endpoint's served certificate chain. TLS certificate and hostname validation stay enabled; the board obtains the time via NTP first.
4. With power disconnected, insert SIM and attach LTE antenna. Connect reliable USB power. Open `SmsGateway.ino`, select **ESP32 Dev Module** and the current COM port, then upload. Monitor at **115200 baud**. Do not run the old manual SMS sketch at the same time.
5. Expect LTE attachment, an LTE data connection, clock synchronization, then `Server authenticated device. Waiting for SMS jobs.` APN, SIM, CMUX and TLS failures must be resolved before sending a live job. Initial modem/attachment failures require resetting after fixing the cause. Loss of an established data connection for 60 seconds triggers a restart after the current SMS operation completes.

## Send through the API

From your backend, with `API_TOKEN` supplied through its environment:

```sh
curl https://sms.jathnier.com/sms \
  -H "Authorization: Bearer $API_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"requestId":"lilygo-test-001","deviceId":"tablet-1","to":"+639171234567","body":"Hello from the LTE WebSocket gateway"}'
```

Use your actual recipient. Query `GET /sms/MESSAGE_ID` with the API token to check status. Retry the same logical request using the same requestId. A new requestId is a new SMS and can incur another charge.

## Results and reconnects

- `sent`: returned only after the modem's SMS submission command succeeds, never merely after a WebSocket job is received. This is **submission confirmation, not a recipient delivery receipt**.
- `failed`: invalid input or an error before submission. This first version accepts 1-160 characters from a conservative single-part GSM subset. Unicode, control characters, GSM escape characters and multipart messages are rejected without sending. The server supports longer messages for other device implementations.
- `unknown`: modem did not confirm submission, or power failed between durable job acceptance and durable result storage. Never automatically resend these jobs; check the recipient first.

Deploy the accompanying server change before using explicit `unknown` results. No database migration is needed. Older servers reject `unknown`, though their own disconnect/confirmation timeout still marks a job unknown. The firmware retains and replays results until `sms.result.ack` confirms server persistence. It uses a separate SMS worker task so network ping/pong remains serviced during the modem's send wait.

Flash stores a 16-entry journal. Unacknowledged entries are never evicted. Acknowledged entries rotate; deduplication of arbitrarily old command IDs is not guaranteed beyond that history. The server never automatically redispatches unknown jobs. Do not erase flash or change the device identity to recover a pending send. If storage fails, new sends stop. Reconnects use a 5-60 second backoff; after a reset, pending IDs are reported without sending again.

## Validation

The gateway source compiled successfully for ESP32 Dev Module with ESP32 core 3.3.12, ArduinoJson 7.4.3 and WebSockets 2.7.2 (646347 bytes flash, 35180 bytes globals). The server integration test covers unknown results, result replay and late sent confirmation. The configured tablet-1 token also passed a live WSS authentication check without submitting an SMS. The earlier manual SMS sketch was verified on hardware. The new LTE/CMUX/WebSocket flow still needs a live device test; compilation alone does not establish modem firmware compatibility or delivery. No SMS is sent by compiling or configuring this sketch.

References: [Espressif PPP example](https://github.com/espressif/arduino-esp32/tree/master/libraries/PPP/examples/PPP_Basic), [esp_modem APIs and CMUX limitations](https://docs.espressif.com/projects/esp-protocols/esp_modem/docs/latest/README.html), [WebSockets client](https://github.com/Links2004/arduinoWebSockets).
