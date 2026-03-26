# Votes Tracker Leaderboard

This project scrapes the Music Startup 1MNext voting pages and generates a static leaderboard.

## Run the scraper

First time only:

```bash
npx playwright install chromium
```

```bash
npm run scrape
```

Outputs:
- `data/leaderboard.json`
- `public/leaderboard.html`

Open `public/leaderboard.html` in a browser to view the table.

## Run as a Node app (auto hourly, random minute)

```bash
npm start
```

Then open `http://localhost:3000` in your browser.

By default, it runs once per hour at a random minute between 5 and 55 to avoid top‑of‑hour spikes.

Optional env vars:
- `RUN_ON_START=true` to scrape immediately on launch.
- `RANDOM_MINUTE_MIN=10` / `RANDOM_MINUTE_MAX=50` to change the random minute window.
- `PORT=3000` to change the server port.

## Daily update (7:00 CET)

Use cron on the machine where this runs (cron uses local time):

```bash
0 7 * * * cd /Users/chrisgyde/Documents/Codex\ Projects/VotesTrackerNuda && npm run scrape
```

If the machine timezone is not set to Europe/Rome, change it or adjust the cron time accordingly.
