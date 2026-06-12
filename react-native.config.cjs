const { fork } = require('child_process');
const path = require('path');
const net = require('net');

// Check if running a development/bundler command
const isDevCommand = process.argv.some(arg =>
  ['start', 'run-ios', 'run-android', 'ios', 'android'].includes(arg)
);



if (isDevCommand) {
  const port = 19796;
  const socket = new net.Socket();

  socket.once('error', () => {
    // Connection failed, meaning the port is free and server is not running
    try {
      const serverPath = path.join(__dirname, 'server.cjs');
      const child = fork(serverPath, [], {
        detached: false, // Keep in the same process group so it closes with Metro
        stdio: 'ignore'  // Run silently in the background
      });
      child.unref(); // Allow the parent CLI process to run/exit independently
    } catch (e) {
      // Silent catch to prevent blocking the build process if anything goes wrong
    }
  });

  socket.once('connect', () => {
    // Port is active; server is already running, just close the connection
    socket.destroy();
  });

  socket.connect(port, '127.0.0.1');
}

module.exports = {};
