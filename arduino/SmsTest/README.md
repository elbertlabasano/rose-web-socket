# LILYGO SMS test

For the original ESP32 LILYGO T-A7670 with A7670E modem. T-Call and S3 variants have different pins; confirm the board marking before using this sketch.

1. With power disconnected, insert an active SIM with SMS service and attach the LTE antenna. Use a reliable USB power supply/cable.
2. Open `SmsTest.ino` in Arduino IDE. Replace `PHONE_NUMBER` with your recipient in international format (for example, +639171234567). Edit `MESSAGE` if desired; keep it short and plain ASCII.
3. Select **ESP32 Dev Module** from **esp32 by Espressif Systems** and the board's port (currently COM10). Upload.
4. Open Serial Monitor at **115200 baud**. Reset the ESP32 if you missed startup output.
5. When `Ready` appears, type lowercase `s` and press Send. Each `s` submits one SMS; normal carrier charges may apply. Nothing sends automatically at startup.

No Wi-Fi, API server, APN or extra Arduino libraries are needed for this standalone SMS test. A modem success response indicates submission, not recipient delivery. If a send times out, check the recipient before sending again to avoid duplicates. SIM PIN errors, registration responses and modem errors appear in Serial Monitor.

Pin mapping and power-key sequence reference: https://github.com/Xinyuan-LilyGO/LilyGo-Modem-Series/tree/main/examples/ATdebug

Validated through Arduino IDE compilation, upload, and a hardware SMS test: the modem returned +CMGS followed by OK. Recipient delivery was not independently confirmed.
