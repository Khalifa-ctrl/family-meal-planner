// Price robot: searches Carrefour UAE and noon Minutes for every item in data/catalog.json
// and writes data/prices.json. Runs in GitHub Actions (workflow_dispatch) with Playwright.
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const catalog = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/catalog.json'), 'utf8'));
const OUT = path.join(ROOT, 'data/prices.json');
const LIMIT = process.env.LIMIT ? +process.env.LIMIT : Infinity; // for quick test runs
const ONLY = process.env.ONLY ? process.env.ONLY.split(',') : null;

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- unit parsing → price per base unit ----------
function parseSize(text) {
  const t = text.toLowerCase().replace(/,/g, '');
  let m;
  // "2 x 500g" / "6x1l"
  if ((m = t.match(/(\d+)\s*[x×]\s*(\d+(?:\.\d+)?)\s*(kg|g|ml|l|ltr|litre)\b/))) {
    const n = +m[1], v = +m[2], u = m[3];
    return normUnit(v * n, u);
  }
  if ((m = t.match(/(\d+(?:\.\d+)?)\s*(kg|g|gm|gr|ml|l|ltr|litre|liter)\b/))) return normUnit(+m[1], m[2]);
  if ((m = t.match(/(\d+)\s*(pcs|pieces|pc|eggs)\b/))) return { qty: +m[1], unit: 'pc' };
  return null;
}
function normUnit(v, u) {
  if (u === 'kg') return { qty: v, unit: 'kg' };
  if (u === 'g' || u === 'gm' || u === 'gr') return { qty: v / 1000, unit: 'kg' };
  if (u === 'l' || u === 'ltr' || u === 'litre' || u === 'liter') return { qty: v, unit: 'l' };
  if (u === 'ml') return { qty: v / 1000, unit: 'l' };
  return null;
}
function score(item, p) {
  const n = p.name.toLowerCase();
  if (item.must.length && !item.must.some((w) => n.includes(w))) return -1;
  if (item.ban.some((w) => n.includes(w))) return -1;
  if (item.need && !item.need.every((w) => n.includes(w))) return -1;
  if (item.any && !item.any.some((w) => n.includes(w))) return -1;
  let s = 1;
  item.prefer.forEach((w) => { if (n.includes(w)) s += 1; });
  if (p.oos) s -= 5;
  return s;
}
function enrich(item, p) {
  const size = parseSize(p.name + ' ' + (p.sizeText || ''));
  p.size = size;
  if (size && p.price != null && size.qty > 0) {
    p.unitPrice = +(p.price / size.qty).toFixed(2);
    p.unitLabel = size.unit === 'kg' ? 'د/كغ' : size.unit === 'l' ? 'د/لتر' : 'د/حبة';
  }
  p.score = score(item, p);
  return p;
}

// ---------- store scrapers (run inside the page) ----------
async function carrefour(page, q) {
  await page.goto(`https://www.carrefouruae.com/mafuae/en/search?keyword=${encodeURIComponent(q)}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  try { await page.waitForSelector('a[href*="/p/"]', { timeout: 20000 }); } catch (e) { return []; }
  await sleep(1500);
  return page.evaluate(() => {
    const out = [], seen = new Set();
    for (const a of document.querySelectorAll('a[href*="/p/"]')) {
      const name = (a.innerText || '').trim(); if (!name) continue;
      let c = a; for (let i = 0; i < 8 && c; i++) { if (/AED\s*[\d.]+/.test(c.innerText || '')) break; c = c.parentElement; }
      if (!c) continue;
      const t = (c.innerText || '').replace(/\s+/g, ' ');
      const m = t.match(/AED\s*([\d.,]+)/); const price = m ? parseFloat(m[1].replace(/,/g, '')) : null;
      if (price == null) continue;
      const key = name + price; if (seen.has(key)) continue; seen.add(key);
      const sizeText = (t.match(/(\d+(?:\.\d+)?\s?(?:kg|g|ml|l|pcs|pc|pack)\b(?:\s?[x×]\s?\d+)?)/i) || [])[1] || '';
      out.push({ name, price, sizeText, oos: /out of stock|sold out|notify/i.test(t), url: a.href.split('?')[0] });
    }
    return out.slice(0, 24);
  });
}
async function noon(page, q) {
  // noon Minutes renders search results server-side; parse the serialized product data
  const res = await fetch(`https://minutes.noon.com/uae-en/search/?q=${encodeURIComponent(q)}`, { headers: { 'user-agent': UA, 'accept-language': 'en-AE,en;q=0.9' } });
  const html = await res.text();
  const out = [], seen = new Set();
  const re = /offer_price:([\d.]+|null),[^{}]*?price:([\d.]+)[\s\S]{0,1500}?sizeInfo:"([^"]*)"[\s\S]{0,400}?sku:"([^"]+)"[\s\S]{0,300}?title:"([^"]+)"/g;
  let m;
  while ((m = re.exec(html))) {
    const sku = m[4]; if (seen.has(sku)) continue; seen.add(sku);
    const op = m[1] === 'null' ? null : +m[1]; const price = op && op < +m[2] ? op : +m[2];
    const seg = html.slice(m.index, m.index + 3000);
    const oos = /is_buyable:!1|isBuyable:!1|showBackInStockNotification:!0/.test(seg) && !/is_buyable:!0/.test(seg);
    out.push({ name: m[5].replace(/\\x3C.*?>/g, ''), price, sizeText: m[3].replace(/^Single x /i, ''), oos, url: 'https://minutes.noon.com/uae-en/now-product/' + sku + '/' });
  }
  return out.slice(0, 24);
}
async function noonLegacy(page, q) {
  await page.goto(`https://minutes.noon.com/uae-en/search/?q=${encodeURIComponent(q)}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(5000);
  return page.evaluate(() => {
    // product cards: find elements whose text ends with a price and contains a name line
    const out = [], seen = new Set();
    const nodes = [...document.querySelectorAll('div,li,article')].filter((el) => {
      const t = el.innerText || ''; return t.length < 220 && /\n\s*\d+(?:\.\d{2})\s*$/.test(t) && /\d+\s?(g|kg|ml|l|pcs|pc)\b/i.test(t);
    });
    for (const el of nodes) {
      if ([...el.children].some((ch) => nodes.includes(ch))) continue; // keep innermost
      const lines = (el.innerText || '').split('\n').map((x) => x.trim()).filter(Boolean);
      const price = parseFloat(lines[lines.length - 1]);
      const name = lines.filter((l) => /\d+\s?(g|kg|ml|l|pcs|pc)\b/i.test(l)).sort((a, b) => b.length - a.length)[0] || lines[0];
      if (!name || isNaN(price)) continue;
      const key = name + price; if (seen.has(key)) continue; seen.add(key);
      out.push({ name, price, sizeText: '', oos: /coming back|notify|sold out/i.test(el.innerText), url: 'https://minutes.noon.com/uae-en/search/?q=' + encodeURIComponent(name) });
    }
    return out.slice(0, 24);
  });
}
const STORES = { carrefour, noon };

(async () => {
  const browser = await chromium.launch({ args: ['--disable-http2'] });
  const ctx = await browser.newContext({ locale: 'en-AE', timezoneId: 'Asia/Dubai', viewport: { width: 1280, height: 900 },
    userAgent: UA });
  const page = await ctx.newPage();
  const prev = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : { items: {} };
  const result = { updatedAt: new Date().toISOString(), area: 'الرقايب، عجمان', stores: {}, items: prev.items || {}, errors: [] };
  for (const s of Object.keys(STORES)) result.stores[s] = { ok: 0, fail: 0 };

  let n = 0;
  for (const item of catalog.items) {
    if (ONLY && !ONLY.includes(item.key)) continue;
    if (n++ >= LIMIT) break;
    result.items[item.key] = result.items[item.key] || {};
    for (const [store, fn] of Object.entries(STORES)) {
      try {
        const raw = await fn(page, item.q);
        const list = raw.map((p) => enrich(item, p)).filter((p) => p.score > 0)
          .sort((a, b) => b.score - a.score || (a.unitPrice ?? a.price) - (b.unitPrice ?? b.price));
        if (!raw.length && result.items[item.key][store] && result.items[item.key][store].best) { console.log(`${item.key} @${store}: empty — keeping previous`); continue; }
        result.items[item.key][store] = { checked: result.updatedAt, found: raw.length, best: list[0] || null, alt: list.slice(1, 4) };
        result.stores[store].ok++;
        console.log(`${item.key} @${store}: ${raw.length} raw → ${list.length} ok → ${list[0] ? list[0].name + ' ' + list[0].price : '—'}`);
      } catch (e) {
        result.stores[store].fail++;
        result.errors.push(`${item.key}@${store}: ${e.message.slice(0, 120)}`);
        console.log(`${item.key} @${store}: ERROR ${e.message.slice(0, 100)}`);
      }
      await sleep(800);
    }
  }
  fs.writeFileSync(OUT, JSON.stringify(result, null, 1));
  await browser.close();
  console.log('done', result.stores);
})();
