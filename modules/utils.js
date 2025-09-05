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

// ------------------ Network Utils ------------------
export async function getIpData() {
  try {
    const { data } = await axios.get("http://ip-api.com/json/");
    if (data.status === "fail") {
      throw new Error(data.message || "IP API request failed");
    }
    return {
      query: data.query,
      country: data.country,
      regionName: data.regionName,
      city: data.city,
      isp: data.isp,
    };
  } catch (error) {
    console.error("Failed to fetch IP data:", error.message);
    return null;
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

// ------------------ Format Utils ------------------
export function formatDownloadSpeed(bytesPerSecond) {
  const kbps = Math.round(bytesPerSecond / 1024);
  if (kbps < 1024) {
    return `${kbps} KB/s`;
  }
  const mbps = (kbps / 1024).toFixed(1);
  return `${mbps} MB/s`;
}

export function getDownloadProgress(completedLength, totalLength) {
  if (totalLength === 0) return { percent: 0, completed: 0, total: 0 };

  const completed = Math.round((completedLength / 1024 / 1024) * 100) / 100; // MB
  const total = Math.round((totalLength / 1024 / 1024) * 100) / 100; // MB
  const percent = Math.round((completedLength / totalLength) * 100 * 10) / 10; // 1 decimal

  return { percent, completed, total };
}
