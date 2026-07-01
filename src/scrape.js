const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const TARGET_URL =
  'https://us-store.msi.com/Motherboards/Intel-Platform-Motherboard/INTEL-Z890/MAG-Z890-TOMAHAWK-WIFI';

const OUTPUT_PATH = path.join(__dirname, '..', 'output', 'product.json');

// Runs inside the page. Pulls raw text/values from the DOM and the GTM dataLayer;
// all number/string normalization happens afterwards in Node.
function extractRawData() {
  const container = document.querySelector('.container-fluid.product-detail');

  const breadcrumbEl = document.querySelector('.breadcrumb');
  const breadcrumbItems = breadcrumbEl
    ? Array.from(breadcrumbEl.querySelectorAll('li')).map((li) => {
        const a = li.querySelector('a');
        return { name: li.textContent.trim(), url: a ? a.href : null };
      })
    : [];

  const titleEl = (container || document).querySelector('h2.title');
  const title = titleEl ? titleEl.textContent.trim() : null;

  const descEl = document.querySelector('.resellerKVContent__description p');
  const description = descEl ? descEl.textContent.trim().replace(/\s+/g, ' ') : null;

  const priceWrapper = document.getElementById('prices-wrapper');
  let newPriceText = null;
  let oldPriceText = null;
  let stockText = null;
  if (priceWrapper) {
    const newPriceEl = priceWrapper.querySelector('#prices-new');
    const oldPriceEl = priceWrapper.querySelector('#prices-old, .prices-old, .old-price, .price-old');
    newPriceText = newPriceEl ? newPriceEl.textContent.trim() : null;
    oldPriceText = oldPriceEl ? oldPriceEl.textContent.trim() : null;

    const stockEl = Array.from(priceWrapper.querySelectorAll('span')).find(
      (span) => span !== newPriceEl && span !== oldPriceEl && span.textContent.trim().length > 0
    );
    stockText = stockEl ? stockEl.textContent.trim() : null;
  }

  const mainImageEl = document.getElementById('imagePopup');
  const mainImageUrl = mainImageEl ? mainImageEl.src : null;
  const thumbUrls = Array.from(document.querySelectorAll('img.product-detail-thumb-bto')).map(
    (img) => img.src
  );

  const specs = [];
  if (container) {
    container.querySelectorAll('table.table-borderless tr').forEach((tr) => {
      const th = tr.querySelector('th');
      const td = tr.querySelector('td');
      if (th) {
        const name = th.textContent.trim();
        const value = td ? td.innerText.trim() : '';
        if (name) specs.push({ name, value: value || null });
      }
    });
  }

  const ratingLink = document.getElementById('average-rating-link');
  const ratingText = ratingLink ? ratingLink.textContent.trim() : null;

  let dataLayerItemId = null;
  if (Array.isArray(window.dataLayer)) {
    const viewItemEvent = window.dataLayer.find((entry) => entry && entry[1] === 'view_item');
    const item = viewItemEvent && viewItemEvent[2] && viewItemEvent[2].items && viewItemEvent[2].items[0];
    dataLayerItemId = item ? item.id : null;
  }
  const productIdInput = document.querySelector('input[name="product_id"]');
  const fallbackItemId = productIdInput ? productIdInput.value : null;

  const brand = /msi/i.test(document.title) ? 'MSI' : null;

  return {
    title,
    brand,
    description,
    breadcrumbItems,
    newPriceText,
    oldPriceText,
    stockText,
    mainImageUrl,
    thumbUrls,
    specs,
    ratingText,
    itemId: dataLayerItemId || fallbackItemId || null,
  };
}

function parsePrice(text) {
  if (!text) return null;
  const cleaned = text.replace(/[^0-9.]/g, '');
  const value = parseFloat(cleaned);
  return Number.isFinite(value) ? value : null;
}

function normalizeAvailability(text) {
  if (!text) return null;
  const normalized = text.toLowerCase();
  if (normalized.includes('out of stock') || normalized.includes('sold out')) return 'out_of_stock';
  if (normalized.includes('pre-order') || normalized.includes('preorder') || normalized.includes('pre order'))
    return 'pre_order';
  if (normalized.includes('in stock') || normalized.includes('available')) return 'in_stock';
  return null;
}

function parseRatingText(text) {
  if (!text) return { starRating: null, reviewCount: null };
  const match = text.match(/([\d.]+)\s*\(([\d,]+)\)/);
  if (!match) return { starRating: null, reviewCount: null };
  const starRating = parseFloat(match[1]);
  const reviewCount = parseInt(match[2].replace(/,/g, ''), 10);
  return {
    starRating: Number.isFinite(starRating) ? starRating : null,
    reviewCount: Number.isFinite(reviewCount) ? reviewCount : null,
  };
}

// Thumbnails are named "<sku>-<index>-400x400.png"; the main image is
// "<sku>-<index>-1024x1024.png". Same index means same photo at a different size.
function getImageIndex(url) {
  const match = url.match(/-(\d+)-\d+x\d+\.\w+(?:\?.*)?$/);
  return match ? match[1] : null;
}

function buildCategoryTree(breadcrumbItems) {
  return breadcrumbItems.filter((item, index) => {
    const isHome = index === 0 && item.name.trim().toLowerCase() === 'home';
    const isCurrentPage = index === breadcrumbItems.length - 1;
    return !isHome && !isCurrentPage;
  });
}

function normalizeProduct(finalUrl, raw) {
  const categoryTree = buildCategoryTree(raw.breadcrumbItems).map((item) => ({
    name: item.name,
    url: item.url || null,
  }));

  const regularPriceText = raw.oldPriceText || raw.newPriceText;
  const salePriceText = raw.oldPriceText ? raw.newPriceText : null;

  const mainIndex = raw.mainImageUrl ? getImageIndex(raw.mainImageUrl) : null;
  const additionalImageUrls = [...new Set(raw.thumbUrls)].filter(
    (url) => getImageIndex(url) !== mainIndex
  );

  const specs = raw.specs.map((spec) => ({
    name: spec.name,
    value: spec.value ? spec.value.split('\n').map((line) => line.trim()).filter(Boolean).join(' | ') : null,
  }));

  const mpnSpec = specs.find((spec) => /manufacturer number/i.test(spec.name));
  const { starRating, reviewCount } = parseRatingText(raw.ratingText);

  return {
    url: finalUrl,
    item_id: raw.itemId || null,
    title: raw.title || null,
    brand: raw.brand || null,
    product_category: categoryTree.length ? categoryTree.map((item) => item.name).join(' > ') : null,
    category_tree: categoryTree,
    description: raw.description || null,
    price: parsePrice(regularPriceText),
    sale_price: parsePrice(salePriceText),
    availability: normalizeAvailability(raw.stockText),
    image_url: raw.mainImageUrl || null,
    additional_image_urls: additionalImageUrls,
    specs,
    star_rating: starRating,
    review_count: reviewCount,
    gtin: null,
    mpn: mpnSpec ? mpnSpec.value : null,
    scraped_at: new Date().toISOString(),
  };
}

// The site's WAF (Akamai) 403s any request whose User-Agent/sec-ch-ua identifies
// as "HeadlessChrome" (Chromium's default headless fingerprint). We find out what
// the browser would send by default, strip the "Headless" marker, and use that as
// the override — this stays correct across Chromium version bumps instead of
// hardcoding a version number.
async function getDeHeadlessedHeaders(browser, url) {
  const probeContext = await browser.newContext();
  const probePage = await probeContext.newPage();
  let defaultHeaders = {};
  probePage.on('request', (request) => {
    if (Object.keys(defaultHeaders).length === 0) defaultHeaders = request.headers();
  });
  await probePage.goto(url, { waitUntil: 'commit', timeout: 15000 }).catch(() => {});
  await probeContext.close();

  const userAgent = (defaultHeaders['user-agent'] || '').replace('HeadlessChrome', 'Chrome');
  const secChUa = defaultHeaders['sec-ch-ua']
    ? defaultHeaders['sec-ch-ua'].replace(/"HeadlessChrome";v="\d+",\s*/, '')
    : null;
  return { userAgent, secChUa };
}

async function scrape() {
  const browser = await chromium.launch({ headless: true });
  try {
    const { userAgent, secChUa } = await getDeHeadlessedHeaders(browser, TARGET_URL);
    const context = await browser.newContext({ userAgent });
    if (secChUa) await context.setExtraHTTPHeaders({ 'sec-ch-ua': secChUa });
    const page = await context.newPage();
    await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForSelector('.container-fluid.product-detail h2.title', { timeout: 20000 });
    // Rating widget loads via a delayed async fetch; wait for it but don't fail
    // the whole scrape if a product genuinely has no reviews yet.
    await page.waitForSelector('#average-rating-link', { timeout: 8000 }).catch(() => {});

    const raw = await page.evaluate(extractRawData);
    const product = normalizeProduct(page.url(), raw);

    fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
    fs.writeFileSync(OUTPUT_PATH, JSON.stringify(product, null, 2));
    console.log(`Saved product data to ${OUTPUT_PATH}`);
  } finally {
    await browser.close();
  }
}

scrape().catch((error) => {
  console.error('Scrape failed:', error.message);
  process.exit(1);
});
