'use strict';

// mouseHelper.js
// ──────────────
// Simulates human mouse movement using cubic Bézier curves with easing,
// randomised control points, and variable per-step timing.
//
// All exported functions accept a Playwright `page` object.

// Track the "current" cursor position across the session
let curX = 640;
let curY = 400;

// ── Math helpers ─────────────────────────────────────────────────────────────

function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2;
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

// Returns N points along a cubic Bézier from (x0,y0) → (x3,y3).
function bezierPath(x0, y0, x3, y3, steps) {
  const dx = x3 - x0;
  const dy = y3 - y0;
  const spread = Math.sqrt(dx * dx + dy * dy) * 0.25;

  const cp1x = x0 + dx * 0.25 + (Math.random() - 0.5) * spread;
  const cp1y = y0 + dy * 0.10 + (Math.random() - 0.5) * spread;
  const cp2x = x0 + dx * 0.75 + (Math.random() - 0.5) * spread;
  const cp2y = y0 + dy * 0.90 + (Math.random() - 0.5) * spread;

  const pts = [];
  for (let i = 0; i <= steps; i++) {
    const t  = easeInOutCubic(i / steps);
    const it = 1 - t;
    pts.push({
      x: it ** 3 * x0 + 3 * it ** 2 * t * cp1x + 3 * it * t ** 2 * cp2x + t ** 3 * x3,
      y: it ** 3 * y0 + 3 * it ** 2 * t * cp1y + 3 * it * t ** 2 * cp2y + t ** 3 * y3,
    });
  }
  return pts;
}

// ── Core movement ─────────────────────────────────────────────────────────────

async function delay(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// Move the cursor from its current position to (tx, ty)
// using a smooth Bézier path with random per-step timing.
async function moveTo(page, tx, ty) {
  const steps = 18 + Math.floor(Math.random() * 18);       // 18–35 steps
  const pts   = bezierPath(curX, curY, tx, ty, steps);

  for (const pt of pts) {
    await page.mouse.move(pt.x, pt.y);
    await delay(4 + Math.random() * 12);                    // 4–16 ms per step
  }
  curX = tx;
  curY = ty;
}

// Move to the centre of an element's bounding box (with slight random offset).
async function moveToElement(page, element) {
  const box = await element.boundingBox();
  if (!box) return;

  const tx = box.x + box.width  * (0.3 + Math.random() * 0.4);
  const ty = box.y + box.height * (0.3 + Math.random() * 0.4);
  await moveTo(page, tx, ty);
}

// ── High-level actions ────────────────────────────────────────────────────────

// Click an element with a human trajectory + variable press duration.
async function humanClick(page, element) {
  await moveToElement(page, element);
  await delay(60 + Math.random() * 140);          // hover pause

  await page.mouse.down();
  await delay(40 + Math.random() * 90);           // hold duration
  await page.mouse.up();
  await delay(80 + Math.random() * 120);          // post-click settle
}

// Type `text` into `element` character-by-character with variable delays,
// occasional micro-pauses (simulating thinking / hesitation), and a rare
// typo-then-backspace event for extra realism.
async function humanType(page, element, text) {
  await humanClick(page, element);
  await delay(120 + Math.random() * 180);

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    // ~3 % chance of a "typo": type a random nearby key then backspace
    if (Math.random() < 0.03 && ch.match(/[a-zA-Z]/)) {
      const typo = String.fromCharCode(ch.charCodeAt(0) + (Math.random() < 0.5 ? 1 : -1));
      await page.keyboard.type(typo);
      await delay(80 + Math.random() * 100);
      await page.keyboard.press('Backspace');
      await delay(60 + Math.random() * 80);
    }

    await page.keyboard.type(ch);

    // Variable keystroke timing: fast (40-90 ms) with occasional pauses
    if (Math.random() < 0.04) {
      await delay(350 + Math.random() * 600);     // "thinking" pause
    } else if (ch === ' ' && Math.random() < 0.15) {
      await delay(160 + Math.random() * 200);     // slight word-boundary pause
    } else {
      await delay(40 + Math.random() * 75);
    }
  }
}

// Select-all then delete the current value of an input/textarea.
async function humanClear(page, element) {
  await humanClick(page, element);
  await delay(100);
  await page.keyboard.press('Control+a');
  await delay(60);
  await page.keyboard.press('Backspace');
  await delay(100);
}

// Randomise the stored cursor starting position (call once per session).
function resetPosition(vw = 1280, vh = 800) {
  curX = vw * 0.3 + Math.random() * vw * 0.4;
  curY = vh * 0.3 + Math.random() * vh * 0.4;
}

module.exports = {
  moveTo,
  moveToElement,
  humanClick,
  humanType,
  humanClear,
  resetPosition,
};