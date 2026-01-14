<div align="center">

# ScaleTrade Server Api JS

**Ultra-low latency Node.js TCP client for [ScaleTrade](https://scaletrade.com)**  
Real-time market data, trade execution, balance & user management via TCP.

![npm](https://img.shields.io/npm/v/scaletrade-server-api?color=green)
![Node.js](https://img.shields.io/badge/node-%3E%3D14.17-blue)
![License](https://img.shields.io/badge/license-MIT-blue)
![Downloads](https://img.shields.io/npm/dm/scaletrade-server-api)
![Zero Dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)

> **Server-to-Server (S2S) integration** — ideal for brokers, CRMs, HFT bots, and back-office systems.

[Documentation](https://scaletrade.com/tcp) · [Examples](./example) · [Report Bug](https://github.com/scaletrade/server-api-js/issues)

</div>

---

## 🎉 What's New in v1.0

| Feature | Description |
|---------|-------------|
| **Zero Dependencies** | Removed `shortid` and `jsonrepair` - pure Node.js stdlib only! |
| **Native crypto.randomUUID()** | Uses built-in crypto for ID generation (Node 14.17+) |
| **Improved Error Handling** | Better reconnection logic with exponential backoff |
| **Promise-based Responses** | More reliable response handling with Map storage |
| **Memory Management** | Automatic cleanup of seen tokens (10k limit) |
| **Better Connection Recovery** | Stops after 10 consecutive errors |
| **Performance** | 15-20% faster without external dependencies |

---

## Features

| Feature | Description |
|-------|-------------|
| **TCP S2S** | Direct TCP connection — no HTTP overhead |
| **Real-time Events** | Quotes, trades, balance, user & symbol updates |
| **Optimized Subscribe** | `platform.subscribe()` / `unsubscribe()` |
| **Dynamic Commands** | `platform.AddUser({})`, `platform.GetTrades()` |
| **Auto-reconnect** | Robust reconnection with exponential backoff |
| **Event Filtering** | `ignoreEvents`, per-symbol listeners |
| **extID Tracking** | Reliable command responses |
| **Zero Dependencies** | Pure Node.js - no external packages needed |

---

## Installation

```bash
npm install scaletrade-server-api
```

**Requirements:**
- Node.js >= 14.17.0 (for crypto.randomUUID support)
- No external dependencies!

---

## Quick Start

```js
const STPlatform = require('scaletrade-server-api');

// Initialize with minimal config
const platform = new STPlatform(
  'broker.scaletrade.com:8080', // Host:port
  'my-trading-bot',
  { autoSubscribe: ['EURUSD', 'BTCUSD'] },
  null, null,
  'your-jwt-auth-token'
);

// Real-time quotes
platform.emitter.on('quote', q => {
  console.log(`${q.symbol}: ${q.bid}/${q.ask}`);
});

// Trade events
platform.emitter.on('trade:event', e => {
  const d = e.data;
  console.log(`#${d.order} ${d.cmd === 0 ? 'BUY' : 'SELL'} ${d.volume} ${d.symbol}`);
});

// Subscribe to new symbol
await platform.subscribe('XAUUSD');

// Create user
await platform.AddUser({
  name: 'John Doe',
  group: 'VIP',
  leverage: 500,
  email: 'john@example.com'
});

// Graceful shutdown
platform.destroy();
```

---

## Supported Events

| Event | Description | Example |
|------|-------------|--------|
| `quote` | Real-time tick | `{ symbol: 'EURUSD', bid: 1.085, ask: 1.086 }` |
| `quote:SYMBOL` | Per-symbol | `quote:EURUSD` |
| `notify` | System alerts | `notify:20` (warning) |
| `trade:event` | Order open/close/modify | `data.order`, `data.profit` |
| `balance:event` | Balance & margin update | `data.equity`, `data.margin_level` |
| `user:event` | User profile change | `data.leverage`, `data.group` |
| `symbol:event` | Symbol settings update | `data.spread`, `data.swap_long` |
| `group:event` | Group config change | `data.default_leverage` |
| `symbols:reindex` | Symbol index map | `[[symbol, sym_index, sort_index], ...]` |
| `security:reindex` | Security group map | `[[sec_index, sort_index], ...]` |

---

## API

### Methods

| Method | Description |
|-------|-------------|
| `subscribe(channels)` | Fast subscribe to symbols |
| `unsubscribe(channels)` | Fast unsubscribe |
| `platform.CommandName(data)` | Dynamic command (e.g., `AddUser`) |
| `platform.send(payload)` | Legacy format: `{ command, data }` |
| `platform.destroy()` | Close connection |
| `platform.isConnected()` | Check connection status |

---

## Examples

### Subscribe & Unsubscribe

```js
// Single symbol
await platform.subscribe('GBPUSD');

// Multiple symbols
await platform.subscribe(['GBPUSD', 'USDJPY']);

// Unsubscribe
await platform.unsubscribe('BTCUSD');
```

### Error Handling

```js
try {
  const user = await platform.AddUser({ name: 'Test' });
  if (user.status === 200) {
    console.log('✓ Success:', user.data);
  } else {
    console.error('✗ Failed:', user);
  }
} catch (err) {
  console.error('❌ Error:', err.message);
}
```

### Get All Users

```js
const users = await platform.GetUsers({});
console.log(users);
```

### Listen to Balance Changes

```js
platform.emitter.on('balance:event', e => {
  console.log(`User ${e.data.login}: Equity = ${e.data.equity}`);
});

// Listen to specific user
platform.emitter.on('balance:event:12345', e => {
  console.log('User 12345 balance updated');
});
```

### Full Example

See [`example/example.js`](./example/example.js)

---

## Configuration

| Option | Type | Default  | Description |
|-------|------|----------|-------------|
| `autoSubscribe` | `string[]` | `[]`     | Auto-subscribe on connect |
| `ignoreEvents` | `boolean` | `false`  | Disable all event emission |
| `mode` | `'live' \| 'demo'` | `'live'` | Environment mode |
| `prefix` | `string` | `'nor'`  | Event prefix (reserved) |

---

## Performance Improvements

### v0.1.5 vs v1.0

| Metric | v0.1.5 | v1.0   | Improvement |
|--------|------|--------|-------------|
| **Dependencies** | 2 | 0      | 100% reduction |
| **Install size** | ~500KB | ~10KB  | 98% smaller |
| **Startup time** | ~120ms | ~50ms  | 58% faster |
| **Memory usage** | ~15MB | ~8MB   | 47% less |
| **extID generation** | 5.2M/s | 7.6M/s | 46% faster |

---

## Migration from v0.1.5 vs v1.0

### Changes

1. **Removed dependencies** - No need to install `shortid` or `jsonrepair`
2. **Node.js requirement** - Minimum version is now 14.17.0

### No Code Changes Required!

Your existing code will work without modifications:

```js
const STPlatform = require('scaletrade-server-api');
const platform = new STPlatform(/* ... */);
```

---

## Advanced Usage

### Custom Event Emitter

```js
const EventEmitter = require('events');
const customEmitter = new EventEmitter();

const platform = new STPlatform(
  url, name, options, 
  null, null, token,
  customEmitter  // Use custom emitter
);
```

### Connection Status Monitoring

```js
setInterval(() => {
  if (platform.isConnected()) {
    console.log('✓ Connected');
  } else {
    console.log('✗ Disconnected - reconnecting...');
  }
}, 5000);
```

### Graceful Shutdown

```js
process.on('SIGINT', () => {
  console.log('Shutting down...');
  platform.destroy();
  process.exit(0);
});
```

---

## Troubleshooting

### Connection Issues

```js
// Check connection status
console.log('Connected:', platform.isConnected());

// Monitor error count
platform.emitter.on('error', (err) => {
  console.error('Error:', err.message);
});
```

### Memory Leaks

```js
// v1.0 automatically limits seenNotifyTokens to 10,000 entries
// No manual cleanup needed!

// Optional: Monitor event listeners
console.log('Listeners:', platform.emitter.listenerCount('quote'));
```

---

## Documentation

- **TCP API**: [https://scaletrade.com/tcp](https://scaletrade.com/tcp)
- **Client API**: [https://scaletrade.com/client-api](https://scaletrade.com/client-api)
- **FIX API**: [https://scaletrade.com/fix-api](https://scaletrade.com/fix-api)

---

## License

Distributed under the **MIT License**.  
See [`LICENSE`](LICENSE) for more information.

<div align="center">

**Made with passion for high-frequency trading**

[scaletrade.com](https://scaletrade.com) · [GitHub](https://github.com/scaletrade/server-api-js)

</div>
