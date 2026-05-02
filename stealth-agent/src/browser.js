'use strict';

const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const logger = require('./logger');

// Apply stealth once at module load time
chromium.use(StealthPlugin());

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
];

/**
 * createBrowser
 * Returns { browser, context, page } with full stealth configuration.
 */
async function createBrowser({ headless = false, proxy = null } = {}) {
  const launchArgs = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-blink-features=AutomationControlled',
    '--disable-features=IsolateOrigins,site-per-process',
    '--disable-infobars',
    '--window-size=1400,900',
    '--lang=en-US',
  ];

  const launchOptions = { headless, args: launchArgs };
  if (proxy) launchOptions.proxy = { server: proxy };

  const browser = await chromium.launch(launchOptions);

  const ua = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];

  const context = await browser.newContext({
    userAgent : ua,
    viewport  : {
      width  : 1280 + Math.floor(Math.random() * 120),
      height : 800  + Math.floor(Math.random() * 80),
    },
    locale        : 'en-US',
    timezoneId    : 'America/New_York',
    colorScheme   : 'light',
    deviceScaleFactor: 1,
    extraHTTPHeaders: {
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept-Encoding': 'gzip, deflate, br',
    },
  });

  // Evasion scripts injected before every page load
  await context.addInitScript(() => {
    // 1. Mask webdriver flag
    Object.defineProperty(navigator, 'webdriver', { get: () => false });

    // 2. Spoof plugins list (empty => bot; populate it)
    Object.defineProperty(navigator, 'plugins', {
      get: () => {
        const arr = [{ name: 'Chrome PDF Plugin' }, { name: 'Chrome PDF Viewer' }];
        arr.length = 2;
        return arr;
      },
    });

    // 3. Languages
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });

    // 4. Remove CDP artefacts
    ['cdc_adoQpoasnfa76pfcZLmcfl_Array',
     'cdc_adoQpoasnfa76pfcZLmcfl_Promise',
     'cdc_adoQpoasnfa76pfcZLmcfl_Symbol',
    ].forEach(k => { try { delete window[k]; } catch (_) {} });

    // 5. Override permission query to not reveal headless
    const origQuery = window.navigator.permissions.query;
    window.navigator.permissions.query = (params) =>
      params.name === 'notifications'
        ? Promise.resolve({ state: Notification.permission })
        : origQuery(params);

    // 6. Realistic chrome object
    if (!window.chrome) {
      window.chrome = { runtime: {}, loadTimes: () => {}, csi: () => {} };
    }
  });

  const page = await context.newPage();

  // Intercept any bot-check JS that looks at Playwright identifiers
  await page.route('**/*', async (route) => {
    const headers = route.request().headers();
    delete headers['x-playwright'];
    try {
      await route.continue({ headers });
    } catch (_) {
      await route.continue();
    }
  });

  logger.info('Browser launched', { ua: ua.substring(0, 60) });
  return { browser, context, page };
}

async function closeBrowser(browser) {
  if (browser) {
    try { await browser.close(); } catch (_) {}
    logger.info('Browser closed');
  }
}

module.exports = { createBrowser, closeBrowser };
