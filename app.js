const path = require('path');
const express = require('express');
const { execFile } = require('child_process');

const app = express();
const PORT = process.env.PORT || 3000;

const PUBLIC_DIR = path.join(__dirname, 'public');
const SCRAPE_SCRIPT = path.join(__dirname, 'scripts', 'scrape.js');

let isRunning = false;
let nextRunAt = null;

function log(message) {
  const stamp = new Date().toISOString();
  // eslint-disable-next-line no-console
  console.log(`[${stamp}] ${message}`);
}

function pickRandomMinute() {
  const min = Number(process.env.RANDOM_MINUTE_MIN ?? 5);
  const max = Number(process.env.RANDOM_MINUTE_MAX ?? 55);
  const safeMin = Number.isFinite(min) ? min : 5;
  const safeMax = Number.isFinite(max) ? max : 55;
  const clampedMin = Math.min(Math.max(safeMin, 0), 59);
  const clampedMax = Math.min(Math.max(safeMax, clampedMin), 59);
  const span = clampedMax - clampedMin + 1;
  return clampedMin + Math.floor(Math.random() * span);
}

function scheduleNextRun() {
  const now = new Date();
  const next = new Date(now);
  next.setMinutes(0, 0, 0);
  next.setHours(next.getHours() + 1);
  next.setMinutes(pickRandomMinute());

  nextRunAt = next;
  const delay = Math.max(next.getTime() - now.getTime(), 1000);

  log(`Next scrape scheduled at ${next.toISOString()}`);
  setTimeout(runScrape, delay);
}

function runScrape() {
  if (isRunning) {
    log('Scrape already running, skipping this slot.');
    scheduleNextRun();
    return;
  }

  isRunning = true;
  log('Starting scrape...');

  execFile('node', [SCRAPE_SCRIPT], { env: process.env }, (err, stdout, stderr) => {
    if (stdout) process.stdout.write(stdout);
    if (stderr) process.stderr.write(stderr);

    if (err) {
      log(`Scrape failed: ${err.message}`);
    } else {
      log('Scrape finished successfully.');
    }

    isRunning = false;
    scheduleNextRun();
  });
}

app.use(express.static(PUBLIC_DIR));

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    isRunning,
    nextRunAt: nextRunAt ? nextRunAt.toISOString() : null,
  });
});

app.get('/', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'leaderboard.html'));
});

app.listen(PORT, () => {
  log(`Server running at http://localhost:${PORT}`);

  if (process.env.RUN_ON_START === 'true') {
    runScrape();
  } else {
    scheduleNextRun();
  }
});
