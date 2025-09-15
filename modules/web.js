
import { getGlobalStats } from "./aria2.js";
import { bytesToSize, getDirectorySize } from "./utils.js";
import { join } from "path";
import { readFile } from "fs/promises";

export function startWebServer(port, botData, saveDir, webxPort, SMBPORT) {
  const server = Bun.serve({
    port,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/api/status") {
        try {
          const statsData = await getGlobalStats();
          const stats = statsData?.result || {};
          const saveDirSize = await getDirectorySize(saveDir).catch(() => 0);
          return new Response(
            JSON.stringify({
              pubkey: botData.pubkey,
              npub: botData.npub,
              webxPort: webxPort,
              smbPort: SMBPORT,
              saveDir: saveDir,
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
  console.log(`🌐 Web dashboard running on http://localhost:${port}`);
  return server;
}
