/**
 * LinkedIn DM Architect — Profile Extraction Engine
 * -------------------------------------------------
 * One extractor for every LinkedIn profile page: the user's own profile
 * (for "Sync My Profile") and any target profile (for DM generation).
 *
 * Design notes
 * - LinkedIn's class names are obfuscated and change often, so extraction is
 *   anchored on things that are stable-ish: section anchor ids
 *   (<div id="experience">), section <h2> headings, list items, and the
 *   `span[aria-hidden="true"]` pattern LinkedIn uses for visible text (each
 *   visible string is duplicated in a `.visually-hidden` span for screen
 *   readers; reading only the aria-hidden copy avoids doubled text).
 * - Every parser works on plain "lines" of text pulled from a list item, so a
 *   markup change usually degrades one field instead of breaking everything.
 * - The extractor only reads `document` — the page the user already has open.
 *   It never fetches other pages or profiles.
 *
 * This file is a classic script (content scripts cannot be ES modules in MV3).
 * It exposes `globalThis.LDAExtractor`, and also `module.exports` so the
 * same code runs in the Node/Playwright test harness.
 */
(function (root) {
  'use strict';

  const SCHEMA_VERSION = 1;

  // Section anchor ids LinkedIn uses on the main profile page, with heading
  // text fallbacks for when the anchors move.
  const SECTIONS = {
    about: { ids: ['about'], headings: ['about'] },
    experience: { ids: ['experience'], headings: ['experience'] },
    education: { ids: ['education'], headings: ['education'] },
    skills: { ids: ['skills'], headings: ['skills'] },
    featured: { ids: ['featured'], headings: ['featured'] },
    activity: { ids: ['content_collections', 'recent_activity', 'activity'], headings: ['activity'] },
    certifications: { ids: ['licenses_and_certifications'], headings: ['licenses & certifications', 'licenses and certifications'] },
    projects: { ids: ['projects'], headings: ['projects'] },
    volunteering: { ids: ['volunteering_experience'], headings: ['volunteering', 'volunteer experience'] },
    honors: { ids: ['honors_and_awards'], headings: ['honors & awards', 'honors and awards'] },
    languages: { ids: ['languages'], headings: ['languages'] },
    publications: { ids: ['publications'], headings: ['publications'] },
  };

  // `/in/<slug>/details/<segment>/` → section key.
  const DETAILS_SEGMENTS = {
    experience: 'experience',
    education: 'education',
    skills: 'skills',
    featured: 'featured',
    certifications: 'certifications',
    projects: 'projects',
    'volunteering-experiences': 'volunteering',
    'honors': 'honors',
    languages: 'languages',
    publications: 'publications',
  };

  // UI chrome that shows up inside list items and is never profile content.
  const NOISE = [
    /^show all\b/i,
    /^show (more|less)\b/i,
    /^(…|\.\.\.)?\s*see (more|less)$/i,
    /^(…|\.\.\.)\s*more$/i,
    /^show credential$/i,
    /^show project$/i,
    /^show publication$/i,
    /^endorse$/i,
    /^endorsed$/i,
    /^\d+\s+endorsements?$/i,
    /^endorsed by\b/i,
    /^(message|connect|follow|following|more|pending|remove)$/i,
    /^(like|comment|repost|send|share)$/i,
    /^\d+\s+(comments?|reposts?|likes?|reactions?)$/i,
    /^(edit|add|delete)$/i,
    /^(follow|unfollow) \S/i,
    /^create a post$/i,
    /^see all\b/i,
    /^(load more|view more)\b/i,
    /^contact info$/i,
    /^·$/,
  ];

  const MONTH = '(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?';
  // "Jan 2020 - Present · 4 yrs 2 mos", "2014 - 2018", "Mar 2021 – Dec 2022"
  const DATE_RANGE_RE = new RegExp(
    `^((?:${MONTH}\\s+)?(?:19|20)\\d{2})\\s*[-–—]\\s*(present|(?:${MONTH}\\s+)?(?:19|20)\\d{2})(?:\\s*·\\s*(.+))?$`,
    'i'
  );
  // Single date, e.g. "Issued Jan 2023", "2019", "Jun 2022 · 3 mos".
  const SINGLE_DATE_RE = new RegExp(`^(?:issued\\s+)?((?:${MONTH}\\s+)?(?:19|20)\\d{2})(?:\\s*·\\s*(.+))?$`, 'i');
  const DURATION_RE = /^(?:\d+\s+(?:yrs?|years?|mos?|months?)\s*){1,2}$/i;
  const EMPLOYMENT_TYPES = [
    'full-time', 'part-time', 'self-employed', 'freelance', 'contract', 'internship',
    'apprenticeship', 'seasonal', 'temporary', 'permanent', 'permanent full-time', 'permanent part-time',
  ];
  const WORK_MODES = /\b(remote|hybrid|on-site|onsite)\b/i;

  // ---------------------------------------------------------------------------
  // Text helpers
  // ---------------------------------------------------------------------------

  function clean(s) {
    return String(s == null ? '' : s)
      .replace(/ /g, ' ')
      .replace(/[ \t\f\v]+/g, ' ')
      .replace(/\s*\n\s*/g, '\n')
      .trim();
  }

  function oneLine(s) {
    return clean(s).replace(/\n+/g, ' ').trim();
  }

  function isNoise(line) {
    return !line || NOISE.some((re) => re.test(line));
  }

  const HIDDEN_SELECTOR =
    '.visually-hidden, .a11y-text, .sr-only, script, style, noscript, svg, button, [role="button"], template';

  /**
   * Pull the visible text lines out of an element, in DOM order.
   * Strategy 1: outermost `span[aria-hidden="true"]` descendants (LinkedIn's
   * visible-text convention). Strategy 2: walk text nodes, skipping screen
   * reader-only copies, buttons and icons.
   * Works on detached clones too (no layout / innerText dependency).
   */
  function linesOf(el, opts) {
    if (!el) return [];
    const options = opts || {};
    let raw = [];

    const spans = Array.from(el.querySelectorAll('span[aria-hidden="true"]')).filter((s) => {
      const outer = s.parentElement && s.parentElement.closest('span[aria-hidden="true"]');
      if (outer && el.contains(outer)) return false; // nested; outer one wins
      if (s.closest('button') && el.contains(s.closest('button'))) return false;
      return true;
    });

    // Old layout: every visible string is an aria-hidden span with a
    // .visually-hidden twin for screen readers — read only the visible copy.
    // Current layout: aria-hidden marks only icons and "·" separators and there
    // are no twins, so reading just those spans would drop the real text.
    const hasTwins = !!el.querySelector('.visually-hidden, .a11y-text, .sr-only') || (el.matches && el.matches('.visually-hidden, .a11y-text, .sr-only'));
    if (spans.length && hasTwins) {
      raw = spans.map((s) => clean(s.textContent));
    } else {
      raw = walkText(el);
    }

    const out = [];
    for (const chunk of raw) {
      for (const piece of options.keepNewlines ? [chunk] : chunk.split('\n')) {
        const line = options.keepNewlines ? clean(piece) : oneLine(piece);
        if (!line || isNoise(line)) continue;
        if (out.length && out[out.length - 1] === line) continue; // consecutive dupes
        out.push(line);
      }
    }
    return out;
  }

  function walkText(el) {
    const doc = el.ownerDocument || document;
    const NodeFilterRef = (doc.defaultView && doc.defaultView.NodeFilter) || root.NodeFilter;
    const walker = doc.createTreeWalker(el, NodeFilterRef.SHOW_TEXT, {
      acceptNode(node) {
        const parent = node.parentElement;
        if (!parent) return NodeFilterRef.FILTER_REJECT;
        const hidden = parent.closest(HIDDEN_SELECTOR);
        if (hidden && el.contains(hidden)) return NodeFilterRef.FILTER_REJECT;
        return node.textContent.trim() ? NodeFilterRef.FILTER_ACCEPT : NodeFilterRef.FILTER_REJECT;
      },
    });
    // Merge text nodes that share a parent so "foo <b>bar</b>" stays one line.
    const groups = [];
    let lastParent = null;
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const block = n.parentElement.closest('p, li, div, span, h1, h2, h3, h4, a') || n.parentElement;
      const outer = n.parentElement.closest('p, li, div, h1, h2, h3, h4, h5, h6, dd, dt, td, section, article') || n.parentElement;
      if (block === lastParent && groups.length) groups[groups.length - 1].text += ' ' + n.textContent;
      else groups.push({ text: n.textContent, outer });
      lastParent = block;
    }
    // "Acme" <span>·</span> "Full-time" in one block → "Acme · Full-time"
    // (LinkedIn renders its separators as separate aria-hidden spans).
    const merged = [];
    for (let i = 0; i < groups.length; i++) {
      const g = groups[i];
      const prev = merged[merged.length - 1];
      const next = groups[i + 1];
      if (/^\s*[·•]\s*$/.test(g.text) && prev && next && prev.outer === g.outer && next.outer === g.outer) {
        prev.text = `${clean(prev.text)} · ${clean(next.text)}`;
        i++;
        continue;
      }
      merged.push({ ...g });
    }
    return merged.map((g) => clean(g.text));
  }

  function textOf(el) {
    return el ? oneLine(linesOf(el).join(' ')) : '';
  }

  /** First non-empty text among a list of selectors (scoped to `scope`). */
  function firstText(scope, selectors) {
    for (const sel of selectors) {
      const el = scope.querySelector(sel);
      const t = el && oneLine(el.textContent);
      if (t) return t;
    }
    return '';
  }

  function uniq(arr) {
    const seen = new Set();
    return arr.filter((x) => {
      const k = typeof x === 'string' ? x.toLowerCase() : JSON.stringify(x);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }

  function absUrl(href, doc) {
    if (!href) return '';
    try {
      const u = new URL(href, (doc && doc.location && doc.location.href) || 'https://www.linkedin.com/');
      // Strip tracking params; keep path-only URLs readable.
      u.search = '';
      u.hash = '';
      return u.href;
    } catch (_) {
      return '';
    }
  }

  // ---------------------------------------------------------------------------
  // Page / URL helpers
  // ---------------------------------------------------------------------------

  // Company sub-tabs that show company content we can read.
  const COMPANY_SUBPAGES = ['', 'about', 'posts', 'jobs', 'people', 'life', 'insights'];

  /**
   * Classify a LinkedIn URL.
   * - Person:  /in/<slug>/ (+ /details/<section>/ and /overlay/...)
   * - Company: /company/<slug>/ (+ about, posts, jobs, people, life)
   * @returns {{isProfile:boolean, entityType:'person'|'company'|null, slug:string,
   *            pageType:'profile'|'details'|'other', detailsSection:string|null, subpage:string}}
   */
  function parseProfileUrl(href) {
    const none = { isProfile: false, entityType: null, slug: '', pageType: 'other', detailsSection: null, subpage: '' };
    let url;
    try {
      url = new URL(href);
    } catch (_) {
      return none;
    }
    if (!/(^|\.)linkedin\.com$/i.test(url.hostname)) return none;
    const m = url.pathname.match(/^\/(in|company)\/([^/]+)\/?(.*)$/);
    if (!m) return none;
    const entityType = m[1] === 'in' ? 'person' : 'company';
    let slug = m[2];
    try {
      slug = decodeURIComponent(slug);
    } catch (_) { /* keep raw */ }
    const rest = (m[3] || '').replace(/\/+$/, '');

    if (entityType === 'company') {
      const subpage = rest.split('/')[0];
      const known = COMPANY_SUBPAGES.includes(subpage);
      return { isProfile: true, entityType, slug, pageType: known ? 'profile' : 'other', detailsSection: null, subpage: known ? subpage : '' };
    }

    const d = rest.match(/^details\/([^/]+)/);
    if (d) {
      return { isProfile: true, entityType, slug, pageType: 'details', detailsSection: DETAILS_SEGMENTS[d[1]] || d[1], subpage: '' };
    }
    // Overlays like /overlay/contact-info/ still show the main profile behind.
    if (rest === '' || /^overlay\//.test(rest)) {
      return { isProfile: true, entityType, slug, pageType: 'profile', detailsSection: null, subpage: '' };
    }
    return { isProfile: true, entityType, slug, pageType: 'other', detailsSection: null, subpage: '' };
  }

  /**
   * The element holding the profile. LinkedIn pages can contain more than one
   * <main> (or none), so prefer the one that holds profile markers.
   */
  function mainRoot(doc) {
    const mains = Array.from(doc.querySelectorAll('main, [role="main"]'));
    if (mains.length === 1) return mains[0];
    if (mains.length > 1) {
      const marked = mains.find((m) => m.querySelector('[id="experience"], [id="about"], h1, .text-heading-xlarge'));
      if (marked) return marked;
      return mains.sort((a, b) => (b.textContent || '').length - (a.textContent || '').length)[0];
    }
    return doc.body;
  }

  /** "(3) Jane Doe | LinkedIn" → "Jane Doe". The tab title is the most stable source of the name. */
  function nameFromTitle(doc) {
    let t = oneLine(doc.title || '').replace(/^\(\d+\+?\)\s*/, '');
    t = t.replace(/\s*[|–—-]\s*LinkedIn\s*$/i, '').trim();
    if (!t || /^(linkedin|feed|messaging|notifications|my network|jobs|search)\b/i.test(t)) return '';
    // Company/school titles look like "Acme: Overview | LinkedIn".
    return t.replace(/:\s*(overview|about|posts|jobs|people|life)$/i, '').trim();
  }

  /** Smallest element in `scope` whose whole text equals `text`. */
  function findTextElement(scope, text) {
    if (!text) return null;
    const target = text.toLowerCase();
    const els = scope.querySelectorAll('h1, h2, h3, a, span, p, div');
    let best = null;
    for (let i = 0; i < els.length && i < 6000; i++) {
      const el = els[i];
      if (el.closest(HIDDEN_SELECTOR)) continue;
      const t = oneLine(el.textContent).toLowerCase();
      if (t === target) best = el; // later matches are deeper (more specific) in document order
      else if (best && !best.contains(el)) break;
    }
    return best;
  }

  /** Climb from a heading to the block that holds its section's content. */
  function containerFor(heading) {
    let el = heading;
    for (let i = 0; i < 8 && el.parentElement; i++) {
      el = el.parentElement;
      if (el.tagName === 'SECTION') return el;
      if (el.querySelector('li') && oneLine(el.textContent).length > oneLine(heading.textContent).length + 20) return el;
    }
    return heading.parentElement;
  }

  /** Locate a profile section, then make sure the container actually holds its entries. */
  function findSection(doc, key) {
    const sec = locateSection(doc, key);
    return sec ? expandToContent(sec, key, mainRoot(doc)) : null;
  }

  const DATED_SECTIONS = ['experience', 'education', 'volunteering', 'certifications', 'projects', 'honors', 'publications'];

  /** Section headings (h2/h3) inside `el` that belong to a different section. */
  function otherSectionHeadings(el, key) {
    const mine = SECTIONS[key].headings;
    const others = Object.entries(SECTIONS).filter(([k]) => k !== key).flatMap(([, v]) => v.headings);
    return Array.from(el.querySelectorAll('h2, h3, [role="heading"]')).filter((h) => {
      const t = (linesOf(h)[0] || oneLine(h.textContent)).toLowerCase();
      return !mine.some((n) => t === n || t.startsWith(n + ' ')) && others.some((n) => t === n || t.startsWith(n + ' '));
    }).length;
  }

  function hasSectionContent(el, key) {
    const lines = walkText(el).map(oneLine).filter((l) => l && !isNoise(l));
    if (key === 'experience') return lines.some(isDateLine);
    return lines.length >= 2;
  }

  /**
   * Anchors like <div id="experience"> sometimes sit in a small wrapper that
   * doesn't contain the entries. Climb until the block has content, without
   * swallowing neighbouring sections.
   */
  function expandToContent(sec, key, main) {
    let cur = sec;
    for (let i = 0; i < 8; i++) {
      if (hasSectionContent(cur, key)) return cur;
      const up = cur.parentElement;
      if (!up || up === main || !main.contains(up) || otherSectionHeadings(up, key)) break;
      cur = up;
    }
    return sec;
  }

  /** Locate a profile section by anchor id, then by <h2> heading text. */
  function locateSection(doc, key) {
    const def = SECTIONS[key];
    if (!def) return null;
    const scope = mainRoot(doc);
    for (const id of def.ids) {
      const anchor = scope.querySelector(`[id="${id}"]`);
      if (anchor) {
        const section = anchor.closest('section') || anchor.parentElement;
        if (section) return section;
      }
    }
    for (const section of scope.querySelectorAll('section')) {
      const h = section.querySelector('h2');
      if (!h) continue;
      const heading = (linesOf(h)[0] || oneLine(h.textContent)).toLowerCase();
      if (def.headings.some((name) => heading === name || heading.startsWith(name + ' '))) return section;
    }
    // Layouts without <section>: find the heading anywhere and climb to its container.
    for (const h of scope.querySelectorAll('h2, h3, [role="heading"]')) {
      const heading = (linesOf(h)[0] || oneLine(h.textContent)).toLowerCase();
      if (def.headings.some((name) => heading === name || heading.startsWith(name + ' '))) return containerFor(h);
    }
    return null;
  }

  /** Top-level <li> items of a section (nested role lists excluded). */
  function topLevelItems(section) {
    if (!section) return [];
    const all = Array.from(section.querySelectorAll('li'));
    const preferred = all.filter((li) =>
      /\b(artdeco-list__item|pvs-list__paged-list-item|pvs-list__item--line-separated)\b/.test(li.className || '')
    );
    const pool = preferred.length >= Math.max(1, all.filter((li) => !li.parentElement.closest('li')).length / 2) ? preferred : all;
    return pool.filter((li) => {
      const parentLi = li.parentElement && li.parentElement.closest('li');
      return !parentLi || !section.contains(parentLi) || !pool.includes(parentLi);
    });
  }

  /** Nested <li> items (e.g. multiple roles grouped under one company). */
  function nestedItems(li) {
    return Array.from(li.querySelectorAll('li')).filter((sub) => {
      const parentLi = sub.parentElement && sub.parentElement.closest('li');
      return parentLi === li;
    });
  }

  /** Lines of `li` excluding anything inside nested lists. */
  function ownLines(li) {
    const clone = li.cloneNode(true);
    clone.querySelectorAll('ul, ol').forEach((list) => {
      if (list.querySelector('li')) list.remove();
    });
    return linesOf(clone);
  }

  // ---------------------------------------------------------------------------
  // Field parsers (operate on text lines)
  // ---------------------------------------------------------------------------

  function parseDateLine(line) {
    const l = oneLine(line);
    let m = l.match(DATE_RANGE_RE);
    if (m) {
      const end = /present/i.test(m[2]) ? 'Present' : m[2];
      return { start: m[1], end, raw: l, duration: m[3] ? m[3].trim() : '', isCurrent: end === 'Present' };
    }
    m = l.match(SINGLE_DATE_RE);
    if (m && l.length < 40) {
      return { start: m[1], end: '', raw: l, duration: m[2] ? m[2].trim() : '', isCurrent: false };
    }
    return null;
  }

  function isDateLine(line) {
    return !!parseDateLine(line);
  }

  function looksLikeLocation(line) {
    if (!line || line.length > 90) return false;
    if (/[.!?]$/.test(line) && !WORK_MODES.test(line)) return false;
    if (WORK_MODES.test(line)) return true;
    // "Lagos, Nigeria", "San Francisco Bay Area", "London Area, United Kingdom"
    return /,/.test(line) || /\b(area|region|metropolitan|greater)\b/i.test(line);
  }

  function splitDot(line) {
    return String(line || '').split(/\s+·\s+/).map((s) => s.trim()).filter(Boolean);
  }

  function parseSkillsLine(line) {
    const m = String(line).match(/^skills?:\s*(.+)$/i);
    if (!m) return null;
    return m[1].split(/\s*(?:·|,|\band\b|\+\d+ skills?)\s*/i).map((s) => s.trim()).filter((s) => s && !/^\d+$/.test(s));
  }

  /** Separate "Company · Full-time" into company + employment type. */
  function parseCompanyLine(line) {
    const parts = splitDot(line);
    if (!parts.length) return { company: '', employmentType: '' };
    // Any part may be the employment type ("Acme · Full-time", "Full-time · 4 yrs").
    const typeIdx = parts.findIndex((p) => EMPLOYMENT_TYPES.includes(p.toLowerCase()));
    const employmentType = typeIdx === -1 ? '' : parts[typeIdx];
    const company = parts.filter((p, i) => i !== typeIdx && !DURATION_RE.test(p)).join(' · ');
    return { company, employmentType };
  }

  /**
   * Parse one role from its lines. `companyHint` is set for grouped roles.
   * Typical lines: [title, "Company · Full-time", "Jan 2020 - Present · 4 yrs",
   *                 "Lagos, Nigeria · Hybrid", description..., "Skills: A · B"]
   */
  function parseRole(lines, companyHint) {
    const role = {
      title: '',
      company: companyHint || '',
      employmentType: '',
      dateRange: null,
      duration: '',
      isCurrent: false,
      location: '',
      workMode: '',
      description: '',
      skills: [],
    };
    if (!lines.length) return role;

    const dateIdx = lines.findIndex(isDateLine);
    role.title = lines[0];

    const headerEnd = dateIdx === -1 ? Math.min(lines.length, 2) : dateIdx;
    for (let i = 1; i < headerEnd; i++) {
      const parsed = parseCompanyLine(lines[i]);
      if (!companyHint && parsed.company && !role.company) role.company = parsed.company;
      if (parsed.employmentType && !role.employmentType) role.employmentType = parsed.employmentType;
    }

    let rest = [];
    if (dateIdx !== -1) {
      const d = parseDateLine(lines[dateIdx]);
      role.dateRange = { start: d.start, end: d.end, raw: d.raw };
      role.duration = d.duration;
      role.isCurrent = d.isCurrent;
      rest = lines.slice(dateIdx + 1);
    } else {
      rest = lines.slice(headerEnd);
    }

    if (rest.length && looksLikeLocation(rest[0])) {
      const parts = splitDot(rest.shift());
      const mode = parts.find((p) => WORK_MODES.test(p) && p.length < 20);
      role.workMode = mode || '';
      role.location = parts.filter((p) => p !== mode).join(' · ');
    }

    const desc = [];
    for (const line of rest) {
      const skills = parseSkillsLine(line);
      if (skills) role.skills.push(...skills);
      else desc.push(line);
    }
    role.description = desc.join('\n');
    role.skills = uniq(role.skills);
    return role;
  }

  function parseExperienceItem(li) {
    const subs = nestedItems(li).filter((sub) => ownLines(sub).some(isDateLine));
    if (subs.length) {
      // Grouped: outer lines are [Company, "Full-time · 6 yrs", location?]
      const header = ownLines(li);
      const company = parseCompanyLine(header[0] || '').company || header[0] || '';
      const groupType = header.slice(1).map(parseCompanyLine).find((p) => p.employmentType);
      const groupLocation = header.slice(1).find((l) => looksLikeLocation(l) && !DURATION_RE.test(l)) || '';
      return subs.map((sub) => {
        const role = parseRole(ownLines(sub), company);
        if (!role.employmentType && groupType) role.employmentType = groupType.employmentType;
        if (!role.location && groupLocation) role.location = splitDot(groupLocation).filter((p) => !WORK_MODES.test(p)).join(' · ');
        return role;
      });
    }
    return [parseRole(ownLines(li))];
  }

  function parseEducationItem(li) {
    const lines = ownLines(li);
    const edu = { school: lines[0] || '', degree: '', field: '', dateRange: null, grade: '', activities: '', description: '' };
    const dateIdx = lines.findIndex(isDateLine);
    const headerEnd = dateIdx === -1 ? Math.min(lines.length, 2) : dateIdx;
    if (headerEnd > 1) {
      // "Bachelor of Science - BS, Computer Science"
      const degreeLine = lines[1];
      const comma = degreeLine.indexOf(', ');
      if (comma > 0) {
        edu.degree = degreeLine.slice(0, comma).trim();
        edu.field = degreeLine.slice(comma + 2).trim();
      } else {
        edu.degree = degreeLine;
      }
    }
    const rest = dateIdx === -1 ? lines.slice(headerEnd) : lines.slice(dateIdx + 1);
    if (dateIdx !== -1) {
      const d = parseDateLine(lines[dateIdx]);
      edu.dateRange = { start: d.start, end: d.end, raw: d.raw };
    }
    const desc = [];
    for (const line of rest) {
      if (/^grade:/i.test(line)) edu.grade = line.replace(/^grade:\s*/i, '');
      else if (/^activities and societies:/i.test(line)) edu.activities = line.replace(/^activities and societies:\s*/i, '');
      else if (!parseSkillsLine(line)) desc.push(line);
    }
    edu.description = desc.join('\n');
    return edu;
  }

  function parseSkillItem(li) {
    const lines = ownLines(li);
    const name = lines[0] || '';
    // Lines like "3 experiences across X and Y" or "Passed LinkedIn Skill Assessment"
    // are context, not separate skills.
    return name && name.length < 80 ? name : '';
  }

  const FEATURED_TYPES = /^(post|article|link|newsletter|document|image|video|profile|company|event)$/i;

  function parseFeaturedItem(li, doc) {
    const lines = linesOf(li);
    const item = { type: '', title: '', snippet: '', url: '' };
    let i = 0;
    if (lines[0] && FEATURED_TYPES.test(lines[0])) {
      item.type = lines[0];
      i = 1;
    }
    item.title = lines[i] || '';
    item.snippet = lines.slice(i + 1).filter((l) => !/^\d[\d,]*$/.test(l)).join(' ').slice(0, 500);
    const a = li.querySelector('a[href]');
    item.url = a ? absUrl(a.getAttribute('href'), doc) : '';
    return item.title ? item : null;
  }

  // "3d •", "2w", "1mo • Edited", "5h"
  const ACTIVITY_WHEN_RE = /^(\d+\s*(?:s|m|h|d|w|mo|yr|y)|just now)\b\s*(?:•.*)?$/i;

  function parseActivityItem(li, doc, profileName) {
    const lines = linesOf(li, { keepNewlines: true });
    if (!lines.length) return null;
    const item = { kind: 'post', when: '', text: '', url: '' };
    for (const line of lines) {
      const flat = oneLine(line);
      if (!item.when && ACTIVITY_WHEN_RE.test(flat)) {
        item.when = flat.split('•')[0].trim();
        continue;
      }
      const kind = flat.match(/\b(reposted|commented on|liked|celebrates|supports|loves|finds this (?:insightful|funny)|shared)\b/i);
      if (kind && flat.length < 160 && profileName && flat.includes(profileName.split(' ')[0])) {
        item.kind = /repost|shared/i.test(kind[1]) ? 'repost' : /comment/i.test(kind[1]) ? 'comment' : 'reaction';
        continue;
      }
    }
    // The post body is the longest line that is not a name/headline/when line.
    const candidates = lines
      .map((l) => clean(l))
      .filter((l) => l.length > 40 && !ACTIVITY_WHEN_RE.test(oneLine(l)) && l !== profileName);
    candidates.sort((a, b) => b.length - a.length);
    item.text = (candidates[0] || '').slice(0, 1200);
    const a = li.querySelector('a[href*="/feed/update/"], a[href*="/posts/"], a[href*="/pulse/"]');
    item.url = a ? absUrl(a.getAttribute('href'), doc) : '';
    return item.text ? item : null;
  }

  function parseGenericItem(li) {
    const lines = ownLines(li);
    if (!lines.length) return null;
    const dateIdx = lines.findIndex(isDateLine);
    return {
      title: lines[0],
      subtitle: lines[1] && lines[1] !== lines[dateIdx] ? lines[1] : '',
      date: dateIdx !== -1 ? lines[dateIdx] : '',
      description: lines.slice(Math.max(2, dateIdx + 1)).filter((l) => !parseSkillsLine(l)).join('\n'),
    };
  }

  function parseCertificationItem(li) {
    const g = parseGenericItem(li);
    if (!g) return null;
    return { name: g.title, issuer: g.subtitle, date: g.date.replace(/^issued\s+/i, ''), description: g.description };
  }

  // ---------------------------------------------------------------------------
  // Top card (name, headline, location, signals)
  // ---------------------------------------------------------------------------

  function extractTopCard(doc) {
    const main = mainRoot(doc);
    const titleName = nameFromTitle(doc);
    // Name element, most specific first; each must have visible text.
    const withText = (el) => (el && oneLine(el.textContent) ? el : null);
    const nameEl =
      withText(main.querySelector('h1')) ||
      withText(main.querySelector('.text-heading-xlarge')) ||
      findTextElement(main, titleName) ||
      withText(doc.querySelector('h1:not(.visually-hidden)'));
    const photo = main.querySelector('img.pv-top-card-profile-picture__image, img[class*="profile-picture"], img[class*="top-card"]');
    const name = (nameEl && oneLine(nameEl.textContent)) || titleName || (photo && oneLine(photo.getAttribute('alt'))) || '';
    const card = (nameEl && (nameEl.closest('section') || topCardFor(nameEl, main))) || main.querySelector('section') || main;

    let headline = firstText(card, [
      '.text-body-medium.break-words',
      '[data-generated-suggestion-target]',
      '.pv-text-details__left-panel .text-body-medium',
      '.text-body-medium',
    ]);

    let location = firstText(card, [
      '.text-body-small.inline.t-black--light.break-words',
      '.pv-text-details__left-panel .text-body-small.inline',
      'span.text-body-small.inline',
    ]);

    // Fallback: positional reading of the card's text lines.
    const lines = walkText(card).map(oneLine).filter(Boolean);
    if (isTopCardChrome(headline) || headline === name) headline = '';
    const nameIdx = lines.findIndex((l) => l === name || l.startsWith(name + ' '));
    if (!headline && nameIdx !== -1) {
      headline = lines.slice(nameIdx + 1).find((l) => !isTopCardChrome(l) && l !== name && l.length > 3) || '';
    }
    if (!location || isTopCardChrome(location)) {
      // "Slough, England · Contact info" may be one merged line.
      const inline = lines.find((l) => /\S\s*·\s*contact info$/i.test(l));
      if (inline) location = inline.replace(/\s*·\s*contact info$/i, '').trim();
    }
    if (!location || isTopCardChrome(location)) {
      const ci = lines.findIndex((l) => /^contact info$/i.test(l));
      for (let i = ci - 1; ci > 0 && i > nameIdx; i--) {
        const l = lines[i].replace(/\s*·\s*$/, '').trim();
        if (l && !isTopCardChrome(l) && l !== headline) {
          location = l;
          break;
        }
      }
    }

    const pronouns = (lines.find((l) => PRONOUNS_RE.test(l)) || '').replace(/[()]/g, '');

    const cardText = lines.join('\n');
    const connections = (cardText.match(/(\d[\d,]*\+?)\s+connections?/i) || [])[1] || '';
    const followers = (cardText.match(/(\d[\d,.]*[KkMm]?)\s+followers?/i) || [])[1] || '';

    const chips = orgChips(card);
    const currentCompany = ariaValue(card, 'Current company') || chips.company || companyFromHeadline(headline) || '';
    const currentSchool = ariaValue(card, 'Education') || chips.school || '';

    return { name, headline, location, pronouns, connections, followers, currentCompany, currentSchool, card, cardText };
  }

  const PRONOUNS_RE = /^\(?\s*(he|she|they|ze|xe|it)\s*\/\s*(him|her|them|they|hers|his|theirs|zir|xem|its)(\s*\/\s*\w+)?\s*\)?$/i;

  /** Top-card text that is never the headline/location: pronouns, degree, badges. */
  function isTopCardChrome(l) {
    const t = oneLine(l);
    return (
      !t ||
      PRONOUNS_RE.test(t) ||
      /^[·•]?\s*(1st|2nd|3rd\+?)(\s+degree connection)?$/i.test(t) ||
      /^[·•]$/.test(t) ||
      /^(verify|verified|get verified|premium|open to work|hiring|contact info|message|connect|follow|more|open to|add section|add profile section|enhance profile|resources)\b/i.test(t) ||
      /^\d[\d,+]*\s+(connections?|followers?)$/i.test(t) ||
      /mutual connections?$/i.test(t) ||
      /^talks about\b/i.test(t)
    );
  }

  /** Climb from the name until the block includes the card's markers ("Contact info", connections). */
  function topCardFor(nameEl, main) {
    let el = nameEl;
    for (let i = 0; i < 12 && el.parentElement && el.parentElement !== main; i++) {
      el = el.parentElement;
      const t = oneLine(el.textContent);
      if (/contact info/i.test(t) && /(connections?|followers?)/i.test(t)) {
        // Keep climbing to include the company/school chips and buttons beside
        // the name, but stop before reaching the About/Experience sections.
        while (el.parentElement && el.parentElement !== main && !hasSectionHeading(el.parentElement)) el = el.parentElement;
        return el;
      }
    }
    return containerFor(nameEl);
  }

  function hasSectionHeading(el) {
    const all = Object.values(SECTIONS).flatMap((v) => v.headings);
    return Array.from(el.querySelectorAll('h2, h3, [role="heading"]')).some((h) => {
      const t = (linesOf(h)[0] || oneLine(h.textContent)).toLowerCase();
      return all.some((n) => t === n || t.startsWith(n + ' '));
    });
  }

  const SCHOOL_RE = /\b(university|college|school|institute|institut|academy|polytechnic|universit|hochschule|lyc[eé]e|faculty|conservatory)\b/i;

  /**
   * Company / school "chips" beside the name (logo + name, linking to the
   * company or school page). Returns the first company and first school.
   */
  function orgChips(card) {
    const out = { company: '', school: '' };
    const links = Array.from(card.querySelectorAll('a[href*="/company/"], a[href*="/school/"], button, a[href="#experience"], a[href="#education"]'));
    for (const a of links) {
      if (!a.querySelector('img')) continue;
      const img = a.querySelector('img');
      const label = textOf(a) || oneLine(img.getAttribute('alt') || '').replace(/\s+logo$/i, '');
      if (!label || label.length > 90 || isTopCardChrome(label)) continue;
      const href = a.getAttribute('href') || '';
      const isSchool = /\/school\//.test(href) || href === '#education' || (!/\/company\//.test(href) && SCHOOL_RE.test(label));
      if (isSchool && !out.school) out.school = label;
      else if (!isSchool && !out.company) out.company = label;
    }
    return out;
  }

  /** "Senior Associate @EliteLanguageCraft" / "PM at Acme Corp | …" → company. */
  function companyFromHeadline(headline) {
    const h = String(headline || '');
    const m = h.match(/(?:@\s?|\bat\s+)([A-Z0-9][\w&.' -]{1,50}?)(?=\s*(?:\||·|,|-|–|—|$))/);
    return m ? m[1].trim() : '';
  }

  /** Read "Current company: Acme. Click to skip to experience card" style labels. */
  function ariaValue(scope, prefix) {
    const el = scope.querySelector(`[aria-label^="${prefix}"]`);
    if (!el) return '';
    const m = el.getAttribute('aria-label').match(new RegExp(`^${prefix}:\\s*([^.]+)`, 'i'));
    return m ? m[1].trim() : '';
  }

  function extractSignals(doc, top) {
    const main = mainRoot(doc);
    const imgAlts = Array.from(main.querySelectorAll('img[alt]')).map((i) => i.getAttribute('alt') || '');
    const text = top.cardText || '';
    const mainText = oneLine(main.textContent || '').slice(0, 20000);

    const openToWork =
      imgAlts.some((a) => /#opentowork/i.test(a)) ||
      /\bopen to work\b/i.test(text) ||
      /\bopen to work\b/i.test(firstSectionText(main, 'open to'));
    const hiring = imgAlts.some((a) => /#hiring/i.test(a)) || /\b(is hiring|#hiring|hiring for)\b/i.test(text);
    const providingServices = /\bproviding services\b/i.test(text) || /\bproviding services\b/i.test(mainText.slice(0, 4000));

    let openToWorkDetails = '';
    const otw = text.match(/open to work\s*\n([^\n]+)/i);
    if (otw) openToWorkDetails = otw[1].slice(0, 200);

    // Mutual connections: "Ada Obi, Tunde Bello and 12 other mutual connections"
    let mutual = { count: 0, text: '', names: [] };
    const mutualLine = text.split('\n').find((l) => /mutual connections?/i.test(l)) || '';
    if (mutualLine) {
      const flat = oneLine(mutualLine);
      const other = flat.match(/and\s+(\d[\d,]*)\s+other mutual/i);
      const namesPart = flat.split(/\s+(?:and\s+\d[\d,]*\s+other|is a mutual|are mutual|mutual connections?)/i)[0];
      const names = namesPart
        .split(/,\s*|\s+and\s+/)
        .map((s) => s.trim())
        .filter((s) => s && !/\d/.test(s) && s.split(' ').length <= 5);
      const total = flat.match(/^(\d[\d,]*)\s+mutual/i);
      mutual = {
        count: total ? parseInt(total[1].replace(/,/g, ''), 10) : names.length + (other ? parseInt(other[1].replace(/,/g, ''), 10) : 0),
        text: flat,
        names,
      };
    }

    return { openToWork, openToWorkDetails, hiring, providingServices, mutualConnections: mutual };
  }

  function firstSectionText(main, startsWith) {
    for (const s of main.querySelectorAll('section')) {
      const t = oneLine(s.textContent || '').slice(0, 300);
      if (t.toLowerCase().startsWith(startsWith)) return t;
    }
    return '';
  }

  // ---------------------------------------------------------------------------
  // Own-profile detection
  // ---------------------------------------------------------------------------

  /**
   * Decide whether the open profile belongs to the signed-in user.
   * Signals (the page itself is the only source):
   *  - owner-only controls: "Add profile section", "Open to", "Enhance profile",
   *    "Edit intro", links to /edit/forms/, the "Private to you" analytics card
   *  - viewer-only controls: "Message", "Connect", "Follow", mutual connections
   *  - an exact slug match against a previously synced profile
   * @param {Document} doc
   * @param {{syncedSlug?:string}} [ctx]
   */
  function detectOwnProfile(doc, ctx) {
    const context = ctx || {};
    const url = parseProfileUrl((doc.location && doc.location.href) || '');
    const main = mainRoot(doc);
    const signals = { owner: [], viewer: [], slugMatch: false };
    // Company pages are never "your profile" (the user's synced profile is a person).
    if (url.entityType === 'company') return { isOwn: false, confidence: 'high', signals };

    if (context.syncedSlug && url.slug && context.syncedSlug.toLowerCase() === url.slug.toLowerCase()) {
      signals.slugMatch = true;
    }

    const labelOf = (el) =>
      oneLine(el.getAttribute('aria-label') || '') + ' | ' + oneLine(el.textContent || '');
    const controls = Array.from(main.querySelectorAll('button, a, [role="button"]')).slice(0, 600);

    const OWNER_PATTERNS = [
      [/\badd profile section\b/i, 'add-profile-section'],
      [/\benhance profile\b/i, 'enhance-profile'],
      [/^open to\b|\|\s*open to\s*$/i, 'open-to'],
      [/\bedit intro\b/i, 'edit-intro'],
      [/\badd (a )?(new )?(position|education|skill|section)\b/i, 'add-item'],
      [/\bedit (about|experience|education|skills)\b/i, 'edit-section'],
      [/\bresources\b.*\bprivate to you\b|\bprivate to you\b/i, 'private-to-you'],
    ];
    const VIEWER_PATTERNS = [
      [/^(invite .+ to connect|connect)\b|\|\s*connect\s*$/i, 'connect'],
      [/^message\b|\|\s*message\s*$/i, 'message'],
      [/^follow\b|\|\s*follow\s*$/i, 'follow'],
    ];

    for (const el of controls) {
      const label = labelOf(el);
      for (const [re, tag] of OWNER_PATTERNS) if (re.test(label)) signals.owner.push(tag);
      for (const [re, tag] of VIEWER_PATTERNS) if (re.test(label)) signals.viewer.push(tag);
      const href = el.getAttribute && el.getAttribute('href');
      if (href && /\/in\/[^/]+\/(edit\/|add-edit\/)|\/edit\/forms\//i.test(href)) signals.owner.push('edit-link');
    }
    if (/\bprivate to you\b/i.test(oneLine(main.textContent || '').slice(0, 30000))) signals.owner.push('private-to-you');
    if (/mutual connections?/i.test(oneLine((main.querySelector('section') || main).textContent || ''))) {
      signals.viewer.push('mutual-connections');
    }

    signals.owner = uniq(signals.owner);
    signals.viewer = uniq(signals.viewer);

    const ownerScore = signals.owner.length * 2 - signals.viewer.length;
    const isOwn = signals.slugMatch || (signals.owner.length >= 1 && ownerScore >= 2);
    const confidence = signals.slugMatch ? 'high' : signals.owner.length >= 2 && !signals.viewer.length ? 'high' : isOwn ? 'medium' : signals.viewer.length ? 'high' : 'low';
    return { isOwn, confidence, signals };
  }

  // ---------------------------------------------------------------------------
  // Lazy-loading support
  // ---------------------------------------------------------------------------

  /**
   * LinkedIn lazy-renders lower profile sections. When the user triggers a
   * sync/analysis we scroll the *current page* down in steps so those sections
   * render, then restore the original scroll position. No network calls of
   * our own; we only let the page do what it does when a human scrolls.
   */
  async function ensureSectionsLoaded(doc, opts) {
    const options = Object.assign({ maxMs: 6000, stepPx: 900, pauseMs: 250 }, opts || {});
    const win = doc.defaultView || root;
    const scroller = doc.scrollingElement || doc.documentElement;
    const start = win.scrollY;
    const deadline = Date.now() + options.maxMs;
    let lastHeight = -1;
    let stableTicks = 0;

    while (Date.now() < deadline) {
      win.scrollBy(0, options.stepPx);
      await sleep(options.pauseMs);
      const atBottom = win.innerHeight + win.scrollY >= scroller.scrollHeight - 4;
      if (scroller.scrollHeight === lastHeight && atBottom) {
        if (++stableTicks >= 2) break;
      } else {
        stableTicks = 0;
      }
      lastHeight = scroller.scrollHeight;
    }
    win.scrollTo(0, start);
    await sleep(100);
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  // ---------------------------------------------------------------------------
  // Main entry points
  // ---------------------------------------------------------------------------

  /**
   * Layout-independent entries: every job/degree shows a date range. Find the
   * deepest elements whose text is a date line and climb to the largest block
   * that holds no other entry's date.
   */
  function dateAnchoredBlocks(section) {
    return anchoredBlocks(section, isDateLine);
  }

  /** Same idea for any marker line (dates, post timestamps): one block per marker. */
  function anchoredBlocks(section, isMarker) {
    const els = Array.from(section.querySelectorAll('*')).filter((el) => !el.closest(HIDDEN_SELECTOR) && !/^(SCRIPT|STYLE|SVG|BUTTON)$/.test(el.tagName));
    const leaves = els.filter((el) => {
      const t = textOf(el);
      if (!t || t.length > 80 || !isMarker(t)) return false;
      return !Array.from(el.children).some((c) => isMarker(textOf(c)));
    });
    const roots = [];
    for (const leaf of leaves) {
      let root = leaf;
      while (root.parentElement && root.parentElement !== section && section.contains(root.parentElement)) {
        const others = leaves.filter((l) => l !== leaf && root.parentElement.contains(l));
        if (others.length) break;
        root = root.parentElement;
      }
      if (!roots.includes(root)) roots.push(root);
    }
    return roots;
  }

  /** Company name of a grouped block ("Acme · 6 yrs" with several roles under it). */
  function groupHeader(root, section, roots) {
    let up = root.parentElement;
    while (up && up !== section) {
      const inside = roots.filter((r) => up.contains(r));
      if (inside.length > 1) {
        const clone = up.cloneNode(true);
        // Remove the role blocks from the clone to keep only the group's own header lines.
        const paths = inside.map((r) => pathFrom(up, r));
        paths.map((pth) => nodeAt(clone, pth)).filter(Boolean).forEach((n) => n.remove());
        const lines = linesOf(clone).filter((l) => !SECTIONS.experience.headings.includes(l.toLowerCase()));
        if (lines[0]) return lines[0];
        // Only the role blocks were in here — the header is one level up.
      }
      up = up.parentElement;
    }
    return '';
  }

  function pathFrom(ancestor, node) {
    const path = [];
    for (let n = node; n && n !== ancestor; n = n.parentElement) path.unshift(Array.prototype.indexOf.call(n.parentElement.children, n));
    return path;
  }

  function nodeAt(root, path) {
    let n = root;
    for (const i of path) n = n && n.children[i];
    return n;
  }

  function experienceFromBlocks(section) {
    const roots = dateAnchoredBlocks(section);
    return roots.map((root) => {
      const lines = linesOf(root).filter((l) => !SECTIONS.experience.headings.includes(l.toLowerCase()));
      // No company line ([title, dates, …]) → the company is the group's header.
      const hint = lines.length > 1 && isDateLine(lines[1]) ? parseCompanyLine(groupHeader(root, section, roots)).company : '';
      return parseRole(lines, hint || undefined);
    });
  }

  function educationFromBlocks(section) {
    return dateAnchoredBlocks(section).map((root) => {
      const fake = root.ownerDocument.createElement('li');
      fake.innerHTML = root.innerHTML;
      return parseEducationItem(fake);
    });
  }

  /** Skill names when the section isn't built from <li> rows. */
  function skillsFromLines(section) {
    return uniq(
      linesOf(section).filter(
        (l) => l.length > 1 && l.length < 60 && !SECTIONS.skills.headings.includes(l.toLowerCase()) &&
          !/endorse|experiences? (across|at)|^passed linkedin|assessment|^\d+\s|followers|skills?$/i.test(l)
      )
    );
  }

  /** Pick whichever strategy found more usable entries. */
  function better(a, b) {
    return (b || []).length > (a || []).length ? b : a;
  }

  function extractSectionList(doc, key, section) {
    const sec = section || findSection(doc, key);
    if (!sec) return null;
    const items = topLevelItems(sec);
    const topName = extractTopCard(doc).name;
    const validRole = (r) => r.title && (r.company || r.dateRange);
    switch (key) {
      case 'experience':
        return better(items.flatMap(parseExperienceItem).filter(validRole), experienceFromBlocks(sec).filter(validRole));
      case 'education':
        return better(items.map(parseEducationItem).filter((e) => e.school), educationFromBlocks(sec).filter((e) => e.school));
      case 'skills':
        return uniq(items.map(parseSkillItem).filter(Boolean)).length ? uniq(items.map(parseSkillItem).filter(Boolean)) : skillsFromLines(sec);
      case 'featured':
        return items.map((li) => parseFeaturedItem(li, doc)).filter(Boolean);
      case 'activity': {
        const fromLi = items.map((li) => parseActivityItem(li, doc, topName)).filter(Boolean);
        const isWhen = (t) => ACTIVITY_WHEN_RE.test(t) || /^\d+\s*(s|m|h|d|w|mo|yr|y)\s*[•·]/i.test(t);
        const fromBlocks = anchoredBlocks(sec, isWhen).map((b) => parseActivityItem(b, doc, topName)).filter(Boolean);
        return better(fromLi, fromBlocks).slice(0, 10);
      }
      case 'certifications':
        return items.map(parseCertificationItem).filter(Boolean);
      default:
        return items.map(parseGenericItem).filter(Boolean);
    }
  }

  function extractAbout(doc) {
    const sec = findSection(doc, 'about');
    if (!sec) return '';
    // Prefer the expandable text container; fall back to every line except the heading.
    const box = sec.querySelector('.inline-show-more-text, [class*="inline-show-more-text"], .pv-shared-text-with-see-more');
    const lines = linesOf(box || sec, { keepNewlines: true }).filter((l) => !/^about$/i.test(oneLine(l)));
    // The About section may end with a "Top skills" sub-card; keep it separate.
    const topSkillsIdx = lines.findIndex((l) => /^top skills$/i.test(oneLine(l)));
    const body = topSkillsIdx === -1 ? lines : lines.slice(0, topSkillsIdx);
    return clean(body.join('\n')).slice(0, 5000);
  }

  function extractTopSkillsFromAbout(doc) {
    const sec = findSection(doc, 'about');
    if (!sec) return [];
    const lines = linesOf(sec);
    const i = lines.findIndex((l) => /^top skills$/i.test(l));
    if (i === -1 || !lines[i + 1]) return [];
    return lines[i + 1].split(/\s*•\s*|\s*·\s*/).map((s) => s.trim()).filter(Boolean);
  }

  /**
   * Extract a structured profile from the currently open LinkedIn page.
   * @param {Document} [doc=document]
   * @param {{syncedSlug?:string}} [ctx]
   * @returns {object} profile (see README "Profile schema")
   */
  function extractProfile(doc, ctx) {
    const d = doc || root.document;
    const href = (d.location && d.location.href) || '';
    const url = parseProfileUrl(href);
    const warnings = [];
    const sectionsFound = [];

    if (url.isProfile && url.entityType === 'company') return extractCompany(d, url);

    const profile = {
      schemaVersion: SCHEMA_VERSION,
      entityType: 'person',
      source: {
        url: url.slug ? `https://www.linkedin.com/in/${encodeURIComponent(url.slug)}/` : href,
        publicIdentifier: url.slug,
        pageType: url.pageType,
        detailsSection: url.detailsSection,
        extractedAt: new Date().toISOString(),
      },
      name: '',
      headline: '',
      location: '',
      pronouns: '',
      connections: '',
      followers: '',
      currentCompany: '',
      currentSchool: '',
      about: '',
      experience: [],
      education: [],
      skills: [],
      featured: [],
      activity: [],
      certifications: [],
      projects: [],
      volunteering: [],
      honors: [],
      languages: [],
      publications: [],
      signals: { openToWork: false, openToWorkDetails: '', hiring: false, providingServices: false, mutualConnections: { count: 0, text: '', names: [] } },
      ownership: detectOwnProfile(d, ctx),
      meta: { sectionsFound, warnings, truncated: {} },
    };

    if (!url.isProfile) {
      warnings.push('Not a LinkedIn profile page (expected linkedin.com/in/...).');
      return profile;
    }

    if (url.pageType === 'details' && url.detailsSection) {
      // Details pages (/details/experience/) hold one full list.
      const main = mainRoot(d);
      const section = findSection(d, url.detailsSection) || main.querySelector('section') || main;
      const list = extractSectionList(d, url.detailsSection, section);
      if (list && list.length) {
        profile[url.detailsSection] = list;
        sectionsFound.push(url.detailsSection);
      } else {
        warnings.push(`No items found on the ${url.detailsSection} details page.`);
      }
      // Details pages show the person's name in the header ("Ada Obi's experience" or h1).
      profile.name = oneLine((main.querySelector('h1, h2') || {}).textContent || '').replace(/'s?\b.*$/, '').trim();
      return profile;
    }

    const top = extractTopCard(d);
    Object.assign(profile, {
      name: top.name,
      headline: top.headline,
      location: top.location,
      pronouns: top.pronouns,
      connections: top.connections,
      followers: top.followers,
      currentCompany: top.currentCompany,
      currentSchool: top.currentSchool,
    });
    if (!profile.name) warnings.push('Could not find the profile name — the page may still be loading.');

    profile.about = extractAbout(d);
    if (profile.about) sectionsFound.push('about');

    for (const key of ['experience', 'education', 'skills', 'featured', 'activity', 'certifications', 'projects', 'volunteering', 'honors', 'languages', 'publications']) {
      const sec = findSection(d, key);
      if (!sec) continue;
      const list = extractSectionList(d, key, sec) || [];
      profile[key] = list;
      if (list.length) sectionsFound.push(key);
      // The main page truncates long lists behind "Show all N ...".
      const showAll = Array.from(sec.querySelectorAll('a, button')).find((el) => /^show all\b/i.test(oneLine(el.textContent)));
      if (showAll) {
        const n = (oneLine(showAll.textContent).match(/\d+/) || [])[0];
        profile.meta.truncated[key] = n ? parseInt(n, 10) : true;
      }
    }

    if (!profile.skills.length) profile.skills = extractTopSkillsFromAbout(d);
    else profile.skills = uniq(profile.skills.concat(extractTopSkillsFromAbout(d)));

    profile.signals = extractSignals(d, top);

    // Derive current company from the latest current role if the top card lacked it.
    if (!profile.currentCompany) {
      const current = profile.experience.find((r) => r.isCurrent) || profile.experience[0];
      if (current) profile.currentCompany = current.company;
    }

    for (const key of Object.keys(profile.meta.truncated)) {
      warnings.push(`${key[0].toUpperCase() + key.slice(1)}: LinkedIn only shows part of this list here. Open “Show all” and press Sync again to add the full list.`);
    }
    if (!profile.experience.length) warnings.push('No experience found. Scroll the page once and try again.');

    return profile;
  }

  // ---------------------------------------------------------------------------
  // Company pages (/company/<slug>/...)
  // ---------------------------------------------------------------------------

  const COMPANY_FIELDS = {
    website: /^website$/i,
    phone: /^phone$/i,
    industry: /^industry$/i,
    companySize: /^company size$/i,
    headquarters: /^headquarters$/i,
    type: /^type$/i,
    founded: /^founded$/i,
    specialties: /^specialt(?:ies|y)$/i,
  };

  /** Read the label/value pairs on the About tab (<dl><dt>Industry</dt><dd>…</dd>). */
  function readCompanyDetails(main) {
    const out = {};
    for (const dt of main.querySelectorAll('dt')) {
      const label = oneLine(dt.textContent);
      const key = Object.keys(COMPANY_FIELDS).find((k) => COMPANY_FIELDS[k].test(label));
      if (!key || out[key]) continue;
      // The value is the next <dd> (some layouts put the employee count in a second <dd>).
      let dd = dt.nextElementSibling;
      while (dd && dd.tagName !== 'DD') dd = dd.nextElementSibling;
      if (dd) out[key] = textOf(dd);
    }
    // Fallback: "Industry\nSoftware Development" style lines.
    if (!Object.keys(out).length) {
      const lines = walkText(main).map(oneLine).filter(Boolean);
      lines.forEach((l, i) => {
        const key = Object.keys(COMPANY_FIELDS).find((k) => COMPANY_FIELDS[k].test(l));
        if (key && !out[key] && lines[i + 1]) out[key] = lines[i + 1];
      });
    }
    return out;
  }

  function findSectionByHeading(main, names) {
    for (const section of main.querySelectorAll('section')) {
      const h = section.querySelector('h2, h3');
      if (!h) continue;
      const heading = oneLine(h.textContent).toLowerCase();
      if (names.some((n) => heading === n || heading.startsWith(n))) return section;
    }
    return null;
  }

  /** Posts on the company home or /posts/ tab. */
  function readCompanyPosts(doc, main, companyName) {
    const nodes = Array.from(main.querySelectorAll('[data-urn^="urn:li:activity"], .feed-shared-update-v2, [data-id^="urn:li:activity"]'));
    const roots = nodes.filter((n) => !nodes.some((o) => o !== n && o.contains(n)));
    let items = roots.map((n) => parseActivityItem(n, doc, companyName)).filter(Boolean);
    if (!items.length) {
      const sec = findSectionByHeading(main, ['page posts', 'posts', 'recent posts']);
      if (sec) items = topLevelItems(sec).map((li) => parseActivityItem(li, doc, companyName)).filter(Boolean);
    }
    for (const n of roots) {
      const urn = n.getAttribute('data-urn') || n.getAttribute('data-id');
      const item = items.find((it) => !it.url && it.text && oneLine(n.textContent).includes(it.text.slice(0, 40)));
      if (item && urn) item.url = `https://www.linkedin.com/feed/update/${urn}/`;
    }
    return items.slice(0, 10);
  }

  /** Job cards visible on the company's Jobs tab (or the home tab's job carousel). */
  function readCompanyJobs(doc, main) {
    const links = Array.from(main.querySelectorAll('a[href*="/jobs/view/"]'));
    const seen = new Set();
    const jobs = [];
    for (const a of links) {
      const card = a.closest('li, .job-card-container, [data-job-id], article') || a;
      const lines = linesOf(card).filter((l) => !/^(promoted|easy apply|actively recruiting|\d+ applicants?|viewed|applied|new)$/i.test(l));
      const title = textOf(a) || lines[0] || '';
      if (!title || title.length > 120) continue;
      const id = (a.getAttribute('href').match(/\/jobs\/view\/(\d+)/) || [])[1] || title;
      if (seen.has(id)) continue;
      seen.add(id);
      const location = lines.find((l) => l !== title && looksLikeLocation(l)) || '';
      jobs.push({ title, location });
      if (jobs.length >= 40) break;
    }
    return jobs;
  }

  /** Climb from the company name to the header card (has followers/employees), stopping before Overview/About. */
  function companyCardFor(nameEl, main) {
    let el = nameEl;
    for (let i = 0; i < 12 && el.parentElement && el.parentElement !== main; i++) {
      el = el.parentElement;
      if (el.tagName === 'SECTION') return el;
      const t = oneLine(el.textContent);
      if (/(followers?|employees)/i.test(t)) {
        while (el.parentElement && el.parentElement !== main && !/\b(overview|page posts)\b/i.test(oneLine(el.parentElement.textContent).slice(0, 4000))) el = el.parentElement;
        return el;
      }
    }
    return nameEl.parentElement;
  }

  function extractCompany(doc, url) {
    const main = mainRoot(doc);
    const warnings = [];
    const sectionsFound = [];
    // Name: <h1> (older layout), else the element matching the tab title
    // ("Acme: About | LinkedIn"), else the title itself.
    const titleName = nameFromTitle(doc);
    const withText = (el) => (el && oneLine(el.textContent) ? el : null);
    const nameEl = withText(main.querySelector('h1')) || findTextElement(main, titleName) || withText(doc.querySelector('h1'));
    const name = (nameEl && oneLine(nameEl.textContent)) || titleName;
    const card = (nameEl && companyCardFor(nameEl, main)) || main.querySelector('section') || main;

    const cardLines = walkText(card).map(oneLine).filter(Boolean);
    const cardText = cardLines.join('\n');
    const nameIdx = cardLines.findIndex((l) => l === name || l.startsWith(name + ' '));
    let tagline = firstText(card, ['.org-top-card-summary__tagline', 'p.org-top-card-summary__tagline', '[class*="tagline"]']);
    // Info line: "Software Development · Lagos, Nigeria · 12K followers · 51-200 employees"
    const infoLine = cardLines.find((l) => /·/.test(l) && /(followers?|employees)/i.test(l)) || '';
    if (!tagline && nameIdx !== -1) {
      tagline = cardLines.slice(nameIdx + 1).find((l) => l !== infoLine && !/(followers?|employees|connections? works? here|^follow$|^message$|^visit website)/i.test(l) && l.length > 3 && !/^(home|about|posts|jobs|people|life)$/i.test(l)) || '';
    }
    let infoItems = Array.from(card.querySelectorAll('.org-top-card-summary-info-list__info-item, [class*="info-list__info-item"]')).map((e) => oneLine(e.textContent));
    if (!infoItems.length && infoLine) infoItems = splitDot(infoLine);
    const followers = (cardText.match(/(\d[\d,.]*[KkMm]?)\s+followers?/i) || [])[1] || '';
    const employeesLine = (cardText.match(/(\d[\d,.]*[KkMm]?\+?(?:\s*-\s*\d[\d,.]*[KkMm]?)?)\s+employees/i) || [])[1] || '';

    const details = readCompanyDetails(main);

    // Overview text: About tab "Overview" section, or the About card on the home tab.
    // Take every paragraph up to the first detail label (Website, Industry, …).
    const overviewSec = findSectionByHeading(main, ['overview', 'about']);
    let about = '';
    if (overviewSec) {
      const lines = walkText(overviewSec).map(oneLine).filter(Boolean);
      const out = [];
      for (const l of lines) {
        if (/^(overview|about)$/i.test(l)) continue;
        if (Object.values(COMPANY_FIELDS).some((re) => re.test(l)) || /^(verified page|phone|show (all|details|more))\b/i.test(l)) break;
        if (!isNoise(l)) out.push(l);
      }
      about = out.join('\n').slice(0, 5000);
    }
    if (about) sectionsFound.push('about');

    const infoNonCount = infoItems.filter((t) => !/followers?|employees/i.test(t));
    const industry = details.industry || infoNonCount[0] || '';
    const headquarters = details.headquarters || infoNonCount.find((t, i) => i > 0 && /,/.test(t)) || infoNonCount[1] || '';

    const specialties = String(details.specialties || '')
      .split(/\s*,\s*(?:and\s+)?|\s+and\s+/)
      .map((s) => s.trim())
      .filter(Boolean);

    const posts = readCompanyPosts(doc, main, name);
    const jobs = readCompanyJobs(doc, main);
    if (jobs.length) sectionsFound.push('jobs');
    if (posts.length) sectionsFound.push('activity');

    // Signals
    const mainText = oneLine(main.textContent || '').slice(0, 40000);
    const jobsMatch = mainText.match(/\b(\d[\d,]*)\s+(?:open\s+)?jobs?\b/i);
    const hiring = !!jobsMatch || jobs.length > 0 || /\b(we(?:'|’)re hiring|is hiring|#hiring|recently posted jobs)\b/i.test(mainText);
    let connections = { count: 0, text: '', names: [] };
    const cw = mainText.match(/((?:[A-Z][\p{L}'’.-]+(?:\s+[A-Z][\p{L}'’.-]+){0,3}\s*(?:&|and)\s*)?(\d[\d,]*)?\s*(?:other\s+)?connections? works? here)/u);
    if (cw) {
      const t = cw[1].trim();
      const names = (t.match(/^([A-Z][\p{L}'’.-]+(?:\s+[A-Z][\p{L}'’.-]+){0,3})\s*(?:&|and)/u) || [])[1];
      const n = parseInt((cw[2] || '0').replace(/,/g, ''), 10);
      connections = { count: n + (names ? 1 : 0), text: t, names: names ? [names] : [] };
    }

    if (!name) warnings.push('Could not find the company name — the page may still be loading.');
    if (!about && !details.industry) warnings.push('Open the company’s “About” tab and analyze again for industry, size and overview.');
    if (!posts.length) warnings.push('No recent posts found here. The “Posts” tab usually has them.');

    return {
      schemaVersion: SCHEMA_VERSION,
      entityType: 'company',
      source: {
        url: `https://www.linkedin.com/company/${encodeURIComponent(url.slug)}/`,
        publicIdentifier: url.slug,
        pageType: 'company',
        subpage: url.subpage,
        extractedAt: new Date().toISOString(),
      },
      name,
      headline: tagline, // shared field name so the UI/engine can treat both alike
      tagline,
      industry,
      location: headquarters,
      headquarters,
      followers,
      companySize: details.companySize || employeesLine,
      founded: details.founded || '',
      website: details.website || '',
      companyType: details.type || '',
      specialties,
      about,
      activity: posts,
      jobs,
      // Empty person fields keep downstream code simple.
      experience: [],
      education: [],
      skills: specialties,
      featured: [],
      signals: {
        hiring,
        jobsCount: Math.max(jobsMatch ? parseInt(jobsMatch[1].replace(/,/g, ''), 10) : 0, jobs.length),
        openToWork: false,
        mutualConnections: connections,
      },
      ownership: { isOwn: false, confidence: 'high', signals: { owner: [], viewer: [], slugMatch: false } },
      meta: { sectionsFound, warnings, truncated: {}, tabsRead: [url.subpage || 'home'] },
    };
  }

  /**
   * Merge two extractions of the same company taken from different tabs
   * (home, About, Posts…). Non-empty values win; lists are unioned.
   */
  function mergeCompany(a, b) {
    if (!a) return b;
    if (!b || a.source.publicIdentifier !== b.source.publicIdentifier) return b;
    const out = JSON.parse(JSON.stringify(a));
    for (const [k, v] of Object.entries(b)) {
      if (k === 'meta' || k === 'source' || k === 'signals') continue;
      if (Array.isArray(v)) {
        const seen = new Set((out[k] || []).map((x) => JSON.stringify(x)));
        out[k] = (out[k] || []).concat(v.filter((x) => !seen.has(JSON.stringify(x))));
      } else if (v && (!out[k] || (typeof v === 'string' && v.length > String(out[k]).length))) {
        out[k] = v;
      }
    }
    out.signals = {
      ...out.signals,
      hiring: a.signals.hiring || b.signals.hiring,
      jobsCount: Math.max(a.signals.jobsCount || 0, b.signals.jobsCount || 0),
      mutualConnections: (b.signals.mutualConnections.count || 0) >= (a.signals.mutualConnections.count || 0) ? b.signals.mutualConnections : a.signals.mutualConnections,
    };
    out.meta = {
      sectionsFound: uniq(a.meta.sectionsFound.concat(b.meta.sectionsFound)),
      warnings: b.meta.warnings.filter((w) => !(/about/i.test(w) && out.about) && !(/posts/i.test(w) && out.activity.length)),
      truncated: {},
      tabsRead: uniq((a.meta.tabsRead || [a.source.subpage || 'home']).concat(b.source.subpage || 'home')),
    };
    out.source = { ...b.source };
    return out;
  }

  /**
   * Merge a details-page extraction (one full section) into a stored profile.
   * The longer list wins so a details page never shrinks synced data.
   */
  function mergeDetails(base, details) {
    const key = details && details.source && details.source.detailsSection;
    if (!base || !key || !Array.isArray(details[key])) return base;
    const merged = JSON.parse(JSON.stringify(base));
    if (details[key].length >= (merged[key] || []).length) merged[key] = details[key];
    merged.meta = merged.meta || { sectionsFound: [], warnings: [], truncated: {} };
    if (merged.meta.truncated) delete merged.meta.truncated[key];
    merged.meta.warnings = (merged.meta.warnings || []).filter((w) => !w.toLowerCase().startsWith(key));
    if (!merged.meta.sectionsFound.includes(key)) merged.meta.sectionsFound.push(key);
    merged.meta.mergedDetails = uniq((merged.meta.mergedDetails || []).concat(key));
    return merged;
  }

  /**
   * Structural report for troubleshooting a page the extractor can't read.
   * Contains tag/class/heading structure and counts — not the person's text
   * (section headings like "Experience" are included; names are not).
   */
  function diagnose(doc) {
    const d = doc || root.document;
    const main = mainRoot(d);
    const url = parseProfileUrl((d.location && d.location.href) || '');
    const cls = (el) => (el && typeof el.className === 'string' ? el.className.split(/\s+/).filter(Boolean).slice(0, 8).join(' ') : '');
    const known = Object.values(SECTIONS).flatMap((s) => s.headings);
    const headings = Array.from(main.querySelectorAll('h1, h2, h3, [role="heading"]')).slice(0, 40).map((h) => {
      const t = oneLine(h.textContent).toLowerCase();
      return { tag: h.tagName.toLowerCase(), cls: cls(h), knownSection: known.find((k) => t === k || t.startsWith(k + ' ')) || null, len: t.length };
    });
    let profile = null;
    let error = null;
    try {
      profile = extractProfile(d);
    } catch (e) {
      error = String(e && e.message);
    }
    const count = (sel) => main.querySelectorAll(sel).length;
    return {
      extractorVersion: SCHEMA_VERSION,
      page: { entityType: url.entityType, pageType: url.pageType, subpage: url.subpage, detailsSection: url.detailsSection },
      title: { hasName: !!nameFromTitle(d), length: (d.title || '').length },
      counts: {
        mains: d.querySelectorAll('main, [role="main"]').length,
        h1: count('h1'), h2: count('h2'), h3: count('h3'), section: count('section'), li: count('li'),
        ariaHiddenSpans: count('span[aria-hidden="true"]'), visuallyHidden: count('.visually-hidden'),
        textHeadingXlarge: count('.text-heading-xlarge'), artdecoListItems: count('li.artdeco-list__item'), pvsItems: count('li.pvs-list__paged-list-item'),
      },
      mainTag: main.tagName.toLowerCase() + (main.id ? '#' + main.id : '') + (cls(main) ? '.' + cls(main).replace(/ /g, '.') : ''),
      h1: Array.from(d.querySelectorAll('h1')).slice(0, 3).map((h) => ({ cls: cls(h), inMain: main.contains(h), hasText: !!oneLine(h.textContent) })),
      anchorIds: Object.fromEntries(Object.entries(SECTIONS).map(([k, v]) => [k, v.ids.some((id) => !!main.querySelector(`[id="${id}"]`))])),
      headings,
      ownership: (() => { try { return detectOwnProfile(d).signals; } catch (_) { return null; } })(),
      // Per-section structure (counts only) to pinpoint which part of a new layout isn't understood.
      sections: Object.fromEntries(
        ['experience', 'education', 'skills', 'activity', 'featured', 'certifications'].map((k) => {
          const sec = (() => { try { return findSection(d, k); } catch (_) { return null; } })();
          if (!sec) return [k, null];
          const lines = walkText(sec).map(oneLine).filter(Boolean);
          return [k, {
            tag: sec.tagName.toLowerCase(),
            li: sec.querySelectorAll('li').length,
            topLevelItems: topLevelItems(sec).length,
            dateLines: lines.filter(isDateLine).length,
            dateBlocks: dateAnchoredBlocks(sec).length,
            ariaHiddenSpans: sec.querySelectorAll('span[aria-hidden="true"]').length,
            twins: sec.querySelectorAll('.visually-hidden, .a11y-text, .sr-only').length,
            textLines: lines.length,
          }];
        })
      ),
      extracted: profile && {
        name: !!profile.name, headline: !!profile.headline, location: !!profile.location, about: profile.about ? profile.about.length : 0,
        experience: (profile.experience || []).length, education: (profile.education || []).length, skills: (profile.skills || []).length,
        featured: (profile.featured || []).length, activity: (profile.activity || []).length, jobs: (profile.jobs || []).length,
        sectionsFound: profile.meta.sectionsFound, warnings: profile.meta.warnings.length,
      },
      error,
      userAgent: (root.navigator && root.navigator.userAgent) || '',
    };
  }

  /** Display name of the person/company on the open page ('' if not readable). */
  function pageName(doc) {
    const d = doc || root.document;
    const url = parseProfileUrl((d.location && d.location.href) || '');
    if (url.entityType === 'company') {
      const h1 = mainRoot(d).querySelector('h1');
      return (h1 && oneLine(h1.textContent)) || nameFromTitle(d);
    }
    return extractTopCard(d).name;
  }

  const api = {
    SCHEMA_VERSION,
    diagnose,
    pageName,
    extractProfile,
    detectOwnProfile,
    parseProfileUrl,
    ensureSectionsLoaded,
    mergeDetails,
    mergeCompany,
    // exported for tests
    _internals: { linesOf, parseRole, parseDateLine, parseCompanyLine, parseEducationItem, findSection, topLevelItems, looksLikeLocation },
  };

  root.LDAExtractor = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
