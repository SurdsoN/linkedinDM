/**
 * Synthetic LinkedIn-like profile pages for tests.
 * They mirror the markup patterns the extractor relies on: section anchor
 * ids, <h2> headings, li.artdeco-list__item rows, and the visible
 * `span[aria-hidden=true]` + `.visually-hidden` duplicate text pattern.
 * All people and companies here are fictional.
 */

// Visible text the way LinkedIn renders it (visible copy + screen-reader copy).
const v = (t) => `<span aria-hidden="true">${t}</span><span class="visually-hidden">${t}</span>`;
const row = (...lines) => lines.map((l) => `<div class="t-14">${v(l)}</div>`).join('');

function section(id, heading, items, { showAll } = {}) {
  return `
  <section class="artdeco-card">
    <div id="${id}" class="pv-profile-card__anchor"></div>
    <div class="pvs-header"><h2 class="pvs-header__title">${v(heading)}</h2></div>
    <div><ul>${items.map((i) => `<li class="artdeco-list__item">${i}</li>`).join('')}</ul></div>
    ${showAll ? `<div class="pvs-list__footer"><a href="#">Show all ${showAll} ${heading.toLowerCase()} →</a></div>` : ''}
  </section>`;
}

function topCard({ name, headline, location, connections, extra = '', buttons = '' }) {
  return `
  <section class="artdeco-card">
    <div class="ph5">
      <div class="pv-top-card__photo"><img alt="${name}" src="data:," /></div>
      <h1 class="text-heading-xlarge">${name}</h1>
      <div class="text-body-medium break-words">${headline}</div>
      <div><span class="text-body-small inline t-black--light break-words">${location}</span>
        <span>·</span> <a href="#">Contact info</a></div>
      <ul><li class="text-body-small"><span class="t-bold">${connections}</span> connections</li></ul>
      ${extra}
      <div class="pv-top-card-v2-ctas">${buttons}</div>
    </div>
  </section>`;
}

function page(body) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>LinkedIn</title>
  <style>.visually-hidden{position:absolute;clip:rect(0 0 0 0);width:1px;height:1px;overflow:hidden}</style>
  </head><body><nav><a href="/feed/">Home</a><button>Me</button></nav><main class="scaffold-layout__main">${body}</main></body></html>`;
}

export const OWN_PROFILE = page(
  topCard({
    name: 'Amara Okafor',
    headline: 'Localization Project Manager | Translation Ops | French &amp; Igbo',
    location: 'Lagos, Lagos State, Nigeria',
    connections: '500+',
    buttons: `<button aria-label="Open to">Open to</button>
      <button>Add profile section</button>
      <button>Enhance profile</button>
      <a href="/in/amara-okafor/edit/intro/" aria-label="Edit intro">✎</a>`,
  }) +
    `<section class="artdeco-card"><h2>${v('Analytics')}</h2>${v('Private to you')}</section>` +
    section('about', 'About', [
      `<div class="inline-show-more-text">${v('I help publishers and NGOs ship multilingual content on time. Over 8 years I have managed 300+ translation projects across 14 languages.')}</div>`,
    ]) +
    section(
      'experience',
      'Experience',
      [
        row(
          'Senior Localization Project Manager',
          'Kestrel Language Services · Full-time',
          'Mar 2022 - Present · 2 yrs 8 mos',
          'Lagos, Nigeria · Hybrid',
          'Cut average turnaround time by 35% by redesigning the vendor workflow for localization projects.',
          'Skills: Project Management · Vendor Management'
        ),
        // Grouped company with two roles
        `${row('Brightway Media Group', 'Full-time · 4 yrs 2 mos')}
        <ul>
          <li>${row('Translation Coordinator', 'Jan 2020 - Feb 2022 · 2 yrs 2 mos', 'Managed a team of 12 freelance translators for content localization.')}</li>
          <li>${row('Junior Translator', 'Jan 2018 - Dec 2019 · 2 yrs', 'French to English translation of marketing content.')}</li>
        </ul>`,
      ],
      { showAll: 5 }
    ) +
    section('education', 'Education', [
      row('University of Lagos', 'Bachelor of Arts - BA, French Language and Literature', '2013 - 2017', 'Activities and societies: Debate club'),
    ]) +
    section('skills', 'Skills', [row('Localization', '12 endorsements'), row('Project Management'), row('Vendor Management'), row('Translation')]) +
    section('featured', 'Featured', [row('Article', 'How we cut localization turnaround by a third', 'Lessons from scaling a vendor network')])
);

export const TARGET_PROFILE = page(
  topCard({
    name: 'Daniel Mensah',
    headline: 'Head of Localization at Northwind Learning | Hiring Project Managers',
    location: 'Lagos, Nigeria',
    connections: '1,204',
    extra: `<div><a href="#"><span>Chidi Eze, Funmi Bello and 6 other mutual connections</span></a></div>
      <img alt="Daniel Mensah #HIRING" src="data:," />`,
    buttons: `<button aria-label="Message Daniel">Message</button>
      <button aria-label="Invite Daniel Mensah to connect">Connect</button>
      <button aria-label="More actions">More</button>`,
  }) +
    section('about', 'About', [
      `<div class="inline-show-more-text">${v('I build localization teams for edtech. Last year we launched our courses in 9 new languages. I believe great localization starts with project management, not just translation.')}</div>`,
    ]) +
    section('content_collections', 'Activity', [
      `${row('Daniel Mensah', 'Head of Localization at Northwind Learning', '1w •')}
       <div class="feed-shared-text">${v('We just opened two Localization Project Manager roles in Lagos. Looking for people who have run vendor workflows at scale and love clean processes.')}</div>
       <a href="https://www.linkedin.com/feed/update/urn:li:activity:123/?trk=x">post</a>`,
    ]) +
    section('experience', 'Experience', [
      row('Head of Localization', 'Northwind Learning · Full-time', 'Jul 2026 - Present · 4 mos', 'Lagos, Nigeria · On-site', 'Leading a 20-person localization team across 9 languages.'),
      row('Localization Manager', 'Brightway Media Group · Full-time', 'Jun 2019 - Jun 2026 · 7 yrs', 'Lagos, Nigeria', 'Scaled the vendor workflow and content localization pipeline.'),
    ]) +
    section('education', 'Education', [row('University of Ghana', 'Master of Arts - MA, Translation Studies', '2014 - 2016')]) +
    section('skills', 'Skills', [row('Localization'), row('Project Management'), row('Team Leadership')]) +
    section('featured', 'Featured', [row('Post', 'Our 2025 localization playbook', 'What we learned launching in 9 languages')])
);

// Main profile with weak owner signals (no edit links) — used to test viewer detection.
export const OWN_DETAILS_SKILLS = page(
  `<section class="artdeco-card"><div class="pvs-header"><h2>${v('Skills')}</h2></div><ul>` +
    ['Localization', 'Project Management', 'Vendor Management', 'Translation', 'Subtitling', 'Quality Assurance', 'CAT Tools']
      .map((s) => `<li class="pvs-list__paged-list-item">${row(s)}<a href="/in/amara-okafor/details/skills/edit/forms/1/">✎</a></li>`)
      .join('') +
    `</ul></section>`
);

// ---------------------------------------------------------------------------
// Company pages (/company/<slug>/, /about/, /jobs/)
// ---------------------------------------------------------------------------

function companyTop(extra = '') {
  return `
  <section class="artdeco-card org-top-card">
    <h1 class="org-top-card-summary__title">Northwind Learning</h1>
    <p class="org-top-card-summary__tagline">Online courses for African learners, in their own language</p>
    <div class="org-top-card-summary-info-list">
      <div class="org-top-card-summary-info-list__info-item">E-Learning Providers</div>
      <div class="org-top-card-summary-info-list__info-item">Lagos, Lagos State</div>
      <div class="org-top-card-summary-info-list__info-item">12K followers</div>
      <div class="org-top-card-summary-info-list__info-item">201-500 employees</div>
    </div>
    <a href="#"><span>Chidi Eze &amp; 11 other connections work here</span></a>
    <button>Follow</button>
    ${extra}
  </section>`;
}

export const COMPANY_HOME = page(
  companyTop() +
    `<section class="artdeco-card"><h2>About</h2><p class="break-words">We build localized online courses. Our mission is to make quality education available in every African language.</p></section>
     <section class="artdeco-card"><h2>Page posts</h2>
       <div class="feed-shared-update-v2" data-urn="urn:li:activity:999">
         ${row('Northwind Learning', '12,034 followers', '3d •')}
         <div class="update-components-text">${v('We just launched our first Igbo-language data science course, built with 40 local subject experts.')}</div>
       </div>
     </section>`
);

export const COMPANY_ABOUT = page(
  companyTop() +
    `<section class="artdeco-card"><h2>Overview</h2>
       <p class="break-words">Northwind Learning builds localized online courses. Our mission is to make quality education available in every African language. We have launched courses in 9 languages.</p>
       <dl>
         <dt>Website</dt><dd><a href="https://northwind.example">https://northwind.example</a></dd>
         <dt>Industry</dt><dd>E-Learning Providers</dd>
         <dt>Company size</dt><dd>201-500 employees</dd><dd>312 associated members</dd>
         <dt>Headquarters</dt><dd>Lagos, Lagos State</dd>
         <dt>Founded</dt><dd>2018</dd>
         <dt>Specialties</dt><dd>Localization, Online Learning, Translation, and Curriculum Design</dd>
       </dl>
     </section>`
);

const job = (id, title, loc) =>
  `<li class="jobs-card"><a href="/jobs/view/${id}/?refId=x">${v(title)}</a>${row('Northwind Learning', loc, 'Easy Apply')}</li>`;
export const COMPANY_JOBS = page(
  companyTop() +
    `<section class="artdeco-card"><h2>Recently posted jobs</h2><ul>
      ${job(1, 'Localization Project Manager', 'Lagos, Nigeria (Hybrid)')}
      ${job(2, 'Senior Localization Project Manager', 'Lagos, Nigeria (On-site)')}
      ${job(3, 'Igbo Translator', 'Remote')}
      ${job(4, 'Backend Engineer', 'Lagos, Nigeria')}
      ${job(1, 'Localization Project Manager', 'Lagos, Nigeria (Hybrid)')}
    </ul></section>`
);

// ---------------------------------------------------------------------------
// "Redesigned" layout: two <main>s, no <h1>, no <section>/anchor ids, name only
// in a <p> and in the tab title — the shape that broke name detection.
// ---------------------------------------------------------------------------
const block = (heading, items) =>
  `<div class="x1a2b"><div class="x3c4d"><h2 class="x5e6f">${heading}</h2></div><ul class="x7g8h">${items.map((i) => `<li class="x9i0j">${i}</li>`).join('')}</ul></div>`;
const plain = (...lines) => lines.map((l) => `<p class="xk1">${l}</p>`).join('');

export const OWN_PROFILE_REDESIGN = `<!doctype html><html><head><meta charset="utf-8"><title>(3) Amara Okafor | LinkedIn</title></head><body>
  <main id="workspace" class="x-msg"><div>Messaging</div></main>
  <main class="xmain">
    <div class="xtop">
      <div><img alt="Amara Okafor" src="data:,"/></div>
      <div><p class="xname">Amara Okafor</p></div>
      <p class="xheadline">Localization Project Manager | Translation Ops</p>
      <p class="xloc">Lagos, Lagos State, Nigeria</p>
      <a href="#">Contact info</a>
      <span>500+ connections</span>
      <button>Open to</button><button>Add profile section</button><button>Enhance profile</button>
    </div>
    ${block('About', [plain('I help publishers and NGOs ship multilingual content on time across 14 languages.')])}
    ${block('Experience', [
      plain('Senior Localization Project Manager', 'Kestrel Language Services · Full-time', 'Mar 2022 - Present · 2 yrs 8 mos', 'Lagos, Nigeria · Hybrid', 'Cut average turnaround time by 35% by redesigning the vendor workflow.'),
      plain('Translation Coordinator', 'Brightway Media Group · Full-time', 'Jan 2020 - Feb 2022 · 2 yrs 2 mos'),
    ])}
    ${block('Education', [plain('University of Lagos', 'Bachelor of Arts - BA, French', '2013 - 2017')])}
    ${block('Skills', [plain('Localization'), plain('Project Management')])}
  </main></body></html>`;

// ---------------------------------------------------------------------------
// 2026-style layout seen on live LinkedIn (from user screenshots): generated
// class names, <div>/<p> only (no <li>, no aria-hidden copies), anchor ids in
// tiny wrappers, pronoun + "Verify" badge next to the name, company/school as
// logo links in the top card. People/companies here are fictional.
// ---------------------------------------------------------------------------
const P = (t) => `<p class="_a1b2">${t}</p>`;
const entry = (...lines) => `<div class="_e1"><div class="_e2"><a href="/company/1/"><img alt="" src="data:,"/></a></div><div class="_e3">${lines.map(P).join('')}</div></div>`;
const sec2026 = (id, heading, body) =>
  `<div class="_s1">${id ? `<div class="_anchor"><div id="${id}"></div></div>` : ''}<div class="_s2"><div class="_s3"><h2 class="_h">${heading}</h2></div></div><div class="_s4">${body}</div></div>`;

const top2026 = ({ name, pronouns, degree, headline, location, connections, chips, buttons, extra = '' }) => `
  <div class="_top">
    <div class="_banner"><img alt="" src="data:,"/></div>
    <div class="_t1"><div class="_t2"><h1 class="_n">${name}</h1>${pronouns ? `<span class="_p">${pronouns}</span>` : ''}${degree ? `<span class="_d">· ${degree}</span>` : ''}
      <a href="#verify" class="_v">Verify in 2 minutes</a></div>
      <div class="_hl">${headline}</div>
      <div class="_loc"><span>${location}</span><span> · </span><a href="#contact">Contact info</a></div>
      <div><a href="#conn"><span>${connections}</span></a></div>
      ${extra}
    </div>
    <div class="_chips">${chips.map(([href, label]) => `<a href="${href}"><img alt="${label} logo" src="data:,"/><div><p>${label}</p></div></a>`).join('')}</div>
    <div class="_btns">${buttons}</div>
  </div>`;

export const OWN_PROFILE_2026 = `<!doctype html><html><head><meta charset="utf-8"><title>(3) Omotola Onabanjo | LinkedIn</title></head><body>
<main class="_m">
  ${top2026({
    name: 'Omotola Onabanjo', pronouns: 'He/Him',
    headline: 'EN &lt;&gt; DE - IT - ES Translator &amp; AI Localization Specialist | Senior Associate @EliteLanguageCraft | Project Management Specialist',
    location: 'Slough, England, United Kingdom', connections: '500+ connections',
    chips: [['https://www.linkedin.com/company/elite-languauge-craft/', 'Elite Languauge Craft'], ['https://www.linkedin.com/school/university-of-surrey/', 'University of Surrey, Guildford, UK']],
    buttons: '<button>Open to</button><button>Add section</button><button>Enhance profile</button><button>Resources</button>',
  })}
  <div class="_otw"><p>Open to work · Recruiters only</p><p>Freelance Translator, Subtitler, Localization …</p></div>
  ${sec2026('about', 'About', P('I translate and localize content between English, German, Italian and Spanish, and manage multilingual projects end to end.'))}
  ${sec2026('experience', 'Experience', `
    <div class="_grp"><div class="_gh"><a href="/company/elite/"><img alt="" src="data:,"/></a>${P('Elite Languauge Craft')}${P('Full-time · 3 yrs 4 mos')}</div>
      <div class="_roles">
        <div class="_r">${P('Senior Associate')}${P('Jan 2024 - Present · 1 yr 10 mos')}${P('Slough, England, United Kingdom · Remote')}${P('Lead localization projects for 40+ clients across 4 languages.')}</div>
        <div class="_r">${P('Project Management Specialist')}${P('Jul 2022 - Dec 2023 · 1 yr 6 mos')}${P('Coordinated 120 translation projects and cut delivery time by 20%.')}</div>
      </div></div>
    ${entry('Freelance Translator & Subtitler', 'Self-employed', 'Mar 2019 - Jun 2022 · 3 yrs 4 mos', 'Subtitled 300+ videos (EN, DE, IT, ES).')}`)}
  ${sec2026('education', 'Education', `
    ${entry('University of Surrey, Guildford, UK', 'Master of Arts - MA, Translation', '2017 - 2018')}
    ${entry('University of Lagos', 'Bachelor of Arts - BA, European Languages', '2010 - 2014')}`)}
  ${sec2026('skills', 'Skills', `
    <div class="_k">${P('Localization')}${P('12 endorsements')}</div><div class="_k">${P('Subtitling')}</div>
    <div class="_k">${P('Project Management')}${P('3 experiences across Elite Languauge Craft and 1 other company')}</div><div class="_k">${P('German')}</div>`)}
</main></body></html>`;

export const TARGET_PROFILE_2026 = `<!doctype html><html><head><meta charset="utf-8"><title>Pratik Vadara | LinkedIn</title></head><body>
<main class="_m">
  ${top2026({
    name: 'Pratik Vadara', degree: '1st',
    headline: 'Junior Project Manager', location: 'Noida, Uttar Pradesh, India', connections: '500+ connections',
    chips: [['https://www.linkedin.com/company/big-language-solutions/', 'BIG Language Solutions'], ['https://www.linkedin.com/school/nmims/', "SVKM's Narsee Monjee Institute of Management Studies"]],
    buttons: '<button aria-label="Message Pratik">Message</button><button>More</button>',
    extra: '<div><a href="#mutual"><span>Hayatullah, Ombeni and 55 other mutual connections</span></a></div>',
  })}
  ${sec2026('', 'Experience', `
    ${entry('Junior Project Manager', 'BIG Language Solutions · Full-time', 'Apr 2022 - Present · 3 yrs 7 mos', 'Noida, Uttar Pradesh, India', 'Manage translation and localization projects for global clients.')}
    ${entry('Project Coordinator', 'Lingua Bridge · Full-time', 'Jun 2019 - Mar 2022 · 2 yrs 10 mos')}`)}
  ${sec2026('', 'Education', entry("SVKM's Narsee Monjee Institute of Management Studies", 'MBA, Operations', '2017 - 2019'))}
</main></body></html>`;

// ---------------------------------------------------------------------------
// Shape reported by the diagnostic report from a live profile (Oct 2026):
// 24 <section>s each with an <h2> title ("Skills (55)", "Languages (4)"), the
// NAME in an <h2> (no <h1>), entries in <li>s, aria-hidden used ONLY for icons
// and "·" separators, and no .visually-hidden twins. Fictional data.
// ---------------------------------------------------------------------------
const sep = '<span aria-hidden="true"> · </span>';
const icon = '<svg aria-hidden="true"><path d="M0 0"/></svg>';
const sec10 = (title, body) => `<section class="gfl1"><div class="gfl2"><h2 class="gflkzy">${title}</h2><button aria-label="Edit">${icon}</button></div><div class="gfl3">${body}</div></section>`;
const row10 = (...parts) => `<li class="gfl4"><div class="gfl5"><a href="/company/9/"><img alt="" src="data:,"></a></div><div class="gfl6">${parts.map((p) => `<div class="gfl7">${p}</div>`).join('')}</div></li>`;

export const OWN_PROFILE_OCT26 = `<!doctype html><html><head><meta charset="utf-8"><title>(5) Kemi Adeyemi | LinkedIn</title></head><body>
<main id="workspace" class="gflk3b">
  <section class="gfltop">
    <div><img alt="Kemi Adeyemi" src="data:,"></div>
    <div><h2 class="gflname">Kemi Adeyemi</h2><span>She/Her</span><a href="#v">${icon}Verify in 2 minutes</a></div>
    <div>EN &lt;&gt; FR Translator &amp; Localization Specialist | Senior Associate @BrightLingo | Project Manager</div>
    <div><span>Reading, England, United Kingdom</span>${sep}<a href="#ci">Contact info</a></div>
    <div><a href="#c">500+ connections</a></div>
    <ul><li><a href="https://www.linkedin.com/company/brightlingo/"><img alt="BrightLingo logo" src="data:,"><span>BrightLingo</span></a></li>
        <li><a href="https://www.linkedin.com/school/uni-of-reading/"><img alt="University of Reading logo" src="data:,"><span>University of Reading</span></a></li></ul>
    <button>Open to</button><button>Add section</button><button>Enhance profile</button><button>Resources</button>
  </section>
  ${sec10('Analytics', '<p>Private to you</p><p>182 profile views</p>')}
  ${sec10('About', '<p>I am a Senior Associate at BrightLingo, focused on localization projects and multilingual delivery for clients across Europe and Africa.</p><p>Top skills</p><p>Localization • Software Localization • Translation</p>')}
  ${sec10('Services', '<p>Technical Writing · Project Management · Translation</p>')}
  ${sec10('Featured', `<ul>${row10('Post', 'IELTS English Test Results')}${row10('Article', 'Why “Native Speaker” Is Not Enough')}</ul>`)}
  ${sec10('Activity', `<p>2,318 followers</p>
    <div class="gflpost"><div>Kemi Adeyemi${sep}You</div><div>Senior Associate at BrightLingo</div><div>1w${sep}${icon}</div><div class="gfltext">I’ve just completed the Crash Course in Localization from the Localization Institute and earned the certificate. Here is what I learned about vendor workflows.</div></div>
    <div class="gflpost"><div>Kemi Adeyemi${sep}You</div><div>Senior Associate at BrightLingo</div><div>3w${sep}${icon}</div><div class="gfltext">Hiring translators is the easy part. That’s why it fails: the real work is building review loops and terminology management.</div></div>`)}
  ${sec10('Experience', `<ul>
    ${row10('Senior Associate', `BrightLingo${sep}Full-time`, `Jan 2025 - Present${sep}10 mos`, `Reading, England, United Kingdom${sep}Remote`, 'Managing projects, quality assurance and delivery for 30+ clients.', `${icon}Localization, Proofreading and +3 skills`)}
    ${row10('Freelance Translator &amp; Localization', `Lingvatech${sep}Contract`, `Mar 2016 - Dec 2024${sep}8 yrs 10 mos`, 'Delivered 1,000+ translation projects for global brands.')}
    ${row10('Senior Web Architect', `Novanet Solutions${sep}Contract`, `Sep 2020 - Jun 2022${sep}1 yr 10 mos`, 'Led the design of scalable web platforms.')}
  </ul><a href="#all">Show all 7 experiences</a>`)}
  ${sec10('Education', `<ul>
    ${row10('University of Reading', 'Master of Arts - MA, Translation and Localization Management', `Sep 2017 - Jan 2019`, 'Grade: Distinction')}
    ${row10('University of Lagos', "Bachelor of Arts - BA, French", `Mar 2010 - Feb 2014`)}
  </ul>`)}
  ${sec10('Connected apps', '<p>Buffer</p>')}
  ${sec10('Licenses &amp; certifications (5)', `<ul>${row10('Crash Course in Localization', 'Localization Institute', 'Issued Oct 2025')}${row10('IELTS English Certificate', 'IELTS', 'Issued Aug 2025')}</ul>`)}
  ${sec10('Projects', `<ul>${row10('Apostille and Birth Certificate', 'Mar 2025 - Mar 2025', 'Translated certificates for official use.')}</ul>`)}
  ${sec10('Volunteering', `<ul>${row10('Volunteer Translator', 'Translators Without Borders', 'Jun 2023 - Present')}</ul>`)}
  ${sec10('Skills (55)', `<ul>${row10('Administrative Organization', 'Endorsed by 1 person in the last 6 months')}${row10('Cross-Cultural Communication', '1 endorsement')}</ul><a href="#s">Show all 55 skills</a>`)}
  ${sec10('Recommendations', `<ul>${row10('Sam Field', 'Worked with Kemi on localization projects.')}</ul>`)}
  ${sec10('Languages (4)', `<ul>${row10('English', 'Professional working proficiency')}${row10('French', 'Native or bilingual proficiency')}</ul>`)}
  ${sec10('Organizations', `<ul>${row10('BrightLingo Guild', 'Operation Manager', 'Jun 2025 - Present')}</ul>`)}
  ${sec10('Interests', '<p>Top Voices</p>')}
</main></body></html>`;

// ---------------------------------------------------------------------------
// Company About tab in the current layout (from the user's screenshot): no
// <h1>, info line with "·" separators, overview paragraphs, then label/value
// pairs as headings + paragraphs, sidebar with other pages' follower counts.
// ---------------------------------------------------------------------------
const csep = '<span aria-hidden="true"> · </span>';
export const COMPANY_ABOUT_OCT26 = `<!doctype html><html><head><meta charset="utf-8"><title>(2) Polyglot Interpreters and Translators: About | LinkedIn</title></head><body>
<main id="workspace" class="gflk3b">
  <section class="gfltop">
    <div><img alt="" src="data:,"></div>
    <div><p class="gfln">Polyglot Interpreters and Translators</p><span aria-hidden="true"><svg></svg></span></div>
    <p>The World’s Voice. Interpreted.</p>
    <div><span>Translation and Localization</span>${csep}<span>Winter Haven, Florida</span>${csep}<span>74K followers</span>${csep}<span>51-200 employees</span></div>
    <div><img alt="" src="data:,"><span>Nada &amp; 1 other connection work here</span></div>
    <button>Follow</button><button>Message</button>
    <nav><a href="/company/polyglot/">Home</a><a href="/company/polyglot/about/">About</a><a href="/company/polyglot/posts/">Posts</a><a href="/company/polyglot/jobs/">Jobs</a><a href="/company/polyglot/people/">People</a></nav>
  </section>
  <section class="gflov">
    <h2>Overview</h2>
    <p>Polyglot Interpreters and Translators is a language service and business solutions company based in Winter Haven, Florida, with operations in Egypt and Latin America.</p>
    <p>Our Mission is to increase the productivity and the labor force of our partners without neglecting high standards and cultural awareness.</p>
    <p>We have at our disposal: 200+ interpreters and translators, 200+ languages, and a proprietary language management system.</p>
    <h3>Website</h3><p><a href="https://www.polyglot.example">https://www.polyglot.example</a></p>
    <h3>Phone</h3><p>+1 (863) 000-0000</p>
    <h3>Verified page</h3><p>November 1, 2024</p>
    <h3>Industry</h3><p>Translation and Localization</p>
    <h3>Company size</h3><p>51-200 employees</p><p>723 associated members</p>
    <h3>Headquarters</h3><p>Winter Haven, Florida</p>
    <h3>Founded</h3><p>2017</p>
    <h3>Specialties</h3><p>Workforce Solutions, Outsourcing &amp; Consulting, BPO, Medical Interpretation, Staffing, Customer Service, Data Entry, and Schedulers</p>
  </section>
  <aside><h2>Pages people also viewed</h2><p>Propio Language Services</p><p>141,906 followers</p></aside>
</main></body></html>`;
