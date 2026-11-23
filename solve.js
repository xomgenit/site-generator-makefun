// site-generator-speed-01: a fast drop-in for makefun-site 1.0.0.
//
// run(input) returns, for one case's input, exactly the answer makefun-site 1.0.0's
// build returns: the output tree as a JSON object of path -> text, byte for byte.
// Written from the makefun-site spec (its vendor README) and its reference behaviour;
// every rule here is makefun-site's own (front matter, template dialect, Markdown
// subset, slug rule, report), not Hugo's, Zola's, Eleventy's or CommonMark's.
//
// Speed notes: the reference spends most of its time escaping HTML one character at
// a time through a regex, lexing Markdown into token objects, and matching /\S+/g
// over every body. This module instead escapes in single passes over clean runs,
// fuses Markdown lexing and rendering into one pass, counts words once per source
// with one /\S+/g match, memoises slugs, and renders templates into chunk arrays
// with reused loop scopes. No dependency, no I/O, no clock, no randomness.

// ---------------------------------------------------------------- text helpers

/** Combining marks, for the slug rule (NFKD then drop \p{M}). */
const MARK_RE = /\p{M}/gu;

/** Code-unit order (never the locale's). */
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * `s` with & < > " ' escaped. A single pass that copies clean runs whole; a
 * string with nothing to escape is returned as-is, with no allocation.
 */
function escStr(s) {
  let out = '';
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    let rep;
    if (c === 38) rep = '&amp;';
    else if (c === 60) rep = '&lt;';
    else if (c === 62) rep = '&gt;';
    else if (c === 34) rep = '&quot;';
    else if (c === 39) rep = '&#39;';
    else continue;
    if (start < i) out += s.slice(start, i);
    out += rep;
    start = i + 1;
  }
  if (start === 0) return s;
  if (start < s.length) out += s.slice(start);
  return out;
}

/** The escaped form of `s[a..b)` pushed as chunks onto `out` (no substring made). */
function escInto(s, a, b, out) {
  let start = a;
  for (let i = a; i < b; i++) {
    const c = s.charCodeAt(i);
    let rep;
    if (c === 38) rep = '&amp;';
    else if (c === 60) rep = '&lt;';
    else if (c === 62) rep = '&gt;';
    else if (c === 34) rep = '&quot;';
    else if (c === 39) rep = '&#39;';
    else continue;
    if (start < i) out.push(s.slice(start, i));
    out.push(rep);
    start = i + 1;
  }
  if (start < b) out.push(s.slice(start, b));
}

/**
 * The slug core of an already-normalised `plain`: A-Z lowered, every run of
 * characters other than a-z and 0-9 one "-", none at either end. Surrogate pairs
 * are two non-keeping code units here, which a gap absorbs exactly as the
 * reference's code-point loop does (a gap is boolean, and keeping chars are ASCII).
 */
function slugCore(plain) {
  let out = '';
  let gap = false;
  for (let i = 0, n = plain.length; i < n; i++) {
    const c = plain.charCodeAt(i);
    if (c >= 65 && c <= 90) {
      if (gap) {
        out += '-';
        gap = false;
      }
      out += String.fromCharCode(c + 32);
    } else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) {
      if (gap) {
        out += '-';
        gap = false;
      }
      out += plain[i];
    } else if (out.length > 0) {
      gap = true;
    }
  }
  return out;
}

/** Slugs are a pure function of their text, so they memoise across a whole run. */
const slugCache = new Map();

/**
 * The slug of `text`: NFKD, combining marks dropped, A-Z lowered, every run of
 * characters other than a-z and 0-9 one "-", none at either end, at most 64
 * characters (a "-" left at the cut dropped), "untitled" when nothing is left.
 * Pure ASCII text skips the normalise step: ASCII has no NFKD decomposition and
 * no combining mark, so the fast path is exact.
 */
function slugify(text) {
  const hit = slugCache.get(text);
  if (hit !== undefined) return hit;
  let ascii = true;
  for (let i = 0, n = text.length; i < n; i++) {
    if (text.charCodeAt(i) > 127) {
      ascii = false;
      break;
    }
  }
  let out = ascii ? slugCore(text) : slugCore(text.normalize('NFKD').replace(MARK_RE, ''));
  if (out.length > 64) out = out.slice(0, 64);
  let end = out.length;
  while (end > 0 && out.charCodeAt(end - 1) === 45) end--;
  if (end < out.length) out = out.slice(0, end);
  if (out === '') out = 'untitled';
  slugCache.set(text, out);
  return out;
}

/** `slug` made unique against `taken` (and added to it): slug, slug-2, slug-3 ... */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** A YYYY-MM-DD date in words, from the string alone: "2026-11-09" is "9 November 2026". */
function longDate(date) {
  const m = (date.charCodeAt(5) - 48) * 10 + (date.charCodeAt(6) - 48);
  const d = (date.charCodeAt(8) - 48) * 10 + (date.charCodeAt(9) - 48);
  return `${d} ${MONTHS[m - 1]} ${date.slice(0, 4)}`;
}

/** Whether code unit `c` is JavaScript whitespace (\s): the full set, exactly. */
function isWs(c) {
  return (
    c === 32 ||
    (c >= 9 && c <= 13) ||
    c === 160 ||
    c === 0x1680 ||
    (c >= 0x2000 && c <= 0x200a) ||
    c === 0x2028 ||
    c === 0x2029 ||
    c === 0x202f ||
    c === 0x205f ||
    c === 0x3000 ||
    c === 0xfeff
  );
}

/**
 * The words of `text`: its runs of characters other than whitespace. One native
 * match call: measured faster here than an exec loop or a hand scan (the hand
 * scan's non-ASCII fallback redoes the work on most bodies, since the generator
 * salts unicode words through them).
 */
function wordsOf(text) {
  const m = text.match(/\S+/g);
  return m === null ? 0 : m.length;
}

// ---------------------------------------------------------------- front matter

/** The days of month `m` (1-12) of year `y`, by the Gregorian rule. */
function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or bare, the rest of the line (never opening on " or [). */
function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** Whether `raw` is a slug: [a-z0-9]+(-[a-z0-9]+)*, at most 64 characters. */
function isSlugValue(raw) {
  if (raw.length === 0 || raw.length > 64) return false;
  const c0 = raw.charCodeAt(0);
  if (!((c0 >= 97 && c0 <= 122) || (c0 >= 48 && c0 <= 57))) return false;
  for (let i = 1; i < raw.length; i++) {
    const c = raw.charCodeAt(i);
    if (c === 45) {
      if (i + 1 >= raw.length) return false;
      const n = raw.charCodeAt(i + 1);
      if (!((n >= 97 && n <= 122) || (n >= 48 && n <= 57))) return false;
    } else if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57))) return false;
  }
  return true;
}

/** Whether `raw` is a template name: [a-z0-9-]+, at least one character. */
function isNameValue(raw) {
  if (raw.length === 0) return false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw.charCodeAt(i);
    if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45)) return false;
  }
  return true;
}

/** One key's value, or why it is refused. */
function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      let y = 0;
      let mo = 0;
      let d = 0;
      let ok = raw.length === 10 && raw.charCodeAt(4) === 45 && raw.charCodeAt(7) === 45;
      if (ok) {
        for (let i = 0; i < 10; i++) {
          if (i === 4 || i === 7) continue;
          const c = raw.charCodeAt(i);
          if (c < 48 || c > 57) {
            ok = false;
            break;
          }
        }
      }
      if (ok) {
        y = (raw.charCodeAt(0) - 48) * 1000 + (raw.charCodeAt(1) - 48) * 100 + (raw.charCodeAt(2) - 48) * 10 + (raw.charCodeAt(3) - 48);
        mo = (raw.charCodeAt(5) - 48) * 10 + (raw.charCodeAt(6) - 48);
        d = (raw.charCodeAt(8) - 48) * 10 + (raw.charCodeAt(9) - 48);
        if (y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) ok = false;
      }
      return ok ? { value: raw } : { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
    }
    case 'tags': {
      if (raw.length < 2 || raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const parts = inner.split(',');
      const tags = new Array(parts.length);
      for (let i = 0; i < parts.length; i++) {
        const t = parts[i].trim();
        if (t === '') return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
        for (let q = 0; q < t.length; q++) {
          const cc = t.charCodeAt(q);
          if (cc === 34 || cc === 91 || cc === 93) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
        }
        tags[i] = t;
      }
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return isNameValue(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return isSlugValue(raw) ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

/**
 * A source's front matter and body: { data, body }, or { error } with the first
 * reason it is refused. `text` has "\n" line ends. The reference splits the whole
 * source into lines and joins the body back; this finds the closing line with
 * indexOf and slices the body out, splitting only the front matter itself.
 */
function parseFrontMatter(text) {
  if (text.length < 3 || text.charCodeAt(0) !== 45 || text.charCodeAt(1) !== 45 || text.charCodeAt(2) !== 45) return { error: 'no front matter' };
  if (text.length !== 3 && text.charCodeAt(3) !== 10) return { error: 'no front matter' };
  let j = -1;
  let p = 3;
  for (;;) {
    const k = text.indexOf('\n---', p);
    if (k === -1) return { error: 'the front matter is not closed' };
    if (k + 4 === text.length || text.charCodeAt(k + 4) === 10) {
      j = k;
      break;
    }
    p = k + 1;
  }
  const data = {};
  // The front matter's lines: text[4..j). j === 3 means the closing line follows
  // the opening one at once, so there are no lines at all.
  const fmLines = j === 3 ? [] : text.slice(4, j).split('\n');
  for (let i = 0; i < fmLines.length; i++) {
    const line = fmLines[i];
    let blank = true;
    for (let q = 0; q < line.length; q++) {
      const cc = line.charCodeAt(q);
      if (cc !== 32 && cc !== 9) {
        blank = false;
        break;
      }
    }
    if (blank) continue;
    if (line.charCodeAt(0) === 35) continue;
    // `key: value`: a key of [a-z_]+, a colon, one space and the value.
    let q = 0;
    while (q < line.length) {
      const cc = line.charCodeAt(q);
      if ((cc >= 97 && cc <= 122) || cc === 95) q++;
      else break;
    }
    if (q === 0 || q >= line.length || line.charCodeAt(q) !== 58) return { error: `line ${i + 2} is not "key: value"` };
    const key = line.slice(0, q);
    let raw;
    if (q + 1 === line.length) raw = '';
    else if (line.charCodeAt(q + 1) === 32) raw = line.slice(q + 2);
    else return { error: `line ${i + 2} is not "key: value"` };
    let end = raw.length;
    while (end > 0) {
      const cc = raw.charCodeAt(end - 1);
      if (cc === 32 || cc === 9) end--;
      else break;
    }
    if (end < raw.length) raw = raw.slice(0, end);
    if (key !== 'title' && key !== 'date' && key !== 'tags' && key !== 'draft' && key !== 'layout' && key !== 'slug' && key !== 'summary') {
      return { error: `unknown key "${key}"` };
    }
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: j + 4 === text.length ? '' : text.slice(j + 5) };
}

// ---------------------------------------------------------------- Markdown

/** The characters a backslash escapes: \ ` * _ [ ] ( ) # + - . ! > */
const ESCAPABLE = new Uint8Array(128);
for (const ch of '\\`*_[]()#+-.!>') ESCAPABLE[ch.charCodeAt(0)] = 1;

/** The first `**` in `s[from..to)` outside a backslash escape, or -1. */
function findStrong(s, from, to) {
  for (let j = from; j + 1 < to; j++) {
    if (s.charCodeAt(j) === 92 && j + 1 < to && ESCAPABLE[s.charCodeAt(j + 1)]) {
      j++;
      continue;
    }
    if (s.charCodeAt(j) === 42 && s.charCodeAt(j + 1) === 42) return j;
  }
  return -1;
}

/** The first single `*` in `s[from..to)` (one whose run is not `**`), outside an escape, or -1. */
function findEm(s, from, to) {
  for (let j = from; j < to; j++) {
    const c = s.charCodeAt(j);
    if (c === 92 && j + 1 < to && ESCAPABLE[s.charCodeAt(j + 1)]) {
      j++;
      continue;
    }
    if (c !== 42) continue;
    if (j + 1 < to && s.charCodeAt(j + 1) === 42) {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

/** The first `]` in `s[from..to)` outside a backslash escape, or -1. */
function findClose(s, from, to) {
  for (let j = from; j < to; j++) {
    if (s.charCodeAt(j) === 92 && j + 1 < to && ESCAPABLE[s.charCodeAt(j + 1)]) {
      j++;
      continue;
    }
    if (s.charCodeAt(j) === 93) return j;
  }
  return -1;
}

const WS_RE = /\s/;

/** The next character the inline scan must handle: a Markdown special or an HTML escape character. */
const SPECIAL_RE = /[\\`*\[&<>"']/g;

/**
 * `s[a..b)` rendered inline into `out`; `link(target)` is a link's href. The
 * regex finds the next character that needs handling in native code, so clean
 * runs are sliced whole with no per-character loop; an escaped character is
 * never an HTML-escape character, so it is pushed raw. Ranges, not substrings,
 * so nested strong, emphasis and links allocate nothing for their inner text.
 * lastIndex is set afresh on every scan, so the recursive calls are safe.
 */
function inlineInto(s, a, b, link, out) {
  let i = a;
  let start = a;
  for (;;) {
    SPECIAL_RE.lastIndex = i;
    const m = SPECIAL_RE.exec(s);
    const j = m === null ? -1 : m.index;
    if (j === -1 || j >= b) break;
    const c = s.charCodeAt(j);
    if (start < j) out.push(s.slice(start, j));
    if (c === 38) {
      out.push('&amp;');
      i = j + 1;
    } else if (c === 60) {
      out.push('&lt;');
      i = j + 1;
    } else if (c === 62) {
      out.push('&gt;');
      i = j + 1;
    } else if (c === 34) {
      out.push('&quot;');
      i = j + 1;
    } else if (c === 39) {
      out.push('&#39;');
      i = j + 1;
    } else if (c === 92) {
      if (j + 1 < b && ESCAPABLE[s.charCodeAt(j + 1)]) {
        out.push(s[j + 1]);
        i = j + 2;
      } else {
        out.push('\\');
        i = j + 1;
      }
    } else if (c === 96) {
      const k = s.indexOf('`', j + 1);
      if (k !== -1 && k < b && k > j + 1) {
        out.push('<code>');
        escInto(s, j + 1, k, out);
        out.push('</code>');
        i = k + 1;
      } else {
        out.push('`');
        i = j + 1;
      }
    } else if (c === 42) {
      if (j + 1 < b && s.charCodeAt(j + 1) === 42) {
        const k = findStrong(s, j + 2, b);
        if (k > j + 2) {
          out.push('<strong>');
          inlineInto(s, j + 2, k, link, out);
          out.push('</strong>');
          i = k + 2;
        } else {
          out.push('**');
          i = j + 2;
        }
      } else {
        const k = findEm(s, j + 1, b);
        if (k > j + 1) {
          out.push('<em>');
          inlineInto(s, j + 1, k, link, out);
          out.push('</em>');
          i = k + 1;
        } else {
          out.push('*');
          i = j + 1;
        }
      }
    } else {
      // c === 91, '[': a link, or itself.
      const k = findClose(s, j + 1, b);
      const m2 = k !== -1 && k + 1 < b && s.charCodeAt(k + 1) === 40 ? s.indexOf(')', k + 2) : -1;
      const target = m2 !== -1 && m2 < b ? s.slice(k + 2, m2) : '';
      if (target !== '' && !WS_RE.test(target)) {
        out.push('<a href="');
        out.push(escStr(link(target)));
        out.push('">');
        inlineInto(s, j + 1, k, link, out);
        out.push('</a>');
        i = m2 + 1;
      } else {
        out.push('[');
        i = j + 1;
      }
    }
    start = i;
  }
  if (start < b) out.push(s.slice(start, b));
}

/** Whether `line` is blank: empty, or spaces and tabs only. */
function isBlank(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A fence's language, or null: ``` then [A-Za-z0-9_+-]*, then spaces or tabs only. */
function fenceOpen(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let i = 3;
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45) i++;
    else break;
  }
  const langEnd = i;
  for (; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return null;
  }
  return line.slice(3, langEnd);
}

/** Whether `line` closes a fence: ``` then spaces or tabs only. */
function isFenceClose(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A heading line's level and text, or null (a heading's text is never empty). */
function headingOf(line) {
  let d = 0;
  while (d < line.length && line.charCodeAt(d) === 35) d++;
  if (d === 0 || d > 6) return null;
  if (d >= line.length) return null;
  const c = line.charCodeAt(d);
  if (c !== 32 && c !== 9) return null;
  let s = d;
  while (s < line.length) {
    const cc = line.charCodeAt(s);
    if (cc === 32 || cc === 9) s++;
    else break;
  }
  let e = line.length;
  while (e > s) {
    const cc = line.charCodeAt(e - 1);
    if (cc === 32 || cc === 9) e--;
    else break;
  }
  if (e === s) return null;
  return { depth: d, text: line.slice(s, e) };
}

/** Whether `line` is a thematic break: --- or ***, then spaces or tabs only. */
function isHR(line) {
  const c0 = line.charCodeAt(0);
  if (c0 !== 45 && c0 !== 42) return false;
  if (line.charCodeAt(1) !== c0 || line.charCodeAt(2) !== c0) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A line with spaces and tabs at either end dropped (the same string when there are none). */
function trimLine(line) {
  let s = 0;
  let e = line.length;
  while (s < e) {
    const c = line.charCodeAt(s);
    if (c === 32 || c === 9) s++;
    else break;
  }
  while (e > s) {
    const c = line.charCodeAt(e - 1);
    if (c === 32 || c === 9) e--;
    else break;
  }
  return s === 0 && e === line.length ? line : line.slice(s, e);
}

/** Whether `line` ends a paragraph: a blank line, a fence, a heading or a thematic break. */
function endsParagraph(line) {
  const c0 = line.charCodeAt(0);
  if (c0 === 32 || c0 === 9) return isBlank(line);
  if (line.length === 0) return true;
  if (c0 === 96) return fenceOpen(line) !== null;
  if (c0 === 35) return headingOf(line) !== null;
  if (c0 === 45 || c0 === 42) return isHR(line);
  return false;
}

/** A bullet item's rest, or null: "- " or "* " then the rest. */
function bulletOf(line) {
  const c0 = line.charCodeAt(0);
  if ((c0 === 45 || c0 === 42) && line.charCodeAt(1) === 32) return line.slice(2);
  return null;
}

/** An ordered item's number and rest, or null: 1-9 digits, ". ", then the rest. */
function orderedOf(line) {
  let i = 0;
  while (i < line.length && i < 9) {
    const c = line.charCodeAt(i);
    if (c >= 48 && c <= 57) i++;
    else break;
  }
  if (i === 0) return null;
  if (line.charCodeAt(i) !== 46 || line.charCodeAt(i + 1) !== 32) return null;
  return { num: line.slice(0, i), rest: line.slice(i + 2) };
}

/** Whether `line` continues a list item: two or more spaces, then a non-space. */
function isContinued(line) {
  if (line.charCodeAt(0) !== 32 || line.charCodeAt(1) !== 32) return false;
  let i = 2;
  while (i < line.length && line.charCodeAt(i) === 32) i++;
  return i < line.length && !isWs(line.charCodeAt(i));
}

/**
 * `src` rendered: its HTML (each block on its own lines, a "\n" after the last),
 * its table of contents (every level 2 and 3 heading: level, id and its inline
 * HTML) and its excerpt (the first paragraph's inline HTML, or "").
 *
 * The reference lexes blocks into token objects and then renders them; this
 * renders each block as it is lexed, straight into the output chunks, so no
 * token object is ever made.
 */
function renderMarkdown(src, link) {
  const lines = src.split('\n');
  const n = lines.length;
  const out = [];
  const toc = [];
  const ids = new Set();
  let excerpt = null;
  let i = 0;
  while (i < n) {
    const line = lines[i];
    // Dispatch on the first character: most lines are paragraphs, and a line's
    // first character rules out nearly every other block (a space-led line is
    // blank or a paragraph; a letter-led line is always a paragraph).
    const c0 = line.charCodeAt(0);
    let bullet = null;
    let ordered = null;
    if (c0 === 32 || c0 === 9) {
      if (isBlank(line)) {
        i++;
        continue;
      }
    } else if (line.length === 0) {
      i++;
      continue;
    } else if (c0 === 96) {
      const lang = fenceOpen(line);
      if (lang !== null) {
        const body = [];
        i++;
        while (i < n && !isFenceClose(lines[i])) body.push(lines[i++]);
        i++;
        out.push('<pre><code');
        if (lang !== '') {
          // A language holds only [A-Za-z0-9_+-], none of which the escape table names.
          out.push(' class="language-', lang, '"');
        }
        out.push('>');
        if (body.length > 0) {
          // Each line is escaped and ends in \n; \n itself is never escaped, so
          // escaping the joined lines and adding one \n is the same text.
          const joined = body.length === 1 ? body[0] : body.join('\n');
          escInto(joined, 0, joined.length, out);
          out.push('\n');
        }
        out.push('</code></pre>\n');
        continue;
      }
    } else if (c0 === 35) {
      const heading = headingOf(line);
      if (heading !== null) {
        const id = uniqueSlug(slugify(heading.text), ids);
        const tmp = [];
        inlineInto(heading.text, 0, heading.text.length, link, tmp);
        const html = tmp.join('');
        out.push(`<h${heading.depth} id="${id}">`, html, `</h${heading.depth}>\n`);
        if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html });
        i++;
        continue;
      }
    } else if (c0 === 45 || c0 === 42) {
      if (isHR(line)) {
        out.push('<hr>\n');
        i++;
        continue;
      }
      bullet = bulletOf(line);
    } else if (c0 === 62) {
      const parts = [];
      while (i < n && lines[i].charCodeAt(0) === 62) {
        let q = lines[i].slice(1);
        if (q.charCodeAt(0) === 32) q = q.slice(1);
        q = trimLine(q);
        if (q !== '') parts.push(q);
        i++;
      }
      if (parts.length === 0) out.push('<blockquote>\n</blockquote>\n');
      else {
        const joined = parts.length === 1 ? parts[0] : parts.join('\n');
        out.push('<blockquote>\n<p>');
        inlineInto(joined, 0, joined.length, link, out);
        out.push('</p>\n</blockquote>\n');
      }
      continue;
    } else if (c0 >= 48 && c0 <= 57) {
      ordered = orderedOf(line);
    }
    if (bullet !== null || ordered !== null) {
      const isOrdered = ordered !== null;
      const start = isOrdered ? Number(ordered.num) : 1;
      const items = [];
      if (isOrdered) items.push([trimLine(ordered.rest)]);
      else items.push([trimLine(bullet)]);
      i++;
      while (i < n) {
        if (isOrdered) {
          const m = orderedOf(lines[i]);
          if (m !== null) {
            items.push([trimLine(m.rest)]);
            i++;
            continue;
          }
        } else {
          const m = bulletOf(lines[i]);
          if (m !== null) {
            items.push([trimLine(m)]);
            i++;
            continue;
          }
        }
        if (isContinued(lines[i])) {
          items[items.length - 1].push(trimLine(lines[i]));
          i++;
        } else break;
      }
      if (isOrdered && start !== 1) out.push(`<ol start="${start}">\n`);
      else out.push(isOrdered ? '<ol>\n' : '<ul>\n');
      for (const parts of items) {
        const joined = parts.length === 1 ? parts[0] : parts.join('\n');
        out.push('<li>');
        inlineInto(joined, 0, joined.length, link, out);
        out.push('</li>\n');
      }
      out.push(isOrdered ? '</ol>\n' : '</ul>\n');
      continue;
    }
    const body = [trimLine(line)];
    i++;
    while (i < n && !endsParagraph(lines[i])) body.push(trimLine(lines[i++]));
    const joined = body.length === 1 ? body[0] : body.join('\n');
    if (excerpt === null) {
      const tmp = [];
      inlineInto(joined, 0, joined.length, link, tmp);
      excerpt = tmp.join('');
      out.push('<p>', excerpt, '</p>\n');
    } else {
      out.push('<p>');
      inlineInto(joined, 0, joined.length, link, out);
      out.push('</p>\n');
    }
  }
  return { html: out.join(''), toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- templates

/** The deepest an include nests: one past it renders nothing. */
const INCLUDE_DEPTH = 8;

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** Whether every character of `src[a..b)` is a space or a tab. */
function isWsRange(src, a, b) {
  for (let i = a; i < b; i++) {
    const c = src.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = isWsRange(src, lineStart, open) && isWsRange(src, end, lineEnd);
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

/** The value at `path` in the scope chain: its first name from the nearest scope holding it, then own properties. */
function lookup(scope, path) {
  let s = scope;
  const first = path[0];
  while (s !== null && !Object.hasOwn(s.vars, first)) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[first];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/**
 * `nodes` rendered in `scope` ({ vars, parent }) into `out`. `templates` is the
 * parsed templates (a template that did not parse absent); `depth` is the
 * include depth. Where the reference returns a fresh string per node and builds
 * a scope object per loop iteration, this pushes chunks onto one array and
 * reuses one scope object per loop invocation, mutating its element and loop
 * record per iteration (rendering is synchronous, so nothing observes the reuse;
 * a re-entrant include is a fresh invocation with its own scope). The loop
 * record is set after the element, so a loop over the name "loop" still binds
 * the record, as the reference's object literal does.
 */
function renderNodes(nodes, scope, templates, depth, out) {
  for (let ni = 0; ni < nodes.length; ni++) {
    const n = nodes[ni];
    switch (n.kind) {
      case 'text':
        out.push(n.text);
        break;
      case 'var': {
        const v = lookup(scope, n.path);
        out.push(escStr(typeof v === 'string' ? v : textOf(v)));
        break;
      }
      case 'raw': {
        const v = lookup(scope, n.path);
        const t = typeof v === 'string' ? v : textOf(v);
        if (t !== '') out.push(t);
        break;
      }
      case 'if': {
        const v = truthy(lookup(scope, n.path));
        const branch = v !== n.not ? n.then : n.else;
        if (branch !== null) renderNodes(branch, scope, templates, depth, out);
        break;
      }
      case 'for': {
        const xs = lookup(scope, n.path);
        if (!Array.isArray(xs)) break;
        const loop = { index: 0, first: true, last: false, length: xs.length };
        const vars = { loop };
        const child = { vars, parent: scope };
        for (let k = 0; k < xs.length; k++) {
          vars[n.name] = xs[k];
          vars.loop = loop;
          loop.index = k + 1;
          loop.first = k === 0;
          loop.last = k === xs.length - 1;
          renderNodes(n.body, child, templates, depth, out);
        }
        break;
      }
      case 'include': {
        const t = templates.get(n.name);
        if (t !== undefined && depth < INCLUDE_DEPTH) renderNodes(t, scope, templates, depth + 1, out);
        break;
      }
    }
  }
}

// ---------------------------------------------------------------- the build

/** The report file every build writes. */
const REPORT_FILE = 'build-report.txt';

/** The top-level directories the generator writes itself, which no page's slug at the root may take. */
const RESERVED = ['posts', 'tags', 'page'];

/** `rel` (a link's path, "/"-separated) from the directory parts `dirParts`, or null when it climbs out of the root. */
function resolvePath(dirParts, rel) {
  const parts = dirParts.slice();
  let i = 0;
  const n = rel.length;
  while (i <= n) {
    let j = rel.indexOf('/', i);
    if (j === -1) j = n;
    const seg = rel.slice(i, j);
    if (seg !== '' && seg !== '.') {
      if (seg === '..') {
        if (parts.length === 0) return null;
        parts.pop();
      } else parts.push(seg);
    }
    i = j + 1;
  }
  return parts.join('/');
}

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** Whether `target` opens with a scheme (`https:`, `mailto:` ...): a letter, then letters, digits, +, -, . and a colon. */
function hasScheme(target) {
  const c0 = target.charCodeAt(0);
  if (!((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122))) return false;
  let j = 1;
  while (j < target.length) {
    const c = target.charCodeAt(j);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 43 || c === 45 || c === 46) j++;
    else break;
  }
  return j < target.length && target.charCodeAt(j) === 58;
}

/** A page's link record as templates read it. */
const linkOf = (s) =>
  s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.dateLong };

/** One site's output tree: path -> text. */
function build(input) {
  // Templates, parsed in code-unit order of name; one that does not parse is
  // reported and left out, as if it were not there.
  const templates = new Map();
  const report = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  let base = input.site.base_url;
  let be = base.length;
  while (be > 0 && base.charCodeAt(be - 1) === 47) be--;
  if (be < base.length) base = base.slice(0, be);

  // 1. The sources, in code-unit order of their paths, line ends made "\n".
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      const text = f.content.indexOf('\r') === -1 ? f.content : f.content.replace(/\r\n?/g, '\n');
      sources.push({ path: f.path, text });
    } else statics.push({ path: f.path, content: f.content });
  }

  // 2. Each source's front matter: a refused source is reported and dropped, and so is a draft.
  const kept = [];
  let pageCount = 0;
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    const own = s.path.startsWith('tags/') ? 'tags' : s.path.startsWith('page/') ? 'page' : undefined;
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    if (!s.post) pageCount++;
    kept.push(s);
  }

  // 3. Each page's output directory and url: its slug made unique in its directory, in source order.
  const taken = new Map();
  const bySource = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), set);
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // 4. Each body's Markdown, its links resolved to the pages and static files they name.
  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  for (const s of kept) {
    const dir = dirOf(s.path);
    const dirParts = dir === '' ? [] : dir.split('/');
    const link = (target) => {
      if (hasScheme(target) || target.charCodeAt(0) === 47 || target.charCodeAt(0) === 35) return target;
      const hash = target.indexOf('#');
      const rel = hash === -1 ? target : target.slice(0, hash);
      const frag = hash === -1 ? '' : target.slice(hash);
      const path = rel === '' ? null : resolvePath(dirParts, rel);
      if (path !== null && bySource.has(path)) return `${bySource.get(path).url}${frag}`;
      if (path !== null && staticPaths.has(path)) return `${base}/${path}${frag}`;
      broken.add(`broken-link ${s.path} -> ${target}`);
      return target;
    };
    const md = renderMarkdown(s.body, link);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
    // Memoized once here: both cardOf and pageOf need these, and posts would otherwise pay for them twice.
    s.readingMinutes = Math.max(1, Math.ceil(wordsOf(s.body) / 200));
    s.dateLong = s.data.date === undefined ? '' : longDate(s.data.date);
  }

  // 5. The posts, newest first and then by slug; each post's newer and older neighbours.
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // 6. The tags: grouped by their slug, each named as first met in the posts' order, ordered by count and then slug.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const slug = slugify(name);
      if (!seen.has(slug)) {
        seen.add(slug);
        out.push(name);
      }
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        // The template-visible link object, shared by every page that lists this tag.
        tag.link = { name, slug, url: tag.url };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) {
    if (s.post) continue;
    s.tagRefs = ownTags(s).map((name) => {
      const slug = slugify(name);
      const tag = bySlug.get(slug);
      if (tag !== undefined) return tag;
      const link = { name, slug, url: '' };
      return { name, slug, url: '', posts: [], link };
    });
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));
  for (const s of kept) s.tagLinks = s.tagRefs.map((t) => t.link);

  // 7. Every page through its layout, the index pages and the tag pages through theirs.
  const cardOf = (s) => ({
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.dateLong,
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: s.readingMinutes,
    tags: s.tagLinks,
  });
  const pageOf = (s) => ({
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.dateLong,
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: s.readingMinutes,
    tags: s.tagLinks,
    slug: s.slug,
    content: s.html,
    toc: s.toc,
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  });
  const cards = new Map(posts.map((p) => [p, cardOf(p)]));
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const output = {};
  // One root scope per kind of page, reused across renders: the reference builds
  // a fresh { site, tags, recent, ...vars } object per render. Each scope holds
  // only its own kind's keys (a page scope never holds `posts`), so no render
  // can see a stale key from another kind; rendering only reads the scope.
  const pageVars = { site, tags: allTags, recent, page: null };
  const pageScope = { vars: pageVars, parent: null };
  for (const s of kept) {
    pageVars.page = pageOf(s);
    const out = [];
    renderNodes(templates.get(s.layout), pageScope, templates, 0, out);
    output[`${s.outDir}/index.html`] = out.join('');
  }
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  const indexNodes = templates.get('index');
  if (indexNodes !== undefined) {
    const indexVars = { site, tags: allTags, recent, posts: null, pager: null };
    const indexScope = { vars: indexVars, parent: null };
    for (let k = 1; k <= pages; k++) {
      indexVars.posts = posts.slice((k - 1) * per, k * per).map((p) => cards.get(p));
      indexVars.pager = { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) };
      const out = [];
      renderNodes(indexNodes, indexScope, templates, 0, out);
      output[k === 1 ? 'index.html' : `page/${k}/index.html`] = out.join('');
    }
  }
  const tagNodes = templates.get('tag');
  if (tagNodes !== undefined) {
    const tagVars = { site, tags: allTags, recent, tag: null };
    const tagScope = { vars: tagVars, parent: null };
    for (const t of tags) {
      tagVars.tag = { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) };
      const out = [];
      renderNodes(tagNodes, tagScope, templates, 0, out);
      output[`tags/${t.slug}/index.html`] = out.join('');
    }
  }
  const tagsNodes = templates.get('tags');
  if (tagsNodes !== undefined) {
    const out = [];
    renderNodes(tagsNodes, { vars: { site, tags: allTags, recent }, parent: null }, templates, 0, out);
    output['tags/index.html'] = out.join('');
  }
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // 8. The report: every refusal, draft, broken link and template that did not parse, sorted, then the counts.
  const lines = [...report, ...broken].sort(byCodeUnits);
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output[REPORT_FILE] = `${lines.join('\n')}\n`;
  return output;
}

export function run(input) {
  return build(input);
}




