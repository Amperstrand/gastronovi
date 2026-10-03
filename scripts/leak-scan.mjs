#!/usr/bin/env node
/**
 * Leak gate. Exit 0 = clean, 1 = findings.
 * Scans git-visible text for card numbers, plates, phones, tokens.
 * Also refuses capture files (HAR, logs, pcaps) even if someone force-adds them.
 *
 *   node scripts/leak-scan.mjs [path] [--history] [--staged]
 */
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const TEXT_EXT =
  /\.(ts|tsx|js|mjs|cjs|json|jsonc|md|txt|html|css|ya?ml|toml|sh|py|rs|go|env|example|log|har)$/;

const BLOCKED_PATH =
  /(^|\/)(\.env|\.env\..*|identity\.json|session\.json|cookies\.txt|.*\.har|.*\.pcap|.*\.log|.*\.pem|.*\.p12|flow-har.*|.*-har\.json)$|^(captures|fixtures|snapshots|films|research)\//i;

function luhnValid(raw) {
  const digits = raw.replace(/[^\d]/g, "");
  if (digits.length < 13 || digits.length > 19) return false;
  if (digits.length === 13) {
    const asNumber = Number(digits);
    if (asNumber > 9e11 && asNumber < 4e12) return false;
  }
  let sum = 0;
  let dbl = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let d = Number(digits[i]);
    if (dbl) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

const PLACEHOLDER =
  /^(x{3,}|\*{3,}|<[^>]+>|\$\{[^}]+\}|changeme|change-me|example.*|placeholder.*|your[-_].*|0+|\d)$/i;

const RULES = [
  {
    id: "pan",
    why: "credit card number (Luhn-valid)",
    regex: /\b(?:\d[ -]?){13,19}\b/g,
    accept: (match) => luhnValid(match),
  },
  { id: "no-plate", why: "Norwegian license plate", regex: /\b[A-HJ-PR-Y]{2}\s?\d{5}\b/g },
  { id: "de-plate", why: "German license plate", regex: /\b[A-ZÄÖÜ]{1,3}-[A-Z]{1,2}-\d{1,4}\b/g },
  { id: "phone", why: "phone number with country code", regex: /\+\d{2}\s?\d{6,12}\b/g },
  { id: "jwt", why: "JWT", regex: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g },
  { id: "cashu-token", why: "Cashu token", regex: /\bcashu[AB][A-Za-z0-9_-]{30,}/g },
  { id: "gh-token", why: "GitHub token", regex: /\b(?:ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]{16,}/g },
  { id: "nsec", why: "Nostr secret key", regex: /\bnsec1[a-z0-9]{20,}/g },
  {
    id: "secret-key",
    why: "secret-looking key/value pair",
    regex:
      /\b(pan|cvc|cvv|card_?number|license_?plate|plate|phone_?number|password|api[_-]?key|secret|rune)\b["']?\s*[:=]\s*["'][^"']{4,}["']/gi,
  },
];

function isPlaceholder(value) {
  return PLACEHOLDER.test(value.trim()) || /^[A-Z][A-Z0-9_]*$/.test(value.trim());
}

function* scanLine(line) {
  for (const rule of RULES) {
    rule.regex.lastIndex = 0;
    const matches = line.match(rule.regex);
    if (matches === null) continue;
    for (const match of matches) {
      if (rule.accept !== undefined && !rule.accept(match)) continue;
      if (rule.id === "secret-key") {
        const value = /["']([^"']{4,})["']/.exec(match)?.[1];
        if (value === undefined || isPlaceholder(value)) continue;
      }
      yield { rule: rule.id, why: rule.why, sample: match.slice(0, 24) };
    }
  }
}

function scanText(findings, text, filePath) {
  const lines = text.split("\n");
  for (const [i, line] of lines.entries()) {
    for (const hit of scanLine(line)) {
      findings.push({ ...hit, file: filePath, line: i + 1 });
    }
  }
}

function gitFiles(root, staged) {
  const args = staged
    ? "git diff --cached --name-only -z --diff-filter=ACMR"
    : "git ls-files -z --cached --others --exclude-standard";
  const listed = execSync(args, { cwd: root, maxBuffer: 64 * 1024 * 1024 })
    .toString()
    .split("\0")
    .filter((file) => file !== "");
  if (!staged) return listed;
  // name-only misses a brand-new file in some hook setups; the cached
  // diff names every path that would land in the commit.
  const cached = execSync("git diff --cached --name-only -z", {
    cwd: root,
    maxBuffer: 64 * 1024 * 1024,
  })
    .toString()
    .split("\0")
    .filter((file) => file !== "");
  return [...new Set([...listed, ...cached])];
}

function blocked(file) {
  return BLOCKED_PATH.test(file);
}

const args = process.argv.slice(2);
const history = args.includes("--history");
const staged = args.includes("--staged");
const root = args.find((arg) => !arg.startsWith("--")) ?? ".";
const findings = [];

for (const file of gitFiles(root, staged)) {
  if (blocked(file)) {
    findings.push({
      rule: "blocked-path",
      why: "capture or secret file must stay gitignored",
      file,
      line: 0,
      sample: file,
    });
    continue;
  }
  if (!TEXT_EXT.test(file)) continue;
  scanText(findings, readFileSync(join(root, file), "utf8"), file);
}

if (history && !staged) {
  const diff = execSync("git log -p --no-color --unified=0", {
    cwd: root,
    maxBuffer: 256 * 1024 * 1024,
  }).toString();
  let file = "";
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ b/")) file = line.slice(6);
    else if (line.startsWith("+") && !line.startsWith("+++") && !blocked(file)) {
      scanText(findings, line.slice(1), file);
    }
  }
}

const seen = new Set();
const unique = findings.filter((finding) => {
  const key = `${finding.rule}:${finding.file}:${finding.line}:${finding.sample}`;
  if (seen.has(key)) return false;
  seen.add(key);
  return true;
});

for (const finding of unique) {
  console.error(`LEAK ${finding.rule} (${finding.why}) ${finding.file}:${finding.line} "${finding.sample}"`);
}
console.error(`leak-scan: ${unique.length} finding(s)`);
process.exit(unique.length > 0 ? 1 : 0);
