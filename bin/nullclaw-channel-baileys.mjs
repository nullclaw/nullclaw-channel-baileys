#!/usr/bin/env node

import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import readline from 'node:readline';
import { mkdir } from 'node:fs/promises';

import {
  DisconnectReason,
  fetchLatestBaileysVersion,
  getContentType,
  makeWASocket,
  useMultiFileAuthState,
} from '@whiskeysockets/baileys';
import qrcodeTerminal from 'qrcode-terminal';

const PROTOCOL_VERSION = 2;
const RECONNECT_DELAY_MS = 3_000;

class JsonRpcError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

class BaileysPlugin {
  constructor() {
    this.runtimeName = process.env.NULLCLAW_EXTERNAL_RUNTIME_NAME || 'whatsapp';
    this.accountId = 'default';
    this.stateDir = null;
    this.authDir = null;
    this.authState = null;
    this.saveCreds = null;
    this.socket = null;
    this.running = false;
    this.stopRequested = false;
    this.connected = false;
    this.loggedIn = false;
    this.latestError = null;
    this.reconnectTimer = null;
    this.qrCode = null;
    this.qrEvent = 'idle';
    this.pairingCode = null;
    this.pairingRequested = false;
    this.config = {
      auth_mode: 'qr',
      pair_phone_number: '',
      display_name: 'Chrome (Linux)',
    };
  }

  async run() {
    const rl = readline.createInterface({
      input: process.stdin,
      crlfDelay: Infinity,
      terminal: false,
    });

    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      await this.handleLine(trimmed);
    }

    await this.stop();
  }

  async handleLine(line) {
    let request;
    try {
      request = JSON.parse(line);
    } catch (error) {
      this.log(`ignoring malformed JSON-RPC line: ${error.message}`);
      return;
    }

    const requestId = request.id;
    const method = request.method;
    const params = request.params ?? {};

    if (typeof method !== 'string') {
      if (requestId !== undefined) {
        this.respondError(requestId, -32600, 'invalid request');
      }
      return;
    }
    if (!isObject(params)) {
      if (requestId !== undefined) {
        this.respondError(requestId, -32602, 'params must be an object');
      }
      return;
    }

    try {
      const result = await this.dispatch(method, params);
      if (requestId !== undefined) {
        this.respondResult(requestId, result);
      }
    } catch (error) {
      if (requestId === undefined) {
        return;
      }
      if (error instanceof JsonRpcError) {
        this.respondError(requestId, error.code, error.message);
        return;
      }
      this.log(`request failed for method=${method}: ${error?.stack || error}`);
      this.respondError(requestId, -32000, String(error?.message || error));
    }
  }

  async dispatch(method, params) {
    switch (method) {
      case 'get_manifest':
        return {
          protocol_version: PROTOCOL_VERSION,
          capabilities: {
            health: true,
            streaming: false,
            send_rich: false,
            typing: true,
            edit: true,
            delete: true,
            reactions: true,
            read_receipts: true,
          },
        };
      case 'start':
        return this.start(params);
      case 'stop':
        return { stopped: await this.stop() };
      case 'health':
        return this.health();
      case 'send':
        return this.send(params);
      case 'start_typing':
        return this.startTyping(params);
      case 'stop_typing':
        return this.stopTyping(params);
      case 'edit_message':
        return this.editMessage(params);
      case 'delete_message':
        return this.deleteMessage(params);
      case 'set_reaction':
        return this.setReaction(params);
      case 'mark_read':
        return this.markRead(params);
      default:
        throw new JsonRpcError(-32601, `unknown method: ${method}`);
    }
  }

  async start(params) {
    const runtime = expectObject(params.runtime, 'runtime');
    const config = params.config ?? {};
    if (!isObject(config)) {
      throw new JsonRpcError(-32602, 'config must be an object');
    }

    await this.stop();

    const runtimeName = normalizeNonEmptyString(runtime.name, 'runtime.name');
    const accountId = String(runtime.account_id || 'default').trim() || 'default';
    const stateDir = resolveStateDir(runtime.state_dir, runtimeName, accountId);

    this.runtimeName = runtimeName;
    this.accountId = accountId;
    this.stateDir = stateDir;
    this.authDir = path.join(stateDir, 'auth');
    this.config = {
      auth_mode: String(config.auth_mode || 'qr').trim() || 'qr',
      pair_phone_number: typeof config.pair_phone_number === 'string' ? config.pair_phone_number.trim() : '',
      display_name: typeof config.display_name === 'string' && config.display_name.trim()
        ? config.display_name.trim()
        : 'Chrome (Linux)',
    };

    if (this.config.auth_mode !== 'qr' && this.config.auth_mode !== 'pair_code') {
      throw new JsonRpcError(-32602, 'config.auth_mode must be "qr" or "pair_code"');
    }
    if (this.config.auth_mode === 'pair_code' && !this.config.pair_phone_number) {
      throw new JsonRpcError(-32602, 'config.pair_phone_number is required for pair_code auth');
    }

    await mkdir(this.authDir, { recursive: true });

    const authBundle = await useMultiFileAuthState(this.authDir);
    this.authState = authBundle.state;
    this.saveCreds = authBundle.saveCreds;
    this.stopRequested = false;
    this.running = true;
    this.connected = false;
    this.loggedIn = Boolean(this.authState.creds?.registered);
    this.latestError = null;
    this.qrCode = null;
    this.qrEvent = this.loggedIn ? 'success' : 'idle';
    this.pairingCode = null;
    this.pairingRequested = false;

    await this.connectSocket();

    return {
      started: true,
      runtime: {
        name: this.runtimeName,
        account_id: this.accountId,
      },
    };
  }

  async stop() {
    this.stopRequested = true;
    this.running = false;
    this.connected = false;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;

    const currentSocket = this.socket;
    this.socket = null;

    if (currentSocket?.ev?.removeAllListeners) {
      currentSocket.ev.removeAllListeners('creds.update');
      currentSocket.ev.removeAllListeners('connection.update');
      currentSocket.ev.removeAllListeners('messages.upsert');
    }
    if (currentSocket?.ws?.close) {
      try {
        currentSocket.ws.close();
      } catch (error) {
        this.log(`socket close failed: ${error.message}`);
      }
    }

    return true;
  }

  health() {
    return {
      healthy: this.running && this.loggedIn,
      connected: this.connected,
      logged_in: this.loggedIn,
      auth_mode: this.config.auth_mode,
      qr_event: this.qrEvent,
      qr_available: Boolean(this.qrCode),
      pairing_code_available: Boolean(this.pairingCode),
      last_error: this.latestError,
    };
  }

  async send(params) {
    const message = this.validateRuntimeAndMessage(params);
    const target = normalizeTargetJid(message.target);
    const stage = String(message.stage || 'final');
    if (stage !== 'final') {
      return { accepted: false, ignored_stage: stage };
    }

    const text = String(message.text || '');
    const response = await this.requireSocket().sendMessage(target, { text });
    return {
      accepted: true,
      message_id: encodeMessageKey(response?.key || makeMessageKey(target, response?.key?.id)),
    };
  }

  async startTyping(params) {
    const recipient = normalizeTargetJid(normalizeNonEmptyString(params.recipient, 'recipient'));
    await this.requireSocket().sendPresenceUpdate('composing', recipient);
    return { accepted: true };
  }

  async stopTyping(params) {
    const recipient = normalizeTargetJid(normalizeNonEmptyString(params.recipient, 'recipient'));
    await this.requireSocket().sendPresenceUpdate('paused', recipient);
    return { accepted: true };
  }

  async editMessage(params) {
    const message = this.validateRuntimeAndMessage(params);
    const target = normalizeTargetJid(message.target);
    const original = decodeMessageKey(normalizeNonEmptyString(message.message_id, 'message.message_id'));
    const text = String(message.text || '');
    const response = await this.requireSocket().sendMessage(target, {
      text,
      edit: original,
    });
    return {
      accepted: true,
      message_id: encodeMessageKey(response?.key || original),
    };
  }

  async deleteMessage(params) {
    const message = this.validateRuntimeAndMessage(params);
    const target = normalizeTargetJid(message.target);
    const original = decodeMessageKey(normalizeNonEmptyString(message.message_id, 'message.message_id'));
    await this.requireSocket().sendMessage(target, { delete: original });
    return { accepted: true };
  }

  async setReaction(params) {
    const message = this.validateRuntimeAndMessage(params);
    const target = normalizeTargetJid(message.target);
    const original = decodeMessageKey(normalizeNonEmptyString(message.message_id, 'message.message_id'));
    const emoji = message.emoji === null || message.emoji === undefined ? '' : String(message.emoji);
    await this.requireSocket().sendMessage(target, {
      react: {
        text: emoji,
        key: original,
      },
    });
    return { accepted: true };
  }

  async markRead(params) {
    const message = this.validateRuntimeAndMessage(params);
    const original = decodeMessageKey(normalizeNonEmptyString(message.message_id, 'message.message_id'));
    await this.requireSocket().readMessages([original]);
    return { accepted: true };
  }

  validateRuntimeAndMessage(params) {
    const runtime = expectObject(params.runtime, 'runtime');
    const message = expectObject(params.message, 'message');
    const runtimeName = normalizeNonEmptyString(runtime.name, 'runtime.name');
    const accountId = normalizeNonEmptyString(runtime.account_id, 'runtime.account_id');

    if (runtimeName !== this.runtimeName) {
      throw new JsonRpcError(-32602, 'runtime.name mismatch');
    }
    if (accountId !== this.accountId) {
      throw new JsonRpcError(-32602, 'runtime.account_id mismatch');
    }
    normalizeNonEmptyString(message.target, 'message.target');
    return message;
  }

  async connectSocket() {
    if (!this.authState) {
      throw new JsonRpcError(-32001, 'auth state not initialized');
    }

    let version;
    try {
      const fetched = await fetchLatestBaileysVersion();
      version = fetched.version;
    } catch (error) {
      this.log(`failed to fetch latest Baileys version: ${error.message}`);
    }

    const socket = makeWASocket({
      auth: this.authState,
      version,
      printQRInTerminal: false,
      markOnlineOnConnect: false,
      browser: ['nullclaw', 'Chrome', '1.0.0'],
    });

    socket.ev.on('creds.update', async () => {
      try {
        await this.saveCreds?.();
      } catch (error) {
        this.log(`failed to persist auth state: ${error.message}`);
      }
    });

    socket.ev.on('connection.update', (update) => {
      this.handleConnectionUpdate(update).catch((error) => {
        this.log(`connection update handler failed: ${error.message}`);
      });
    });

    socket.ev.on('messages.upsert', (event) => {
      this.handleMessagesUpsert(event).catch((error) => {
        this.log(`messages.upsert handler failed: ${error.message}`);
      });
    });

    this.socket = socket;
  }

  async handleConnectionUpdate(update) {
    if (typeof update.qr === 'string' && update.qr) {
      this.qrCode = update.qr;
      this.qrEvent = 'code';
      this.log('received WhatsApp QR code');
      qrcodeTerminal.generate(update.qr, { small: true }, (qr) => {
        process.stderr.write(`${qr}\n`);
      });
    }

    if (
      this.config.auth_mode === 'pair_code' &&
      this.socket &&
      !this.pairingRequested &&
      !this.loggedIn &&
      this.config.pair_phone_number &&
      (update.connection === 'connecting' || typeof update.qr === 'string')
    ) {
      this.pairingRequested = true;
      try {
        const code = await this.socket.requestPairingCode(this.config.pair_phone_number);
        this.pairingCode = code;
        this.log(`pairing code: ${code}`);
      } catch (error) {
        this.pairingRequested = false;
        this.latestError = `pairing_code_failed:${error.message}`;
        this.log(`requestPairingCode failed: ${error.message}`);
      }
    }

    if (update.connection === 'open') {
      this.connected = true;
      this.loggedIn = true;
      this.qrCode = null;
      this.qrEvent = 'success';
      this.latestError = null;
      this.log('WhatsApp connection opened');
      return;
    }

    if (update.connection !== 'close') {
      return;
    }

    this.connected = false;
    const statusCode = update?.lastDisconnect?.error?.output?.statusCode;
    if (statusCode === DisconnectReason.loggedOut) {
      this.loggedIn = false;
      this.qrEvent = 'logged_out';
      this.latestError = 'logged_out';
      this.log('WhatsApp session logged out; manual re-link required');
      return;
    }

    this.latestError = `connection_closed:${statusCode ?? 'unknown'}`;
    this.log(`WhatsApp connection closed (status=${statusCode ?? 'unknown'})`);
    if (!this.stopRequested && this.running) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = setTimeout(() => {
        this.connectSocket().catch((error) => {
          this.latestError = `reconnect_failed:${error.message}`;
          this.log(`reconnect failed: ${error.message}`);
        });
      }, RECONNECT_DELAY_MS);
    }
  }

  async handleMessagesUpsert(event) {
    if (!this.running || !event || !Array.isArray(event.messages)) {
      return;
    }

    for (const item of event.messages) {
      if (!item?.message || item?.key?.fromMe) {
        continue;
      }

      const text = extractMessageText(item.message);
      if (!text) {
        continue;
      }

      const remoteJid = typeof item.key?.remoteJid === 'string' ? item.key.remoteJid : '';
      if (!remoteJid) {
        continue;
      }

      const isGroup = remoteJid.endsWith('@g.us');
      const sender = isGroup
        ? String(item.key?.participant || remoteJid)
        : remoteJid;
      const messageId = encodeMessageKey(item.key);

      this.notify('inbound_message', {
        message: {
          sender_id: sender,
          chat_id: remoteJid,
          text,
          metadata: {
            peer_kind: isGroup ? 'group' : 'direct',
            peer_id: isGroup ? remoteJid : sender,
            is_group: isGroup,
            is_dm: !isGroup,
            typing_recipient: remoteJid,
            message_id: messageId,
            sender_display_name: typeof item.pushName === 'string' ? item.pushName : undefined,
          },
        },
      });
    }
  }

  requireSocket() {
    if (!this.socket || !this.running) {
      throw new JsonRpcError(-32001, 'socket not running');
    }
    return this.socket;
  }

  respondResult(requestId, result) {
    this.writeLine({
      jsonrpc: '2.0',
      id: requestId,
      result,
    });
  }

  respondError(requestId, code, message) {
    this.writeLine({
      jsonrpc: '2.0',
      id: requestId,
      error: {
        code,
        message,
      },
    });
  }

  notify(method, params) {
    this.writeLine({
      jsonrpc: '2.0',
      method,
      params,
    });
  }

  writeLine(payload) {
    process.stdout.write(JSON.stringify(payload));
    process.stdout.write('\n');
  }

  log(message) {
    process.stderr.write(`[nullclaw-channel-baileys] ${message}\n`);
  }
}

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function expectObject(value, field) {
  if (!isObject(value)) {
    throw new JsonRpcError(-32602, `${field} must be an object`);
  }
  return value;
}

function normalizeNonEmptyString(value, field) {
  const normalized = String(value || '').trim();
  if (!normalized) {
    throw new JsonRpcError(-32602, `${field} is required`);
  }
  return normalized;
}

function normalizeTargetJid(rawTarget) {
  const target = normalizeNonEmptyString(rawTarget, 'message.target');
  if (target.includes('@')) {
    return target;
  }
  const digits = target.replace(/[^\d]/g, '');
  if (!digits) {
    throw new JsonRpcError(-32602, 'message.target must be a valid WhatsApp JID or phone number');
  }
  return `${digits}@s.whatsapp.net`;
}

function resolveStateDir(rawStateDir, runtimeName, accountId) {
  if (typeof rawStateDir === 'string' && rawStateDir.trim()) {
    return rawStateDir.trim();
  }
  return path.join(os.homedir(), '.local', 'state', 'nullclaw', 'external', runtimeName, accountId);
}

function encodeMessageKey(key) {
  return Buffer.from(JSON.stringify({
    remoteJid: key?.remoteJid || '',
    id: key?.id || '',
    participant: key?.participant || '',
    fromMe: Boolean(key?.fromMe),
  }), 'utf8').toString('base64url');
}

function decodeMessageKey(encoded) {
  let payload;
  try {
    payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  } catch (error) {
    throw new JsonRpcError(-32602, 'message.message_id is not a valid encoded message key');
  }
  if (!payload || typeof payload !== 'object' || !payload.remoteJid || !payload.id) {
    throw new JsonRpcError(-32602, 'message.message_id is incomplete');
  }
  return {
    remoteJid: String(payload.remoteJid),
    id: String(payload.id),
    participant: payload.participant ? String(payload.participant) : undefined,
    fromMe: Boolean(payload.fromMe),
  };
}

function makeMessageKey(remoteJid, id) {
  return {
    remoteJid,
    id: id || '',
    fromMe: true,
  };
}

function extractMessageText(message) {
  if (!message || typeof message !== 'object') {
    return '';
  }

  const messageType = getContentType(message);
  if (!messageType) {
    return '';
  }

  if (messageType === 'conversation') {
    return String(message.conversation || '');
  }
  if (messageType === 'extendedTextMessage') {
    return String(message.extendedTextMessage?.text || '');
  }
  if (messageType === 'imageMessage') {
    return String(message.imageMessage?.caption || '');
  }
  if (messageType === 'videoMessage') {
    return String(message.videoMessage?.caption || '');
  }
  if (messageType === 'buttonsResponseMessage') {
    return String(message.buttonsResponseMessage?.selectedDisplayText || '');
  }
  if (messageType === 'listResponseMessage') {
    return String(
      message.listResponseMessage?.title ||
      message.listResponseMessage?.singleSelectReply?.selectedRowId ||
      ''
    );
  }
  if (messageType === 'ephemeralMessage') {
    return extractMessageText(message.ephemeralMessage?.message);
  }
  if (messageType === 'viewOnceMessage') {
    return extractMessageText(message.viewOnceMessage?.message);
  }
  if (messageType === 'viewOnceMessageV2') {
    return extractMessageText(message.viewOnceMessageV2?.message);
  }
  if (messageType === 'viewOnceMessageV2Extension') {
    return extractMessageText(message.viewOnceMessageV2Extension?.message);
  }
  if (messageType === 'editedMessage') {
    return extractMessageText(message.editedMessage?.message?.protocolMessage?.editedMessage);
  }

  return '';
}

const plugin = new BaileysPlugin();
plugin.run().catch((error) => {
  process.stderr.write(`[nullclaw-channel-baileys] fatal: ${error?.stack || error}\n`);
  process.exitCode = 1;
});

