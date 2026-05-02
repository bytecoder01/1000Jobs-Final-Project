'use strict';

const fs = require('fs');
const pdfParse = require('pdf-parse');
const logger = require('./logger');

// pdfTextExtractor.js
// ───────────────────
// Extracts plain text from PDF files

// Extract text from a PDF file
async function extractTextFromPDF(filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) {
      logger.warn('[PDF_EXTRACTOR] File not found', { filePath });
      return '';
    }

    const fileBuffer = fs.readFileSync(filePath);
    const data = await pdfParse(fileBuffer);
    
    const extractedText = data.text || '';
    
    logger.info('[PDF_EXTRACTOR] PDF text extracted successfully', {
      file: filePath,
      pages: data.numpages,
      characters: extractedText.length,
    });

    return extractedText;
  } catch (error) {
    logger.warn('[PDF_EXTRACTOR] Failed to extract text from PDF', {
      filePath,
      error: error.message,
    });
    return '';
  }
}

// Extract text from PDF by base64 string
async function extractTextFromBase64PDF(base64String) {
  try {
    if (!base64String) {
      logger.warn('[PDF_EXTRACTOR] Empty base64 string provided');
      return '';
    }

    const buffer = Buffer.from(base64String, 'base64');
    const data = await pdfParse(buffer);
    
    const extractedText = data.text || '';
    
    logger.info('[PDF_EXTRACTOR] PDF text extracted from base64', {
      characters: extractedText.length,
      pages: data.numpages,
    });

    return extractedText;
  } catch (error) {
    logger.warn('[PDF_EXTRACTOR] Failed to extract text from base64 PDF', {
      error: error.message,
    });
    return '';
  }
}

module.exports = {
  extractTextFromPDF,
  extractTextFromBase64PDF,
};