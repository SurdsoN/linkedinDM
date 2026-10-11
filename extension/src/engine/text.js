/** Shared text helpers for the matching engines. */

const STOPWORDS = new Set(
  ('a an and are as at be by for from has have i in is it its of on or our that the their this to was we were with you your ' +
    'my me am will can about into over more most just also not but so if all any who what when where how why than then them ' +
    'they he she his her us very really new team teams work working company companies people help helping based years year experience')
    .split(' ')
);

export function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}+#. ]+/gu, ' ')
    .split(/\s+/)
    .map((w) => w.replace(/^\.+|\.+$/g, ''))
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
}
