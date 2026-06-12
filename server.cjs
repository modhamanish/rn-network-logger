#!/usr/bin/env node

const fs = require('fs');
const http = require('http');
const path = require('path');
const WebSocket = require('ws');

const port = 19796;
const activeClients = new Set();

// Create HTTP server to serve the inspector to web browsers
const httpServer = http.createServer((req, res) => {
  const parsedUrl = req.url.split('?')[0];
  if (
    parsedUrl === '/' ||
    parsedUrl === '/index.html' ||
    parsedUrl === '/browser'
  ) {
    const htmlPath = path.join(__dirname, 'webview.html');
    fs.readFile(htmlPath, 'utf8', (err, data) => {
      if (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end(`Internal Server Error: Failed to read webview.html from ${htmlPath}.`);
      } else {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(data);
      }
    });
  } else {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  }
});

const wss = new WebSocket.Server({ server: httpServer });

function broadcastStatus() {
  const hasAppClient = Array.from(activeClients).some(c => !c.isBrowser);
  const status = hasAppClient ? 'connected' : 'disconnected';

  for (const client of activeClients) {
    if (client.isBrowser && client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({ type: 'status', status }));
    }
  }
}

wss.on('connection', (ws, req) => {
  const url = req.url || '';
  const isBrowser = url.includes('client=browser') || url.startsWith('/browser');
  ws.isBrowser = isBrowser;
  activeClients.add(ws);

  console.log(`[NetworkInspector] Client connected (isBrowser: ${isBrowser})`);

  // Send initial status
  const hasAppClient = Array.from(activeClients).some(c => !c.isBrowser);
  const status = hasAppClient ? 'connected' : 'disconnected';
  ws.send(JSON.stringify({ type: 'status', status }));

  broadcastStatus();

  ws.on('message', (message) => {
    try {
      // Broadcast to all browser clients
      for (const client of activeClients) {
        if (client.isBrowser && client.readyState === WebSocket.OPEN) {
          client.send(message.toString());
        }
      }
    } catch (err) {
      console.error('[NetworkInspector] Error parsing message:', err);
    }
  });

  ws.on('close', () => {
    activeClients.delete(ws);
    console.log(`[NetworkInspector] Client disconnected (isBrowser: ${isBrowser})`);
    broadcastStatus();
  });

  ws.on('error', (err) => {
    console.error('[NetworkInspector] Socket error:', err);
    activeClients.delete(ws);
    broadcastStatus();
  });
});

httpServer.listen(port, () => {
  console.log(`\n[NetworkInspector] Web Server started at http://localhost:${port}`);
  console.log(`[NetworkInspector] WebSocket server started at ws://localhost:${port}`);
  console.log(`[NetworkInspector] Open http://localhost:${port} in your browser to inspect network traffic.\n`);
});
