<img width="1582" height="1123" alt="1" src="https://github.com/user-attachments/assets/6cecc83b-0fc9-4e57-ad94-706a2fffb038" />

# 📥 KATAL

**KATAL** is a **decentralized download manager** powered by a **Nostr bot**.
It’s fast, censorship-resistant, and fully open-source — built as an alternative to [Telearia](https://github.com/besoeasy/telearia).

Under the hood, it uses **aria2** for efficient downloads and integrates seamlessly with decentralized systems.

---

## ✨ Features

- ⚡ **Fast & Lightweight** – powered by `aria2`
- 🔒 **Nostr Controlled** – censorship-resistant bot interface
- 🌐 **Web UI (Port 6799)** – access files directly over HTTP
- 🖥️ **Samba SMB Share (Port 445)** – browse and share files via network
- 🤖 **Bot Setup UI (Port 6798)** – configure your initial account with ease
- 🧩 **Extensible** – can be plugged into **Sonarr, Plex, Jellyfin, Bitmagnet**, and more
- 🛡️ **Decentralization First** – designed with censorship resistance in mind

---

## 🚀 Quick Start

Run KATAL using Docker:

```bash
docker run -d --name katal --restart unless-stopped -p 6798:6798 -p 6799:6799 -p 445:445 -p 59123:59123/tcp -p 59123:59123/udp -v katal-data:/tmp/katal ghcr.io/besoeasy/katal:main

```

OR

```bash

version: "3.8"

services:
  katal:
    image: ghcr.io/besoeasy/katal:test
    container_name: katal
    restart: unless-stopped
    ports:
      - "6798:6798"   # Bot setup UI
      - "6799:6799"   # Web file access
      - "445:445"     # SMB share
      - "59123:59123/tcp"
      - "59123:59123/udp"
    volumes:
      - katal-data:/tmp/katal

volumes:
  katal-data:
```

---

## 📡 Ports

| Port  | Purpose               |
| ----- | --------------------- |
| 6798  | Bot setup UI          |
| 6799  | Web file access       |
| 445   | Samba SMB share       |
| 59123 | Torrent communication |

---

## 🛠️ Integrations

KATAL supports a few torrent APIs out-of-the-box.
With some creativity, you can hook it into:

- 🎬 **Plex / Jellyfin** for media libraries
- 📺 **Sonarr / Radarr** for automation
- 🔍 **Bitmagnet** for discovery

---

## 🌍 Decentralization

Unlike traditional download managers, KATAL leverages **Nostr** to reduce reliance on centralized platforms.
This means:

- Minimal censorship
- Open participation
- Greater resilience
