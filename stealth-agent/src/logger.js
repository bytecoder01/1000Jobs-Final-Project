'use strict';

const winston = require('winston');
const path    = require('path');
const fs      = require('fs');

const LOG_DIR = path.join(__dirname, '../logs');
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

const { combine, timestamp, printf, colorize, errors } = winston.format;

const lineFormat = printf(({ level, message, timestamp, stack, ...meta }) => {
  let line = `[${timestamp}] [${level.toUpperCase().padEnd(5)}] ${message}`;
  const extra = Object.keys(meta);
  if (extra.length) line += `  » ${JSON.stringify(meta)}`;
  if (stack)        line += `\n${stack}`;
  return line;
});

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: combine(
    errors({ stack: true }),
    timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
    lineFormat
  ),
  transports: [
    new winston.transports.Console({
      format: combine(
        colorize({ all: true }),
        errors({ stack: true }),
        timestamp({ format: 'HH:mm:ss.SSS' }),
        lineFormat
      ),
    }),
    new winston.transports.File({
      filename : path.join(LOG_DIR, 'error.log'),
      level    : 'error',
    }),
    new winston.transports.File({
      filename: path.join(LOG_DIR, 'combined.log'),
    }),
  ],
});

module.exports = logger;
