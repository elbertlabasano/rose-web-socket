# Rose SMS service

Standalone Node.js HTTP API + WebSocket gateway with MySQL persistence. Requires Node 20.11+ and MySQL 8+ or MariaDB 10.4+. Run one service process; multiple replicas require shared device ownership and dispatch coordination.

## Setup

1. Run `npm install`.
2. Copy `.env.example` to `.env`. Set a random API_TOKEN (at least 24 characters) and your MySQL credentials. Generate a token with `openssl rand -hex 32`.
3. Create a dedicated database and user using a MySQL administrator, replacing the sample password:

```sql
CREATE DATABASE rose_sms CHARACTER SET utf8mb4;
CREATE USER 'rose_sms'@'localhost' IDENTIFIED BY 'choose-a-strong-password';
GRANT SELECT, INSERT, UPDATE, CREATE, REFERENCES ON rose_sms.* TO 'rose_sms'@'localhost';
```

Your local MySQL client is `/usr/local/mysql/bin/mysql`. Connect interactively with `/usr/local/mysql/bin/mysql -u root -p`. Do not put your password in a command argument. DB_SOCKET=/tmp/mysql.sock uses your existing local installation; remove it when using TCP or a remote database.

4. Run `npm run migrate`, then `npm start`.
5. Run `npm test` for API/WebSocket integration tests using an in-memory test store. These do not validate MySQL connectivity; migrate and a live send flow are still required against your database.

## API

Examples use localhost. Set API_TOKEN in your terminal to the value from .env. Call from your backend so the API token stays private. For remote access, put the service behind HTTPS/WSS with a reverse proxy; forward WebSocket Upgrade headers. Keep MySQL private.

### Register a device

```sh
curl http://localhost:3000/devices \
  -H "Authorization: Bearer $API_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"id":"tablet-1","name":"Office tablet"}'
```

Returns HTTP 201 with `{ "id": "tablet-1", "token": "..." }`. Save the device token on the tablet; the database stores only its hash. GET /devices lists registered devices and whether they are connected. Both require the API token.

### Submit SMS

```sh
curl http://localhost:3000/sms \
  -H "Authorization: Bearer $API_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"requestId":"order-123-notification","to":"+639171234567","body":"Your order is ready."}'
```

Returns HTTP 202 with the message ID and initial status. Optional `deviceId` targets a particular registered device; omit it to use an available device. Offline messages stay queued. Required requestId identifies one logical send: retry the same payload and ID to retrieve the existing message (HTTP 200); reusing the ID with different content returns 409.

### Get status

```sh
curl http://localhost:3000/sms/MESSAGE_ID -H "Authorization: Bearer $API_TOKEN"
```

Statuses: queued → dispatched → sent or failed. `unknown` means connection loss, server restart, or a confirmation timeout after dispatch. Unknown messages are never automatically resent, because the device may already have sent them. A late device result can resolve unknown. Sent means the device reports successful sending, not delivery to the recipient. Webhooks and delivery receipts are not implemented.

GET /health checks database availability without authentication.

## Tablet protocol

Connect to `ws://localhost:3000/device?deviceId=tablet-1` with the HTTP handshake header `Authorization: Bearer DEVICE_TOKEN`. Use the server's LAN address from a physical tablet. Browser WebSocket clients cannot set this header; use a native device app. Only one connection per device ID is accepted.

Server confirms connection:

```json
{"type":"device.ready","deviceId":"tablet-1"}
```

Server sends one outstanding command per device:

```json
{"type":"sms.send","messageId":"uuid","to":"+639171234567","body":"Your order is ready."}
```

The device sends the SMS through its native SMS implementation, waits for its send result, then replies:

```json
{"type":"sms.result","messageId":"uuid","status":"sent"}
```

Or:

```json
{"type":"sms.result","messageId":"uuid","status":"failed","error":"No service"}
```

Server confirms persistence with `{"type":"sms.result.ack","messageId":"uuid","status":"sent"}`. Persist message IDs/results on the device, deduplicate commands, and retain/replay results after reconnect until acknowledged. Never blindly resend an SMS after losing connectivity. The native WebSocket client must respond to ping frames. Reconnect with backoff.

The device app itself is not included. Messages contain phone numbers and SMS content; plan database backups and a retention policy before production. API and device tokens currently have no management UI or rotation endpoint. This initial service has no rate limits, bulk sending, or multi-instance support.
