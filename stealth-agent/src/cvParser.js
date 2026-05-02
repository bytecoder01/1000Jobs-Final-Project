'use strict';

const logger = require('./logger');

// cvParser.js
// ───────────
// Extracts contact information (email, phone, LinkedIn, GitHub) from CV text using regex.
// Automatically populates applicantData with parsed fields if not already provided.

// Email regex - matches standard email formats
const EMAIL_REGEX = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g;

// Phone regex - matches various phone formats:
// - +1-555-1234
// - (555) 123-4567
// - 555.123.4567
// - 555-123-4567
// - +1 (555) 123-4567
// - 5551234567
const PHONE_REGEX = /(?:\+?1[-.\s]?)?\(?([0-9]{3})\)?[-.\s]?([0-9]{3})[-.\s]?([0-9]{4})/g;

// LinkedIn regex - extracts LinkedIn profile URLs
// Matches:
// - https://linkedin.com/in/username
// - https://www.linkedin.com/in/username
// - linkedin.com/in/username
// - www.linkedin.com/in/username
const LINKEDIN_REGEX = /(?:https?:\/\/)?(?:www\.)?linkedin\.com\/(?:in|company)\/[\w\-]+/gi;

// GitHub regex - extracts GitHub profile URLs
// Matches:
// - https://github.com/username
// - https://www.github.com/username
// - github.com/username
// - www.github.com/username
const GITHUB_REGEX = /(?:https?:\/\/)?(?:www\.)?github\.com\/[\w\-]+/gi;

// Extract emails from text
function extractEmail(text) {
  if (!text) return null;
  const matches = text.match(EMAIL_REGEX);
  if (!matches || matches.length === 0) return null;
  
  // Filter out common non-email addresses (be less aggressive)
  const filtered = matches.filter(email => {
    const emailLower = email.toLowerCase();
    const domain = email.split('@')[1].toLowerCase();
    
    // Only exclude obvious test/placeholder emails
    if (domain === 'example.com' || domain === 'test.com' || domain === 'email.com') return false;
    if (emailLower.includes('noreply')) return false;
    if (emailLower === 'email@email.com') return false;
    
    return true;
  });

  return filtered.length > 0 ? filtered[0] : null;
}

// Extract phone numbers from text
function extractPhone(text) {
  if (!text) return null;
  const matches = text.match(PHONE_REGEX);
  if (!matches || matches.length === 0) return null;
  
  // Return the first valid match with full formatting
  // Try to reconstruct with standardized format
  const match = matches[0];
  // Clean up and return as-is (preserves original format from CV)
  return match.trim();
}

// Extract LinkedIn profile URL from text
function extractLinkedIn(text) {
  if (!text) return null;
  const matches = text.match(LINKEDIN_REGEX);
  if (!matches || matches.length === 0) return null;
  
  let linkedinUrl = matches[0];
  
  // Ensure it has http prefix
  if (!linkedinUrl.startsWith('http')) {
    linkedinUrl = 'https://' + linkedinUrl;
  }
  
  // Normalize www
  linkedinUrl = linkedinUrl.replace(/linkedin\.com/, 'linkedin.com');
  
  return linkedinUrl;
}

// Extract GitHub profile URL from text
function extractGitHub(text) {
  if (!text) return null;
  const matches = text.match(GITHUB_REGEX);
  if (!matches || matches.length === 0) return null;
  
  let githubUrl = matches[0];
  
  // Ensure it has http prefix
  if (!githubUrl.startsWith('http')) {
    githubUrl = 'https://' + githubUrl;
  }
  
  // Normalize www
  githubUrl = githubUrl.replace(/github\.com/, 'github.com');
  
  return githubUrl;
}

// Parse CV content and extract all contact information
function parseCVForContactInfo(cvText) {
  if (!cvText || typeof cvText !== 'string') {
    return { email: null, phone: null, linkedin: null, github: null };
  }

  const parsed = {
    email: extractEmail(cvText),
    phone: extractPhone(cvText),
    linkedin: extractLinkedIn(cvText),
    github: extractGitHub(cvText),
  };

  logger.info('[CV_PARSER] Parsed contact info from CV', {
    email: parsed.email ? '✓' : '✗',
    phone: parsed.phone ? '✓' : '✗',
    linkedin: parsed.linkedin ? '✓' : '✗',
    github: parsed.github ? '✓' : '✗',
  });

  return parsed;
}

// Enrich applicantData with parsed CV information
// Only sets fields that:
// 1. Were not already provided in applicantData
// 2. Were successfully parsed from the CV
function enrichApplicantDataFromCV(applicantData, cvText) {
  if (!applicantData || typeof applicantData !== 'object') {
    return applicantData;
  }

  const parsed = parseCVForContactInfo(cvText);
  const enriched = { ...applicantData };

  // Only set fields if not already provided and successfully parsed
  if (!enriched.email && parsed.email) {
    enriched.email = parsed.email;
    logger.info('[CV_PARSER] Populated email from CV', { email: parsed.email });
  }

  if (!enriched.phone && parsed.phone) {
    enriched.phone = parsed.phone;
    logger.info('[CV_PARSER] Populated phone from CV', { phone: parsed.phone });
  }

  if (!enriched.linkedin && parsed.linkedin) {
    enriched.linkedin = parsed.linkedin;
    logger.info('[CV_PARSER] Populated linkedin from CV', { linkedin: parsed.linkedin });
  }

  if (!enriched.github && parsed.github) {
    enriched.github = parsed.github;
    logger.info('[CV_PARSER] Populated github from CV', { github: parsed.github });
  }

  // Remove fields that are empty or were not provided (clean payload)
  const fieldsToClean = ['currentLocation', 'currentCompany', 'currentTitle', 'additionalInfo'];
  fieldsToClean.forEach(field => {
    if (!enriched[field] || enriched[field].trim() === '') {
      delete enriched[field];
    }
  });

  return enriched;
}

module.exports = {
  parseCVForContactInfo,
  enrichApplicantDataFromCV,
  extractEmail,
  extractPhone,
  extractLinkedIn,
  extractGitHub,
};