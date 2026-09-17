#!/usr/bin/env node
/**
 * Landing-page copy gate.
 *
 * Two owner rules, enforced rather than remembered:
 *   1. No em-dashes in anything visitor-facing. This is absolute.
 *   2. A landing page is a couple hundred words a first-time visitor actually reads.
 *
 * Rule 2 is a RATCHET, not a fixed bar. The pages are not at 250 words yet, and a gate that
 * is red the day it lands gets ignored. So the baseline is whatever the page measured when
 * this was installed: the page may get shorter, and may drift up by a small slack, but it
 * cannot quietly grow back. Lower the baseline with `--update` when you genuinely cut copy.
 *
 * THE MEASUREMENT TRAP this exists to avoid: a naive word count reads about 3x high, because
 * collapsed <details>, elements carrying a `hidden` attribute, and <noscript> are all in the
 * HTML and none of them are on the page.
 *
 *   node scripts/copy-budget.mjs            # check, exit 1 on a breach
 *   node scripts/copy-budget.mjs --update   # record the current numbers as the baseline
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE = join(ROOT, 'scripts', 'copy-budget.json');
const PARA_LIMIT = 30;          // words in any one paragraph
const GROWTH_SLACK = 1.08;      // 8% drift before the ratchet complains

const PAGE = ['index.html', 'docs/index.html', 'site/index.html']
  .map((p) => join(ROOT, p))
  .find((p) => existsSync(p));

if (!PAGE) {
  console.error('copy-budget: no index.html found; nothing to check.');
  process.exit(0);
}

const html = readFileSync(PAGE, 'utf8');

/** Everything a visitor cannot see, stripped. */
function visible(source) {
  const bodyAt = source.toLowerCase().indexOf('<body');
  let body = bodyAt >= 0 ? source.slice(bodyAt) : source;
  const invisible = [
    /<script\b[\s\S]*?<\/script>/gi,
    /<style\b[\s\S]*?<\/style>/gi,
    /<!--[\s\S]*?-->/g,
    /<svg\b[\s\S]*?<\/svg>/gi,
    /<noscript\b[\s\S]*?<\/noscript>/gi,
    /<details\b[\s\S]*?<\/details>/gi,
    /<div\b[^>]*\shidden[^>]*>[\s\S]*?<\/div>/gi,
    /<nav\b[\s\S]*?<\/nav>/gi,
    /<footer\b[\s\S]*?<\/footer>/gi,
    /<table\b[\s\S]*?<\/table>/gi,
    /<pre\b[\s\S]*?<\/pre>/gi,
  ];
  for (const re of invisible) body = body.replace(re, ' ');
  return body;
}

const body = visible(html);
let words = 0;
const longParas = [];
for (const m of body.matchAll(/<(p|li)\b[^>]*>([\s\S]*?)<\/\1>/gi)) {
  const text = m[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  const n = text ? text.split(' ').length : 0;
  words += n;
  if (n > PARA_LIMIT) longParas.push({ n, text: text.slice(0, 80) });
}

// em-dashes anywhere outside <style>/<script>, where they would be code, not copy
const codeSpans = [];
for (const re of [/<style\b[\s\S]*?<\/style>/gi, /<script\b[\s\S]*?<\/script>/gi]) {
  for (const m of html.matchAll(re)) codeSpans.push([m.index, m.index + m[0].length]);
}
let dashes = 0;
for (const m of html.matchAll(/—|&mdash;/g)) {
  if (!codeSpans.some(([a, b]) => m.index >= a && m.index < b)) dashes++;
}

if (process.argv.includes('--update')) {
  writeFileSync(BASELINE, JSON.stringify({ words, note: 'visible prose words; lower is better' }, null, 2) + '\n');
  console.log(`copy-budget: baseline recorded at ${words} words.`);
  process.exit(0);
}

const base = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, 'utf8')).words : null;
const ceiling = base === null ? Infinity : Math.round(base * GROWTH_SLACK);
const fails = [];

if (dashes > 0) fails.push(`${dashes} em-dash(es) in visitor-facing copy. The owner's rule is zero; use a comma, colon, semicolon or period.`);
if (longParas.length) {
  fails.push(`${longParas.length} paragraph(s) over ${PARA_LIMIT} words:`);
  for (const p of longParas.slice(0, 5)) fails.push(`    ${p.n}w  ${p.text}`);
}
if (words > ceiling) {
  fails.push(`page grew to ${words} visible words, over the ${ceiling} ceiling (baseline ${base}).`);
  fails.push('    Put the specialist half behind <details>, or run --update if this growth is intended.');
}

console.log(`copy-budget: ${words} visible words${base === null ? '' : ` (baseline ${base}, ceiling ${ceiling})`}, longest paragraph ${longParas.length ? Math.max(...longParas.map((p) => p.n)) : '<=' + PARA_LIMIT}, ${dashes} em-dashes.`);

if (fails.length) {
  console.error('\ncopy-budget FAILED:\n  ' + fails.join('\n  '));
  process.exit(1);
}
console.log('copy-budget: ok');
