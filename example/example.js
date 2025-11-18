/**
 * IonTrader API Example
 * Demonstrates full event handling and subscribe/unsubscribe
 */

const IONPlatform = require('../index');

const url = 'example.host:8080'; // Host and port for the ION platform
const name = 'ion-example'; // Platform name
const token = 'your-jwt-auth-token'; // Authentication token

const platform = new IONPlatform(
    url,
    name,
    {
        autoSubscribe: ['EURUSD', 'BTCUSD']
    },
    null,
    null,
    token
);

// === EVENTS ===

// Quote counter
let quoteCount = 0;
const quoteStats = {};

platform.emitter.on('quote', (q) => {
    quoteCount++;
    quoteStats[q.symbol] = (quoteStats[q.symbol] || 0) + 1;

    // Print every 10th quote to reduce spam
    if (quoteCount % 10 === 0) {
        console.log(`[QUOTE #${quoteCount}] ${q.symbol}: ${q.bid}/${q.ask}`);
    }
});

platform.emitter.on('quote:EURUSD', (q) => {
    // Specific symbol handler
});

platform.emitter.on('notify', (n) => {
    const level = { 10: 'INFO', 20: 'WARN', 30: 'ERROR', 40: 'PROMO' }[n.level] || n.level;
    console.log(`[NOTIFY:${level}] ${n.message}`);
    if (n.description) console.log(`  └─ ${n.description}`);
});

platform.emitter.on('trade:event', (e) => {
    const d = e.data;
    const cmd = d.cmd === 0 ? 'BUY' : d.cmd === 1 ? 'SELL' : 'UNKNOWN';
    console.log(`[TRADE #${d.order}] ${cmd} ${d.volume} ${d.symbol} @ ${d.open_price} (P&L: ${d.profit})`);
});

platform.emitter.on('balance:event', (e) => {
    const d = e.data;
    console.log(`[BALANCE] ${d.login} | Balance: ${d.balance} | Equity: ${d.equity} | Margin: ${d.margin_level}%`);
});

platform.emitter.on('user:event', (e) => {
    const d = e.data;
    console.log(`[USER] ${d.login} | ${d.name} | Group: ${d.group} | Leverage: ${d.leverage}`);
});

platform.emitter.on('symbol:event', (e) => {
    const d = e.data;
    console.log(`[SYMBOL] ${d.symbol} updated | Spread: ${d.spread || 'N/A'}`);
});

platform.emitter.on('group:event', (e) => {
    const d = e.data;
    console.log(`[GROUP] ${d.group} | Leverage: ${d.default_leverage || 'N/A'}`);
});

platform.emitter.on('symbols:reindex', (list) => {
    console.log(`[REINDEX] ${list.length} symbols updated`);
});

platform.emitter.on('security:reindex', (list) => {
    console.log(`[SECURITY] ${list.length} security groups updated`);
});

// === COMMANDS ===
setTimeout(async () => {
    if (!platform.isConnected()) {
        console.error('❌ Not connected');
        return;
    }

    try {
        // Subscribe
        console.log('\n📡 Subscribing to GBPUSD...');
        const subResp = await platform.subscribe('GBPUSD');
        console.log('✓ Subscribed:', subResp.data);

        // Create user with error handling
        console.log('\n👤 Creating user...');
        const email = `john${Date.now()}@example.com`;
        const user = await platform.AddUser({
            group: "TestGroup",
            name: "John Doe",
            password: "pass123",
            leverage: 100,
            enable: 1,
            email
        });

        if (user.status === 200) {
            console.log(`✓ User created: Login ${user.data.login}, Leverage: ${user.data.leverage}`);
        } else {
            console.log(`✗ User creation failed:`, user);
        }

        // Test command that doesn't exist (error handling)
        try {
            await platform.NonExistentCommand({ test: 1 });
        } catch (err) {
            console.log('✓ Error handling works:', err.message);
        }

        // Unsubscribe after 10s
        setTimeout(async () => {
            console.log('\n📡 Unsubscribing from BTCUSD...');
            const unsubResp = await platform.unsubscribe('BTCUSD');
            console.log('✓ Unsubscribed:', unsubResp.data);

            // Print statistics
            console.log('\n📊 Quote Statistics:');
            console.log(`Total quotes received: ${quoteCount}`);
            Object.entries(quoteStats).forEach(([symbol, count]) => {
                console.log(`  ${symbol}: ${count} quotes`);
            });
        }, 10000);

    } catch (err) {
        console.error('❌ Command error:', err.message);
    }

    // Auto shutdown
    setTimeout(() => {
        console.log('\n👋 Shutting down...');
        console.log(`📊 Final stats: ${quoteCount} total quotes received`);
        platform.destroy();
        process.exit(0);
    }, 30000);
}, 2000);

// Graceful shutdown on Ctrl+C
process.on('SIGINT', () => {
    console.log('\n\n⚠️  Caught interrupt signal');
    console.log(`📊 Total quotes: ${quoteCount}`);
    platform.destroy();
    process.exit(0);
});

// Handle uncaught errors
process.on('uncaughtException', (err) => {
    console.error('💥 Uncaught exception:', err);
    platform.destroy();
    process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('💥 Unhandled rejection at:', promise, 'reason:', reason);
});

console.log('\n🚀 ION Platform Example Started');
console.log('Press Ctrl+C to stop\n');