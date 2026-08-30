const { WebSocketServer } = require('ws');
const jwt = require('jsonwebtoken');
const config = require('../config/env');
const User = require('../models/User');
const TerminalSession = require('../models/TerminalSession');
const GpuServer = require('../models/GpuServer');
const { MAX_INPUT, SESSION_IDLE_MS, audit } = require('./permission.service');
const provider = require('../utils/denglish-providers');

function send(ws, payload) {
  if (ws.readyState === 1) ws.send(JSON.stringify(payload));
}

function attachTerminalGateway(httpServer) {
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://localhost');
    const match = url.pathname.match(/^\/ws\/terminal\/([^/]+)$/);
    if (!match) return;
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req, match[1], url.searchParams.get('access_token') || '');
    });
  });

  wss.on('connection', async (ws, req, sessionId, token) => {
    let user = null;
    try {
      if (!token) throw new Error('UNAUTHORIZED');
      const payload = jwt.verify(token, config.jwtSecret);
      user = await User.findById(payload.sub);
      if (!user) throw new Error('UNAUTHORIZED');
    } catch {
      send(ws, { type: 'error', message: 'UNAUTHORIZED', code: 'UNAUTHORIZED' });
      ws.close();
      return;
    }

    const session = await TerminalSession.findOne({ sessionId, user: user._id });
    if (!session) {
      send(ws, { type: 'error', message: 'SESSION_EXPIRED', code: 'SESSION_EXPIRED' });
      ws.close();
      return;
    }

    const server = await GpuServer.findById(session.server);
    if (!server || String(server.owner) !== String(user._id)) {
      send(ws, { type: 'error', message: 'FORBIDDEN', code: 'FORBIDDEN' });
      ws.close();
      return;
    }

    let bytesIn = 0;
    let bytesOut = 0;
    let last = Date.now();
    const idle = setInterval(() => {
      if (Date.now() - last > SESSION_IDLE_MS) {
        send(ws, { type: 'error', message: 'TERMINAL_TIMEOUT', code: 'TERMINAL_TIMEOUT' });
        ws.close();
      }
    }, 15000);

    session.status = 'connected';
    session.lastActivityAt = new Date();
    await session.save();
    send(ws, { type: 'status', status: 'connected' });
    send(ws, {
      type: 'output',
      data: `\r\nPH AI Market GPU terminal  ·  ${server.name}\r\nprovider=${server.provider}  kind=${server.kind}\r\nType help for sandbox commands. Credentials never leave the server.\r\n\r\n$ `,
    });
    await audit({
      sessionId,
      user: user._id,
      projectId: session.projectId,
      serverId: String(server._id),
      event: 'ws_connected',
    });

    let lineBuf = '';
    ws.on('message', async (raw) => {
      last = Date.now();
      let msg;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (msg.type === 'resize') return;
      if (msg.type !== 'input') return;
      const chunk = String(msg.data || '');
      if (chunk.length > MAX_INPUT) return;
      bytesIn += Buffer.byteLength(chunk);
      for (const ch of chunk) {
        if (ch === '\x03') {
          send(ws, { type: 'output', data: '^C\r\n$ ' });
          lineBuf = '';
          continue;
        }
        if (ch === '\x04') {
          send(ws, { type: 'output', data: '\r\n[disconnected]\r\n' });
          ws.close();
          return;
        }
        if (ch === '\x0c') {
          send(ws, { type: 'output', data: '\x1bc$ ' });
          continue;
        }
        if (ch === '\r' || ch === '\n') {
          const cmd = lineBuf.trim();
          lineBuf = '';
          const out = await sandboxExec(cmd, server);
          const payload = `\r\n${out}\r\n$ `;
          bytesOut += Buffer.byteLength(payload);
          send(ws, { type: 'output', data: payload });
          continue;
        }
        if (ch === '\x7f' || ch === '\b') {
          lineBuf = lineBuf.slice(0, -1);
          send(ws, { type: 'output', data: '\b \b' });
          continue;
        }
        lineBuf += ch;
        send(ws, { type: 'output', data: ch });
      }
      session.lastActivityAt = new Date();
      session.bytesIn = (session.bytesIn || 0) + bytesIn;
      session.bytesOut = (session.bytesOut || 0) + bytesOut;
      bytesIn = 0;
      bytesOut = 0;
      await session.save().catch(() => {});
    });

    ws.on('close', async () => {
      clearInterval(idle);
      session.status = 'disconnected';
      session.disconnectedAt = new Date();
      session.disconnectReason = 'ws_close';
      await session.save().catch(() => {});
      try {
        await provider.closeProviderTerminal(session.provider, session.sessionId);
      } catch (_) {
        /* ignore */
      }
    });
  });

  return wss;
}

async function sandboxExec(cmd, server) {
  if (!cmd) return '';
  if (cmd === 'help') {
    return 'sandbox shell: help, hostname, nvidia-smi, ls, date, echo …\nInteractive SSH to RunPod is opened by the Python provider when the pod is RUNNING.';
  }
  if (cmd === 'hostname') return server.name || 'gpu-lab';
  if (cmd === 'nvidia-smi') {
    return `${server.gpu || 'NVIDIA GPU'}\n+|    0   RTX  (sandbox)  |  12%   42C  |   1024MiB / 24564MiB  |`;
  }
  if (cmd === 'ls' || cmd === 'ls -la') {
    return 'game/  checkpoints/  README.md  start-stream.sh';
  }
  if (cmd === 'date') return new Date().toISOString();
  if (cmd.startsWith('echo ')) return cmd.slice(5);
  return `sandbox: command not found: ${cmd}`;
}

module.exports = { attachTerminalGateway };
