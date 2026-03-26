const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const LIST_URL = 'https://musicstartup.it/vota-1mnext/';
const OUTPUT_JSON = path.join(__dirname, '..', 'data', 'leaderboard.json');
const OUTPUT_HTML = path.join(__dirname, '..', 'public', 'leaderboard.html');
const OUTPUT_INDEX = path.join(__dirname, '..', 'public', 'index.html');
const OUTPUT_DIRS = [
  path.join(__dirname, '..', 'data'),
  path.join(__dirname, '..', 'public'),
];

function normalizeWhitespace(text) {
  return text.replace(/\s+/g, ' ').trim();
}

function parseVotesFromText(text) {
  const cleaned = normalizeWhitespace(text);
  const match = cleaned.match(/(\d[\d\.\s]*)\s*(voti|voto)/i);
  if (!match) return null;
  const digits = match[1].replace(/\D/g, '');
  if (!digits) return null;
  return Number(digits);
}

function nowCET() {
  return new Date().toLocaleString('en-GB', { timeZone: 'Europe/Rome' });
}

function nextRunWindowCET() {
  const now = new Date();
  const nowUtc = new Date(now.getTime());
  const minutes = nowUtc.getUTCMinutes();
  const nextBase = new Date(nowUtc.getTime());

  if (minutes < 30) {
    nextBase.setUTCMinutes(30, 0, 0);
  } else {
    nextBase.setUTCHours(nowUtc.getUTCHours() + 1, 0, 0, 0);
  }

  const windowEnd = new Date(nextBase.getTime() + 25 * 60 * 1000);
  const format = (date) =>
    date.toLocaleString('en-GB', {
      timeZone: 'Europe/Rome',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });

  return `${format(nextBase)} – ${format(windowEnd)} CET`;
}

async function collectBandLinks(page, context) {
  const visited = new Set();
  const toVisit = [LIST_URL];
  const bandLinks = new Set();

  async function countArtistLinks() {
    return page.$$eval('a[href*="/artista/"]', (anchors) => anchors.length);
  }

  async function autoLoadAllArtists(targetCount = 119) {
    let previousCount = 0;
    let stableRounds = 0;

    for (let i = 0; i < 120; i += 1) {
      const currentCount = await countArtistLinks();
      if (currentCount === previousCount) {
        stableRounds += 1;
      } else {
        stableRounds = 0;
        previousCount = currentCount;
      }

      if (currentCount >= targetCount || stableRounds >= 10) break;

      const loadMore = page.getByRole('button', { name: /load more|mostra|altro|more/i });
      if (await loadMore.count()) {
        try {
          await loadMore.first().click();
          await page.waitForTimeout(1200);
        } catch (err) {
          // ignore and fall back to scrolling
        }
      }

      await page.evaluate(() => {
        const scrollables = Array.from(document.querySelectorAll('*')).filter((el) => {
          const style = window.getComputedStyle(el);
          const canScroll =
            (style.overflowY === 'auto' || style.overflowY === 'scroll') &&
            el.scrollHeight > el.clientHeight + 200;
          return canScroll;
        });

        const target =
          scrollables.sort(
            (a, b) => b.scrollHeight - b.clientHeight - (a.scrollHeight - a.clientHeight)
          )[0] || document.scrollingElement || document.documentElement;

        target.scrollBy(0, Math.min(800, target.clientHeight || 800));
      });

      await page.waitForTimeout(1200);
    }
  }

  while (toVisit.length) {
    const url = toVisit.shift();
    if (!url || visited.has(url)) continue;
    visited.add(url);

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(1500);

    if (url === LIST_URL) {
      await autoLoadAllArtists(119);
    }

    const { direct, artistLinks, pageLinks } = await page.$$eval('a', (anchors) => {
      const hrefs = anchors.map((a) => a.href).filter(Boolean);
      const direct = anchors
        .filter((a) => /vota\s*ora/i.test(a.textContent || '') && a.href)
        .map((a) => a.href);

      const artistLinks = hrefs.filter((href) => href.includes('/artista/'));

      const pageLinks = hrefs.filter(
        (href) =>
          href.includes('vota-1mnext') &&
          (href.includes('/page/') || href.includes('paged='))
      );

      return {
        direct,
        artistLinks,
        pageLinks,
      };
    });

    [...direct, ...artistLinks].forEach((link) => bandLinks.add(link));
    pageLinks.forEach((link) => {
      if (!visited.has(link)) toVisit.push(link);
    });

    if (url === LIST_URL && context) {
      let nextPage = await page
        .locator('.e-load-more-anchor')
        .first()
        .getAttribute('data-next-page');

      const seenPages = new Set();
      while (nextPage && !seenPages.has(nextPage)) {
        seenPages.add(nextPage);

        const response = await context.request.get(nextPage);
        const html = await response.text();

        extractArtistLinksFromHtml(html).forEach((link) => bandLinks.add(link));

        const extractedNext = extractNextPageFromHtml(html);
        if (extractedNext && extractedNext !== nextPage) {
          nextPage = extractedNext;
        } else {
          nextPage = null;
        }
      }
    }
  }

  return Array.from(bandLinks);
}

async function scrapeBand(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(1500);

  let name = null;
  try {
    name = normalizeWhitespace(await page.locator('h1').first().innerText());
  } catch (err) {
    name = null;
  }

  let votes = null;
  try {
    const voteText = await page.locator('span.contest-vote-count').first().innerText();
    votes = Number(voteText.replace(/\D/g, '')) || null;
  } catch (err) {
    votes = null;
  }

  if (votes === null) {
    const bodyText = normalizeWhitespace(await page.locator('body').innerText());
    votes = parseVotesFromText(bodyText);
  }

  if (votes === null) {
    const possible = await page.$$eval('*', (nodes) => {
      return nodes
        .map((n) => (n.textContent || '').trim())
        .filter((t) => /vot/i.test(t));
    });
    for (const chunk of possible) {
      votes = parseVotesFromText(chunk);
      if (votes !== null) break;
    }
  }

  return {
    name: name || url.split('/').filter(Boolean).slice(-1)[0],
    url,
    votes,
  };
}

function renderHtml(rows, updatedAt) {
  const tableRows = rows
    .map(
      (row, index) => `
        <tr>
          <td>${index + 1}</td>
          <td><a href="${row.url}" target="_blank" rel="noreferrer">${row.name}</a></td>
          <td>${row.votes ?? 'N/A'}</td>
        </tr>`
    )
    .join('');

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Band Votes Leaderboard</title>
  <style>
    :root {
      --bg: #f4f1ec;
      --panel: #ffffff;
      --text: #1e1b16;
      --accent: #b34b2e;
      --muted: #6f665a;
    }
    body {
      margin: 0;
      font-family: "Georgia", "Times New Roman", serif;
      background: radial-gradient(circle at top, #fff6e9, #f4f1ec 60%);
      color: var(--text);
    }
    main {
      max-width: 900px;
      margin: 40px auto;
      padding: 24px;
    }
    h1 {
      margin: 0 0 12px;
      font-size: 2.4rem;
      letter-spacing: 0.02em;
    }
    p {
      margin: 0 0 20px;
      color: var(--muted);
    }
    table {
      width: 100%;
      border-collapse: collapse;
      background: var(--panel);
      box-shadow: 0 12px 30px rgba(0, 0, 0, 0.08);
      border-radius: 12px;
      overflow: hidden;
    }
    thead {
      background: var(--accent);
      color: #fff;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      font-size: 0.75rem;
    }
    th, td {
      padding: 14px 16px;
      text-align: left;
    }
    tbody tr:nth-child(odd) {
      background: #faf7f2;
    }
    tbody tr:hover {
      background: #f0e7dc;
    }
    a {
      color: var(--accent);
      text-decoration: none;
      font-weight: 600;
    }
    .footer {
      margin-top: 16px;
      font-size: 0.9rem;
      color: var(--muted);
    }
  </style>
</head>
<body>
  <main>
    <h1>Band Votes Leaderboard</h1>
    <p>Sorted by highest votes. Updated every 30 minutes.</p>
    <table>
      <thead>
        <tr>
          <th>Rank</th>
          <th>Band</th>
          <th>Votes</th>
        </tr>
      </thead>
      <tbody>
        ${tableRows}
      </tbody>
    </table>
    <div class="footer">Last updated: ${updatedAt} CET</div>
    <div class="footer">Next scheduled run window: ${nextRunWindowCET()}</div>
  </main>
</body>
</html>`;
}

function extractArtistLinksFromHtml(html) {
  const links = new Set();
  const regex = /href="([^"]*\/artista\/[^"]*)"/gi;
  let match;
  while ((match = regex.exec(html)) !== null) {
    const href = match[1];
    if (href.startsWith('http')) {
      links.add(href);
    } else if (href.startsWith('/')) {
      links.add(`https://musicstartup.it${href}`);
    }
  }
  return links;
}

function extractNextPageFromHtml(html) {
  const match = html.match(/data-next-page="([^"]+)"/i);
  return match ? match[1] : null;
}

async function main() {
  OUTPUT_DIRS.forEach((dir) => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  });

  console.log('Starting scrape job...');

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121 Safari/537.36',
  });
  context.setDefaultTimeout(60000);
  await context.route('**/*', (route) => {
    const type = route.request().resourceType();
    if (['image', 'media', 'font'].includes(type)) {
      return route.abort();
    }
    return route.continue();
  });

  const page = await context.newPage();

  const links = await collectBandLinks(page, context);
  if (!links.length) {
    console.error('No band links found on listing page.');
  }
  console.log(`Found ${links.length} artist links.`);

  const results = [];
  for (const url of links) {
    try {
      const bandPage = await context.newPage();
      const data = await scrapeBand(bandPage, url);
      await bandPage.close();
      results.push(data);
    } catch (err) {
      results.push({ name: url, url, votes: null, error: String(err) });
    }
  }

  await browser.close();

  const sorted = results
    .slice()
    .sort((a, b) => (b.votes ?? -1) - (a.votes ?? -1));

  const payload = {
    updatedAt: new Date().toISOString(),
    updatedAtCET: nowCET(),
    source: LIST_URL,
    results: sorted,
  };

  fs.writeFileSync(OUTPUT_JSON, JSON.stringify(payload, null, 2));
  const html = renderHtml(sorted, payload.updatedAtCET);
  fs.writeFileSync(OUTPUT_HTML, html);
  fs.writeFileSync(OUTPUT_INDEX, html);

  console.log(`Saved ${sorted.length} entries to ${OUTPUT_JSON}`);
  console.log(`Wrote leaderboard to ${OUTPUT_HTML}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
