import { SimplePool, nip19, getPublicKey, finalizeEvent, nip04, generateSecretKey, getEventHash } from "nostr-tools";
import sqlite3 from "sqlite3";
import { open } from "sqlite";
import dotenv from "dotenv";
import path from "path";
import http from "http";
import serveHandler from "serve-handler";

import { SAVE_DIR, WEBX_PORT, getGlobalStats, downloadAria, getDownloadStatus, getOngoingDownloads, cancelDownload, isAria2Available } from "./aria2.js";

import { bytesToSize, getDirectorySize, getIpData, getImdbId, fetchTorrent, short, formatDownloadSpeed, getDownloadProgress } from "./utils.js";

import { startWebServer } from "./web.js";

dotenv.config();

const RELAYS = ["wss://relay.damus.io", "wss://nos.lol", "wss://relay.snort.social", "wss://nostr-pub.wellorder.net", "wss://nostr.oxtr.dev"];

function loadOrGeneratePrivateKey() {
  let BOT_PRIVKEY_RAW = process.env.BOT_PRIVKEY;

  // Check for NSEC format in environment variable
  if (!BOT_PRIVKEY_RAW && process.env.NSEC) {
    try {
      const decoded = nip19.decode(process.env.NSEC);
      if (decoded && decoded.type === "nsec") {
        BOT_PRIVKEY_RAW = Array.from(decoded.data)
          .map((b) => b.toString(16).padStart(2, "0"))
          .join("");
        console.log("[INFO] Using NSEC from environment variable");
      }
    } catch (e) {
      console.warn("[WARN] Invalid NSEC in environment variable:", e.message);
    }
  }

  if (!BOT_PRIVKEY_RAW) {
    // Generate a new random 32-byte private key using nostr-tools
    const secretKey = generateSecretKey();
    BOT_PRIVKEY_RAW = Array.from(secretKey)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    console.log("[INFO] Generated new private key for this session:");
    console.log("Private key (hex):", BOT_PRIVKEY_RAW);
    console.log("Private key (nsec):", nip19.nsecEncode(secretKey));
    console.log("[WARN] This key will be lost when the bot stops. Consider adding NSEC to .env file to persist identity.");
  }

  return BOT_PRIVKEY_RAW;
}

const BOT_PRIVKEY_RAW = loadOrGeneratePrivateKey();

const EVENT_WINDOW_MS = 5 * 60 * 1000; // 5 minutes

// ------------------ Helpers: privkey parsing ------------------
function parsePrivKey(input) {
  if (!input) return null;
  try {
    if (input.startsWith("nsec") || input.startsWith("NSEC")) {
      const decoded = nip19.decode(input);
      if (decoded && decoded.type === "nsec") {
        // Return as Uint8Array for new API
        return new Uint8Array(decoded.data);
      }
    }
  } catch (e) {}

  if (/^[0-9a-fA-F]{64}$/.test(input)) {
    // Convert hex string to Uint8Array
    const hexString = input.toLowerCase();
    const bytes = new Uint8Array(32);
    for (let i = 0; i < 32; i++) {
      bytes[i] = parseInt(hexString.substr(i * 2, 2), 16);
    }
    return bytes;
  }

  console.error("Invalid BOT_PRIVKEY format. Provide nsec or 64-hex private key.");
  process.exit(1);
}

const BOT_PRIVKEY = parsePrivKey(BOT_PRIVKEY_RAW);
const BOT_PUBKEY = getPublicKey(BOT_PRIVKEY);

// Convert to Nostr formats
const BOT_PRIVKEY_NSEC = nip19.nsecEncode(BOT_PRIVKEY);
const BOT_PUBKEY_NPUB = nip19.npubEncode(BOT_PUBKEY);

console.log("Bot pubkey (hex):", BOT_PUBKEY);
console.log("Bot pubkey (npub):", BOT_PUBKEY_NPUB);
console.log("Bot privkey (hex):", BOT_PRIVKEY_RAW);
console.log("Bot privkey (nsec):", BOT_PRIVKEY_NSEC);
console.log("Relays:", RELAYS.join(", "));

// ------------------ DB Setup ------------------
let db;
(async function initDB() {
  db = await open({ filename: ":memory:", driver: sqlite3.Database });
  await db.exec(`
    CREATE TABLE IF NOT EXISTS processed_events (
      id TEXT PRIMARY KEY,
      created_at INTEGER
    );
  `);
})();

// ------------------ Whitelist utilities ------------------
async function cleanupExpired() {
  const now = Date.now();
  await db.run("DELETE FROM processed_events WHERE created_at <= ?", now - EVENT_WINDOW_MS);
  console.log("[cleanup] removed old events");
}

setInterval(() => {
  cleanupExpired().catch((err) => console.error("cleanup error", err));
}, 10 * 60 * 1000); // Clean up every 10 minutes

// ------------------ Nostr connection ------------------
const pool = new SimplePool();

const filter = { kinds: [4], "#p": [BOT_PUBKEY] };

const sub = pool.subscribe(RELAYS, filter, {
  onevent: async (event) => {
    try {
      const sender = event.pubkey;
      const encrypted = event.content;

      // Skip events older than EVENT_WINDOW_MS
      const ageMs = Date.now() - event.created_at * 1000;
      if (ageMs > EVENT_WINDOW_MS) {
        return;
      }

      // Skip already processed events
      const seen = await db.get("SELECT id FROM processed_events WHERE id = ?", event.id);
      if (seen) {
        console.log(`Skipping duplicate event ${event.id}`);
        return;
      }

      // Mark event as processed
      await db.run("INSERT INTO processed_events (id, created_at) VALUES (?, ?)", event.id, event.created_at * 1000);

      // Decrypt (nip04)
      let decrypted;
      try {
        decrypted = await nip04.decrypt(BOT_PRIVKEY, sender, encrypted);
      } catch (e) {
        console.warn("Failed to decrypt message from", sender, "maybe not encrypted to me. Ignoring.");
        return;
      }

      const content = decrypted.trim();
      console.log(`DM from ${short(sender)}: ${content}`);

      // Clean content - remove any NIP-18 metadata
      const cleanContent = content.replace(/^\[\/\/\]: # \(nip18\)\s*/i, "").trim();

      // Check if it's a command (starts with known command words) or echo back
      const possibleCommand = cleanContent.split(/\s+/)[0].toLowerCase();
      const validCommands = ["help", "whoami", "start", "download", "dl", "downloading", "find", "ip", "time", "stats"];

      const isStatusCommand = possibleCommand.startsWith("status_");
      const isCancelCommand = possibleCommand.startsWith("cancel_");

      console.log(`Checking command: '${possibleCommand}' from content: '${cleanContent}'`);

      if (validCommands.includes(possibleCommand) || isStatusCommand || isCancelCommand) {
        console.log(`Executing command: ${possibleCommand}`);
        // Add small delay before processing command to ensure stability
        setTimeout(() => handleCommand(sender, cleanContent), 500);
        return;
      }

      // Send help message for unrecognized input
      console.log(`Unrecognized message: '${cleanContent}' - sending help`);
      await sendEncryptedDM(sender, `Unknown command. Send "help" to see available commands.`);
    } catch (err) {
      console.error("Error handling event:", err);
      // Add retry logic for failed event processing
      setTimeout(() => {
        console.log("Event processing error - system will continue");
      }, 1000);
    }
  },
  oneose: () => {
    console.log("Subscription established to relays.");
  },
});

// Add connection health check
setInterval(() => {
  try {
    // Simple health check - just log that we're still running
    console.log("Bot health check - system running normally");
  } catch (error) {
    console.error("Health check failed:", error);
  }
}, 60000); // Every minute

// ------------------ Command handling ------------------
async function handleCommand(sender, text) {
  const [cmd, ...args] = text.split(/\s+/);
  const userIdHash = sender.slice(0, 8); // Use first 8 chars of pubkey as user ID

  switch (cmd.toLowerCase()) {
    case "help":
      await sendEncryptedDM(
        sender,
        `help - show this\n` +
          `whoami - your pubkey\n` +
          `start - bot info and commands\n` +
          `download <url> - start download\n` +
          `dl <url> - alias for download\n` +
          `downloading - view active downloads\n` +
          `find <imdb_url_or_id> - search torrents\n` +
          `status_<gid> - check download status\n` +
          `cancel_<gid> - cancel download\n` +
          `stats - show aria2 global stats\n` +
          `ip - server IP info\n` +
          `time - server time`
      );
      break;

    case "whoami":
      await sendEncryptedDM(sender, `Your pubkey: ${sender}\nYour npub: ${nip19.npubEncode(sender)}`);
      break;

    case "start":
      const saveDirSize = await getDirectorySize(SAVE_DIR).catch(() => 0);
      const startMessage =
        `🤖 Katal Bot\n\n` +
        `Your User ID: ${userIdHash}\n` +
        `Used Space: ${bytesToSize(saveDirSize)}\n` +
        `Server Port: ${WEBX_PORT}\n\n` +
        `🌐 HTTP Access:\n` +
        `http://pi.local:${WEBX_PORT}\n\n` +
        `Send help for all commands`;
      await sendEncryptedDM(sender, startMessage);
      break;

    case "download":
    case "dl":
      if (args.length === 0) {
        await sendEncryptedDM(sender, "Please provide a URL to download.");
        break;
      }
      await handleDownload(sender, args[0], userIdHash);
      break;

    case "downloading":
      await handleDownloading(sender);
      break;

    case "find":
      if (args.length === 0) {
        await sendEncryptedDM(sender, "Please provide an IMDb URL or IMDb ID.");
        break;
      }
      await handleFind(sender, args[0]);
      break;

    case "ip":
      await handleIpData(sender);
      break;

    case "time":
      await sendEncryptedDM(sender, `Server time: ${new Date().toISOString()}`);
      break;

    case "stats":
      await handleStats(sender);
      break;

    default:
      if (cmd.toLowerCase().startsWith("status_")) {
        await handleStatus(sender, cmd.split("_")[1]);
      } else if (cmd.toLowerCase().startsWith("cancel_")) {
        await handleCancel(sender, cmd.split("_")[1]);
      } else {
        await sendEncryptedDM(sender, `Unknown command: ${cmd}. Send help for list.`);
      }
  }
}

// ------------------ Download Handlers ------------------
async function handleDownload(sender, input, userIdHash) {
  try {
    let magnet = null;
    let url = null;

    // Magnet link detection
    if (typeof input === "string") {
      const magnetMatch = input.match(/magnet:\?xt=urn:btih:[a-zA-Z0-9]+[^"]*/);
      if (magnetMatch) {
        magnet = magnetMatch[0];
      } else {
        // URL detection (http/https)
        const urlMatch = input.match(/https?:\/\/[\w\-\.\/?#&=:%]+/);
        if (urlMatch) {
          url = urlMatch[0];
        }
      }
    }

    if (magnet) {
      const downloadData = await downloadAria(userIdHash, magnet);
      if (downloadData && downloadData.result) {
        const downloadId = downloadData.result;
        await sendEncryptedDM(sender, "🧲 Magnet download started\n" + `Track: status_${downloadId}\n` + "See all: downloading");
      } else {
        await sendEncryptedDM(sender, "Failed to start magnet download. Check if Aria2 is running.");
      }
    } else if (url) {
      const downloadData = await downloadAria(userIdHash, url);
      if (downloadData && downloadData.result) {
        const downloadId = downloadData.result;
        await sendEncryptedDM(sender, "🔗 URL download started\n" + `Track: status_${downloadId}\n` + "See all: downloading");
      } else {
        await sendEncryptedDM(sender, "Failed to start URL download. Check if Aria2 is running.");
      }
    } else {
      await sendEncryptedDM(sender, "No valid magnet link or URL found in your input.");
    }
  } catch (error) {
    console.error("Download error:", error);
    await sendEncryptedDM(sender, "Failed to start download. Try again.");
  }
}

async function handleStatus(sender, downloadId) {
  try {
    const downloadData = await getDownloadStatus(downloadId);
    if (downloadData && downloadData.result) {
      const result = downloadData.result;
      const completedSize = (result.completedLength / 1024 / 1024).toFixed(2);
      const totalSize = (result.totalLength / 1024 / 1024).toFixed(2);
      const percent = totalSize > 0 ? ((completedSize / totalSize) * 100).toFixed(1) : "0";

      let reply = `📊 Download Status\n` + `Status: ${result.status}\n` + `Progress: ${completedSize} MB / ${totalSize} MB (${percent}%)\n`;

      if (result.status === "active") {
        reply += `Cancel: cancel_${downloadId}\n`;
      }

      const files = result.files
        .slice(0, 3) // Limit to first 3 files
        .map((file) => `📁 ${path.basename(file.path)}`)
        .join("\n");

      if (files) {
        reply += `\nFiles:\n${files}`;
        if (result.files.length > 3) {
          reply += `\n... and ${result.files.length - 3} more files`;
        }
      }

      await sendEncryptedDM(sender, reply);
    } else {
      await sendEncryptedDM(sender, `Could not get status for ${downloadId}. Download may not exist.`);
    }
  } catch (error) {
    console.error("Status error:", error);
    await sendEncryptedDM(sender, `Could not get status for ${downloadId}. Try again later.`);
  }
}

async function handleCancel(sender, downloadId) {
  try {
    const result = await cancelDownload(downloadId);
    if (result) {
      await sendEncryptedDM(sender, `❌ Download ${downloadId} canceled.`);
    } else {
      await sendEncryptedDM(sender, `Failed to cancel ${downloadId}. May not exist or already finished.`);
    }
  } catch (error) {
    console.error("Cancel error:", error);
    await sendEncryptedDM(sender, `Failed to cancel ${downloadId}. Try again later.`);
  }
}

async function handleDownloading(sender) {
  try {
    const ongoingData = await getOngoingDownloads();
    if (ongoingData && ongoingData.result && ongoingData.result.length > 0) {
      let reply = "📥 Ongoing Downloads\n\n";
      for (const download of ongoingData.result.slice(0, 5)) {
        // Limit to 5 downloads
        const { gid, completedLength, totalLength, status } = download;
        const downloadedSize = (completedLength / 1024 / 1024).toFixed(2);
        const totalSize = (totalLength / 1024 / 1024).toFixed(2);
        const progress = totalLength > 0 ? ((completedLength / totalLength) * 100).toFixed(1) : "0";

        reply += `🆔 status_${gid}\n`;
        reply += `📊 ${status} - ${progress}%\n`;
        reply += `💾 ${downloadedSize}/${totalSize} MB\n\n`;
      }
      await sendEncryptedDM(sender, reply);
    } else {
      await sendEncryptedDM(sender, "No ongoing downloads.");
    }
  } catch (error) {
    console.error("Downloads error:", error);
    await sendEncryptedDM(sender, "Failed to fetch downloads. Try again later.");
  }
}

async function handleFind(sender, imdbInput) {
  try {
    const imdbId = getImdbId(imdbInput);
    if (!imdbId) {
      await sendEncryptedDM(sender, "Please provide a valid IMDb URL or IMDb ID (e.g. tt1234567)");
      return;
    }

    await sendEncryptedDM(sender, "🔍 Searching torrents for " + imdbId + "...");
    const torrents = await fetchTorrent(imdbId);

    if (!torrents.length) {
      await sendEncryptedDM(sender, "No torrents found for this IMDb ID.");
      return;
    }

    // Send first 3 torrents
    for (let i = 0; i < Math.min(3, torrents.length); i++) {
      const t = torrents[i];
      await sendEncryptedDM(sender, `🎬 ${t.title}\n\n${t.magnet}`);
    }

    if (torrents.length > 3) {
      await sendEncryptedDM(sender, `... and ${torrents.length - 3} more results found.`);
    }
  } catch (error) {
    console.error("Find error:", error);
    await sendEncryptedDM(sender, "Failed to fetch torrents. Try again later.");
  }
}

async function handleIpData(sender) {
  try {
    const ipData = await getIpData();
    if (ipData) {
      await sendEncryptedDM(
        sender,
        "🌐 Server IP Info\n" +
          `IP: ${ipData.query}\n` +
          `Country: ${ipData.country}\n` +
          `Region: ${ipData.regionName}\n` +
          `City: ${ipData.city}\n` +
          `ISP: ${ipData.isp}`
      );
    } else {
      await sendEncryptedDM(sender, "Could not fetch IP info. Try again later.");
    }
  } catch (error) {
    console.error("IP data error:", error);
    await sendEncryptedDM(sender, "Could not fetch IP info. Try again later.");
  }
}

async function handleStats(sender) {
  try {
    const statsData = await getGlobalStats();
    if (statsData && statsData.result) {
      const stats = statsData.result;
      const downloadSpeed = bytesToSize(parseInt(stats.downloadSpeed)) + "/s";
      const uploadSpeed = bytesToSize(parseInt(stats.uploadSpeed)) + "/s";

      await sendEncryptedDM(
        sender,
        "📊 Aria2 Global Stats\n\n" +
          `🔽 Download Speed: ${downloadSpeed}\n` +
          `🔼 Upload Speed: ${uploadSpeed}\n` +
          `📦 Active Downloads: ${stats.numActive}\n` +
          `⏳ Waiting Downloads: ${stats.numWaiting}\n` +
          `🛑 Stopped Downloads: ${stats.numStopped}\n` +
          `📈 Total Downloads: ${parseInt(stats.numActive) + parseInt(stats.numWaiting) + parseInt(stats.numStopped)}`
      );
    } else {
      await sendEncryptedDM(sender, "Could not fetch aria2 stats. Check if aria2 is running.");
    }
  } catch (error) {
    console.error("Stats error:", error);
    await sendEncryptedDM(sender, "Failed to fetch stats. Try again later.");
  }
}

// ------------------ Periodic Stats Posting ------------------
let statsIntervalId = null;

async function startPeriodicStatsPosting() {
  console.log("📊 Starting periodic stats posting (every 10 minutes)");

  statsIntervalId = setInterval(async () => {
    try {
      const stats = await getGlobalStats();
      if (stats && stats.result) {
        const numActive = stats.result.numActive || 0;
        const numWaiting = stats.result.numWaiting || 0;
        const numStopped = stats.result.numStopped || 0;
        const downloadSpeed = Math.round((stats.result.downloadSpeed || 0) / 1024); // KB/s
        const uploadSpeed = Math.round((stats.result.uploadSpeed || 0) / 1024); // KB/s

        const saveDirSize = await getDirectorySize(SAVE_DIR).catch(() => 0);

        const statsMessage =
          "📊 Katal Bot Status\n\n" +
          `Active: ${numActive}\n` +
          `Queued: ${numWaiting}\n` +
          `Stopped: ${numStopped}\n` +
          `Download: ${downloadSpeed} KB/s\n` +
          `Upload: ${uploadSpeed} KB/s\n` +
          `Disk Used: ${bytesToSize(saveDirSize)}\n` +
          `Time: ${new Date().toISOString()}`;

        await postPublicNote(statsMessage);
        console.log("📊 Posted periodic stats update");
      }
    } catch (error) {
      console.error("Error posting periodic stats:", error);
    }
  }, 10 * 60 * 1000); // 10 minutes
}

function stopPeriodicStatsPosting() {
  if (statsIntervalId) {
    clearInterval(statsIntervalId);
    statsIntervalId = null;
    console.log("📊 Stopped periodic stats posting");
  }
}

// ------------------ Sending encrypted DM ------------------
async function sendEncryptedDM(toPubkey, plaintext, retryCount = 0) {
  const MAX_RETRIES = 2;
  const RETRY_DELAY = 1000; // 1 second delay between retries
  
  try {
    const encrypted = await nip04.encrypt(BOT_PRIVKEY, toPubkey, plaintext);

    const unsignedEvent = {
      kind: 4,
      created_at: Math.floor(Date.now() / 1000),
      tags: [["p", toPubkey]],
      content: encrypted,
    };

    // Use finalizeEvent to sign the event properly
    const signedEvent = finalizeEvent(unsignedEvent, BOT_PRIVKEY);

    // Add a small delay before publishing to ensure relay connections are stable
    await new Promise(resolve => setTimeout(resolve, 100));
    
    const results = pool.publish(RELAYS, signedEvent);
    console.log(`Sent DM to ${short(toPubkey)}.`);

    // Wait for publishing results with timeout
    const timeout = new Promise((_, reject) => 
      setTimeout(() => reject(new Error('Publishing timeout')), 10000)
    );

    try {
      const outcomes = await Promise.race([
        Promise.allSettled(results),
        timeout
      ]);

      const successful = outcomes.filter((o) => o.status === "fulfilled").length;
      const failed = outcomes.filter((o) => o.status === "rejected").length;
      
      console.log(`Publish results: ${successful} successful, ${failed} failed`);
      
      // If all failed and we haven't exceeded retries, try again
      if (successful === 0 && failed > 0 && retryCount < MAX_RETRIES) {
        console.log(`Retrying DM send (attempt ${retryCount + 1}/${MAX_RETRIES + 1})...`);
        setTimeout(() => {
          sendEncryptedDM(toPubkey, plaintext, retryCount + 1);
        }, RETRY_DELAY * (retryCount + 1)); // Exponential backoff
        return;
      }
      
    } catch (timeoutError) {
      console.warn("Publishing timeout, but message may still be delivered");
    }

  } catch (e) {
    console.error("Failed to send DM to", toPubkey, e);
    
    // Retry if we haven't exceeded max retries
    if (retryCount < MAX_RETRIES) {
      console.log(`Retrying DM send due to error (attempt ${retryCount + 1}/${MAX_RETRIES + 1})...`);
      setTimeout(() => {
        sendEncryptedDM(toPubkey, plaintext, retryCount + 1);
      }, RETRY_DELAY * (retryCount + 1));
    } else {
      console.error("Max retries exceeded for DM to", short(toPubkey));
    }
  }
}

// ------------------ Public Note Posting ------------------
// ------------------ Public Note Posting ------------------
async function postPublicNote(message) {
  try {
    console.log("Preparing to post public note...");

    const unsignedEvent = {
      kind: 1, // Text note
      created_at: Math.floor(Date.now() / 1000),
      tags: [],
      content: message,
    };

    // Use finalizeEvent to sign the event properly
    const signedEvent = finalizeEvent(unsignedEvent, BOT_PRIVKEY);
    console.log("Event signed, publishing to relays...");
    console.log("Event ID:", signedEvent.id);

    // Use the pool to publish - wait a bit longer for connections
    setTimeout(async () => {
      try {
        const publishPromises = pool.publish(RELAYS, signedEvent);

        // Wait for all publishing attempts
        const results = await Promise.allSettled(publishPromises);

        let successful = 0;
        let failed = 0;

        results.forEach((result, index) => {
          if (result.status === "fulfilled") {
            console.log(`✅ Published to ${RELAYS[index]}: ${result.value}`);
            successful++;
          } else {
            console.log(`❌ Failed to publish to ${RELAYS[index]}: ${result.reason}`);
            failed++;
          }
        });

        console.log(`Public post results: ${successful} successful, ${failed} failed`);

        if (successful === 0) {
          console.warn("Warning: No relays accepted the post");
        }
      } catch (error) {
        console.error("Error during publishing:", error);
      }
    }, 1000); // Wait 1 second for relay connections
  } catch (e) {
    console.error("Failed to prepare public note:", e);
  }
}

// ------------------ Graceful shutdown ------------------
process.on("SIGINT", async () => {
  console.log("Shutting down...");

  // Stop periodic stats posting
  stopPeriodicStatsPosting();

  // Close web server
  if (webServer) {
    webServer.close(() => {
      console.log("Web server closed");
    });
  }

  try {
    await db.close();
  } catch (e) {}

  // Close the subscription
  if (sub && sub.close) {
    sub.close();
  }

  // Destroy the pool (closes all relay connections)
  pool.destroy();

  process.exit(0);
});

console.log("Katal Bot starting up...");

// Add startup delay to ensure all services are ready
setTimeout(() => {
  console.log("Katal Bot running - send me a DM with commands!");
}, 2000);

// Start web dashboard with a small delay
setTimeout(() => {
  const botData = {
    pubkey: BOT_PUBKEY,
    npub: BOT_PUBKEY_NPUB,
    privkey: BOT_PRIVKEY_RAW,
    nsec: BOT_PRIVKEY_NSEC,
  };

  const webServer = startWebServer(6798, botData, SAVE_DIR, WEBX_PORT);
}, 1000);

// Start periodic stats posting after a longer delay
setTimeout(() => {
  startPeriodicStatsPosting();
}, 15000); // Wait 15 seconds before starting periodic stats

http
  .createServer((request, response) => {
    return serveHandler(request, response, {
      public: SAVE_DIR,
      directoryListing: true,
      cleanUrls: false,
    });
  })
  .listen(WEBX_PORT, () => {});
