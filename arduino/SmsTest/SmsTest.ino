#include <Arduino.h>

const char PHONE_NUMBER[] = "+63XXXXXXXXXX";
const char MESSAGE[] = "Hello from my LILYGO A7670E!";

HardwareSerial modem(1);
bool ready = false;

bool waitFor(const char *expected, uint32_t timeout, String &reply) {
  reply = "";
  uint32_t start = millis();

  while (millis() - start < timeout) {
    while (modem.available()) {
      char c = modem.read();
      Serial.write(c);
      reply += c;

      if (reply.indexOf(expected) >= 0) return true;
      if (reply.indexOf("ERROR") >= 0) return false;

      if (reply.length() > 2048) {
        reply.remove(0, 1024);
      }
    }
    delay(1);
  }

  Serial.println("\nModem response timed out.");
  return false;
}

bool command(const String &cmd, String &reply,
             uint32_t timeout = 3000) {
  while (modem.available()) {
    Serial.write(modem.read());
  }

  Serial.println("\n> " + cmd);
  modem.print(cmd + "\r\n");
  return waitFor("\r\nOK\r\n", timeout, reply);
}

bool registered(const String &reply, const char *prefix) {
  int pos = reply.indexOf(prefix);
  if (pos < 0) return false;

  int comma = reply.indexOf(',', pos);
  if (comma < 0) return false;

  int status = reply.substring(comma + 1).toInt();
  return status == 1 || status == 5;
}

void sendSms() {
  String reply;

  if (String(PHONE_NUMBER).indexOf('X') >= 0) {
    Serial.println("Replace PHONE_NUMBER and upload again.");
    return;
  }

  if (!command("AT+CMGF=1", reply)) return;
  if (!command("AT+CSCS=\"GSM\"", reply)) return;

  modem.print(String("AT+CMGS=\"") + PHONE_NUMBER + "\"\r\n");

  if (!waitFor(">", 5000, reply)) {
    modem.write(27);
    return;
  }

  modem.print(MESSAGE);
  modem.write(26); // Ctrl+Z submits the SMS.

  bool ok = waitFor("\r\nOK\r\n", 60000, reply);

  if (ok && reply.indexOf("+CMGS:") >= 0) {
    Serial.println("\nSMS accepted by modem!");
  } else {
    Serial.println(
      "\nFailed or result unknown. Check recipient before retrying."
    );
  }
}

void setup() {
  Serial.begin(115200);

  pinMode(12, OUTPUT);
  digitalWrite(12, HIGH); // Enable modem power.

  pinMode(25, OUTPUT);
  digitalWrite(25, LOW); // Keep modem awake.

  pinMode(5, OUTPUT);
  digitalWrite(5, LOW); // Reset inactive.

  modem.begin(115200, SERIAL_8N1, 27, 26);
  delay(3000);

  String reply;

  if (!command("AT", reply)) {
    pinMode(4, OUTPUT);
    digitalWrite(4, LOW);
    delay(100);
    digitalWrite(4, HIGH);
    delay(1000);
    digitalWrite(4, LOW);
  }

  bool responding = false;

  for (int i = 0; i < 30 && !responding; i++) {
    responding = command("AT", reply, 1000);
    if (!responding) delay(1000);
  }

  if (!responding) {
    Serial.println("Modem not responding. Check board and power.");
    return;
  }

  command("ATE0", reply);
  command("AT+CMEE=2", reply);

  if (!command("AT+CPIN?", reply) ||
      reply.indexOf("READY") < 0) {
    Serial.println("SIM not ready. Check SIM insertion or PIN lock.");
    return;
  }

  command("AT+CFUN=1", reply, 10000);

  Serial.println("Waiting up to 2 minutes for cellular network...");
  uint32_t start = millis();

  while (millis() - start < 120000) {
    bool lte = command("AT+CEREG?", reply) &&
               registered(reply, "+CEREG:");

    bool gsm = command("AT+CREG?", reply) &&
               registered(reply, "+CREG:");

    if (lte || gsm) {
      ready = true;
      break;
    }

    delay(2000);
  }

  command("AT+CSQ", reply);

  if (ready) {
    Serial.println("\nReady! Type s and press Send to send one SMS.");
  } else {
    Serial.println(
      "\nNo network. Check SIM, antenna and coverage, then reset."
    );
  }
}

void loop() {
  if (Serial.available()) {
    char c = Serial.read();

    if (c == 's' && ready) {
      sendSms();
    }
  }

  while (modem.available()) {
    Serial.write(modem.read());
  }

  delay(1);
}