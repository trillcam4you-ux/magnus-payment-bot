/**
 * Run Telegram bot + credential dashboard together (Ctrl+C stops both).
 */
const { spawn } = require('child_process');
const path = require('path');

const cwd = __dirname;
const node = process.execPath;

const bot = spawn(node, ['bot.js'], { cwd, stdio: 'inherit', env: process.env });
const dash = spawn(node, ['dashboard-server.js'], { cwd, stdio: 'inherit', env: process.env });

function shutdown(code = 0) {
    bot.removeAllListeners();
    dash.removeAllListeners();
    try {
        bot.kill('SIGTERM');
    } catch (_) {}
    try {
        dash.kill('SIGTERM');
    } catch (_) {}
    setTimeout(() => process.exit(code), 300).unref();
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

bot.on('exit', (code, sig) => {
    if (code !== 0 && code !== null) console.error('bot.js exited', code, sig);
    shutdown(code || 0);
});
dash.on('exit', (code, sig) => {
    if (code !== 0 && code !== null) console.error('dashboard-server.js exited', code, sig);
    shutdown(code || 0);
});
