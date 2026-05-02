'use strict';

const fs   = require('fs');
const path = require('path');

const logger  = require('./logger');
const { createBrowser, closeBrowser } = require('./browser');
const { resetPosition }               = require('./mouseHelper');
const {
  navigateToApplyPage,
  fillApplicationForm,
  locateSubmitButton,
  clickSubmitButton,
  collectCustomQuestions,
  fillCustomQuestionsWithAnswers,
} = require('./formFiller');
const { answerAllQuestions } = require('./llmHandler');
const { enrichApplicantDataFromCV } = require('./cvParser');
const { extractTextFromPDF } = require('./pdfTextExtractor');

const SCREENSHOT_DIR = path.join(__dirname, '../screenshots');

//  Internal helper 

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

async function takeScreenshot(page, label) {
  ensureDir(SCREENSHOT_DIR);
  const file = path.join(SCREENSHOT_DIR, `${label}_${Date.now()}.png`);
  try {
    await page.screenshot({ path: file, fullPage: true });
    logger.info('[AGENT] Screenshot saved', { file });
  } catch (_) {}
  return file;
}

// ── Main agent entry point ─────────────────────────────────────────────────────

/**
 * runAgent
 * ────────
 * Orchestrates the full application flow for a single Lever job posting.
 *
 * @param {object} params
 * @param {string}  params.jobUrl           - Full Lever job URL
 * @param {object}  params.applicantData    - Applicant profile object
 * @param {string}  [params.resumePath]     - Absolute path to PDF resume file
 * @param {boolean} [params.submitApplication=false] - Whether to actually click Submit
 *
 * @returns {Promise<object>} Structured result object
 */
async function runAgent({
  jobUrl,
  applicantData,
  resumePath        = null,
  submitApplication = false,
}) {
  const startedAt   = new Date().toISOString();
  const startMs     = Date.now();
  const executionLog = [];
  let   browser     = null;
  let   page        = null;

  // ── Step logger ────────────────────────────────────────────────────────────
  const step = (name, status, details = {}) => {
    const entry = {
      step      : name,
      status,
      timestamp : new Date().toISOString(),
      ...details,
    };
    executionLog.push(entry);
    const lvl = status === 'error' ? 'error' : 'info';
    logger[lvl](`[AGENT] ${name}`, { status, ...details });
  };

  // ── Input validation ───────────────────────────────────────────────────────
  try {
    if (!jobUrl)
      throw new Error('jobUrl is required');
    if (!jobUrl.startsWith('http'))
      throw new Error('jobUrl must be a valid HTTP/HTTPS URL');
    if (!applicantData?.name)
      throw new Error('applicantData.name is required');
    // Email is optional - will be filled from form or parsed from CV
  } catch (err) {
    return {
      success       : false,
      status        : 'validation_failed',
      error         : err.message,
      duration_ms   : Date.now() - startMs,
      started_at    : startedAt,
      execution_log : executionLog,
    };
  }

  step('validation', 'success');

  // ── Resolve resume from file path ──────────────────────────────────────────
  let resolvedResumePath = null;

  if (resumePath) {
    resolvedResumePath = path.resolve(resumePath);
    if (!fs.existsSync(resolvedResumePath)) {
      return {
        success       : false,
        status        : 'resume_not_found',
        error         : `Resume file not found: ${resolvedResumePath}`,
        duration_ms   : Date.now() - startMs,
        started_at    : startedAt,
        execution_log : executionLog,
      };
    }

    try {
      const buf = fs.readFileSync(resolvedResumePath);
      const resumeBase64 = buf.toString('base64');
      applicantData = applicantData || {};
      applicantData.resumeBase64 = resumeBase64;
      applicantData.resumeFilename = path.basename(resolvedResumePath);
      step('attach_resume', 'success', { path: resolvedResumePath, size: buf.length });

      // ── Extract text from CV and parse contact information ────────────────
      try {
        step('parse_cv', 'starting');
        const cvText = await extractTextFromPDF(resolvedResumePath);
        
        if (cvText && cvText.length > 0) {
          logger.info('[AGENT] CV text extracted', { length: cvText.length, preview: cvText.substring(0, 200) });
          
          // Enrich applicantData with parsed CV fields (email, phone, linkedin, github)
          const enrichedData = enrichApplicantDataFromCV(applicantData, cvText);
          applicantData = enrichedData;
          
          step('parse_cv', 'success', {
            email: applicantData.email || 'not found',
            phone: applicantData.phone || 'not found',
            linkedin: applicantData.linkedin ? 'found' : 'not found',
            github: applicantData.github ? 'found' : 'not found',
          });
          
          logger.info('[AGENT] Enriched applicant data', {
            name: applicantData.name,
            email: applicantData.email,
            phone: applicantData.phone,
            linkedin: applicantData.linkedin,
            github: applicantData.github,
          });
        } else {
          step('parse_cv', 'no_text_extracted');
        }
      } catch (parseErr) {
        logger.warn('[AGENT] CV parsing failed', { error: parseErr.message });
        step('parse_cv', 'warning', { error: parseErr.message });
      }
    } catch (err) {
      return {
        success       : false,
        status        : 'resume_read_failed',
        error         : `Failed to read resume: ${err.message}`,
        duration_ms   : Date.now() - startMs,
        started_at    : startedAt,
        execution_log : executionLog,
      };
    }
  }

  // ── Run the agent ──────────────────────────────────────────────────────────
  try {

    // 1. Launch browser
    step('browser_launch', 'starting');
    const result = await createBrowser({
      headless : process.env.HEADLESS === 'true',
      proxy    : process.env.PROXY_URL  || null,
    });
    browser = result.browser;
    page    = result.page;
    resetPosition(1280, 800);
    step('browser_launch', 'success');

    // 2. Navigate to the application form
    step('navigate', 'starting', { url: jobUrl });
    await navigateToApplyPage(page, jobUrl);
    step('navigate', 'success', { currentUrl: page.url() });

    // 3. Small human-like pause before starting to fill
    await new Promise(r => setTimeout(r, 800 + Math.random() * 800));

    // ── PARALLEL WORKFLOW: LLM + Form Filling ─────────────────────────────
    // The key optimization: send LLM request immediately, fill standard fields while LLM processes

    // 3a. COLLECT custom questions (fast scan, no LLM call yet)
    step('collect_custom_questions', 'starting');
    const { allFieldData, fieldOperations } = await collectCustomQuestions(page);
    const hasCustomQuestions = fieldOperations.length > 0;
    step('collect_custom_questions', 'success', { count: fieldOperations.length });

    // 3b. START LLM request IMMEDIATELY (don't await yet - this runs in background)
    let llmPromise = null;
    if (hasCustomQuestions) {
      step('start_llm_request', 'starting');
      llmPromise = answerAllQuestions(allFieldData, applicantData).catch(err => {
        logger.error('[AGENT] LLM request failed', { error: err.message });
        step('start_llm_request', 'failed', { error: err.message });
        return {};
      });
      step('start_llm_request', 'success', { questionsCount: fieldOperations.length });
    }

    // 3c. MEANWHILE: Fill standard fields and upload resume (this happens in parallel)
    step('fill_standard_fields', 'starting');
    const filledFields = await fillApplicationForm(
      page,
      applicantData,
      resolvedResumePath,
    );
    step('fill_standard_fields', 'success', { filledFields });

    // 3d. NOW WAIT for LLM results to come back
    let customQAnswers = {};
    if (llmPromise) {
      step('wait_llm_results', 'starting');
      customQAnswers = await llmPromise;
      step('wait_llm_results', 'success', { answersCount: Object.keys(customQAnswers).length });

      // 3e. Fill custom questions with LLM answers
      step('fill_custom_questions', 'starting');
      const customQFilled = await fillCustomQuestionsWithAnswers(page, fieldOperations, customQAnswers);
      step('fill_custom_questions', 'success', { count: customQFilled.length });
      filledFields.customQuestions = customQFilled.length;
    }

    // 4. Scroll through form naturally before taking screenshots
    await page.evaluate(() => window.scrollTo({ top: document.body.scrollHeight / 2, behavior: 'smooth' }));
    await new Promise(r => setTimeout(r, 600 + Math.random() * 400));
    await page.evaluate(() => window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' }));
    await new Promise(r => setTimeout(r, 600 + Math.random() * 600));

    // 5. Screenshot: form filled state
    const screenshotFilled = await takeScreenshot(page, 'form_filled');

    // 6. Locate submit button
    step('locate_submit', 'starting');
    const submitBtn = await locateSubmitButton(page);
    step('locate_submit', 'success');

    // 7. Screenshot: ready-to-submit state  (the primary deliverable)
    const screenshotReady = await takeScreenshot(page, 'ready_to_submit');
    step('screenshot_ready_to_submit', 'success', { file: screenshotReady });

    // 8. Submit (only if caller explicitly requested it)
    let finalStatus  = 'ready_to_submit';
    let screenshotPost = null;

    if (submitApplication) {
      step('submit', 'starting');
      const submitted = await clickSubmitButton(page, submitBtn);
      screenshotPost  = await takeScreenshot(page, 'post_submit');
      step('submit', submitted ? 'success' : 'uncertain', { url: page.url() });
      finalStatus = submitted ? 'submitted' : 'submit_uncertain';
    }

    return {
      success       : true,
      status        : finalStatus,
      job_url       : jobUrl,
      applicant     : applicantData.name,
      fields_filled : filledFields,
      screenshots   : {
        filled         : screenshotFilled,
        ready_to_submit: screenshotReady,
        post_submit    : screenshotPost,
      },
      duration_ms   : Date.now() - startMs,
      started_at    : startedAt,
      execution_log : executionLog,
    };

  } catch (err) {
    logger.error('[AGENT] Fatal error', { error: err.message, stack: err.stack });
    step('fatal_error', 'error', { message: err.message });

    // Screenshot on failure for debugging
    if (page) {
      try {
        await takeScreenshot(page, 'error');
      } catch (_) {}
    }

    return {
      success       : false,
      status        : 'failed',
      error         : err.message,
      duration_ms   : Date.now() - startMs,
      started_at    : startedAt,
      execution_log : executionLog,
    };

  } finally {
    if (browser) await closeBrowser(browser);
  }
}

module.exports = { runAgent };
