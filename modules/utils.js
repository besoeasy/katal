import axios from "axios";
import fs from "fs";
import path from "path";

// ------------------ File System Utils ------------------
export function bytesToSize(bytes) {
  const sizes = ["Bytes", "KB", "MB", "GB", "TB"];
  if (bytes === 0) return "0 Bytes";
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / 1024 ** i).toFixed(2)} ${sizes[i]}`;
}

export async function getDirectorySize(directory) {
  try {
    const entries = await fs.promises.readdir(directory, { withFileTypes: true });
    const sizes = await Promise.all(
      entries.map((entry) => {
        const fullPath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          return getDirectorySize(fullPath);
        }
        return fs.promises.stat(fullPath).then((stat) => stat.size);
      })
    );
    return sizes.reduce((acc, size) => acc + size, 0);
  } catch (error) {
    if (error.code === "ENOENT") {
      return 0; // Directory does not exist
    }
    throw error;
  }
}

// ------------------ Torrent Search Utils ------------------
export function getImdbId(url) {
  const match = url.match(/(tt\d{7,8})/);
  return match ? match[1] : null;
}

export async function fetchTorrent(imdbId) {
  try {
    const response = await axios.get(`https://torrentio.strem.fun/stream/movie/${imdbId}.json`);
    const streams = response.data.streams || [];

    return streams
      .map((stream) => ({
        title: stream.title || "Unknown",
        magnet: stream.infoHash ? `magnet:?xt=urn:btih:${stream.infoHash}&dn=${encodeURIComponent(stream.title || "torrent")}` : null,
      }))
      .filter((item) => item.magnet);
  } catch (error) {
    console.error("Torrent fetch error:", error);
    return [];
  }
}

// ------------------ String Utils ------------------
export function short(s) {
  return s ? s.slice(0, 6) + "..." + s.slice(-4) : s;
}

export const RELAYS = [
  "wss://relay.damus.io",
  "wss://nos.lol",
  "wss://relay.snort.social",
  "wss://nostr-pub.wellorder.net",
  "wss://nostr.oxtr.dev",
  "wss://relay.nostr.band",
  "wss://nostr.wine",
  "wss://relay.primal.net",
  "wss://nostr.mom",
  "wss://relay.nostr.info",
  "wss://nostr-relay.wlvs.space",
  "wss://relay.current.fyi",
  "wss://brb.io",
  "wss://nostr.fmt.wiz.biz",
  "wss://relay.nostr.bg",
  "wss://nostr.inosta.cc",
  "wss://relay.orangepill.dev",
  "wss://nostr.rocks",
  "wss://nostr.zebedee.cloud",
  "wss://relay.nostrati.com",
  "wss://nostr.sandwich.farm",
  "wss://nostr.land",
  "wss://relay.minds.com/nostr/v1/ws",
  "wss://nostr.bitcoiner.social",
  "wss://relay.lexingtonbitcoin.org",
  "wss://nostr.hugo.com.br",
  "wss://relay.nostr.ro",
  "wss://nostr.bitcoinmaximalists.online",
  "wss://nostr.8e23.net",
  "wss://relay.nostr.nu",
];

export const randomcode = () => {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let result = "";

  const randomDecimal = Math.floor(Math.random() * (20 - 10 + 1)) + 10;

  for (let i = 0; i < randomDecimal; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
};
