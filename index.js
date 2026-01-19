/**
 * scaletrade-server-api (Fixed for x32/x64 compatibility)
 * High-performance TCP client for ScaleTrade platform
 */

const net = require('net');
const events = require('events');
const crypto = require('crypto');

const RECONNECT_DELAY_MS = 4000;
const RESPONSE_TIMEOUT_MS = 30000;
const AUTO_SUBSCRIBE_DELAY_MS = 500;
const SOCKET_KEEPALIVE = true;
const SOCKET_NODELAY = true;
const MAX_BUFFER_SIZE = 100 * 1024 * 1024; // 100MB limit for x32

/**
 * Generate a short unique ID for extID
 * @returns {string} 12-character random ID
 */
function generateExtID() {
    if (crypto.randomUUID) {
        return crypto.randomUUID().replace(/-/g, '').substring(0, 12);
    }
    // Fallback - more reliable on x32
    const timestamp = Date.now().toString(36);
    const random = Math.random().toString(36).substring(2, 8);
    return (timestamp + random).substring(0, 12);
}

/**
 * Safe number parsing for x32 compatibility
 * @param {*} value - Value to parse
 * @returns {number|null}
 */
function safeParseNumber(value) {
    if (typeof value === 'number') {
        // Check if number is safe integer on x32
        if (!Number.isSafeInteger(value) && Math.abs(value) > Number.MAX_SAFE_INTEGER) {
            console.warn(`Unsafe integer detected: ${value}`);
        }
        return value;
    }
    const parsed = Number(value);
    return isNaN(parsed) ? null : parsed;
}

/**
 * Safe timestamp conversion for x32
 * @param {number} unixTimestamp - Unix timestamp in seconds
 * @returns {Date|null}
 */
function safeTimestamp(unixTimestamp) {
    if (!unixTimestamp) return null;
    try {
        // Avoid overflow on x32 by checking range
        const ms = safeParseNumber(unixTimestamp) * 1000;
        if (ms > 8640000000000000) { // Max valid JS date
            console.warn(`Timestamp out of range: ${unixTimestamp}`);
            return new Date();
        }
        return new Date(ms);
    } catch (e) {
        console.error('Timestamp conversion error:', e.message);
        return new Date();
    }
}

/**
 * Simple JSON repair - removes common issues
 * @param {string} str - Potentially malformed JSON string
 * @returns {string} Cleaned JSON string
 */
function jsonRepair(str) {
    return str
        .replace(/[\n\r\t]/g, '')   // Remove whitespace
        .replace(/,\s*}/g, '}')     // Remove trailing commas in objects
        .replace(/,\s*]/g, ']')     // Remove trailing commas in arrays
        .trim();
}

class STPlatform {
    constructor(url, name, options = {}, broker, ctx, token, emitter = null) {
        this.name = name;
        this.url = url;
        this.errorCount = 0;
        this.broker = broker || {};
        this.ctx = ctx || {};
        this.ignoreEvents = options.ignoreEvents || false;
        this.prefix = options.prefix || 'nor';
        this.mode = options.mode || 'live';
        this.token = token;
        this.emitter = emitter || new events.EventEmitter();
        this.autoSubscribeChannels = Array.isArray(options.autoSubscribe) ? options.autoSubscribe : [];
        this.seenNotifyTokens = new Set();
        this.pendingRequests = new Map();

        // x32 specific limits
        this.maxBufferSize = MAX_BUFFER_SIZE;
        this.arch = process.arch; // Store architecture info

        this.createSocket();

        // Return proxy for dynamic command calls
        return new Proxy(this, {
            get: (target, prop) => {
                if (prop in target) return Reflect.get(target, prop);
                return (data = {}) => target.callCommand(prop, data);
            }
        });
    }

    /**
     * Establish TCP connection and set up event handlers
     */
    createSocket() {
        this.errorCount = 0;
        this.connected = false;
        this.alive = true;
        this.recv = '';
        this.seenNotifyTokens.clear();

        this.socket = new net.Socket();
        this.socket.setKeepAlive(SOCKET_KEEPALIVE);
        this.socket.setNoDelay(SOCKET_NODELAY);

        this.socket
            .on('connect', () => {
                console.info(`ST [${this.name}] Connected to ${this.url} (${this.arch})`);
                this.connected = true;
                this.errorCount = 0;
                this.seenNotifyTokens.clear();

                // Auto-subscribe after connection
                if (this.autoSubscribeChannels.length > 0) {
                    setTimeout(() => {
                        this.subscribe(this.autoSubscribeChannels)
                            .then(() => console.info(`ST [${this.name}] Auto-subscribed: ${this.autoSubscribeChannels.join(', ')}`))
                            .catch(err => console.error(`ST [${this.name}] Auto-subscribe failed:`, err.message));
                    }, AUTO_SUBSCRIBE_DELAY_MS);
                }
            })
            .on('timeout', () => {
                console.error(`ST [${this.name}] Socket timeout`);
                if (this.alive) this.reconnect();
            })
            .on('close', () => {
                this.connected = false;
                console.warn(`ST [${this.name}] Connection closed`);
                if (this.alive) this.reconnect();
            })
            .on('error', (err) => {
                this.errorCount++;
                console.error(`ST [${this.name}] Socket error (count: ${this.errorCount}):`, err.message);

                // Don't reconnect too aggressively on repeated errors
                if (this.errorCount < 10 && this.alive) {
                    this.reconnect();
                } else if (this.errorCount >= 10) {
                    console.error(`ST [${this.name}] Too many errors, stopping reconnection attempts`);
                    this.alive = false;
                }
            })
            .on('data', (data) => this.handleData(data));

        const [host, port] = this.url.split(':');
        this.socket.connect({ host, port: parseInt(port) });
    }

    /**
     * Handle incoming TCP data
     * @param {Buffer} data - Raw TCP chunk
     */
    handleData(data) {
        try {
            // Convert buffer to string safely
            const chunk = data.toString('utf8');

            // Check buffer size limit (important for x32)
            if (this.recv.length + chunk.length > this.maxBufferSize) {
                console.error(`ST [${this.name}] Buffer overflow (${(this.recv.length / 1024 / 1024).toFixed(2)} MB). Resetting.`);
                this.recv = ''; // Reset buffer
                return;
            }

            this.recv += chunk;

            let delimiterPos = this.recv.indexOf('\r\n');

            while (delimiterPos !== -1) {
                const message = this.recv.substring(0, delimiterPos);
                this.recv = this.recv.substring(delimiterPos + 2);

                if (message.trim()) {
                    this.processMessage(message);
                }

                delimiterPos = this.recv.indexOf('\r\n');
            }
        } catch (err) {
            console.error(`ST [${this.name}] handleData error:`, err.message);
            this.recv = ''; // Reset on error
        }
    }

    processMessage(token) {
        let parsed;
        try {
            const cleaned = jsonRepair(token);
            parsed = JSON.parse(cleaned);
        } catch (e) {
            console.error(`ST [${this.name}] Parse error:`, token.substring(0, 100), e.message);
            return;
        }

        // === ARRAY MESSAGES ===
        if (Array.isArray(parsed)) {
            const [marker] = parsed;

            // Quote: ["t", symbol, bid, ask, timestamp]
            if (marker === 't' && parsed.length >= 4) {
                const [, symbol, bid, ask, timestamp] = parsed;
                if (typeof symbol === 'string' && typeof bid === 'number' && typeof ask === 'number') {
                    const quote = {
                        symbol,
                        bid: safeParseNumber(bid),
                        ask: safeParseNumber(ask),
                        timestamp: safeTimestamp(timestamp)
                    };
                    this.emit('quote', quote);
                    this.emit(`quote:${symbol.toUpperCase()}`, quote);
                }
                return;
            }

            // Notify: ["n", msg, desc, token, status, level, user_id, time, data?, code]
            if (marker === 'n' && parsed.length >= 8) {
                const [
                    , message, description, token, status, level, user_id, create_time, dataOrCode, code
                ] = parsed;

                if (this.seenNotifyTokens.has(token)) return;
                this.seenNotifyTokens.add(token);

                // Limit set size
                if (this.seenNotifyTokens.size > 10000) {
                    const firstToken = this.seenNotifyTokens.values().next().value;
                    this.seenNotifyTokens.delete(firstToken);
                }

                const isObject = dataOrCode && typeof dataOrCode === 'object';
                const notify = {
                    message, description, token, status, level, user_id,
                    create_time: safeTimestamp(create_time),
                    data: isObject ? dataOrCode : {},
                    code: Number(isObject ? code : dataOrCode) || 0
                };

                this.emit('notify', notify);
                this.emit(`notify:${level}`, notify);
                return;
            }

            // Symbols Reindex
            if (marker === 'sr' && parsed.length === 2) {
                this.emit('symbols:reindex', parsed[1]);
                return;
            }

            // Security Reindex
            if (marker === 'sc' && parsed.length === 2) {
                this.emit('security:reindex', parsed[1]);
                return;
            }

            console.warn(`ST [${this.name}] Unknown array message:`, parsed);
            return;
        }

        // === JSON EVENT OBJECTS ===
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && parsed.event) {
            const { event, type, data } = parsed;
            this.emit(event, { type, data });

            if (data?.login) this.emit(`${event}:${data.login}`, { type, data });
            if (data?.symbol) this.emit(`${event}:${data.symbol}`, { type, data });
            if (data?.group) this.emit(`${event}:${data.group}`, { type, data });
            return;
        }

        // === COMMAND RESPONSES (extID) ===
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && parsed.extID) {
            const extID = parsed.extID;

            if (this.pendingRequests.has(extID)) {
                const { resolve, timeout } = this.pendingRequests.get(extID);
                clearTimeout(timeout);
                this.pendingRequests.delete(extID);

                // Use setImmediate for better x32 compatibility
                setImmediate(() => resolve(parsed));
            } else {
                this.emit(extID, parsed);
            }
            return;
        }

        console.warn(`ST [${this.name}] Unknown message:`, parsed);
    }

    /**
     * Emit event if not ignored
     * @param {string} name - Event name
     * @param {*} data - Event data
     */
    emit(name, data) {
        if (!this.ignoreEvents) {
            // Use setImmediate to avoid blocking on x32
            setImmediate(() => this.emitter.emit(name, data));
        }
    }

    /**
     * Send command via proxy (e.g., platform.AddUser())
     * @param {string} command - Command name
     * @param {Object} data - Command payload
     * @returns {Promise<Object>}
     */
    async callCommand(command, data = {}) {
        const payload = { command, data };
        if (!payload.extID) payload.extID = generateExtID();
        return this.send(payload);
    }

    /**
     * Low-level send (improved with promise-based response handling)
     * @param {Object} payload - { command, data, extID?, __token }
     * @returns {Promise<Object>}
     */
    async send(payload) {
        if (!payload.extID) payload.extID = generateExtID();
        payload.__token = this.token;

        if (!this.connected) {
            return Promise.reject(new Error(`ST [${this.name}] Not connected`));
        }

        return new Promise((resolve, reject) => {
            // Use Math.min to ensure timeout doesn't overflow on x32
            const timeoutMs = Math.min(RESPONSE_TIMEOUT_MS, 2147483647);

            const timeout = setTimeout(() => {
                this.pendingRequests.delete(payload.extID);
                reject(new Error(`ST [${this.name}] Timeout for extID: ${payload.extID}`));
            }, timeoutMs);

            this.pendingRequests.set(payload.extID, { resolve, reject, timeout });

            try {
                const message = JSON.stringify(payload) + "\r\n";

                // Check message size
                if (Buffer.byteLength(message, 'utf8') > 65536) {
                    clearTimeout(timeout);
                    this.pendingRequests.delete(payload.extID);
                    reject(new Error(`ST [${this.name}] Message too large`));
                    return;
                }

                this.socket.write(message, 'utf8', (err) => {
                    if (err) {
                        clearTimeout(timeout);
                        this.pendingRequests.delete(payload.extID);
                        reject(err);
                    }
                });
            } catch (err) {
                clearTimeout(timeout);
                this.pendingRequests.delete(payload.extID);
                reject(err);
            }
        });
    }

    /**
     * Subscribe to market data channels (optimized for speed)
     * @param {string|Array<string>} channels - Symbol(s) or channel(s)
     * @returns {Promise<Object>}
     */
    async subscribe(channels) {
        const chanels = Array.isArray(channels) ? channels : [channels];
        return this.callCommand('Subscribe', { chanels });
    }

    /**
     * Unsubscribe from channels
     * @param {string|Array<string>} channels - Symbol(s) to unsubscribe
     * @returns {Promise<Object>}
     */
    async unsubscribe(channels) {
        const chanels = Array.isArray(channels) ? channels : [channels];
        return this.callCommand('Unsubscribe', { chanels });
    }

    /**
     * Reconnect logic with backoff
     */
    reconnect() {
        if (!this.alive || this._reconnectTimer) return;

        this.socket.destroy();
        this.seenNotifyTokens.clear();

        // Clear pending requests with error
        for (const [extID, { reject, timeout }] of this.pendingRequests.entries()) {
            clearTimeout(timeout);
            reject(new Error(`ST [${this.name}] Connection lost`));
        }
        this.pendingRequests.clear();

        // Exponential backoff with safe max delay for x32
        const baseDelay = RECONNECT_DELAY_MS * Math.pow(1.5, this.errorCount - 1);
        const delay = Math.min(baseDelay, 30000);

        this._reconnectTimer = setTimeout(() => {
            delete this._reconnectTimer;
            console.info(`ST [${this.name}] Reconnecting... (attempt ${this.errorCount + 1})`);
            this.createSocket();
        }, delay);
    }

    /**
     * Gracefully close connection
     */
    destroy() {
        this.alive = false;
        if (this._reconnectTimer) clearTimeout(this._reconnectTimer);
        this.seenNotifyTokens.clear();

        // Clear all pending requests
        for (const [extID, { reject, timeout }] of this.pendingRequests.entries()) {
            clearTimeout(timeout);
            reject(new Error(`ST [${this.name}] Platform destroyed`));
        }

        this.pendingRequests.clear();

        this.socket.destroy();
    }

    /**
     * Get connection status
     * @returns {boolean}
     */
    isConnected() {
        return this.connected;
    }
}

module.exports = STPlatform;