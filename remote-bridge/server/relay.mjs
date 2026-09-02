// Kivio Remote 中继服务器
// 职责：配对（桌面 ↔ 手机）+ JSON 消息转发。不解析、不存储消息内容。
//
//   桌面端(Kivio) ──出站 wss──▶ 本服务 ◀──出站 wss── 手机浏览器
//
// 部署：见 ../README.md（node relay.mjs，建议置于 nginx/caddy TLS 反代之后）。

import { WebSocketServer, WebSocket } from 'ws';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8787);
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data.json');
const PAIR_TTL_MS = 10 * 60 * 1000;
const MAX_FRAME = 2 * 1024 * 1024; // 单条转发上限（历史消息可能较大）
const PING_INTERVAL_MS = 30_000;

/* ---------------- 持久化：只存 token 映射，不存消息 ---------------- */

let store = { devices: {} }; // deviceToken -> { clientToken, createdAt }
function loadStore() {
  try {
    store = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    if (!store.devices || typeof store.devices !== 'object') store = { devices: {} };
  } catch {
    store = { devices: {} };
  }
}
let saveTimer = null;
function saveStore() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      fs.writeFileSync(DATA_FILE, JSON.stringify(store, null, 2));
    } catch (err) {
      console.error('[relay] save store failed:', err.message);
    }
  }, 500);
}
loadStore();

/* ---------------- 房间与配对 ---------------- */

// key -> Room。key 两种：`p:<code>`（配对中）/ `d:<deviceToken>`（已绑定）
const rooms = new Map();
const pairCodes = new Map(); // code -> { expiresAt }
function roomOf(key) {
  let room = rooms.get(key);
  if (!room) {
    room = { key, device: null, clients: new Set() };
    rooms.set(key, room);
  }
  return room;
}
function dropRoomIfEmpty(room) {
  if (!room.device && room.clients.size === 0) rooms.delete(room.key);
}
function deviceRoomByClientToken(clientToken) {
  for (const [deviceToken, rec] of Object.entries(store.devices)) {
    if (rec.clientToken === clientToken) return `d:${deviceToken}`;
  }
  return null;
}

const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
function newPairCode() {
  const bytes = crypto.randomBytes(8);
  let code = '';
  for (const b of bytes) code += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return code;
}
const newToken = (p) => `${p}_${crypto.randomBytes(24).toString('base64url')}`;

function completePairing(room) {
  if (!room.device || room.clients.size === 0) return;
  const deviceToken = newToken('dt');
  const clientToken = newToken('ct');
  store.devices[deviceToken] = { clientToken, createdAt: Date.now() };
  saveStore();

  room.device.pairKey = `d:${deviceToken}`;
  for (const c of room.clients) c.pairKey = `d:${deviceToken}`;

  sendTo(room.device, { type: 'session_bound', device_token: deviceToken });
  for (const c of room.clients) sendTo(c, { type: 'client_bound', client_token: clientToken });

  rooms.delete(room.key);
  room.key = `d:${deviceToken}`;
  rooms.set(room.key, room);
  console.log(`[relay] pairing complete -> room d:${deviceToken.slice(3, 11)}…`);
}

function sendTo(ws, obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify(obj));
    } catch {
      /* 连接正在关闭 */
    }
  }
}

/* ---------------- HTTP：配对接口 + 静态页面 ---------------- */

function publicOrigin(req) {
  const proto = String(req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
  const host = String(req.headers.host || `localhost:${PORT}`);
  return `${proto}://${host}`;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://local');
  if (req.method === 'POST' && url.pathname === '/api/pair') {
    // 清理过期码
    const now = Date.now();
    for (const [code, meta] of pairCodes) if (meta.expiresAt < now) pairCodes.delete(code);

    let code = newPairCode();
    while (pairCodes.has(code)) code = newPairCode();
    pairCodes.set(code, { expiresAt: now + PAIR_TTL_MS });
    const body = JSON.stringify({
      code,
      expires_in: PAIR_TTL_MS / 1000,
      client_url: `${publicOrigin(req)}/?code=${code}`,
    });
    console.log(`[relay] pair code issued: ${code}`);
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(body);
    return;
  }
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    fs.readFile(path.join(__dirname, 'public', 'index.html'), (err, buf) => {
      if (err) {
        res.writeHead(500);
        res.end('index.html missing');
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(buf);
    });
    return;
  }
  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('not found');
});

/* ---------------- WebSocket 路由 ---------------- */

const wss = new WebSocketServer({ server, maxPayload: MAX_FRAME });

function isAlive(ws) {
  return ws.isAlive !== false;
}

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://local');
  if (url.pathname !== '/ws') {
    ws.close(1008, 'bad path');
    return;
  }
  const mode = url.searchParams.get('mode');
  const token = url.searchParams.get('token') || '';
  const code = (url.searchParams.get('code') || '').toUpperCase().trim();

  ws.isAlive = true;
  ws.on('pong', () => {
    ws.isAlive = true;
  });

  let room = null;
  if (mode === 'device' && token) {
    if (!store.devices[token]) {
      sendTo(ws, { type: 'error', error: 'device_token 无效，请重新配对' });
      ws.close(1008, 'bad token');
      return;
    }
    room = roomOf(`d:${token}`);
  } else if (mode === 'device' && code) {
    const meta = pairCodes.get(code);
    if (!meta || meta.expiresAt < Date.now()) {
      sendTo(ws, { type: 'error', error: '配对码无效或已过期' });
      ws.close(1008, 'bad code');
      return;
    }
    room = roomOf(`p:${code}`);
  } else if (mode === 'client' && code) {
    const meta = pairCodes.get(code);
    if (!meta || meta.expiresAt < Date.now()) {
      sendTo(ws, { type: 'error', error: '配对码无效或已过期' });
      ws.close(1008, 'bad code');
      return;
    }
    room = roomOf(`p:${code}`);
  } else if (mode === 'client' && token) {
    const key = deviceRoomByClientToken(token);
    if (!key) {
      sendTo(ws, { type: 'error', error: 'client_token 无效，请重新扫码配对' });
      ws.close(1008, 'bad token');
      return;
    }
    room = roomOf(key);
  } else {
    ws.close(1008, 'bad params');
    return;
  }

  // 同类旧连接挤掉（同一 token 重复开）
  if (mode === 'device') {
    if (room.device && room.device !== ws) {
      sendTo(room.device, { type: 'error', error: '本机在其他位置重新连接' });
      room.device.close(4000, 'replaced');
    }
    room.device = ws;
  } else {
    room.clients.add(ws);
  }
  ws.pairKey = room.key;
  console.log(`[relay] ${mode} joined ${room.key} (clients=${room.clients.size})`);

  if (room.key.startsWith('p:')) completePairing(room);
  else sendTo(ws, { type: 'hello' });

  ws.on('message', (data) => {
    if (data.length > MAX_FRAME) return;
    const cur = rooms.get(ws.pairKey);
    if (!cur) return;
    let frame;
    try {
      frame = JSON.parse(data.toString('utf8'));
    } catch {
      return;
    }
    if (!frame || typeof frame.type !== 'string' || frame.type.length > 64) return;

    if (mode === 'client') {
      // 手机 → 桌面
      sendTo(cur.device, frame);
    } else {
      // 桌面 → 所有手机
      for (const c of cur.clients) sendTo(c, frame);
    }
  });

  ws.on('close', () => {
    const cur = rooms.get(ws.pairKey);
    if (!cur) return;
    if (mode === 'device') cur.device = null;
    else cur.clients.delete(ws);
    dropRoomIfEmpty(cur);
    console.log(`[relay] ${mode} left (clients=${cur ? cur.clients.size : 0})`);
  });
  ws.on('error', () => {
    /* close 会跟进 */
  });
});

const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!isAlive(ws)) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    try {
      ws.ping();
    } catch {
      /* ignore */
    }
  }
}, PING_INTERVAL_MS);
wss.on('close', () => clearInterval(heartbeat));

server.listen(PORT, () => {
  console.log(`[relay] listening on :${PORT}  (pair: POST /api/pair, ws: /ws)`);
});
