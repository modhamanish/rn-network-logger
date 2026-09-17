#!/usr/bin/env node

const fs = require("fs");
const http = require("http");
const path = require("path");
const WebSocket = require("ws");

const port = 19796;
const activeClients = new Set();

const faviconSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><defs><linearGradient id="grad" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#8c52ff"/><stop offset="100%" stop-color="#00e6ff"/></linearGradient></defs><rect width="32" height="32" rx="8" fill="#16161a"/><rect x="1" y="1" width="30" height="30" rx="7" fill="none" stroke="#282830" stroke-width="1"/><g transform="translate(4, 4)" fill="none" stroke="url(#grad)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polygon points="6 2 18 2 18 6 6 6 6 2"/><rect x="3" y="6" width="18" height="16" rx="2"/><line x1="10" y1="12" x2="14" y2="12"/></g></svg>`;

// Create HTTP server to serve the inspector to web browsers
const httpServer = http.createServer((req, res) => {
  const parsedUrl = req.url.split("?")[0];
  if (
    parsedUrl === "/" ||
    parsedUrl === "/index.html" ||
    parsedUrl === "/browser"
  ) {
    const htmlPath = path.join(__dirname, "webview.html");
    fs.readFile(htmlPath, "utf8", (err, data) => {
      if (err) {
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end(
          `Internal Server Error: Failed to read webview.html from ${htmlPath}.`,
        );
      } else {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(data);
      }
    });
  } else if (parsedUrl === "/favicon.ico" || parsedUrl === "/favicon.svg") {
    res.writeHead(200, { "Content-Type": "image/svg+xml" });
    res.end(faviconSvg);
  } else {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not Found");
  }
});

const wss = new WebSocket.Server({ server: httpServer });

let activeDeviceInfo = null;

function broadcastStatus() {
  const hasAppClient = Array.from(activeClients).some((c) => !c.isBrowser);
  const status = hasAppClient ? "connected" : "disconnected";
  if (!hasAppClient) {
    activeDeviceInfo = null;
  }

  for (const client of activeClients) {
    if (client.isBrowser && client.readyState === WebSocket.OPEN) {
      client.send(
        JSON.stringify({
          type: "status",
          status,
          deviceInfo: activeDeviceInfo,
        }),
      );
    }
  }
}

wss.on("connection", (ws, req) => {
  const url = req.url || "";
  const isBrowser =
    url.includes("client=browser") || url.startsWith("/browser");
  ws.isBrowser = isBrowser;
  activeClients.add(ws);

  console.log(`[NetworkInspector] Client connected (isBrowser: ${isBrowser})`);

  // Send initial status
  const hasAppClient = Array.from(activeClients).some((c) => !c.isBrowser);
  const status = hasAppClient ? "connected" : "disconnected";
  if (!hasAppClient) {
    activeDeviceInfo = null;
  }
  ws.send(
    JSON.stringify({ type: "status", status, deviceInfo: activeDeviceInfo }),
  );

  broadcastStatus();

  ws.on("message", (message) => {
    try {
      const msgStr = message.toString();
      // If we receive a register message from the app, save device info and broadcast it
      if (!ws.isBrowser) {
        try {
          const parsed = JSON.parse(msgStr);
          if (parsed && parsed.type === "register") {
            activeDeviceInfo = parsed.deviceInfo;
            broadcastStatus();
            return;
          }
        } catch (e) {
          // ignore
        }
      }

      // Broadcast to all browser clients
      for (const client of activeClients) {
        if (client.isBrowser && client.readyState === WebSocket.OPEN) {
          client.send(msgStr);
        }
      }
    } catch (err) {
      console.error("[NetworkInspector] Error parsing message:", err);
    }
  });

  ws.on("close", () => {
    activeClients.delete(ws);
    console.log(
      `[NetworkInspector] Client disconnected (isBrowser: ${isBrowser})`,
    );
    broadcastStatus();
  });

  ws.on("error", (err) => {
    console.error("[NetworkInspector] Socket error:", err);
    activeClients.delete(ws);
    broadcastStatus();
  });
});

httpServer.listen(port, () => {
  console.log(
    `\n[NetworkInspector] Web Server started at http://localhost:${port}`,
  );
  console.log(
    `[NetworkInspector] WebSocket server started at ws://localhost:${port}`,
  );
  console.log(
    `[NetworkInspector] Open http://localhost:${port} in your browser to inspect network traffic.\n`,
  );

  // Automatically attempt to forward the WebSocket port for connected Android devices/emulators
  try {
    const { exec } = require("child_process");
    exec("adb reverse tcp:19796 tcp:19796", (err) => {
      if (!err) {
        console.log("[NetworkInspector] Port 19796 reversed successfully via adb for Android devices/emulators.");
      }
    });
  } catch (e) {
    // Fail silently if child_process/adb is not available or errors out
  }
});
