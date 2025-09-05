import express from "express";
import { getGlobalStats } from "./aria2.js";
import { bytesToSize, getDirectorySize } from "./utils.js";

export function startWebServer(port, botData, saveDir, webxPort, SMBPORT) {
  const app = express();

  // Serve static files from public directory
  app.use(express.static("public"));

  // Home route - Serve the new Tailwind CSS + Vue.js dashboard
  app.get("/", (req, res) => {
    res.sendFile("index.html", { root: "public" });
  });

  // API endpoint for JSON data
  app.get("/api/status", async (req, res) => {
    try {
      const statsData = await getGlobalStats();
      const stats = statsData?.result || {};
      const saveDirSize = await getDirectorySize(saveDir).catch(() => 0);

      res.json({
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
      });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  const server = app.listen(port, () => {
    console.log(`🌐 Web dashboard running on http://localhost:${port}`);
  });

  return server;
}
