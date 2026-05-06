/**
 * Builds assets/plan-banner.gif: animated Matrix-style rain + optional poster overlay.
 * Pure JS (jimp + gifenc). Run: npm run generate:banner
 */
const fs = require('fs');
const path = require('path');
const { Jimp, loadFont } = require('jimp');
const { GIFEncoder, quantize, applyPalette } = require('gifenc');

const W = 480;
const H = 720;
const COL_W = 10;
const ROW_H = 10;
const COLS = Math.ceil(W / COL_W);
const FRAMES = 24;
const FRAME_DELAY = 90;

const MATRIX_CHARS =
    'ｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃ0123456789ABCDEFﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜﾝ';

function randomMatrixChar() {
    return MATRIX_CHARS[(Math.random() * MATRIX_CHARS.length) | 0];
}

function initColumns() {
    const cols = [];
    for (let i = 0; i < COLS; i++) {
        cols.push({
            head: Math.random() * H * 1.5 - H * 0.5,
            speed: 3 + Math.random() * 5,
            len: 12 + Math.floor(Math.random() * 18)
        });
    }
    return cols;
}

function fillBlack(jimp) {
    const d = jimp.bitmap.data;
    for (let i = 0; i < d.length; i += 4) {
        d[i] = 0;
        d[i + 1] = 0;
        d[i + 2] = 0;
        d[i + 3] = 255;
    }
}

function tintGlyphGreen(cell, g) {
    const b = Math.min(255, Math.floor(g * 0.35));
    const d = cell.bitmap.data;
    for (let i = 0; i < d.length; i += 4) {
        const lum = d[i] + d[i + 1] + d[i + 2];
        if (d[i + 3] > 40 && lum > 180) {
            d[i] = 0;
            d[i + 1] = g;
            d[i + 2] = b;
            d[i + 3] = 255;
        }
    }
}

function drawMatrix(frame, cols, tick, font, cell) {
    fillBlack(frame);

    for (let c = 0; c < COLS; c++) {
        const col = cols[c];
        const x = c * COL_W + 1;
        const yBase = col.head + tick * col.speed * 0.35;

        for (let i = 0; i < col.len; i++) {
            const tail = i / col.len;
            const g = Math.floor(40 + tail * 215);
            const py = Math.round(yBase - i * ROW_H);

            if (py + ROW_H < 0 || py > H) continue;

            fillBlack(cell);
            cell.print({ font, x: 0, y: 0, text: randomMatrixChar() });
            tintGlyphGreen(cell, g);
            frame.composite(cell, x, py);
        }

        col.head += col.speed * 0.12;
        if (col.head > H + col.len * ROW_H) {
            col.head = -col.len * ROW_H - Math.random() * 400;
            col.len = 12 + Math.floor(Math.random() * 18);
            col.speed = 3 + Math.random() * 5;
        }
    }
}

async function main() {
    const root = path.join(__dirname, '..');
    const outDir = path.join(root, 'assets');
    const outPath = path.join(outDir, 'plan-banner.gif');
    const posterPath = path.join(outDir, 'plan-poster.png');

    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

    const printRoot = path.dirname(require.resolve('@jimp/plugin-print/package.json'));
    const fontPath = path.join(printRoot, 'fonts/open-sans/open-sans-8-white/open-sans-8-white.fnt');
    if (!fs.existsSync(fontPath)) {
        throw new Error('Bitmap font not found: ' + fontPath);
    }
    const font = await loadFont(fontPath);

    let posterFit = null;
    if (fs.existsSync(posterPath)) {
        const poster = await Jimp.read(posterPath);
        poster.contain({ w: W, h: H });
        posterFit = poster;
    } else {
        console.warn('Optional assets/plan-poster.png not found; GIF will be rain only.');
    }

    const cell = new Jimp({ width: COL_W + 4, height: ROW_H + 4, color: 0x000000ff });
    const cols = initColumns();
    const gif = GIFEncoder();
    const frame = new Jimp({ width: W, height: H, color: 0x000000ff });

    for (let f = 0; f < FRAMES; f++) {
        drawMatrix(frame, cols, f, font, cell);
        if (posterFit) {
            frame.composite(posterFit, 0, 0);
        }

        const raw = new Uint8Array(frame.bitmap.data.buffer, frame.bitmap.data.byteOffset, frame.bitmap.data.length);
        const palette = quantize(raw, 256, { format: 'rgb444' });
        const index = applyPalette(raw, palette, 'rgb444');
        const opts = { palette, delay: FRAME_DELAY };
        if (f === 0) opts.repeat = 0;
        gif.writeFrame(index, W, H, opts);
    }

    gif.finish();
    fs.writeFileSync(outPath, Buffer.from(gif.bytes()));
    console.log('Wrote', outPath, fs.statSync(outPath).size, 'bytes');
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
