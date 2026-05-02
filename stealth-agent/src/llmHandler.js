'use strict';

const { GoogleGenerativeAI } = require('@google/generative-ai');
const logger = require('./logger');

let _client = null;

function getClient() {
  if (!_client) {
    if (!process.env.GOOGLE_API_KEY) {
      throw new Error('GOOGLE_API_KEY is not set in environment variables');
    }
    _client = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);
  }
  return _client;
}

function safeParseJSON(text) {
  // Attempt 1: direct parse
  try { return JSON.parse(text); } catch (_) {}

  // Attempt 2: extract outermost {...} block (handles trailing prose)
  const objMatch = text.match(/\{[\s\S]*\}/);
  if (objMatch) {
    try { return JSON.parse(objMatch[0]); } catch (_) {}
  }

  // Attempt 3: strip JS-style comments then retry
  try {
    const stripped = text
      .replace(/\/\/[^\n]*/g, '')
      .replace(/\/\*[\s\S]*?\*\//g, '');
    return JSON.parse(stripped);
  } catch (_) {}

  // Attempt 4: extract object after stripping comments
  try {
    const stripped = text
      .replace(/\/\/[^\n]*/g, '')
      .replace(/\/\*[\s\S]*?\*\//g, '');
    const m = stripped.match(/\{[\s\S]*\}/);
    if (m) return JSON.parse(m[0]);
  } catch (_) {}

  return null;
}

// Cleans model output — handles all known Gemini wrapping styles
function cleanOutput(raw) {
  return raw
    .replace(/^```json[\r\n]*/i, '')  // ```json at start
    .replace(/^```[\r\n]*/i, '')      // ``` at start
    .replace(/[\r\n]*```\s*$/i, '')   // ``` at end (with preceding newlines)
    .replace(/\u0000/g, '')           // null bytes
    .trim();
}

// answerAllQuestions
async function answerAllQuestions(allQuestions, applicantData) {
  if (!allQuestions || Object.values(allQuestions).every(v => !v || v.length === 0)) {
    return {};
  }

  const {
    name           = 'the applicant',
    email          = '',
    phone          = '',
    linkedin       = '',
    github         = '',
    currentCompany = '',
    currentTitle   = '',
    additionalInfo = '',
    resumeBase64   = null,
    resumeFilename = null,
  } = applicantData;

  const totalCount =
    (allQuestions.textareas  || []).length +
    (allQuestions.inputs     || []).length +
    (allQuestions.selects    || []).length +
    (allQuestions.checkboxes || []).length +
    (allQuestions.radios     || []).length;

  logger.info('[LLM] Answering all questions in single call', {
    total: totalCount,
    model: 'gemini-3-flash-preview',
  });

  const systemPrompt = `You are filling out a job application on behalf of ${name}.

Applicant profile:
• Name:            ${name}
• Email:           ${email || 'N/A'}
• Phone:           ${phone || 'N/A'}
• LinkedIn:        ${linkedin || 'N/A'}
• GitHub:          ${github || 'N/A'}
• Current role:    ${currentTitle || 'N/A'}
• Current company: ${currentCompany || 'N/A'}
• Background:      ${additionalInfo || 'Experienced professional with a strong track record.'}
${resumeFilename ? `• Resume:          ${resumeFilename} (contents attached)` : ''}

RULES — respond ONLY with valid JSON:
- No markdown
- No explanations
- No trailing commas
- No unescaped quotes

FORMAT:
{
  "questionId": "answer",
  "checkboxQuestionId": ["option1", "option2"]
}

GUIDELINES:
1. textareas / inputs → 20-30 words, first-person
2. selects / radios   → EXACT option string or ""
3. checkboxes         → array of options or []

Return ONLY JSON.`;

  try {
    const client = getClient();

    const model = client.getGenerativeModel({
      model: 'gemini-3-flash-preview',
      systemInstruction: systemPrompt,
    });

    const userParts = [
      {
        text: `Answer all questions below. Return ONLY JSON.\n\n${JSON.stringify(allQuestions, null, 2)}`,
      },
    ];

    if (resumeBase64) {
      userParts.push({
        inlineData: {
          data: resumeBase64,
          mimeType: 'application/pdf',
        },
      });
    }

    const response = await model.generateContent({
      contents: [{ role: 'user', parts: userParts }],
      generationConfig: {
        temperature: 0.2,
        topP: 0.9,
        topK: 40,
        maxOutputTokens: 3000,
        responseMimeType: 'application/json', 
      },
    });

    let raw = response.response.text();
    logger.info('[LLM] Raw response received', { length: raw.length, preview: raw.substring(0, 300) });
    raw = cleanOutput(raw);

    const parsed = safeParseJSON(raw);

    if (!parsed) {
      logger.error('[LLM] Failed to parse JSON after recovery', { raw: raw.substring(0, 500) });
      return {};
    }

    logger.info('[LLM] Success', {
      keys: Object.keys(parsed).length,
    });

    return parsed;

  } catch (err) {
    logger.error('[LLM] Error in single-call answer', {
      error: err.message,
      stack: err.stack,
    });
    return {};
  }
}

module.exports = { answerAllQuestions };