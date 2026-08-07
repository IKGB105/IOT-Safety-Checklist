# IoT Safety Checklist System

> A full-stack IoT system that digitizes pre-shift safety verification for industrial machinery, replacing paper-based processes with an offline-first PWA connected to smart relays that physically interlock machine startup.

![Node.js](https://img.shields.io/badge/Node.js-20-339933?style=flat&logo=node.js&logoColor=white)
![Express](https://img.shields.io/badge/Express-4-000000?style=flat&logo=express&logoColor=white)
![Capacitor](https://img.shields.io/badge/Capacitor-6-119EFF?style=flat&logo=capacitor&logoColor=white)
![Raspberry Pi](https://img.shields.io/badge/Raspberry_Pi-3B+-A22846?style=flat&logo=raspberry-pi&logoColor=white)

---

## Overview

A production-deployed safety system built for a food manufacturing plant. Operators must complete a digital safety checklist before every shift start — once all points are verified, a smart relay physically enables the machine's start button circuit. **No checklist approval, no machine start.**

The system runs entirely on a Raspberry Pi that acts as both the web server and a local WiFi access point, making it fully **offline** and independent of any corporate network or internet connection.

![Operator app — checklist start screen](images/app-screenshot.png)

---

## Key Features

- **Offline-first PWA** — works on any mobile browser, no install required
- **Hardware interlock** — Shelly 2PM Gen4 relay wired in series with machine start buttons; only closes after checklist approval
- **Photo evidence** — operators capture timestamped photos at critical safety checkpoints
- **3-shift auto-detection** — app detects current shift (T1/T2/T3) based on system time
- **Critical item blocking** — NOK on safety-critical items blocks machine activation and triggers an instant WhatsApp alert
- **WhatsApp alerts** — automatic supervisor notifications via Callmebot API on safety violations
- **Supervisor emergency release** — password-protected bypass with mandatory reason field and full audit trail
- **Random mid-shift verification** — configurable surprise photo requests during active shifts
- **Admin panel** — full configuration UI: machines, checklist questions, photo requirements, relay IPs, alert settings
- **Android APK** — packaged with Capacitor 6 for native camera access
- **QR code access** — each machine has a printed QR label; operators scan to open their checklist directly

---

## System Architecture

```
┌──────────────────────────────────────────────────────┐
│                  Raspberry Pi 3B+                    │
│                                                      │
│  hostapd  →  WiFi Access Point (local network)       │
│  dnsmasq  →  DHCP + local DNS resolution             │
│  Node.js  →  Express API + static file serving       │
│  iptables →  port 80 → 3000 redirect                │
│  PM2      →  process manager + auto-restart          │
│  Tailscale→  remote SSH without port exposure        │
└──────────────────┬───────────────────────────────────┘
                   │ <PI_IP>
                   │
       ┌───────────┴────────────────────────┐
       │         Local WiFi 2.4 GHz         │
       │                                    │
  [Phones / Tablets]        [Shelly 2PM Gen4 relays]
  Operator PWA               One relay per machine
  Admin panel                REST API: Cover.Open / Cover.Stop
```

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| **Server** | Node.js 20 + Express 4 |
| **Frontend** | Vanilla JS / CSS / HTML — single-file PWA, no framework |
| **Android** | Capacitor 6 (native camera access) |
| **Process manager** | PM2 |
| **Hardware** | Raspberry Pi 3B+ |
| **IoT relays** | Shelly 2PM Gen4 — Cover profile, REST API |
| **Networking** | hostapd (WiFi AP) + dnsmasq (DHCP + DNS) |
| **Remote access** | Tailscale VPN |
| **Alerts** | Callmebot WhatsApp API |
| **Storage** | JSON flat-file (config + records) + IndexedDB (client-side photos) |
| **File uploads** | Multer → local filesystem |

---

## Project Structure

```
├── server.js                  # Express server — REST API + static file serving
├── package.json
├── capacitor.config.ts        # Android build configuration
├── mobile/
│   ├── index.html             # Operator PWA (self-contained single file)
│   ├── manifest.json
│   ├── jsqr.min.js            # QR scanning library
│   └── ilustraciones/         # Reference images per machine per checklist item
├── admin/
│   └── index.html             # Admin configuration panel
└── scripts/
    └── sync-mobile.js         # Syncs mobile/ assets for Capacitor APK build
```

---

## API Reference

| Method | Route | Description |
|--------|-------|-------------|
| `GET` | `/mobile/` | Operator PWA |
| `GET` | `/admin/` | Admin panel |
| `POST` | `/api/admin/login` | Admin authentication |
| `GET/POST` | `/api/admin/config` | Read / write full system config |
| `POST` | `/api/checklist/save` | Save shift record (detects NOK → fires alert) |
| `POST` | `/api/upload` | Upload photo evidence (Multer) |
| `POST` | `/api/bypass` | Validate supervisor emergency password |
| `GET` | `/api/admin/logs` | Retrieve saved checklist records |
| `GET/POST` | `/api/admin/alert-config` | WhatsApp alert configuration |
| `POST` | `/api/admin/test-alert` | Send test WhatsApp message |
| `GET` | `/api/shelly/:ip/status` | Relay status |
| `POST` | `/api/shelly/:ip/open` | Activate relay (Cover.Open) |
| `POST` | `/api/shelly/:ip/stop` | Deactivate relay (Cover.Stop) |

---

## How the Hardware Interlock Works

The Shelly 2PM relay is wired **in series** with the machine's start button circuit. The **Cover profile** includes a configurable `Max Operation Time` — after this window the relay opens automatically.

```
[Checklist approved in app]
         ↓
[POST /rpc/Cover.Open → Shelly relay]
         ↓
[Relay closes → start button circuit is live]
         ↓
[Operator presses start → machine contactor latches]
         ↓
[Shelly deactivates after timeout]
         ↓
[Contactor holds — machine keeps running independently]
```

The machine continues running after the Shelly deactivates because the internal contactor self-latches once energized. The Shelly enforces the **authorization window for startup only** — a connectivity issue never stops a running machine.

---

## Operator Flow

```
Scan QR on machine  →  App opens with machine pre-selected
         ↓
Auto-detect shift (T1 / T2 / T3 based on system time)
         ↓
Fill checklist items  →  OK / NOK + photos + numeric fields
         ↓
Critical item NOK?  →  Activation blocked + WhatsApp alert fired
         ↓
All items verified + required photos captured
         ↓
Tap "Enable Machine"  →  Relay closes  →  Operator presses start
         ↓
Shift timer running  →  optional random photo check mid-shift
         ↓
Tap "End shift"  →  record saved with full timestamp audit trail
```

---

## Running Locally

```bash
git clone https://github.com/IKGB105/iot-safety-checklist.git
cd iot-safety-checklist
npm install
node server.js
# → http://localhost:3000
```

When `/data/` doesn't exist (Pi-only path), the server automatically falls back to `./data/` for local development.

---

## Android APK Build

```bash
npm run apk:sync    # sync mobile/ into Capacitor + cap sync
npm run apk:open    # open Android Studio
# Build → Generate Signed APK
```

---

## What I Built

This project involved designing and shipping a complete production system end-to-end:

- **Raspberry Pi as a WiFi access point + web server** for an air-gapped industrial environment with zero internet dependency
- **Single-file PWA** (no build tools, no framework) that works on any mobile browser and packages cleanly into a native Android APK via Capacitor
- **IoT hardware integration** — Shelly smart relays controlled via REST API to physically enforce software-approved safety verification before machine startup
- **Photo evidence pipeline** — Multer upload on server, IndexedDB cache on client, configurable required/optional fields per machine
- **Local DNS + DHCP** with dnsmasq: custom domain resolution, MAC-based static IP assignments for each relay, iptables port redirect
- **Admin panel** for non-technical users to manage machines, checklist items, relay IPs, alert recipients and passwords without touching code
- **Production deployment** with PM2 (auto-restart, startup hook) and Tailscale for remote maintenance without exposing the Pi to the internet
