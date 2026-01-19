/**
 * Universal test script for x32/x64 compatibility
 */

const STPlatform = require('../index');

// Configuration
const url = 'example.host:8080'; // Host and port for the ScaleTrade platform
const name = 'ScaleTrade-example'; // Platform name
const token = 'your-jwt-auth-token'; // Authentication token

// System info
console.log('\n========== SYSTEM INFO ==========');
console.log(`Node version: ${process.version}`);
console.log(`Architecture: ${process.arch}`);
console.log(`Platform: ${process.platform}`);
console.log(`Memory: ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB used`);
console.log('=================================\n');

const platform = new STPlatform(
    url,
    name,
    { autoSubscribe: ['EURUSD', 'BTCUSD'] },
    null,
    null,
    token
);

// Test counters
const testResults = {
    quotes: 0,
    notifies: 0,
    commands: 0,
    errors: 0,
    startTime: Date.now()
};

// Quote handler
platform.emitter.on('quote', (q) => {
    testResults.quotes++;

    if (testResults.quotes === 1) {
        console.log(`✓ First quote received: ${q.symbol} ${q.bid}/${q.ask}`);
    }

    // Check for number integrity issues (x32 problem indicator)
    if (!Number.isFinite(q.bid) || !Number.isFinite(q.ask)) {
        console.error(`❌ Invalid number in quote: bid=${q.bid}, ask=${q.ask}`);
        testResults.errors++;
    }
});

// Notify handler
platform.emitter.on('notify', (n) => {
    testResults.notifies++;
    console.log(`✓ Notify received: ${n.message}`);
});

// Connection test
setTimeout(async () => {
    if (!platform.isConnected()) {
        console.error('❌ Connection failed after 3s');
        process.exit(1);
    }

    console.log('✓ Connection established\n');

    // Run command tests
    await runCommandTests();

}, 3000);

async function runCommandTests() {
    console.log('========== COMMAND TESTS ==========\n');

    // Test 1: Subscribe
    try {
        console.log('Test 1: Subscribe to GBPUSD...');
        const start = Date.now();
        const result = await platform.subscribe('GBPUSD');
        const duration = Date.now() - start;

        console.log(`✓ Subscribe OK (${duration}ms)`);
        console.log(`  Response:`, result);
        testResults.commands++;

        if (duration > 5000) {
            console.warn(`⚠️  Slow response detected (${duration}ms) - potential x32 issue`);
        }
    } catch (err) {
        console.error('❌ Subscribe failed:', err.message);
        testResults.errors++;
    }

    // Test 2: Large number handling
    try {
        console.log('\nTest 2: Testing large numbers...');
        const largeNum = 999999999999;
        console.log(`  Testing number: ${largeNum}`);
        console.log(`  Is safe integer: ${Number.isSafeInteger(largeNum)}`);
        console.log(`  Max safe integer: ${Number.MAX_SAFE_INTEGER}`);

        if (process.arch === 'ia32' || process.arch === 'x32') {
            console.log('  ⚠️  Running on 32-bit architecture - numbers limited');
        }
    } catch (err) {
        console.error('❌ Number test failed:', err.message);
        testResults.errors++;
    }

    // Test 3: Multiple rapid commands (stress test)
    try {
        console.log('\nTest 3: Rapid command stress test...');
        const start = Date.now();
        const promises = [];

        for (let i = 0; i < 5; i++) {
            promises.push(platform.subscribe(`TEST${i}`));
        }

        const results = await Promise.allSettled(promises);
        const duration = Date.now() - start;
        const successful = results.filter(r => r.status === 'fulfilled').length;

        console.log(`✓ Stress test complete (${duration}ms)`);
        console.log(`  Successful: ${successful}/5`);
        testResults.commands += successful;

        if (duration > 10000) {
            console.warn(`⚠️  Very slow responses - check x32 compatibility`);
        }
    } catch (err) {
        console.error('❌ Stress test failed:', err.message);
        testResults.errors++;
    }

    // Test 4: Memory check
    console.log('\nTest 4: Memory usage check...');
    const memUsage = process.memoryUsage();
    console.log(`  Heap used: ${Math.round(memUsage.heapUsed / 1024 / 1024)}MB`);
    console.log(`  Heap total: ${Math.round(memUsage.heapTotal / 1024 / 1024)}MB`);

    if (memUsage.heapUsed > 100 * 1024 * 1024) {
        console.warn('  ⚠️  High memory usage detected');
    } else {
        console.log('  ✓ Memory usage normal');
    }

    // Wait for quotes
    console.log('\n========== WAITING FOR QUOTES ==========');
    console.log('Collecting data for 15 seconds...\n');

    setTimeout(() => {
        printFinalReport();
    }, 15000);
}

function printFinalReport() {
    const duration = (Date.now() - testResults.startTime) / 1000;

    console.log('\n========== FINAL REPORT ==========');
    console.log(`Duration: ${duration.toFixed(1)}s`);
    console.log(`Architecture: ${process.arch}`);
    console.log(`\nResults:`);
    console.log(`  Quotes received: ${testResults.quotes}`);
    console.log(`  Notifies received: ${testResults.notifies}`);
    console.log(`  Commands executed: ${testResults.commands}`);
    console.log(`  Errors: ${testResults.errors}`);

    const qps = (testResults.quotes / duration).toFixed(2);
    console.log(`\nPerformance:`);
    console.log(`  Quotes per second: ${qps}`);

    const memUsage = process.memoryUsage();
    console.log(`\nMemory:`);
    console.log(`  Heap used: ${Math.round(memUsage.heapUsed / 1024 / 1024)}MB`);
    console.log(`  RSS: ${Math.round(memUsage.rss / 1024 / 1024)}MB`);

    console.log('\n========== DIAGNOSTICS ==========');

    if (testResults.quotes === 0) {
        console.error('❌ CRITICAL: No quotes received - connection issue');
    } else if (testResults.quotes < 10) {
        console.warn('⚠️  WARNING: Very few quotes - possible timeout issue');
    } else {
        console.log('✓ Quote reception working normally');
    }

    if (testResults.errors > 0) {
        console.error(`❌ ${testResults.errors} errors detected - check logs above`);
    } else {
        console.log('✓ No errors detected');
    }

    if (process.arch === 'ia32' || process.arch === 'x32') {
        console.log('\n⚠️  Running on 32-bit architecture');
        console.log('   If experiencing issues, check:');
        console.log('   - Number overflow in timestamps');
        console.log('   - Buffer size limits');
        console.log('   - setTimeout precision');
    }

    console.log('\n=================================\n');

    platform.destroy();

    // Exit with appropriate code
    if (testResults.errors > 0 || testResults.quotes === 0) {
        console.error('❌ Tests FAILED');
        process.exit(1);
    } else {
        console.log('✓ All tests PASSED');
        process.exit(0);
    }
}

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('\n\n⚠️  Interrupted by user');
    printFinalReport();
});

process.on('uncaughtException', (err) => {
    console.error('\n💥 Uncaught exception:', err);
    testResults.errors++;
    platform.destroy();
    process.exit(1);
});

console.log('🚀 Starting universal compatibility test...\n');