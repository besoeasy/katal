// Add at the very beginning of the file, before any other code

let isShuttingDown = false;

// Graceful shutdown handler
async function gracefulShutdown(signal) {
  if (isShuttingDown) {
    console.log("Already shutting down, please wait...");
    return;
  }

  isShuttingDown = true;
  console.log(`\n${signal} received - starting graceful shutdown...`);

  try {
    // Stop periodic stats posting
    if (typeof stopPeriodicStatsPosting === "function") {
      stopPeriodicStatsPosting();
      console.log("✓ Stopped stats posting");
    }

    // Close web server
    if (webServer) {
      webServer.stop();
      console.log("✓ Web server closed");
    }

    // Close the subscription
    if (sub && sub.close) {
      sub.close();
      console.log("✓ Closed subscription");
    }

    // Destroy the pool (closes all relay connections)
    if (pool && pool.close) {
      await pool.close(RELAYS);
      console.log("✓ Closed relay connections");
    }

    // Clear processed events
    if (processedEvents) {
      processedEvents.clear();
      console.log("✓ Cleared event cache");
    }

    console.log("✓ Graceful shutdown complete");
    process.exit(0);
  } catch (error) {
    console.error("Error during shutdown:", error);
    process.exit(1);
  }
}

// Register signal handlers immediately
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("SIGHUP", () => gracefulShutdown("SIGHUP"));

// Prevent the process from exiting on unhandled errors during shutdown
process.on("uncaughtException", (error) => {
  if (isShuttingDown) {
    console.log("Error during shutdown (ignoring):", error.message);
  } else {
    console.error("Uncaught exception:", error);
    gracefulShutdown("UNCAUGHT_EXCEPTION");
  }
});

import { SimplePool, nip19, getPublicKey, finalizeEvent, nip04, generateSecretKey, getEventHash } from "nostr-tools";
import dotenv from "dotenv";
import path from "path";
import fs from "fs";

import { getGlobalStats, downloadAria, getDownloadStatus, getOngoingDownloads, cancelDownload } from "./modules/aria2.js";
import { bytesToSize, getDirectorySize, getImdbId, fetchTorrent, short, RELAYS, randomcode } from "./modules/utils.js";
import { SERVERPORT, WEBPORT, SAVE_DIR, SMBPORT } from "./modules/vars.js";

dotenv.config();

// File management utility functions
async function getFilesRecursively(dir) {
  const files = [];
  try {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        files.push(...(await getFilesRecursively(fullPath)));
      } else if (entry.isFile()) {
        const stats = await fs.promises.stat(fullPath);
        files.push({ path: fullPath, mtime: stats.mtimeMs });
      }
    }
  } catch (error) {
    console.error(`Error reading directory ${dir}:`, error.message);
  }
  return files;
}

async function removeEmptyFolders(dir) {
  try {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await removeEmptyFolders(fullPath);
      }
    }
    const isEmpty = (await fs.promises.readdir(dir)).length === 0;
    if (isEmpty && dir !== SAVE_DIR) {
      // Don't delete the main SAVE_DIR
      await fs.promises.rmdir(dir);
      console.log(`Removed empty folder: ${dir}`);
    }
  } catch (error) {
    console.error(`Error removing empty folders from ${dir}:`, error.message);
  }
}

async function deleteOldFiles() {
  try {
    const files = await getFilesRecursively(SAVE_DIR);
    if (!files.length) {
      console.log("No files to delete.");
      return "No files to delete.";
    }
    files.sort((a, b) => a.mtime - b.mtime);
    const oldestFile = files[0];
    await fs.promises.unlink(oldestFile.path);
    console.log(`Deleted: ${oldestFile.path}`);
    await removeEmptyFolders(SAVE_DIR);
    return `🗑️ Deleted oldest file: ${path.basename(oldestFile.path)}`;
  } catch (error) {
    console.error("Error deleting files:", error.message);
    return "❌ Failed to delete files.";
  }
}

async function autoCleanOldFiles() {
  try {
    const files = await getFilesRecursively(SAVE_DIR);
    if (!files.length) {
      console.log("No files to auto-clean.");
      return "No files found to auto-clean.";
    }

    const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const oldFiles = files.filter((file) => file.mtime < thirtyDaysAgo);

    if (!oldFiles.length) {
      console.log("No files older than 30 days found.");
      return "No files older than 30 days found.";
    }

    let deletedCount = 0;
    let totalSize = 0;

    for (const file of oldFiles) {
      try {
        const stats = await fs.promises.stat(file.path);
        totalSize += stats.size;
        await fs.promises.unlink(file.path);
        deletedCount++;
        console.log(`Auto-deleted: ${file.path}`);
      } catch (error) {
        console.error(`Failed to delete ${file.path}:`, error.message);
      }
    }

    await removeEmptyFolders(SAVE_DIR);

    const message = `🧹 Auto-clean completed!\n` + `✅ Deleted ${deletedCount} files older than 30 days\n` + `💾 Freed up ${bytesToSize(totalSize)} of space`;

    console.log(`Auto-clean: Deleted ${deletedCount} files, freed ${bytesToSize(totalSize)}`);
    return message;
  } catch (error) {
    console.error("Error during auto-clean:", error.message);
    return "❌ Auto-clean failed. Try again later.";
  }
}

const UNLOCKCODE = process.env.UNLOCKCODE || randomcode();

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

const EVENT_WINDOW_MS = 2 * 60 * 1000;

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
console.log("🔐 Unlock Code:", UNLOCKCODE);
console.log("Relays:", RELAYS.join(", "));

// ------------------ Event tracking with in-memory array ------------------
const MAX_STORED_EVENTS = 1000; // Reduced from 10000 since we're managing it more efficiently
const processedEvents = new Map(); // Map of event_id -> timestamp

// ------------------ Whitelist system ------------------
const whitelist = new Set(); // Set of authorized pubkeys

// ------------------ Nostr connection ------------------
let pool = new SimplePool();
let sub = null;

const filter = { kinds: [4], "#p": [BOT_PUBKEY] };

// Function to create new relay connection
function createRelayConnection() {
  const startTime = Date.now();
  console.log("🔄 Creating new relay connection...");

  // Close existing subscription if it exists
  if (sub && sub.close) {
    try {
      sub.close();
      console.log("✅ Closed existing subscription");
    } catch (error) {
      console.warn("⚠️  Error closing subscription:", error.message);
    }
  }

  // Destroy existing pool if it exists
  if (pool) {
    try {
      pool.destroy();
      console.log("✅ Destroyed existing pool");
    } catch (error) {
      console.warn("⚠️  Error destroying pool:", error.message);
    }
  }

  // Short pause to ensure cleanup is complete
  setTimeout(() => {
    // Create new pool
    pool = new SimplePool();
    console.log("✅ Created new pool");

    // Create new subscription
    sub = pool.subscribe(RELAYS, filter, {
      onevent: async (event) => {
        try {
          const sender = event.pubkey;
          const encrypted = event.content;

          console.log(`📨 Received event ${event.id.slice(0, 8)} from ${sender.slice(0, 8)}`);

          // Skip events older than EVENT_WINDOW_MS
          const ageMs = Date.now() - event.created_at * 1000;
          if (ageMs > EVENT_WINDOW_MS) {
            console.log(`⏰ Skipping old event (${Math.round(ageMs / 1000)}s old)`);
            return;
          }

          // Skip already processed events
          if (processedEvents.has(event.id)) {
            console.log(`♻️  Skipping duplicate event ${event.id.slice(0, 8)}`);
            return;
          }

          // Mark event as processed and maintain cache size
          processedEvents.set(event.id, event.created_at * 1000);

          // Remove oldest entries if we exceed the limit
          if (processedEvents.size > MAX_STORED_EVENTS) {
            // Find and remove the oldest entry
            let oldestEventId = null;
            let oldestTimestamp = Infinity;

            for (const [eventId, timestamp] of processedEvents.entries()) {
              if (timestamp < oldestTimestamp) {
                oldestTimestamp = timestamp;
                oldestEventId = eventId;
              }
            }

            if (oldestEventId) {
              processedEvents.delete(oldestEventId);
              console.log(`🗑️  Cache cleanup: removed oldest event, size: ${processedEvents.size}`);
            }
          }

          // Decrypt (nip04)
          let decrypted;
          try {
            console.log(`🔓 Attempting to decrypt message from ${sender.slice(0, 8)}`);
            decrypted = await nip04.decrypt(BOT_PRIVKEY, sender, encrypted);
            console.log(`✅ Successfully decrypted message`);
          } catch (e) {
            console.warn(`❌ Failed to decrypt message from ${sender.slice(0, 8)}:`, e.message);
            return;
          }

          const content = decrypted.trim();
          console.log(`💬 DM from ${short(sender)}: ${content}`);

          // Clean content - remove any NIP-18 metadata
          const cleanContent = content.replace(/^\[\/\/\]: # \(nip18\)\s*/i, "").trim();

          // Check if user is authorized
          if (!whitelist.has(sender)) {
            console.log(`🚫 Unauthorized user ${short(sender)} - checking for unlock code`);

            // Check if they sent the unlock code
            if (cleanContent === UNLOCKCODE) {
              whitelist.add(sender);
              console.log(`✅ User ${short(sender)} authorized with unlock code`);
              await sendEncryptedDM(sender, `🔓 Access granted! You are now authorized to use Katal Bot.\n\n` + `Send "help" to see available commands.`);
              return;
            }

            // Not authorized and didn't send unlock code
            console.log(`❌ User ${short(sender)} not authorized - requesting unlock code`);
            await sendEncryptedDM(
              sender,
              `🔐 Access Required\n\n` +
                `This bot requires authorization to prevent abuse.\n` +
                `Please send the unlock code to gain access.\n\n` +
                `Contact the bot owner for the unlock code.`
            );
            return;
          }

          console.log(`✅ Authorized user ${short(sender)} - processing command`);

          // Check if it's a command (starts with known command words) or echo back
          const possibleCommand = cleanContent.split(/\s+/)[0].toLowerCase();

          const validCommands = ["help", "whoami", "start", "download", "dl", "downloading", "find", "ip", "time", "stats", "clean", "autoclean"];

          const isStatusCommand = possibleCommand.startsWith("status_");
          const isCancelCommand = possibleCommand.startsWith("cancel_");
          const isDlHashCommand = possibleCommand.startsWith("dl_"); // Add this line

          console.log(`Checking command: '${possibleCommand}' from content: '${cleanContent}'`);

          if (validCommands.includes(possibleCommand) || isStatusCommand || isCancelCommand || isDlHashCommand) {
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
        console.log("✅ Subscription established to relays");
        console.log(`📡 Connected to ${RELAYS.length} relays for maximum reliability`);
      },
      onclose: (reason) => {
        console.warn("⚠️  Subscription closed:", reason);
        console.log("🔄 Attempting to reconnect...");

        // Attempt to reconnect after 5 seconds
        setTimeout(() => {
          console.log("🔌 Reconnecting to relays...");
          // The pool will automatically handle reconnection
        }, 5000);
      },
    });

    const endTime = Date.now();
    console.log(`✅ Relay connection created successfully in ${endTime - startTime}ms`);
  }, 100); // Small delay to ensure cleanup
}

// Initial connection setup
createRelayConnection();

// Restart relay connections every 100 seconds to prevent stuck connections
setInterval(() => {
  console.log("🔄 Scheduled relay restart (every 100 seconds)");
  createRelayConnection();
}, 100 * 1000); // 100 seconds

// Add connection health check with more detailed logging
setInterval(() => {
  try {
    const connectedRelays = pool && pool.seenOn ? pool.seenOn.size : 0;
    console.log(
      `💓 Health check - Cache: ${processedEvents.size} events, Whitelist: ${whitelist.size} users, Connected relays: ${connectedRelays}/${RELAYS.length}`
    );

    // Log relay connection status periodically (every 5th health check = 5 minutes)
    if (Math.random() < 0.2) {
      // 20% chance each minute = roughly every 5 minutes
      console.log(`🌐 Relay status check - ensuring connectivity to all ${RELAYS.length} relays`);
    }
  } catch (error) {
    console.error("❌ Health check failed:", error);
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
        `🤖 Katal Bot Commands\n\n` +
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
          `clean - delete oldest file\n` +
          `autoclean - delete files older than 30 days\n` +
          `time - server time\n\n` +
          `✅ You are authorized (whitelisted)`
      );
      break;

    case "whoami":
      await sendEncryptedDM(sender, `Your pubkey: ${sender}\nYour npub: ${nip19.npubEncode(sender)}`);
      break;

    case "start":
      const saveDirSize = await getDirectorySize(SAVE_DIR).catch(() => 0);

      // Read SMB credentials from file
      let smbCredentials = "";
      try {
        const credentialsData = fs.readFileSync("/var/run/smb_credentials.txt", "utf8").trim();
        const [smbUser, smbPass] = credentialsData.split(":");
        smbCredentials =
          `\n📁 SMB/Samba Access:\n` +
          `Guest (read-only): //hostname/katal\n` +
          `Full access: //hostname/katal-rw\n` +
          `Username: ${smbUser}\n` +
          `Password: ${smbPass}\n`;
      } catch (error) {
        console.log("Could not read SMB credentials:", error.message);
        smbCredentials = `\n📁 SMB Access: Not configured\n`;
      }

      const startMessage =
        `🤖 Katal Bot\n\n` +
        `Your User ID: ${userIdHash}\n` +
        `Used Space: ${bytesToSize(saveDirSize)}\n` +
        `Server Port: ${SERVERPORT}\n\n` +
        `🌐 HTTP Access:\n` +
        `http://hostname:${SERVERPORT}\n` +
        smbCredentials +
        `\n` +
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

    case "time":
      await sendEncryptedDM(sender, `Server time: ${new Date().toISOString()}`);
      break;

    case "stats":
      await handleStats(sender);
      break;

    case "clean":
      console.log(`User ${short(sender)} requested clean command`);
      const cleanResult = await deleteOldFiles();
      await sendEncryptedDM(sender, cleanResult);
      break;

    case "autoclean":
      console.log(`User ${short(sender)} requested autoclean command`);
      const autocleanResult = await autoCleanOldFiles();
      await sendEncryptedDM(sender, autocleanResult);
      break;

    default:
      if (cmd.toLowerCase().startsWith("status_")) {
        await handleStatus(sender, cmd.split("_")[1]);
      } else if (cmd.toLowerCase().startsWith("cancel_")) {
        await handleCancel(sender, cmd.split("_")[1]);
      } else if (cmd.toLowerCase().startsWith("dl_")) {
        const hash = cmd.split("_")[1];
        if (hash) {
          const magnetLink = `magnet:?xt=urn:btih:${hash}`;
          await handleDownload(sender, magnetLink, sender.slice(0, 8));
        } else {
          await sendEncryptedDM(sender, "Invalid download command. Hash missing.");
        }
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

    // Send first 3 torrents with clickable download commands
    for (let i = 0; i < Math.min(3, torrents.length); i++) {
      const t = torrents[i];

      // Extract hash from magnet link
      const hashMatch = t.magnet.match(/btih:([a-zA-Z0-9]+)/);
      const hash = hashMatch ? hashMatch[1] : null;

      let message = `🎬 ${t.title}\n\n`;

      if (hash) {
        // Add clickable download command
        message += `📥 Quick download: dl_${hash}\n\n`;
      }

      message += t.magnet;

      await sendEncryptedDM(sender, message);
    }

    if (torrents.length > 3) {
      await sendEncryptedDM(sender, `... and ${torrents.length - 3} more results found.`);
    }
  } catch (error) {
    console.error("Find error:", error);
    await sendEncryptedDM(sender, "Failed to fetch torrents. Try again later.");
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

        const uptime = process.uptime();
        const uptimeHours = Math.floor(uptime / 3600);
        const uptimeMinutes = Math.floor((uptime % 3600) / 60);
        const uptimeSeconds = uptime % 60;

        const statsMessage =
          "📊 Katal Bot Status\n\n" +
          `Uptime: ${uptimeHours}h ${uptimeMinutes}m ${uptimeSeconds}s\n` +
          `Authorised Users: ${getAuthorisedUserCount()}\n` +
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
  }, 25 * 60 * 1000); // 25 minutes
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
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Check if pool exists (might be temporarily null during restart)
    if (!pool) {
      console.warn("⚠️  Pool not available during DM sending, retrying in 1 second...");
      await new Promise((resolve) => setTimeout(resolve, 1000));
      if (!pool) {
        throw new Error("Pool unavailable after retry");
      }
    }

    const results = pool.publish(RELAYS, signedEvent);
    console.log(`Sent DM to ${short(toPubkey)}.`);

    // Wait for publishing results with timeout
    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error("Publishing timeout")), 10000));

    try {
      const outcomes = await Promise.race([Promise.allSettled(results), timeout]);

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

async function postPublicNote(message) {
  try {
    console.log("Preparing to post public note...");

    const unsignedEvent = {
      kind: 1, // Text note
      created_at: Math.floor(Date.now() / 1000),
      tags: [],
      content: message + "\n\n#bot #katal \nAutomated Post By : https://github.com/besoeasy/katal",
    };

    // Use finalizeEvent to sign the event properly
    const signedEvent = finalizeEvent(unsignedEvent, BOT_PRIVKEY);
    console.log("Event signed, publishing to relays...");
    console.log("Event ID:", signedEvent.id);

    // Use the pool to publish - wait a bit longer for connections
    setTimeout(async () => {
      try {
        // Check if pool exists (might be temporarily null during restart)
        if (!pool) {
          console.warn("⚠️  Pool not available during stats posting, skipping this cycle");
          return;
        }

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
let webServer; // Declare webServer variable

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

  // Clear processed events
  processedEvents.clear();
  console.log("Cleared processed events cache");

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
}, 7000);

// Start web dashboard with a small delay
setTimeout(() => {
  const botData = {
    pubkey: BOT_PUBKEY,
    npub: BOT_PUBKEY_NPUB,
    privkey: BOT_PRIVKEY_RAW,
    nsec: BOT_PRIVKEY_NSEC,
    unlockCode: UNLOCKCODE,
    getWhitelistCount: () => whitelist.size,
  };

  // Inline startWebServer logic from modules/web.js
  webServer = Bun.serve({
    port: WEBPORT,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/api/status") {
        try {
          const statsData = await getGlobalStats();
          const stats = statsData?.result || {};
          const saveDirSize = await getDirectorySize(SAVE_DIR).catch(() => 0);
          return new Response(
            JSON.stringify({
              pubkey: botData.pubkey,
              npub: botData.npub,
              webxPort: SERVERPORT,
              smbPort: SMBPORT,
              saveDir: SAVE_DIR,
              usedSpace: saveDirSize,
              usedSpaceFormatted: bytesToSize(saveDirSize),
              uptime: process.uptime(),
              aria2Stats: stats,
              unlockCode: botData.unlockCode,
              whitelistCount: botData.getWhitelistCount ? botData.getWhitelistCount() : 0,
              timestamp: new Date().toISOString(),
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        } catch (error) {
          return new Response(JSON.stringify({ error: error.message }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
          });
        }
      }

      // Serve index.html for root
      if (url.pathname === "/") {
        try {
          const html = await readFile(join("public", "index.html"));
          return new Response(html, { status: 200, headers: { "Content-Type": "text/html" } });
        } catch {
          return new Response("Not found", { status: 404 });
        }
      }

      // Serve static files from public directory
      if (url.pathname.startsWith("/")) {
        const filePath = join("public", url.pathname);
        try {
          const file = await readFile(filePath);
          // Basic content type detection
          let contentType = "application/octet-stream";
          if (filePath.endsWith(".js")) contentType = "application/javascript";
          else if (filePath.endsWith(".css")) contentType = "text/css";
          else if (filePath.endsWith(".html")) contentType = "text/html";
          else if (filePath.endsWith(".json")) contentType = "application/json";
          else if (filePath.endsWith(".png")) contentType = "image/png";
          else if (filePath.endsWith(".jpg") || filePath.endsWith(".jpeg")) contentType = "image/jpeg";
          else if (filePath.endsWith(".svg")) contentType = "image/svg+xml";
          return new Response(file, { status: 200, headers: { "Content-Type": contentType } });
        } catch {
          // Not found
        }
      }
      return new Response("Not found", { status: 404 });
    },
  });
  console.log(`🌐 Web dashboard running on http://localhost:${WEBPORT}`);
}, 1000);

// Start periodic stats posting after a longer delay
setTimeout(() => {
  startPeriodicStatsPosting();
}, 55000); // Wait 15 seconds before starting periodic stats

import { join } from "path";
import { readdir, stat, readFile } from "fs/promises";

const serveStatic = async (req, dir) => {
  const url = new URL(req.url);
  let filePath = join(dir, decodeURIComponent(url.pathname));
  try {
    const fileStat = await stat(filePath);
    if (fileStat.isDirectory()) {
      // Directory listing
      const files = await readdir(filePath);
      return new Response(
        `<h1>Index of ${url.pathname}</h1><ul>` + files.map((f) => `<li><a href="${url.pathname.replace(/\/$/, "")}/${f}">${f}</a></li>`).join("") + `</ul>`,
        { headers: { "Content-Type": "text/html" } }
      );
    } else {
      // Serve file
      const data = await readFile(filePath);
      return new Response(data);
    }
  } catch {
    return new Response("Not found", { status: 404 });
  }
};

Bun.serve({
  port: SERVERPORT,
  async fetch(req) {
    return serveStatic(req, SAVE_DIR);
  },
});
