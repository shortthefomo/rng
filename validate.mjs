// Consensus check for an AppLoader document. Kept in this repo so the dice
// page does not import the PWA repo. This follows
// appLoader::validate in Xahau/xahaud PR 793: UTF-8, no C0 controls other
// than HTML whitespace, opens with a doctype or <html>, and the last
// </html> has only whitespace after it. The cap is 4096 bytes.

export const MAX = 4096;

function isSpace(c) {
  return c === 9 || c === 10 || c === 12 || c === 13 || c === 32;
}

function isForbidden(c) {
  if (isSpace(c)) return false;
  return c < 32 || c === 127;
}

function lower(c) {
  return c >= 65 && c <= 90 ? c + 32 : c;
}

function matchAt(buf, pos, lit) {
  if (pos + lit.length > buf.length) return false;
  for (let i = 0; i < lit.length; i++) {
    if (lower(buf[pos + i]) !== lit.charCodeAt(i)) return false;
  }
  return true;
}

function findFrom(buf, from, lit) {
  for (let i = from; i + lit.length <= buf.length; i++) {
    if (matchAt(buf, i, lit)) return i;
  }
  return buf.length;
}

function tagEnd(c) {
  return isSpace(c) || c === 62 || c === 47;
}

export function validate(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(String(input));
  if (buf.length === 0) return "empty";
  if (buf.length > MAX) return "tooLarge";
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    return "badUTF8";
  }
  for (const c of buf) if (isForbidden(c)) return "badControlChar";

  let begin = 0;
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) begin = 3;
  while (begin < buf.length && isSpace(buf[begin])) begin++;
  if (begin === buf.length) return "empty";

  const opensDoctype =
    matchAt(buf, begin, "<!doctype") && begin + 9 < buf.length && isSpace(buf[begin + 9]);
  const opensHtml = matchAt(buf, begin, "<html") && begin + 5 < buf.length && tagEnd(buf[begin + 5]);
  if (!opensDoctype && !opensHtml) return "noDoctype";

  let open = begin;
  for (;;) {
    open = findFrom(buf, open, "<html");
    if (open === buf.length) return "noHtmlElement";
    if (open + 5 < buf.length && tagEnd(buf[open + 5])) break;
    open++;
  }

  let close = -1;
  let closeEnd = -1;
  let probe = open;
  for (;;) {
    const found = findFrom(buf, probe, "</html");
    if (found === buf.length) break;
    let j = found + 6;
    while (j < buf.length && isSpace(buf[j])) j++;
    if (j < buf.length && buf[j] === 62) {
      close = found;
      closeEnd = j + 1;
    }
    probe = found + 1;
  }
  if (close < 0) return "unclosed";
  for (let i = closeEnd; i < buf.length; i++) if (!isSpace(buf[i])) return "trailingGarbage";
  return "ok";
}
