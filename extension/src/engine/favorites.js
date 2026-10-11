/**
 * Favourite drafts are stored as reusable templates. Before saving, the
 * recipient's name and company are swapped for placeholders, so a favourite
 * never stores who it was first written for:
 *   {{firstName}}  recipient first name (or "<Company> team")
 *   {{name}}       recipient full name
 *   {{company}}    recipient's company (person) / the company itself (company page)
 */

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function recipientParts(target, recipientName = '') {
  const isCompany = target && target.entityType === 'company';
  const person = isCompany ? String(recipientName || '').trim() : String((target && target.name) || '').trim();
  const firstName = person ? person.split(/\s+/)[0] : isCompany ? `${target.name} team` : 'there';
  const company = isCompany ? target.name : (target && target.currentCompany) || '';
  return { name: person, firstName, company };
}

/** Replace recipient-specific words with placeholders. */
export function toTemplate(message, target, recipientName) {
  const { name, firstName, company } = recipientParts(target, recipientName);
  let t = String(message || '');
  // Longest first so "Daniel Mensah" wins over "Daniel".
  const pairs = [
    [name, '{{name}}'],
    [company, '{{company}}'],
    [firstName, '{{firstName}}'],
  ].filter(([v]) => v && v.length > 1);
  pairs.sort((a, b) => b[0].length - a[0].length);
  for (const [value, ph] of pairs) {
    t = t.replace(new RegExp(`(^|[^\\p{L}])${escapeRe(value)}(?=$|[^\\p{L}])`, 'gu'), `$1${ph}`);
  }
  return t;
}

/** Fill placeholders for the profile currently open. */
export function fillTemplate(template, target, recipientName) {
  const { name, firstName, company } = recipientParts(target, recipientName);
  return String(template || '')
    .replace(/\{\{name\}\}/g, name || firstName)
    .replace(/\{\{firstName\}\}/g, firstName)
    .replace(/\{\{company\}\}/g, company || 'your company');
}
