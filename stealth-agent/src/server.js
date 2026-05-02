'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const express = require('express');
const path = require('path');
const logger = require('./logger');
const { runAgent } = require('./agent');
const { enrichApplicantDataFromCV } = require('./cvParser');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));

// CORS headers for local and remote clients
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// Request logging middleware
app.use((req, res, next) => {
  logger.info('[API] Incoming request', {
    method: req.method,
    url: req.url,
    ip: req.ip,
  });
  next();
});

// Routes

app.post('/apply', async (req, res) => {
  const requestId = Math.random().toString(36).substring(7);
  const startTime = Date.now();

  try {
    // Input validation
    let { jobUrl, applicantData, resumePath, cvText, submitApplication } = req.body;

    if (!jobUrl || typeof jobUrl !== 'string') {
      logger.warn('[API] Missing/invalid jobUrl', { requestId });
      return res.status(400).json({
        success: false,
        error: 'jobUrl is required and must be a string',
        requestId,
      });
    }

    if (!applicantData || typeof applicantData !== 'object') {
      logger.warn('[API] Missing/invalid applicantData', { requestId });
      return res.status(400).json({
        success: false,
        error: 'applicantData is required and must be an object',
        requestId,
      });
    }

    // Enrich applicantData with parsed CV information FIRST
    if (cvText && typeof cvText === 'string' && cvText.length > 0) {
      logger.info('[API] Enriching applicantData with CV text', { requestId });
      applicantData = enrichApplicantDataFromCV(applicantData, cvText);
    }

    // Validate required fields AFTER enrichment
    // Only require name - email will be parsed from resume/CV or filled during form
    if (!applicantData.name) {
      logger.warn('[API] Missing required applicant fields', { requestId, missing: ['name'] });
      return res.status(400).json({
        success: false,
        error: 'applicantData.name is required',
        requestId,
      });
    }

    // Email format validation (only if email is provided)
    if (applicantData.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(applicantData.email)) {
      logger.warn('[API] Invalid email format', { requestId });
      return res.status(400).json({
        success: false,
        error: 'Invalid email format in applicantData.email',
        requestId,
      });
    }

    logger.info('[API] Valid request received', {
      requestId,
      jobUrl: jobUrl.substring(0, 80),
      applicant: applicantData.name,
      hasEmail: !!applicantData.email,
      hasPhone: !!applicantData.phone,
      hasLinkedIn: !!applicantData.linkedin,
      hasGitHub: !!applicantData.github,
    });

    // Execute the agent
    const result = await runAgent({
      jobUrl,
      applicantData,
      resumePath: resumePath || null,
      submitApplication: submitApplication === true,
    });

    const elapsed = Date.now() - startTime;

    // Return response
    if (result.success) {
      logger.info('[API] Agent succeeded', { requestId, status: result.status, elapsed });
      return res.status(200).json({
        success: true,
        requestId,
        status: result.status,
        applicant: result.applicant,
        job_url: result.job_url,
        fields_filled: result.fields_filled,
        screenshots: result.screenshots || {},
        duration_ms: result.duration_ms,
        execution_log: result.execution_log,
        timestamp: new Date().toISOString(),
      });
    } else {
      // Agent failed
      const statusCode = result.status === 'validation_failed' ? 400 : 500;
      logger.error('[API] Agent failed', { requestId, status: result.status, error: result.error, elapsed });
      return res.status(statusCode).json({
        success: false,
        requestId,
        status: result.status,
        error: result.error,
        duration_ms: result.duration_ms,
        execution_log: result.execution_log,
        timestamp: new Date().toISOString(),
      });
    }

  } catch (err) {
    logger.error('[API] Unhandled error in /apply', { error: err.message, stack: err.stack });
    return res.status(500).json({
      success: false,
      error: 'Internal server error: ' + err.message,
      requestId: Math.random().toString(36).substring(7),
      timestamp: new Date().toISOString(),
    });
  }
});

// 404 handler

app.use((req, res) => {
  logger.warn('[API] 404 Not Found', { url: req.url });
  res.status(404).json({
    success: false,
    error: 'Endpoint not found. Try POST /apply or GET /health',
  });
});

// Error handler

app.use((err, req, res, next) => {
  logger.error('[API] Global error handler', { error: err.message, stack: err.stack });
  res.status(500).json({
    success: false,
    error: 'Internal server error',
  });
});

// Server startup

const server = app.listen(PORT, () => {
  logger.info(`[SERVER] Stealth Agent API running on http://localhost:${PORT}`);
  logger.info('[SERVER] Available endpoints:');
  logger.info('[SERVER]   • GET  /health  - Health check');
  logger.info('[SERVER]   • POST /apply   - Submit job application');
});

// Graceful shutdown

process.on('SIGTERM', () => {
  logger.info('[SERVER] SIGTERM received — shutting down gracefully');
  server.close(() => {
    logger.info('[SERVER] Server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  logger.info('[SERVER] SIGINT received — shutting down gracefully');
  server.close(() => {
    logger.info('[SERVER] Server closed');
    process.exit(0);
  });
});

module.exports = app;