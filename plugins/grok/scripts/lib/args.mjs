/**
 * Minimal argv parser for the companion CLI.
 *
 * Supports `--flag`, `--key value`, `--key=value`, repeatable options, `--`
 * passthrough, and bare positionals. Unknown `--tokens` are kept as positionals
 * so a user's stray text never silently disappears.
 */

export function parseArgs(argv, config = {}) {
  const valueOptions = new Set(config.valueOptions ?? []);
  const booleanOptions = new Set(config.booleanOptions ?? []);
  const repeatOptions = new Set(config.repeatOptions ?? []);
  const aliases = config.aliases ?? {};

  const options = {};
  const positionals = [];
  let passthrough = false;

  const assign = (key, value) => {
    if (repeatOptions.has(key)) {
      options[key] = [...(options[key] ?? []), value];
      return;
    }
    options[key] = value;
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (passthrough) {
      positionals.push(token);
      continue;
    }

    if (token === "--") {
      passthrough = true;
      continue;
    }

    if (typeof token !== "string" || !token.startsWith("-") || token === "-") {
      positionals.push(token);
      continue;
    }

    const isLong = token.startsWith("--");
    const body = isLong ? token.slice(2) : token.slice(1);
    const separatorIndex = body.indexOf("=");
    const rawKey = separatorIndex === -1 ? body : body.slice(0, separatorIndex);
    const inlineValue = separatorIndex === -1 ? undefined : body.slice(separatorIndex + 1);
    const key = aliases[rawKey] ?? rawKey;

    if (booleanOptions.has(key)) {
      // `--flag=false` is the only way to negate; a bare `--flag` is true.
      assign(key, inlineValue === undefined ? true : inlineValue !== "false");
      continue;
    }

    if (valueOptions.has(key) || repeatOptions.has(key)) {
      const value = inlineValue ?? argv[index + 1];
      if (value === undefined) {
        throw new Error(`Missing value for ${isLong ? "--" : "-"}${rawKey}`);
      }
      assign(key, value);
      if (inlineValue === undefined) {
        index += 1;
      }
      continue;
    }

    positionals.push(token);
  }

  return { options, positionals };
}

/**
 * Split a raw `$ARGUMENTS` string the way a POSIX shell would, so a quoted
 * prompt survives as one token.
 */
export function splitArgumentString(raw) {
  if (typeof raw !== "string") {
    return [];
  }

  const tokens = [];
  let current = "";
  let started = false;
  let quote = null;
  let escaping = false;

  for (const character of raw) {
    if (escaping) {
      current += character;
      escaping = false;
      continue;
    }

    if (character === "\\" && quote !== "'") {
      escaping = true;
      started = true;
      continue;
    }

    if (quote) {
      if (character === quote) {
        quote = null;
      } else {
        current += character;
      }
      continue;
    }

    if (character === "'" || character === '"') {
      quote = character;
      started = true;
      continue;
    }

    if (/\s/.test(character)) {
      if (started) {
        tokens.push(current);
        current = "";
        started = false;
      }
      continue;
    }

    current += character;
    started = true;
  }

  if (escaping) {
    current += "\\";
    started = true;
  }

  if (started) {
    tokens.push(current);
  }

  return tokens;
}

/**
 * Parse a whole-number option, refusing anything outside `min`..`max` rather
 * than quietly changing it: the user gets what they asked for, or is told why not.
 */
export function parseWholeNumber(value, { flag, fallback, min, max }) {
  if (value === undefined || value === null) {
    return fallback;
  }
  const text = String(value).trim();
  const number = Number(text);
  if (!/^\d+$/.test(text) || number < min || number > max) {
    throw new Error(`${flag} ${value} is not a whole number from ${min} to ${max}.`);
  }
  return number;
}

/** Parse a positive integer option, falling back when absent or malformed. */
export function parseCount(value, { fallback = 1, min = 1, max = 8 } = {}) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, parsed));
}
