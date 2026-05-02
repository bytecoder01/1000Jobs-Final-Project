'use strict';

const fs          = require('fs');
const path        = require('path');
const logger      = require('./logger');
const mouse       = require('./mouseHelper');
const { answerAllQuestions } = require('./llmHandler');

// ── Selector maps for standard Lever fields ───────────────────────────────────

const SELECTORS = {
  name: [
    'input[name="name"]',
    '#name',
    'input[id*="name"]',
    'input[placeholder*="full name" i]',
    'input[placeholder*="your name" i]',
  ],
  email: [
    'input[name="email"]',
    '#email',
    'input[type="email"]',
    'input[placeholder*="email" i]',
  ],
  phone: [
    'input[name="phone"]',
    '#phone',
    'input[type="tel"]',
    'input[placeholder*="phone" i]',
  ],
  org: [
    'input[name="org"]',
    '#org',
    'input[placeholder*="current company" i]',
    'input[placeholder*="company" i]',
  ],
  currentCompanyUrl: [
    'input[name="current_company_url"]',
    'input[name="company_url"]',
    'input[placeholder*="company website" i]',
    'input[placeholder*="company url" i]',
  ],
  currentLocation: [
    'input[name="current_location"]',
    'input[id*="current_location"]',
    'input[placeholder*="current location" i]',
    'input[placeholder*="location" i]',
  ],
  linkedin: [
    'input[name="urls[LinkedIn]"]',
    'input[name="urls[linkedin]"]',
    'input[placeholder*="linkedin" i]',
    'input[data-qa*="linkedin" i]',
  ],
  portfolio: [
    'input[name="urls[Portfolio]"]',
    'input[name="urls[portfolio]"]',
    'input[placeholder*="portfolio" i]',
    'input[placeholder*="portfolio site" i]',
  ],
  github: [
    'input[name="urls[GitHub]"]',
    'input[name="urls[github]"]',
    'input[placeholder*="github" i]',
  ],
  twitter: [
    'input[name="urls[Twitter]"]',
    'input[placeholder*="twitter" i]',
  ],
  website: [
    'input[name="urls[Portfolio]"]',
    'input[name="urls[Website]"]',
    'input[placeholder*="portfolio" i]',
    'input[placeholder*="website" i]',
    'input[placeholder*="personal site" i]',
  ],
  otherWebsite: [
    'input[name="urls[Other]"]',
    'input[name="urls[other]"]',
    'input[placeholder*="other website" i]',
    'input[placeholder*="additional website" i]',
  ],
  pronouns: [
    'input[name="pronouns"]',
    'input[type="checkbox"][name="pronouns"]',
    '#candidatePronounsCheckboxes input[type="checkbox"]',
  ],
  location: [
    'input[name="location"]',
    'input[id="location-input"]',
    'input.location-input',
    'input[data-qa="location-input"]',
    'input[name="current_location"]',
    'input[placeholder*="current location" i]',
  ],
  opportunityLocation: [
    'select[name="opportunityLocationId"]',
    'select.opportunity-location',
    'select[data-qa="opportunity-location-select"]',
  ],
  comments: [
    'textarea[name="comments"]',
    '#comments',
    'textarea[placeholder*="cover letter" i]',
    'textarea[placeholder*="anything else" i]',
    'textarea[placeholder*="additional" i]',
  ],
};

// Names of standard fields — used to exclude them when scanning for custom questions
const STANDARD_FIELD_NAMES = new Set([
  'name', 'email', 'phone', 'org', 'current_location', 'location',
  'opportunityLocationId',
  // pronouns intentionally NOT listed here — handled by fillPronouns() when
  // applicantData.pronouns is supplied; otherwise collected for LLM
  'urls[LinkedIn]', 'urls[linkedin]',
  'urls[GitHub]',  'urls[github]',
  'urls[Portfolio]', 'urls[portfolio]',
  'urls[Twitter]', 'urls[twitter]',
  'urls[Website]', 'urls[Other]', 'urls[other]',
  'urls[Referral ]', 'urls[Referral]',
  'current_company', 'current_company_url',
  'comments',
  'selectedLocation', // Hidden location field
]);

// ── Helper utilities ──────────────────────────────────────────────────────────

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function rand(lo, hi) {
  return lo + Math.random() * (hi - lo);
}

/** Try each selector in order; return the first visible, on-screen element. */
async function findElement(page, selectors) {
  for (const sel of selectors) {
    try {
      const el = await page.$(sel);
      if (!el) continue;
      if (!(await el.isVisible())) continue;
      const box = await el.boundingBox();
      if (box && box.width > 0 && box.height > 0) return el;
    } catch (_) {
      // try next selector
    }
  }
  return null;
}

/**
 * Detect whether an element is a honeypot:
 *  - zero-size bounding box
 *  - off-screen position
 *  - CSS hidden / invisible
 */
async function isHoneypot(page, element) {
  try {
    const box = await element.boundingBox();
    if (!box || box.width === 0 || box.height === 0)   return true;
    if (box.x < -50 || box.y < -50)                    return true;
    if (!(await element.isVisible()))                   return true;

    const css = await page.evaluate(el => {
      const s = window.getComputedStyle(el);
      return {
        display    : s.display,
        visibility : s.visibility,
        opacity    : parseFloat(s.opacity),
        left       : parseInt(s.left,  10),
        top        : parseInt(s.top,   10),
        position   : s.position,
      };
    }, element);

    if (css.display    === 'none')    return true;
    if (css.visibility === 'hidden')  return true;
    if (css.opacity    === 0)         return true;
    if (css.position   === 'absolute' &&
        (css.left < -200 || css.top < -200)) return true;

    return false;
  } catch (_) {
    return true; // treat errors as honeypot
  }
}

/**
 * Scroll an element into view with a realistic pause,
 * then fill it with human-like typing.
 */
async function fillField(page, element, value) {
  if (!value || !element) return;
  if (await isHoneypot(page, element)) {
    logger.warn('[FORM] Honeypot detected — skipping field');
    return;
  }

  await element.scrollIntoViewIfNeeded();
  await sleep(rand(200, 500));

  await mouse.humanClear(page, element);
  await sleep(rand(80, 180));
  await mouse.humanType(page, element, value);

  logger.info('[FORM] Field filled', { preview: String(value).substring(0, 40) });
}

/**
 * After typing into location-style inputs, try to pick the closest
 * autocomplete suggestion that appears.
 */
async function chooseAutocompleteSuggestion(page, element, typedValue) {
  if (!element) return false;
  const selectors = [
    'li[role="option"]', 'div[role="option"]', '.pac-item',
    '.autocomplete-suggestion', '.suggestion-item', '.combobox-option',
    '.tt-suggestion', '.suggestions li'
  ];

  for (let attempt = 0; attempt < 20; attempt++) {
    const picked = await page.evaluate((el, sels, val) => {
      for (const s of sels) {
        const nodes = Array.from(document.querySelectorAll(s)).filter(n => n.offsetParent !== null);
        if (nodes.length > 0) {
          // prefer items that start with the typed value, else containing it, else first
          let best = nodes[0];
          for (const n of nodes) {
            const txt = (n.innerText || n.textContent || '').trim();
            if (!txt) continue;
            if (txt.toLowerCase().startsWith(val.toLowerCase())) { best = n; break; }
            if (txt.toLowerCase().includes(val.toLowerCase())) best = n;
          }
          try { best.click(); } catch (_) { /* ignore */ }
          return true;
        }
      }
      return false;
    }, element, selectors, typedValue || '');

    if (picked) return true;
    await sleep(100);
  }
  return false;
}

// ── Navigation ────────────────────────────────────────────────────────────────

/**
 * Land on the Lever application form.
 * Tries the direct /apply URL first; falls back to clicking the Apply button.
 */
async function navigateToApplyPage(page, jobUrl) {
  const applyUrl = jobUrl.replace(/\/$/, '').endsWith('/apply')
    ? jobUrl
    : `${jobUrl.replace(/\/$/, '')}/apply`;

  logger.info('[NAV] Navigating to apply URL', { url: applyUrl });

  await page.goto(applyUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await sleep(rand(1500, 2500));

  // Verify we're on a form page; if not, try to click Apply button
  const onForm = await page.$('input[name="name"], input[name="email"]');
  if (!onForm) {
    logger.info('[NAV] Form not found — looking for Apply button');
    await page.goto(jobUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await sleep(rand(1000, 2000));

    const applyBtn =
      await page.$('.postings-btn')                  ||
      await page.$('a[href*="/apply"]')              ||
      await page.$('button:has-text("Apply")')       ||
      await page.$('a:has-text("Apply for this")')   ||
      await page.$('a:has-text("Apply now")')        ;

    if (applyBtn) {
      logger.info('[NAV] Clicking Apply button');
      await mouse.humanClick(page, applyBtn);
      await page.waitForLoadState('domcontentloaded');
      await sleep(rand(1500, 2500));
    } else {
      throw new Error('Could not find the application form or Apply button');
    }
  }

  // Check for CAPTCHA / bot-wall
  const captcha =
    await page.$('iframe[src*="recaptcha"]') ||
    await page.$('iframe[src*="hcaptcha"]')  ||
    await page.$('[class*="captcha"]');
  if (captcha) {
    logger.warn('[NAV] CAPTCHA detected — manual intervention may be required');
  }

  logger.info('[NAV] Application form page reached');
}

// ── Resume upload ─────────────────────────────────────────────────────────────

async function uploadResume(page, resumePath) {
  if (!resumePath) return false;

  const abs = path.resolve(resumePath);
  if (!fs.existsSync(abs)) throw new Error(`Resume not found: ${abs}`);

  const fileInput = await page.$('input[type="file"]');
  if (!fileInput) {
    logger.warn('[FORM] No file input found — skipping resume upload');
    return false;
  }

  logger.info('[FORM] Uploading resume', { path: abs });
  await fileInput.setInputFiles(abs);
  await sleep(rand(2000, 3500));          // wait for upload processing

  // Try to confirm upload was accepted
  const confirmed =
    await page.$('.resume-name')                    ||
    await page.$('[class*="filename"]')             ||
    await page.$('[class*="upload-success"]')       ||
    await page.$('[class*="file-uploaded"]');

  logger.info('[FORM] Resume upload ' + (confirmed ? 'confirmed' : 'attempted'));
  return true;
}

// ── Custom question detection + LLM answering ─────────────────────────────────

/**
 * Scrape the label text associated with a form element.
 * Works for <label for="id">, ancestor <label>, and sibling/parent text nodes.
 */
async function getLabelText(page, element) {
  return page.evaluate(el => {
    const textFrom = node => (node && node.innerText ? node.innerText.trim() : '');

    // Lever: question text is stored in .application-label or .text
    const appQuestion = el.closest('.application-question');
    if (appQuestion) {
      const lbl =
        appQuestion.querySelector('.application-label .text') ||
        appQuestion.querySelector('.application-label');
      const text = textFrom(lbl);
      if (text) return text;
    }

    // <label for="...">
    if (el.id) {
      const lbl = document.querySelector(`label[for="${el.id}"]`);
      if (lbl) return lbl.innerText.trim();
    }

    // aria-label / aria-labelledby
    const ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel && ariaLabel.trim()) return ariaLabel.trim();
    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const ids = labelledBy.split(/\s+/).filter(Boolean);
      const combined = ids
        .map(id => textFrom(document.getElementById(id)))
        .filter(Boolean)
        .join(' ')
        .trim();
      if (combined) return combined;
    }
    // Placeholder as last resort
    return el.placeholder || null;
  }, element);
}

async function getOptionLabelText(page, element) {
  return page.evaluate(el => {
    const textFrom = node => (node && node.innerText ? node.innerText.trim() : '');
    const parentLabel = el.closest('label');
    if (parentLabel) {
      const alt = parentLabel.querySelector('.application-answer-alternative');
      const altText = textFrom(alt);
      if (altText) return altText;
      const labelText = textFrom(parentLabel);
      if (labelText) return labelText;
    }
    return (el.getAttribute('aria-label') || el.value || el.name || '').trim();
  }, element);
}

async function getGroupQuestionText(page, element) {
  return page.evaluate(el => {
    const textFrom = node => (node && node.innerText ? node.innerText.trim() : '');
    const appQuestion = el.closest('.application-question');
    if (appQuestion) {
      const lbl =
        appQuestion.querySelector('.application-label .text') ||
        appQuestion.querySelector('.application-label');
      const text = textFrom(lbl);
      if (text) return text;
    }

    return null;
  }, element);
}

function cleanQuestionText(text) {
  if (!text) return text;
  return text.replace(/\s*[✱*]+\s*$/g, '').trim();
}

/**
 * Detect if a string is generic placeholder text (not a real question)
 */
function isPlaceholderText(text) {
  if (!text) return true;
  const normalized = text.toLowerCase().trim();
  const placeholders = [
    'type your response',
    'type here',
    'enter text',
    'type text',
    'your text here',
    'enter your response',
    'write here',
    'your answer',
    'please enter',
    'input text',
    'type something',
    'enter something',
    'describe here',
    'answer here',
  ];
  return placeholders.some(ph => normalized.includes(ph));
}

/**
 * collectCustomQuestions
 * ──────────────────────
 * Scan page for all custom questions WITHOUT making LLM call.
 * Returns structured data ready for LLM processing.
 * 
 * @returns {Promise<object>} - { allFieldData, fieldOperations }
 */
async function collectCustomQuestions(page) {
  logger.info('[FORM] Scanning for ALL custom questions (collecting only, no LLM call yet)…');
  
  const allFieldData = {
    textareas: [],
    inputs: [],
    selects: [],
    checkboxes: [],
    radios: []
  };
  
  const fieldOperations = [];
  let qId = 1;

  // ── Collect textareas ─────────────────────────────────────────────────────
  const textareas = await page.$$('textarea');
  for (const ta of textareas) {
    if (await isHoneypot(page, ta)) continue;
    const name = await ta.getAttribute('name') || '';
    if (name === 'comments') continue;

    let question = await getLabelText(page, ta);
    question = cleanQuestionText(question);
    if (!question || question.length < 8) continue;
    if (isPlaceholderText(question)) continue;

    const currId = `q${qId++}`;
    allFieldData.textareas.push({
      id: currId,
      question: question
    });
    fieldOperations.push({
      id: currId,
      type: 'textarea',
      el: ta,
      question: question
    });
  }

  // ── Collect text inputs ───────────────────────────────────────────────────
  const inputs = await page.$$('input[type="text"], input:not([type])');
  for (const inp of inputs) {
    if (await isHoneypot(page, inp)) continue;
    const name = await inp.getAttribute('name') || '';
    if (STANDARD_FIELD_NAMES.has(name) || name.startsWith('urls[')) continue;

    const currentVal = await inp.inputValue().catch(() => '');
    if (currentVal.length > 0) continue;

    let question = await getLabelText(page, inp);
    question = cleanQuestionText(question);
    if (!question || question.length < 8) continue;
    if (isPlaceholderText(question)) continue;

    const ph = (await inp.getAttribute('placeholder') || '').toLowerCase();
    if (ph.includes('url') || ph.includes('http') || ph.includes('www')) continue;

    const currId = `q${qId++}`;
    allFieldData.inputs.push({
      id: currId,
      question: question
    });
    fieldOperations.push({
      id: currId,
      type: 'input',
      el: inp,
      question: question
    });
  }

  // ── Collect selects ──────────────────────────────────────────────────────
  const selects = await page.$$('select');
  for (const sel of selects) {
    if (await isHoneypot(page, sel)) continue;
    const name = await sel.getAttribute('name') || '';
    // Skip standard/hidden/urls fields, but allow opportunityLocationId through
    // so the LLM can answer "Which location are you applying for?" if not pre-supplied
    if (STANDARD_FIELD_NAMES.has(name) && name !== 'opportunityLocationId') continue;
    // Skip opportunityLocationId only when it has already been filled
    if (name === 'opportunityLocationId') {
      const currentVal = await sel.evaluate(el => el.value);
      if (currentVal) continue; // already selected, skip
    }

    let question = await getLabelText(page, sel) || name;
    question = cleanQuestionText(question);
    if (!question || question.length < 3) continue;
    if (isPlaceholderText(question)) continue;

    const optionsData = await page.evaluate(el => {
      return Array.from(el.options).map(o => ({ text: o.text, value: o.value }));
    }, sel);

    const currId = `q${qId++}`;
    allFieldData.selects.push({
      id: currId,
      question: question,
      options: optionsData.map(o => o.text).filter(Boolean)
    });
    fieldOperations.push({
      id: currId,
      type: 'select',
      el: sel,
      question: question,
      optionsData: optionsData
    });
  }

  // ── Collect checkboxes ────────────────────────────────────────────────────
  const checkboxes = await page.$$('input[type="checkbox"]');
  const checkboxGroups = {};
  for (const box of checkboxes) {
    if (await isHoneypot(page, box)) continue;
    const groupName = (await box.getAttribute('name')) || '';
    if (!groupName) continue;

    if (!checkboxGroups[groupName]) {
      checkboxGroups[groupName] = [];
    }
    checkboxGroups[groupName].push(box);
  }

  for (const [groupName, boxes] of Object.entries(checkboxGroups)) {
    if (STANDARD_FIELD_NAMES.has(groupName)) continue;

    let question = '';
    if (boxes.length === 1) {
      question = await getOptionLabelText(page, boxes[0]);
    } else {
      question = await getGroupQuestionText(page, boxes[0]);
    }
    question = cleanQuestionText(question);
    if (isPlaceholderText(question)) continue;

    const isSingleCheckbox = boxes.length === 1;
    const currId = `q${qId++}`;
    const boxTexts = [];
    for (const box of boxes) {
      boxTexts.push(await getOptionLabelText(page, box));
    }

    allFieldData.checkboxes.push({
      id: currId,
      question: question,
      options: boxTexts,
      single: isSingleCheckbox
    });
    fieldOperations.push({
      id: currId,
      type: isSingleCheckbox ? 'checkbox_single' : 'checkbox_multi',
      el: boxes[0],
      question: question,
      boxArr: boxes.map((b, i) => ({ el: b, text: boxTexts[i] || '' }))
    });
  }

  // ── Collect radios ────────────────────────────────────────────────────────
  const radios = await page.$$('input[type="radio"]');
  const radioGroups = {};
  for (const radio of radios) {
    if (await isHoneypot(page, radio)) continue;
    const groupName = (await radio.getAttribute('name')) || '';
    if (!groupName) continue;

    if (!radioGroups[groupName]) {
      radioGroups[groupName] = [];
    }
    radioGroups[groupName].push(radio);
  }

  for (const [groupName, radios] of Object.entries(radioGroups)) {
    if (STANDARD_FIELD_NAMES.has(groupName)) continue;

    let question = await getGroupQuestionText(page, radios[0]);
    question = cleanQuestionText(question);
    if (isPlaceholderText(question)) continue;

    const currId = `q${qId++}`;
    const radioTexts = [];
    for (const radio of radios) {
      radioTexts.push(await getOptionLabelText(page, radio));
    }

    allFieldData.radios.push({
      id: currId,
      question: question,
      options: radioTexts
    });
    fieldOperations.push({
      id: currId,
      type: 'radio',
      el: radios[0],
      question: question,
      radios: radios.map((r, i) => ({ el: r, text: radioTexts[i] || '' }))
    });
  }

  logger.info('[FORM] Custom questions collected', {
    textareas: allFieldData.textareas.length,
    inputs: allFieldData.inputs.length,
    selects: allFieldData.selects.length,
    checkboxes: allFieldData.checkboxes.length,
    radios: allFieldData.radios.length,
    total: fieldOperations.length,
  });

  return { allFieldData, fieldOperations };
}

/**
 * fillCustomQuestionsWithAnswers
 * ──────────────────────────────
 * Fill custom questions with provided LLM answers.
 * Used after LLM returns results.
 *
 * @param {object} page            - Playwright page object
 * @param {array}  fieldOperations - From collectCustomQuestions()
 * @param {object} llmAnswers      - LLM results mapping question IDs to answers
 * @returns {Promise<array>}       - Array of filled question info
 */
async function fillCustomQuestionsWithAnswers(page, fieldOperations, llmAnswers) {
  logger.info('[FORM] Filling custom questions with LLM answers…', { count: fieldOperations.length });
  const answered = [];

  if (!fieldOperations || fieldOperations.length === 0) {
    logger.info('[FORM] No custom questions to fill');
    return answered;
  }

  // ── Apply all answers to the form ────────────────────────────────────────
  for (const op of fieldOperations) {
    const ans = llmAnswers[op.id];
    if (ans === null || ans === undefined || ans === '' || (Array.isArray(ans) && ans.length === 0)) {
      continue; // Skip empty/null answers
    }

    try {
      if (op.type === 'textarea') {
        await op.el.scrollIntoViewIfNeeded();
        await sleep(rand(200, 400));
        await mouse.humanType(page, op.el, ans);
        await sleep(rand(200, 400));
        logger.info('[FORM] Textarea filled', { question: op.question });
        answered.push({ type: 'textarea', question: op.question });
      } 
      else if (op.type === 'input') {
        const trimmed = ans.length > 120 ? ans.substring(0, 117) + '…' : ans;
        await op.el.scrollIntoViewIfNeeded();
        await sleep(rand(200, 400));
        await mouse.humanType(page, op.el, trimmed);
        await sleep(rand(200, 400));
        logger.info('[FORM] Input filled', { question: op.question });
        answered.push({ type: 'input', question: op.question });
      } 
      else if (op.type === 'select') {
        const ansNorm = (ans || '').trim().toLowerCase();
        // exact match first, then fuzzy includes
        let matched = op.optionsData.find(o => o.text.trim().toLowerCase() === ansNorm);
        if (!matched) {
          matched = op.optionsData.find(o => {
            const t = o.text.trim().toLowerCase();
            return t.includes(ansNorm) || ansNorm.includes(t);
          });
        }
        if (matched && matched.value) {
          await op.el.scrollIntoViewIfNeeded();
          await page.evaluate(([el, val]) => {
            el.value = val;
            el.dispatchEvent(new Event('change', { bubbles: true }));
          }, [op.el, matched.value]);
          logger.info('[FORM] Dropdown selected', { question: op.question, ans });
          answered.push({ type: 'select', question: op.question });
        } else {
          logger.warn('[FORM] Select answer not matched', { question: op.question, ans, options: op.optionsData.map(o => o.text) });
        }
      } 
      else if (op.type === 'checkbox_single') {
        if (ans === "YES") {
          const isChecked = await op.boxArr[0].el.isChecked();
          if (!isChecked) {
            await op.boxArr[0].el.click();
            await sleep(rand(100, 200));
          }
        }
      } 
      else if (op.type === 'checkbox_multi') {
        const choices = Array.isArray(ans) ? ans : [ans];
        const chosenSet = new Set(choices.map(c => c.trim().toLowerCase()));
        for (const box of op.boxArr) {
          const boxTextNorm = (box.text || '').trim().toLowerCase();
          const shouldCheck = chosenSet.has(boxTextNorm) ||
            [...chosenSet].some(c => boxTextNorm.includes(c) || c.includes(boxTextNorm));
          if (shouldCheck) {
            const isChecked = await box.el.isChecked();
            if (!isChecked) {
              await box.el.scrollIntoViewIfNeeded();
              await box.el.click();
              await sleep(rand(100, 200));
            }
          }
        }
        logger.info('[FORM] Checkboxes selected', { question: op.question, ans });
        answered.push({ type: 'checkbox', question: op.question });
      } 
      else if (op.type === 'radio') {
        const ansNorm = (ans || '').trim().toLowerCase();
        // exact match first, then includes-based fallback
        let targetRadio = op.radios.find(r => r.text.trim().toLowerCase() === ansNorm);
        if (!targetRadio) {
          targetRadio = op.radios.find(r => {
            const t = r.text.trim().toLowerCase();
            return t.includes(ansNorm) || ansNorm.includes(t);
          });
        }
        if (targetRadio) {
          await targetRadio.el.scrollIntoViewIfNeeded();
          await targetRadio.el.click();
          await sleep(rand(100, 200));
          logger.info('[FORM] Radio button selected', { question: op.question, ans });
          answered.push({ type: 'radio', question: op.question });
        } else {
          logger.warn('[FORM] Radio answer not matched to any option', { question: op.question, ans, options: op.radios.map(r => r.text) });
        }
      }
    } catch (e) {
      logger.error(`[FORM] Error applying answer for ${op.type}`, { error: e.message, id: op.id });
    }
  }

  logger.info('[FORM] LLM answers applied', { answered: answered.length });
  return answered;
}

/**
 * Fill pronouns checkboxes based on applicant data.
 * Supports standard pronouns like "They/them", "She/her", etc.
 */
async function fillPronouns(page, pronouns) {
  if (!pronouns) return false;
  
  try {
    const pronounsArray = Array.isArray(pronouns) ? pronouns : [pronouns];
    
    for (const pronoun of pronounsArray) {
      // Find checkbox by value matching the pronoun
      const checkbox = await page.$(`input[type="checkbox"][name="pronouns"][value="${pronoun}"]`);
      if (checkbox) {
        const isChecked = await checkbox.isChecked();
        if (!isChecked) {
          await checkbox.scrollIntoViewIfNeeded();
          await sleep(rand(100, 300));
          await checkbox.click();
          await sleep(rand(100, 200));
          logger.info('[FORM] Pronoun selected', { pronoun });
        }
      }
    }
    return true;
  } catch (e) {
    logger.warn('[FORM] Failed to fill pronouns', { error: e.message });
    return false;
  }
}

/**
 * Fill location dropdown/select field.
 * Handles both opportunity location and general location selects.
 */
async function fillLocationSelect(page, location) {
  if (!location) return false;
  
  try {
    const selector = 'select[name="opportunityLocationId"], select.opportunity-location';
    const select = await page.$(selector);
    if (!select) return false;
    
    // Get all options
    const options = await page.evaluate((sel) => {
      const selectEl = document.querySelector(sel);
      if (!selectEl) return [];
      return Array.from(selectEl.options).map(opt => ({
        value: opt.value,
        text: opt.textContent.trim()
      }));
    }, selector);
    
    // Find best matching option
    const locationLower = location.toLowerCase();
    let bestMatch = null;
    
    for (const opt of options) {
      if (opt.value && opt.text) {
        const textLower = opt.text.toLowerCase();
        // Exact match
        if (textLower === locationLower) {
          bestMatch = opt;
          break;
        }
        // Partial match
        if (textLower.includes(locationLower) || locationLower.includes(textLower)) {
          if (!bestMatch) bestMatch = opt;
        }
      }
    }
    
    if (bestMatch) {
      await select.scrollIntoViewIfNeeded();
      await sleep(rand(200, 400));
      await select.selectOption(bestMatch.value);
      await sleep(rand(200, 400));
      logger.info('[FORM] Location selected', { location: bestMatch.text });
      return true;
    }
    
    return false;
  } catch (e) {
    logger.warn('[FORM] Failed to fill location select', { error: e.message });
    return false;
  }
}

// ── Main fill orchestrator ────────────────────────────────────────────────────

/**
 * fillApplicationForm
 * ───────────────────
 * Fills ONLY standard fields on the current Lever apply page.
 * Does NOT handle custom questions (those are handled asynchronously).
 * Returns an object summarising what was filled.
 */
async function fillApplicationForm(page, applicantData, resumePath) {
  logger.info('[FORM] Starting standard form fill (no custom questions)…');

  const filled = {};

  // Scroll to top first
  await page.evaluate(() => window.scrollTo(0, 0));
  await sleep(rand(500, 1000));

  // ── Standard text fields ─────────────────────────────────────────────────
  const fieldMap = [
    { key: 'name',           value: applicantData.name,           sels: SELECTORS.name     },
    { key: 'email',          value: applicantData.email,          sels: SELECTORS.email    },
    { key: 'phone',          value: applicantData.phone,          sels: SELECTORS.phone    },
    { key: 'currentCompany', value: applicantData.currentCompany, sels: SELECTORS.org      },
    { key: 'linkedin',       value: applicantData.linkedin,       sels: SELECTORS.linkedin },
    { key: 'github',         value: applicantData.github,         sels: SELECTORS.github   },
    { key: 'twitter',        value: applicantData.twitter,        sels: SELECTORS.twitter  },
    { key: 'website',        value: applicantData.website,        sels: SELECTORS.website  },
    { key: 'portfolio',      value: applicantData.portfolio,      sels: SELECTORS.portfolio },
    { key: 'otherWebsite',   value: applicantData.otherWebsite,   sels: SELECTORS.otherWebsite },
    { key: 'currentCompanyUrl', value: applicantData.currentCompanyUrl, sels: SELECTORS.currentCompanyUrl },
  ];

  for (const { key, value, sels } of fieldMap) {
    if (!value) continue;
    const el = await findElement(page, sels);
    if (el) {
      await fillField(page, el, value);
      filled[key] = true;
      await sleep(rand(300, 700));
    } else {
      logger.debug(`[FORM] Field not found on page: ${key}`);
    }
  }

  // ── Location field with autocomplete ──────────────────────────────────────
  if (applicantData.currentLocation) {
    const locationEl = await findElement(page, SELECTORS.location);
    if (locationEl) {
      await fillField(page, locationEl, applicantData.currentLocation);
      try {
        await chooseAutocompleteSuggestion(page, locationEl, applicantData.currentLocation);
        await sleep(rand(150, 350));
      } catch (e) {
        logger.debug('[FORM] Autocomplete selection failed', { error: e.message });
      }
      filled.currentLocation = true;
      await sleep(rand(300, 700));
    }
  }

  // ── Opportunity Location dropdown ─────────────────────────────────────────
  if (applicantData.opportunityLocation) {
    const locationOk = await fillLocationSelect(page, applicantData.opportunityLocation);
    if (locationOk) {
      filled.opportunityLocation = true;
      await sleep(rand(300, 700));
    }
  }

  // ── Pronouns checkboxes ───────────────────────────────────────────────────
  if (applicantData.pronouns) {
    const pronounsOk = await fillPronouns(page, applicantData.pronouns);
    if (pronounsOk) {
      filled.pronouns = true;
      await sleep(rand(300, 700));
    }
  }

  // ── Resume upload ─────────────────────────────────────────────────────────
  if (resumePath) {
    const ok = await uploadResume(page, resumePath);
    filled.resume = ok;
    await sleep(rand(500, 1000));
  }

  // ── Cover letter / comments ───────────────────────────────────────────────
  if (applicantData.coverLetter) {
    const el = await findElement(page, SELECTORS.comments);
    if (el) {
      await fillField(page, el, applicantData.coverLetter);
      filled.coverLetter = true;
      await sleep(rand(400, 800));
    }
  }

  // Note: Custom questions are handled separately via collectCustomQuestions() 
  // and fillCustomQuestionsWithAnswers() in agent.js for parallel LLM processing

  logger.info('[FORM] Standard form fill complete', filled);
  return filled;
}

// ── Submit helpers ────────────────────────────────────────────────────────────

const SUBMIT_SELECTORS = [
  'button[type="submit"]',
  'button:has-text("Submit application")',
  'button:has-text("Submit Application")',
  'button:has-text("Submit")',
  'input[type="submit"]',
  '[data-qa="btn-submit"]',
  '[class*="submit-btn"]',
  '[class*="btn-submit"]',
];

/** Locate the submit button and scroll it into view. Returns the element. */
async function locateSubmitButton(page) {
  const btn = await findElement(page, SUBMIT_SELECTORS);
  if (!btn) throw new Error('Submit button not found on page');

  await btn.scrollIntoViewIfNeeded();
  await sleep(rand(400, 800));
  logger.info('[FORM] Submit button located');
  return btn;
}

/** Click the submit button (call only when submitApplication === true). */
async function clickSubmitButton(page, btn) {
  logger.info('[FORM] Clicking submit button…');
  await mouse.humanClick(page, btn);
  await sleep(rand(3000, 5000));

  // Look for success confirmation
  const success =
    await page.$('[class*="thank"]')                       ||
    await page.$('[class*="success"]')                     ||
    await page.$('h2:has-text("application")')             ||
    await page.$('[data-qa="application-submitted"]')      ||
    await page.$('p:has-text("received your application")')  ;

  if (success) {
    logger.info('[FORM] Submission confirmed via success indicator');
    return true;
  }

  // Fallback: check URL change
  const url = page.url();
  logger.info('[FORM] Post-submit URL', { url });
  return url.includes('confirmation') || url.includes('thank') || url.includes('success');
}

module.exports = {
  navigateToApplyPage,
  fillApplicationForm,
  locateSubmitButton,
  clickSubmitButton,
  collectCustomQuestions,
  fillCustomQuestionsWithAnswers,
};
