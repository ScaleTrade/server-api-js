/**
 * scaletrade-server-api (Optimized for x32/x64)
 * High-performance TCP client for ScaleTrade platform
 */

const net = require('net');
const events = require('events');
const crypto = require('crypto');

const IS_ARCH_64 = process.arch === 'x64' || process.arch === 'arm64';

const DEFAULTS = {
    RECONNECT_DELAY_MS: 4000,
    RESPONSE_TIMEOUT_MS: 30000,
    AUTO_SUBSCRIBE_DELAY_MS: 500,
    SOCKET_KEEPALIVE: true,
    SOCKET_NODELAY: true,
    // x64 - 1GB, x32 - 256MB
    MAX_BUFFER_SIZE: IS_ARCH_64 ? 1024 * 1024 * 1024 : 256 * 1024 * 1024
};

/**
 * Generate a short unique ID for extID
 * @returns {string} 12-character random ID
 */
function generateExtID() {
    if (crypto.randomUUID) {
        return crypto.randomUUID().replace(/-/g, '').substring(0, 12);
    }
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
        const ms = safeParseNumber(unixTimestamp) * 1000;
        if (ms > 8640000000000000 || ms < -8640000000000000) {
            return new Date();
        }
        return new Date(ms);
    } catch (e) {
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
    /**
     * @param {string} url - host:port
     * @param {string} name - Logger tag
     * @param {Object} options - Configuration options
     * @param {Object} broker - Broker context
     * @param {Object} ctx - Global context
     * @param {string} token - Auth token
     * @param {events.EventEmitter} emitter - Custom emitter
     */
    constructor(url, name, options = {}, broker, ctx, token, emitter = null) {
        this.name = name;
        this.url = url;
        this.broker = broker || {};
        this.ctx = ctx || {};
        this.token = token;

        this.config = { ...DEFAULTS, ...options };

        this.ignoreEvents = options.ignoreEvents || false;
        this.prefix = options.prefix || 'sct';
        this.mode = options.mode || 'live';

        this.emitter = emitter || new events.EventEmitter();
        this.autoSubscribeChannels = Array.isArray(options.autoSubscribe) ? options.autoSubscribe : [];

        this.seenNotifyTokens = new Set();
        this.pendingRequests = new Map();

        this.errorCount = 0;
        this.recv = '';
        this.connected = false;
        this.alive = true;
        this.arch = process.arch;

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
        this.socket.setKeepAlive(this.config.SOCKET_KEEPALIVE);
        this.socket.setNoDelay(this.config.SOCKET_NODELAY);

        this.socket
            .on('connect', () => {
                console.info(`ST [${this.name}] Connected to ${this.url} (${this.arch}, Limit: ${(this.config.MAX_BUFFER_SIZE/1024/1024).toFixed(0)}MB)`);
                this.connected = true;
                this.errorCount = 0;
                this.seenNotifyTokens.clear();

                if (this.autoSubscribeChannels.length > 0) {
                    setTimeout(() => {
                        this.subscribe(this.autoSubscribeChannels)
                            .then(() => console.info(`ST [${this.name}] Auto-subscribed: ${this.autoSubscribeChannels.length} channels`))
                            .catch(err => console.error(`ST [${this.name}] Auto-subscribe failed:`, err.message));
                    }, this.config.AUTO_SUBSCRIBE_DELAY_MS);
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
                console.error(`ST [${this.name}] Socket error (${this.errorCount}): ${err.message}`);
                if (this.alive && this.errorCount < 20) {
                    // ...
                } else if (this.errorCount >= 20) {
                    console.error(`ST [${this.name}] Too many errors, giving up.`);
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
            const chunk = data.toString('utf8');

            if (this.recv.length + chunk.length > this.config.MAX_BUFFER_SIZE) {
                console.error(`ST [${this.name}] CRITICAL: Buffer overflow (${(this.recv.length / 1024 / 1024).toFixed(2)} MB). Resetting buffer.`);
                this.recv = '';
                // this.socket.destroy();
                return;
            }

            this.recv += chunk;

            let delimiterPos = this.recv.indexOf('\r\n');

            while (delimiterPos !== -1) {
                const message = this.recv.substring(0, delimiterPos);
                this.recv = this.recv.substring(delimiterPos + 2);

                if (message.trim()) {
                    if (!IS_ARCH_64 && this.recv.length > 10000) {
                        setImmediate(() => this.processMessage(message));
                    } else {
                        this.processMessage(message);
                    }
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
            parsed = JSON.parse(token);
        } catch (e) {
            try {
                const cleaned = jsonRepair(token);
                parsed = JSON.parse(cleaned);
            } catch (e2) {
                console.error(`ST [${this.name}] JSON Parse Error. Len: ${token.length}`);
                return;
            }
        }

        // === ARRAY MESSAGES ===
        if (Array.isArray(parsed)) {
            const [marker] = parsed;

            // Quote: ["t", symbol, bid, ask, timestamp]
            if (marker === 't' && parsed.length >= 4) {
                const [, symbol, bid, ask, timestamp] = parsed;
                const quote = {
                    symbol,
                    bid: safeParseNumber(bid),
                    ask: safeParseNumber(ask),
                    timestamp: safeTimestamp(timestamp)
                };
                this.emit('quote', quote);
                this.emit(`quote:${symbol.toUpperCase()}`, quote);
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
            this.emitter.emit(name, data);
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
            const timeoutMs = this.config.RESPONSE_TIMEOUT_MS;

            const timeout = setTimeout(() => {
                this.pendingRequests.delete(payload.extID);
                reject(new Error(`ST [${this.name}] Timeout for extID: ${payload.extID}`));
            }, timeoutMs);

            this.pendingRequests.set(payload.extID, { resolve, reject, timeout });

            try {
                const message = JSON.stringify(payload) + "\r\n";

                const success = this.socket.write(message, 'utf8', (err) => {
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

        for (const [extID, { reject, timeout }] of this.pendingRequests.entries()) {
            clearTimeout(timeout);
            reject(new Error(`ST [${this.name}] Connection lost during request`));
        }
        this.pendingRequests.clear();

        const baseDelay = this.config.RECONNECT_DELAY_MS;
        const delay = Math.min(baseDelay * Math.pow(1.2, this.errorCount), 30000);

        console.info(`ST [${this.name}] Reconnecting in ${(delay/1000).toFixed(1)}s...`);

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