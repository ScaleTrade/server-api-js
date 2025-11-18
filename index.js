/**
 * ion-server-api
 * High-performance TCP client for IonTrader platform
 * Supports real-time quotes, trades, balance, user & symbol events
 * Zero external dependencies
 */

const net = require('net');
const events = require('events');
const crypto = require('crypto');

const RECONNECT_DELAY_MS = 4000;
const RESPONSE_TIMEOUT_MS = 30000;
const AUTO_SUBSCRIBE_DELAY_MS = 500;
const SOCKET_KEEPALIVE = true;
const SOCKET_NODELAY = true;

/**
 * Generate a short unique ID for extID
 * @returns {string} 12-character random ID
 */
function generateExtID() {
    if (crypto.randomUUID) {
        return crypto.randomUUID().replace(/-/g, '').substring(0, 12);
    }
    // Fallback for older Node versions
    return crypto.randomBytes(6).toString('hex');
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

class IONPlatform {
    /**
     * Create a new IONPlatform instance
     * @param {string} url - Host and port (e.g., 'host:8080')
     * @param {string} name - Identifier for logging
     * @param {Object} [options={}] - Configuration
     * @param {Array<string>} [options.autoSubscribe=[]] - Auto-subscribe channels
     * @param {boolean} [options.ignoreEvents=false] - Disable event emission
     * @param {string} [options.prefix='ion'] - Event prefix
     * @param {string} [options.mode='live'] - 'live' || 'demo' || ...
     * @param {Object} [broker={}] - Optional broker
     * @param {Object} [ctx={}] - Optional context
     * @param {string} token - JWT authentication token
     * @param {EventEmitter} [emitter=null] - Custom EventEmitter
     */
    constructor(url, name, options = {}, broker, ctx, token, emitter = null) {
        this.name = name;
        this.url = url;
        this.errorCount = 0;
        this.broker = broker || {};
        this.ctx = ctx || {};
        this.ignoreEvents = options.ignoreEvents || false;
        this.prefix = options.prefix || 'ion';
        this.mode = options.mode || 'live';
        this.token = token;
        this.emitter = emitter || new events.EventEmitter();
        this.autoSubscribeChannels = Array.isArray(options.autoSubscribe) ? options.autoSubscribe : [];
        this.seenNotifyTokens = new Set();
        this.pendingRequests = new Map();

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
                console.info(`ION [${this.name}] Connected to ${this.url}`);
                this.connected = true;
                this.errorCount = 0;
                this.seenNotifyTokens.clear();

                // Auto-subscribe after connection
                if (this.autoSubscribeChannels.length > 0) {
                    setTimeout(() => {
                        this.subscribe(this.autoSubscribeChannels)
                            .then(() => console.info(`ION [${this.name}] Auto-subscribed: ${this.autoSubscribeChannels.join(', ')}`))
                            .catch(err => console.error(`ION [${this.name}] Auto-subscribe failed:`, err.message));
                    }, AUTO_SUBSCRIBE_DELAY_MS);
                }
            })
            .on('timeout', () => {
                console.error(`ION [${this.name}] Socket timeout`);
                if (this.alive) this.reconnect();
            })
            .on('close', () => {
                this.connected = false;
                console.warn(`ION [${this.name}] Connection closed`);
                if (this.alive) this.reconnect();
            })
            .on('error', (err) => {
                this.errorCount++;
                console.error(`ION [${this.name}] Socket error (count: ${this.errorCount}):`, err.message);

                // Don't reconnect too aggressively on repeated errors
                if (this.errorCount < 10 && this.alive) {
                    this.reconnect();
                } else if (this.errorCount >= 10) {
                    console.error(`ION [${this.name}] Too many errors, stopping reconnection attempts`);
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
        this.recv += data.toString();

        const delimiterPos = this.recv.lastIndexOf('\r\n');
        if (delimiterPos === -1) return;

        const received = this.recv.slice(0, delimiterPos);
        this.recv = this.recv.slice(delimiterPos + 2);
        const tokens = received.split('\r\n');

        for (const token of tokens) {
            if (!token.trim()) continue;

            let parsed;
            try {
                const cleaned = jsonRepair(token);
                parsed = JSON.parse(cleaned);
            } catch (e) {
                console.error(`ION [${this.name}] Parse error:`, token.substring(0, 100), e.message);
                continue;
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
                            bid,
                            ask,
                            timestamp: timestamp ? new Date(timestamp * 1000) : null
                        };
                        this.emit('quote', quote);
                        this.emit(`quote:${symbol.toUpperCase()}`, quote);
                    }
                    continue;
                }

                // Notify: ["n", msg, desc, token, status, level, user_id, time, data?, code]
                if (marker === 'n' && parsed.length >= 8) {
                    const [
                        , message, description, token, status, level, user_id, create_time, dataOrCode, code
                    ] = parsed;

                    // Skip duplicates
                    if (this.seenNotifyTokens.has(token)) continue;
                    this.seenNotifyTokens.add(token);

                    // Limit size of seen tokens set
                    if (this.seenNotifyTokens.size > 10000) {
                        const firstToken = this.seenNotifyTokens.values().next().value;
                        this.seenNotifyTokens.delete(firstToken);
                    }

                    const isObject = dataOrCode && typeof dataOrCode === 'object';
                    const notify = {
                        message, description, token, status, level, user_id,
                        create_time: create_time ? new Date(create_time * 1000) : null,
                        data: isObject ? dataOrCode : {},
                        code: Number(isObject ? code : dataOrCode) || 0
                    };

                    this.emit('notify', notify);
                    this.emit(`notify:${level}`, notify);
                    continue;
                }

                // Symbols Reindex: ["sr", [[symbol, sym_index, sort_index], ...]]
                if (marker === 'sr' && parsed.length === 2) {
                    const [, symbols] = parsed;
                    this.emit('symbols:reindex', symbols);
                    continue;
                }

                // Security Reindex: ["sc", [[sec_index, sort_index], ...]]
                if (marker === 'sc' && parsed.length === 2) {
                    const [, groups] = parsed;
                    this.emit('security:reindex', groups);
                    continue;
                }

                console.warn(`ION [${this.name}] Unknown array message:`, parsed);
                continue;
            }

            // === JSON EVENT OBJECTS ===
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && parsed.event) {
                const { event, type, data } = parsed;

                this.emit(event, { type, data });

                if (data?.login) this.emit(`${event}:${data.login}`, { type, data });
                if (data?.symbol) this.emit(`${event}:${data.symbol}`, { type, data });
                if (data?.group) this.emit(`${event}:${data.group}`, { type, data });

                continue;
            }

            // === COMMAND RESPONSES (extID) ===
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && parsed.extID) {
                const extID = parsed.extID;

                // Resolve pending promise
                if (this.pendingRequests.has(extID)) {
                    const { resolve, timeout } = this.pendingRequests.get(extID);
                    clearTimeout(timeout);
                    this.pendingRequests.delete(extID);
                    resolve(parsed);
                } else {
                    // Also emit for legacy compatibility
                    this.emit(extID, parsed);
                }
                continue;
            }

            console.warn(`ION [${this.name}] Unknown message:`, parsed);
        }
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
            return Promise.reject(new Error(`ION [${this.name}] Not connected`));
        }

        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                this.pendingRequests.delete(payload.extID);
                reject(new Error(`ION [${this.name}] Timeout for extID: ${payload.extID}`));
            }, RESPONSE_TIMEOUT_MS);

            // Store in map instead of relying on event emitter
            this.pendingRequests.set(payload.extID, { resolve, reject, timeout });

            try {
                this.socket.write(JSON.stringify(payload) + "\r\n");
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
            reject(new Error(`ION [${this.name}] Connection lost`));
        }
        this.pendingRequests.clear();

        // Exponential backoff with max delay
        const delay = Math.min(RECONNECT_DELAY_MS * Math.pow(1.5, this.errorCount - 1), 30000);

        this._reconnectTimer = setTimeout(() => {
            delete this._reconnectTimer;
            console.info(`ION [${this.name}] Reconnecting... (attempt ${this.errorCount + 1})`);
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
            reject(new Error(`ION [${this.name}] Platform destroyed`));
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

module.exports = IONPlatform;