import express from 'express';
import { getGlobalStats } from './aria2.js';
import { bytesToSize, getDirectorySize } from './utils.js';

export function startWebServer(port, botData, saveDir, webxPort) {
  const app = express();
  
  // Set up EJS as template engine (we'll use simple HTML for now)
  app.use(express.static('public'));
  
  // Home route - Bot status dashboard
  app.get('/', async (req, res) => {
    try {
      // Get aria2 stats
      const statsData = await getGlobalStats();
      const stats = statsData?.result || {};
      
      // Get directory size
      const saveDirSize = await getDirectorySize(saveDir).catch(() => 0);
      
      // Prepare bot status data
      const botStatus = {
        pubkey: botData.pubkey,
        npub: botData.npub,
        webxPort: webxPort,
        saveDir: saveDir,
        usedSpace: bytesToSize(saveDirSize),
        uptime: process.uptime(),
        aria2Stats: {
          downloadSpeed: bytesToSize(parseInt(stats.downloadSpeed || 0)) + '/s',
          uploadSpeed: bytesToSize(parseInt(stats.uploadSpeed || 0)) + '/s',
          activeDownloads: stats.numActive || 0,
          waitingDownloads: stats.numWaiting || 0,
          stoppedDownloads: stats.numStopped || 0,
          totalDownloads: parseInt(stats.numActive || 0) + parseInt(stats.numWaiting || 0) + parseInt(stats.numStopped || 0)
        },
        timestamp: new Date().toISOString()
      };
      
      // Generate HTML response
      const html = generateDashboardHTML(botStatus);
      res.send(html);
      
    } catch (error) {
      console.error('Web dashboard error:', error);
      res.status(500).send(`
        <h1>Error</h1>
        <p>Failed to load bot status: ${error.message}</p>
        <a href="/">Retry</a>
      `);
    }
  });
  
  // API endpoint for JSON data
  app.get('/api/status', async (req, res) => {
    try {
      const statsData = await getGlobalStats();
      const stats = statsData?.result || {};
      const saveDirSize = await getDirectorySize(saveDir).catch(() => 0);
      
      res.json({
        pubkey: botData.pubkey,
        npub: botData.npub,
        webxPort: webxPort,
        saveDir: saveDir,
        usedSpace: saveDirSize,
        usedSpaceFormatted: bytesToSize(saveDirSize),
        uptime: process.uptime(),
        aria2Stats: stats,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });
  
  // QR Code page for NPUB
  app.get('/qr', (req, res) => {
    const html = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Bot NPUB QR Code</title>
    <style>
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            margin: 0;
            padding: 20px;
            background-color: #1a1a1a;
            color: #ffffff;
            text-align: center;
        }
        .container {
            max-width: 600px;
            margin: 0 auto;
        }
        .qr-container {
            background: #2a2a2a;
            border-radius: 15px;
            padding: 30px;
            border: 1px solid #333;
            margin: 20px 0;
        }
        .qr-code {
            background: white;
            padding: 20px;
            border-radius: 10px;
            display: inline-block;
            margin: 20px 0;
        }
        .npub-text {
            background: #333;
            padding: 15px;
            border-radius: 8px;
            font-family: 'Courier New', monospace;
            font-size: 14px;
            word-break: break-all;
            margin: 20px 0;
        }
        .back-btn {
            background: #ff6b35;
            color: white;
            border: none;
            padding: 10px 20px;
            border-radius: 5px;
            cursor: pointer;
            font-size: 14px;
            text-decoration: none;
            display: inline-block;
        }
        .back-btn:hover {
            background: #e55a2b;
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>🤖 Bot NPUB QR Code</h1>
        <div class="qr-container">
            <h3>Scan to get Bot's Public Key</h3>
            <div class="qr-code">
                <img src="https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(botData.npub)}" 
                     alt="NPUB QR Code">
            </div>
            <div class="npub-text">
                ${botData.npub}
            </div>
            <p>Share this QR code to allow others to find and message the bot on Nostr!</p>
        </div>
        <a href="/" class="back-btn">← Back to Dashboard</a>
    </div>
</body>
</html>`;
    res.send(html);
  });
  
  const server = app.listen(port, () => {
    console.log(`🌐 Web dashboard running on http://localhost:${port}`);
  });
  
  return server;
}

function generateDashboardHTML(botStatus) {
  const uptimeHours = Math.floor(botStatus.uptime / 3600);
  const uptimeMinutes = Math.floor((botStatus.uptime % 3600) / 60);
  
  return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Nostr Aria Bot - Dashboard</title>
    <style>
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            margin: 0;
            padding: 20px;
            background-color: #1a1a1a;
            color: #ffffff;
        }
        .container {
            max-width: 1200px;
            margin: 0 auto;
        }
        .header {
            text-align: center;
            margin-bottom: 30px;
        }
        .header h1 {
            color: #ff6b35;
            margin-bottom: 10px;
        }
        .status-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
            gap: 20px;
            margin-bottom: 30px;
        }
        .status-card {
            background: #2a2a2a;
            border-radius: 10px;
            padding: 20px;
            border: 1px solid #333;
        }
        .status-card h3 {
            margin-top: 0;
            color: #ff6b35;
            border-bottom: 1px solid #333;
            padding-bottom: 10px;
        }
        .status-item {
            display: flex;
            justify-content: space-between;
            margin: 10px 0;
            padding: 5px 0;
        }
        .status-label {
            font-weight: 500;
            color: #bbb;
        }
        .status-value {
            color: #fff;
            font-family: 'Courier New', monospace;
        }
        .pubkey {
            word-break: break-all;
            font-size: 12px;
        }
        .refresh-btn {
            background: #ff6b35;
            color: white;
            border: none;
            padding: 10px 20px;
            border-radius: 5px;
            cursor: pointer;
            font-size: 14px;
        }
        .refresh-btn:hover {
            background: #e55a2b;
        }
        .footer {
            text-align: center;
            margin-top: 30px;
            color: #666;
            font-size: 12px;
        }
        .online-indicator {
            display: inline-block;
            width: 10px;
            height: 10px;
            background-color: #4CAF50;
            border-radius: 50%;
            margin-right: 8px;
        }
        .qr-link {
            color: #ff6b35 !important;
            text-decoration: none;
        }
        .qr-link:hover {
            color: #e55a2b !important;
            text-decoration: underline;
        }
    </style>
    <script>
        function refreshPage() {
            window.location.reload();
        }
        
        // Auto-refresh every 30 seconds
        setInterval(refreshPage, 30000);
    </script>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>🤖 Nostr Aria Bot Dashboard</h1>
            <p><span class="online-indicator"></span>Status: Online</p>
            <button class="refresh-btn" onclick="refreshPage()">🔄 Refresh</button>
        </div>
        
        <div class="status-grid">
            <div class="status-card">
                <h3>🔑 Bot Identity</h3>
                <div class="status-item">
                    <span class="status-label">Public Key (hex):</span>
                    <span class="status-value pubkey">${botStatus.pubkey}</span>
                </div>
                <div class="status-item">
                    <span class="status-label">Public Key (npub):</span>
                    <span class="status-value pubkey">${botStatus.npub}</span>
                </div>
                <div class="status-item">
                    <span class="status-label">NPUB QR Code:</span>
                </div>
                <div style="text-align: center; margin: 15px 0;">
                    <img src="https://api.qrserver.com/v1/create-qr-code/?size=150x150&data=${encodeURIComponent(botStatus.npub)}" 
                         alt="NPUB QR Code" 
                         style="border: 2px solid #333; border-radius: 8px; cursor: pointer;"
                         title="Click for larger QR code"
                         onclick="window.open('/qr', '_blank')">
                    <br>
                    <small style="color: #888;">
                        <a href="/qr" target="_blank" class="qr-link">
                            📱 Click for larger QR code
                        </a>
                    </small>
                </div>
            </div>
            
            <div class="status-card">
                <h3>🌐 Server Info</h3>
                <div class="status-item">
                    <span class="status-label">Web Dashboard Port:</span>
                    <span class="status-value">6798</span>
                </div>
                <div class="status-item">
                    <span class="status-label">File Server Port:</span>
                    <span class="status-value">${botStatus.webxPort}</span>
                </div>
                <div class="status-item">
                    <span class="status-label">Save Directory:</span>
                    <span class="status-value">${botStatus.saveDir}</span>
                </div>
                <div class="status-item">
                    <span class="status-label">Used Space:</span>
                    <span class="status-value">${botStatus.usedSpace}</span>
                </div>
                <div class="status-item">
                    <span class="status-label">Uptime:</span>
                    <span class="status-value">${uptimeHours}h ${uptimeMinutes}m</span>
                </div>
            </div>
            
            <div class="status-card">
                <h3>📊 Aria2 Stats</h3>
                <div class="status-item">
                    <span class="status-label">Download Speed:</span>
                    <span class="status-value">${botStatus.aria2Stats.downloadSpeed}</span>
                </div>
                <div class="status-item">
                    <span class="status-label">Upload Speed:</span>
                    <span class="status-value">${botStatus.aria2Stats.uploadSpeed}</span>
                </div>
                <div class="status-item">
                    <span class="status-label">Active Downloads:</span>
                    <span class="status-value">${botStatus.aria2Stats.activeDownloads}</span>
                </div>
                <div class="status-item">
                    <span class="status-label">Waiting Downloads:</span>
                    <span class="status-value">${botStatus.aria2Stats.waitingDownloads}</span>
                </div>
                <div class="status-item">
                    <span class="status-label">Stopped Downloads:</span>
                    <span class="status-value">${botStatus.aria2Stats.stoppedDownloads}</span>
                </div>
                <div class="status-item">
                    <span class="status-label">Total Downloads:</span>
                    <span class="status-value">${botStatus.aria2Stats.totalDownloads}</span>
                </div>
            </div>
        </div>
        
        <div class="footer">
            <p>Last updated: ${botStatus.timestamp}</p>
            <p>Auto-refresh every 30 seconds</p>
            <p>Files available at: <a href="http://localhost:${botStatus.webxPort}" target="_blank">http://localhost:${botStatus.webxPort}</a></p>
        </div>
    </div>
</body>
</html>
  `;
}
