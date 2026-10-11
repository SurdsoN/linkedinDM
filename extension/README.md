# LinkedIn DM Architect

A Chrome extension (Manifest V3) that drafts personalized LinkedIn DMs aimed at networking, interviews and hiring conversations. It works on **person profiles** (`linkedin.com/in/…`) and **company pages** (`linkedin.com/company/…`). It reads the page you're viewing and can research the company. It matches all of that against your own synced profile, ranks the strongest openers, and writes 3 editable drafts. Each draft comes with a "why this works" note and a fact-check that highlights any detail not found in either profile.

**It never sends anything.** You review, edit, copy and paste.

---

## Install

**From the zip** (`linkedin-dm-architect-v0.6.0.zip`):
1. Unzip it to a folder you'll keep. Chrome loads the extension from that folder, so don't delete it.
2. Open `chrome://extensions` in Chrome (version 116 or later) and turn on **Developer mode** (top right).
3. Click **Load unpacked** and select the unzipped folder (the one containing `manifest.json`).
4. Pin the extension. Open the side panel from its toolbar icon or the floating **DM Architect** tab on any LinkedIn profile or company page.

**From source:** do the same with this `linkedin-dm-architect/` folder. There's no build step. `npm run package` rebuilds the zip into `dist/`.

To update, replace the folder's contents and click the ↻ reload button on the extension's card in `chrome://extensions`.

## Updating

Updates are published to **[github.com/SurdsoN/linkedinDM](https://github.com/SurdsoN/linkedinDM)**. The panel checks once a day and shows a banner when a new version is out.

1. Open **Settings → Updates** and click **Check for updates**.
2. Click **Install update**. An update page opens; the first time, choose the folder you installed DM Architect from. Chrome asks you to allow access, and the panel checks that folder's `manifest.json` is really this extension.
3. **Install update** downloads the zip and verifies it: SHA-256 from `version.json`, extension name, version, and only extension files are allowed. It writes the files into the folder, `manifest.json` last, and reloads the extension.

Chrome only auto-updates Web Store extensions, so this is the one-click path for an unpacked install. You can always update by hand instead: download the zip, copy it over the folder, and click ↻ in `chrome://extensions`. Settings, keys, the synced profile and saved drafts are kept, because they live in Chrome's storage, not in the folder.

**Publishing a release** (maintainer): bump `version` in `manifest.json`, add a section at the top of `CHANGELOG.md`, then run `sh scripts/publish.sh /path/to/linkedindm`. This writes `releases/<zip>`, `version.json` (version, notes, sha256) and the source mirror in `extension/`. Commit and push that repo.



### 1. Tell it who you are (Settings → You)
Enter **your name** as it appears on LinkedIn (required). Optionally add **your LinkedIn profile URL or username** (e.g. `linkedin.com/in/your-name`); it's recommended. Sync uses these to confirm a page is yours before saving anything.

### 2. Sync your profile (once, no upload)
1. Go to your own profile, `linkedin.com/in/<you>/`. The side panel's **Open my profile** button takes you there.
2. The panel shows **Sync My Profile**.
3. Click it. The extension checks the page is yours:
   - **with a username set:** the page address must match it exactly;
   - **with only a name:** the name on the page must match your Settings name (accents, middle names and suffixes like ", MBA" are fine), and the page must not show Connect/Message buttons;
   - **if the page shows no readable name:** it relies on owner-only controls such as "Add profile section" and "Open to".

   If the check passes, it scrolls the page so LinkedIn loads every section, reads it, and saves a structured JSON copy in `chrome.storage.local`. Your name is always taken from Settings. After the first sync, your username is filled into Settings automatically so later checks are exact. If the check fails, nothing is saved and the panel says why.
4. You'll see what was captured (roles, schools, skills…) and the last sync time. Use **Re-sync** after you update your profile.

LinkedIn's main profile page only shows part of long lists (e.g. "Show all 12 experiences"). The panel warns you when this happens. Open that **Show all** page (`/in/<you>/details/experience/`) and click Sync there to add the full list to your saved profile.

If your own profile shows up as someone else's, use **"Is this your profile? Check your name / username in Settings"**.

Add an **About me note** (on your profile view or in Settings) for things that aren't on your profile, such as what you're looking for, availability or a recent win. AI drafts use it; it's stored only in your browser.

### 3. Draft a DM
1. Open someone else's profile, or a company page.
2. Click **Analyze profile**. The panel ranks hooks such as shared employers or schools (with date-overlap detection), recent posts, new roles, hiring signals, one of your measurable results that matches their focus, shared or complementary skills, featured items, a line from their About, mutual connections and location.
3. Keep the top 3 or pick your own (up to 3).
4. Choose a **Goal**: Warm Network, Value-First, Soft Opportunity, **Interview Request**, or Peer Collaboration. Then pick a **Tone** and a **Length** (DM ≤600 chars, or connection note ≤300).
5. Click **Generate DM**. Edit the drafts in place, then use **Copy**.
   - **↻ Regenerate** rewrites just that one draft and keeps the others, including your edits.
   - **Fact-check:** any name or number not found in your profile, your note, the viewed page or the research is highlighted with "check before sending". This mainly catches AI-invented details. It updates as you type.
   - **☆ Save** keeps a draft in **★ Saved drafts** as a reusable template. The recipient's name and company become `{{firstName}}` / `{{name}}` / `{{company}}`, so no target data is stored. Use **Use for <name>** to drop it into the current profile.

### 4. Research the company (interview-focused)
On a person's profile, the research card offers **the company they currently work at**. On a company page it offers that company. You can edit the name if it's wrong.

- **Research company** uses Groq web search or Gemini with Google Search (whichever you selected first, the other as backup) to find what the company does, recent news, **the areas it hires for most**, **where it tends to hire from** (backgrounds, companies, schools, when that's public), its values and interview talking points, with source links.
- Each hiring area is matched against your synced profile (✓ matches you). The best match becomes a **hiring domain** hook, which ranks highest under **Interview Request**. If the company often hires from a background you have (e.g. a former employer), you get a **talent source** hook.
- Without a key, company pages still show hiring areas taken from the job titles on the company's **Jobs** tab.
- Only the company name (plus industry and location from the page, to pick the right company) is sent. No profile text goes into the research request. Results stay in memory and are reused for other people at the same company until the panel closes.

### 5. Company pages: Analyze → Research → Application
Company pages have their own three-step flow, tracked at the top of the panel. There's no DM section on company pages.

1. **Analyze the About page.** Open `linkedin.com/company/<name>/about/` (the panel offers an **Open the About tab** button) and click **Analyze company**.
2. **Research (Tavily).** This starts automatically after step 1. Tavily searches the web, and Groq combines the results with the About page. Groq or Gemini web search is used only if Tavily fails, and results are saved for 7 days.
3. **Application message.** Pick a tone and click **Draft Application Message**.

Details: The panel reads the name, tagline, the "Industry · Location · Followers · Employees" line, the full Overview and the details (website, size, headquarters, founded, specialties). It then **researches the company automatically, Tavily first**, combining the search results with what's on the page. Groq or Gemini web search is the fallback, and a saved copy (7 days) is reused.

**Draft Application** (company pages) writes a job application, with a subject line and a message of **at most 700 characters** (LinkedIn's message limit is 750), for the company's careers email, a LinkedIn message or a recruiter. It uses **Groq** when a Groq key is saved, otherwise your selected provider. It's built only from your synced profile, About-me note, the company page and the research. It pitches the role area that matches you, backs it with your real results, and ends with a request for an interview. If a draft comes back longer than 700 characters, it's shortened automatically. While you edit, a counter shows `n / 700 · LinkedIn limit 750` (orange over 700, red over 750), with a **Shorten to 700** button. You can edit it, the fact-check runs on it, **↻ Regenerate** writes a different version, and you copy it out. Nothing is sent or stored.

Open `linkedin.com/company/<name>/` and click **Analyze company**. Then open its **About**, **Posts** and **Jobs** tabs and click Analyze on each; the panel combines them (overview, size, specialties, posts, open roles, connections who work there). Optionally type **who you're messaging** (e.g. a recruiter's name). Otherwise drafts are addressed to "<Company> team".

If you worked at the company, you get an **alumni** hook.

## AI generation: Groq (default, free)

[Groq](https://console.groq.com/keys) has a free plan with no credit card and fast replies. That's why it's the default: drafts usually arrive in a few seconds. Its free plan allows about 30 requests a minute and roughly 1,000 a day on its larger models, which is plenty for one-at-a-time outreach. Limits are per model and change over time; your Groq console shows the current ones.

1. Sign in at **console.groq.com**, open **API Keys**, and create a key (starts with `gsk_`).
2. In Settings, **AI provider: Groq** (already selected). Paste the key and click **Save**. The Model list fills with the chat models your key can use, and the best one is chosen (`openai/gpt-oss-120b` when available).
3. Click **Test key** to confirm it works, then tick the consent box.

**Company research** tries, in order, every engine you have keys for:
1. **Groq web search.** First `groq/compound`; if your key can't use it ("does not exist or you do not have access"), then `openai/gpt-oss-120b` / `20b` with Groq's built-in **browser search** tool, which is free during its beta.
2. **Tavily** (optional, recommended backup). Add a free key from [app.tavily.com](https://app.tavily.com/) under **Settings → Web research**; the free plan gives 1,000 searches a month with no card. Each research uses 2 searches, and your AI provider (e.g. Groq) summarises only those results.
3. **Gemini with Google Search**, if you've added a Gemini key.

With Gemini selected as the provider, Gemini goes first. If every engine fails, the message shows what each one said.

**Quota-friendly by design:**
- Research results are saved on your computer for 7 days, so revisiting a company or another person at it costs nothing. Use **Research again** for fresh results, or **Clear saved research** in Settings.
- If a model's daily free quota is used up, the next model is used for that request, since each model has its own quota. A per-minute limit tells you how many seconds to wait.
- Models that get retired are replaced automatically, for both Groq and Gemini.

### Google Gemini (alternative, free tier)

In Settings, choose **Google Gemini**:

1. **AI provider:** Google Gemini is selected by default.
2. **API key:** paste your key from [Google AI Studio](https://aistudio.google.com/app/apikey). Use **Show** to check it, **Save** to store it, and **Test key** to confirm it works.
3. **Model:** picked for you. When you save or test a Gemini key, the extension asks Google which models that key can use (a free call). It fills the model list with them and chooses the best one, preferring **Flash** models, which are what the free tier includes. If Google later retires the model you're on, the next request returns "not found". The extension then switches to the best available model, saves it, tells you, and retries automatically. You can still type any model id yourself.
4. Tick the consent box. AI generation and research stay off until you do, because they send data to the provider.

The key field is masked while you type. **Show** reveals only what you're typing and re-hides when you click away. Once saved, the key is never put back into the field; you only see a masked preview (`AIza••••••••7890`). Saving with the field empty keeps the existing key, and **Remove key** deletes it.

Drafts use Gemini with `responseMimeType: application/json` and a strict `responseSchema` (`variants[] → angle, message, why, hooksUsed`), so results always come back in the same structure.

OpenAI, Anthropic Claude and xAI Grok can also be used for drafts (paid). Research always uses Groq or Gemini, because they have web search. With no key, or provider set to **None**, the extension uses its built-in local templates. These are less fluent, but they are built only from your real data.

## Privacy & safety

| | |
|---|---|
| Your synced profile + About-me note | Stored only in `chrome.storage.local` on this browser. View or delete in Settings. |
| Profiles / company pages you view | Kept in the side panel's memory only. Never written to storage, never sent to any server we run (there is none). Cleared when you navigate to someone else. |
| Company research | Sent only to the search engine you use (Groq, Tavily or Gemini). Saved on this computer for 7 days (public company information only; clear it in Settings). The request contains the company name and a little context, never profile text. |
| Saved drafts | Stored locally as templates with the recipient's name/company replaced by placeholders. |
| API keys | Stored in `chrome.storage.local` and sent only to the provider you choose. |
| LLM calls | Only when you click **Generate DM** with a key and consent. They go straight from your browser to the provider. Only the fields needed for writing are sent (no profile URLs or follower counts). |
| Page access | The content script reads a page only when the side panel asks (after your click), and only the page that is open. It never visits other pages, clicks LinkedIn buttons, or sends messages. Its only on-page addition is the floating button, which you can hide (×) or turn off in Settings. |
| Bulk actions | None. One profile, one click, one set of drafts. |

> **LinkedIn Terms of Service:** LinkedIn's User Agreement restricts automated access to and copying of its data. This tool reads only the page you are viewing, only when you click, and never automates messaging. You are responsible for how you use it. Keep it to personal, one-at-a-time outreach.

## Project structure

```
linkedin-dm-architect/
├── manifest.json                  MV3 manifest (side panel, content script, host permissions)
├── icons/                         16/32/48/128 px icons
├── src/
│   ├── background/service-worker.js   Opens the side panel (toolbar icon or floating button)
│   ├── content/
│   │   ├── extractor.js           Extraction engine: person profiles (own + target) and company pages
│   │   └── content-script.js      Answers LDA_PING / LDA_EXTRACT; floating button
│   ├── shared/storage.js          chrome.storage.local wrapper (profile, settings, note, favourites)
│   ├── engine/
│   │   ├── hooks.js               Hook ranking + matching (person, company, research hooks)
│   │   ├── research.js            Gemini + Google Search company research; Jobs-tab hiring domains
│   │   ├── factcheck.js           Flags names/numbers not found in the source data
│   │   ├── favorites.js           Saved-draft templates ({{firstName}}, {{company}})
│   │   ├── text.js / errors.js    Shared helpers
│   │   ├── prompt.js              System prompt, goal/tone/length rules, JSON schema
│   │   ├── llm.js                 Groq / Gemini / OpenAI / Anthropic / Grok clients
│   │   ├── http.js                Shared requests + rate-limit classification
│   │   ├── gemini-models.js       Gemini model discovery / fallback
│   │   ├── groq-models.js         Groq model discovery / fallback
│   │   └── templates.js           Local no-API generator (person + company)
│   └── sidepanel/                 UI (HTML/CSS/JS, vanilla ES modules)
├── scripts/package.sh             Builds dist/linkedin-dm-architect-v<version>.zip
└── tests/
    ├── fixtures.mjs               Synthetic LinkedIn-like pages (fictional people)
    ├── run-tests.mjs              Extractor (in Chromium) + engine unit tests
    └── e2e-extension.mjs          Loads the real extension and drives the side panel
```

### How extraction works
LinkedIn's class names are obfuscated and change often, so `extractor.js` anchors on more stable structure:
- section anchor ids (`#about`, `#experience`, `#education`, `#skills`, `#featured`, `#content_collections`…), with `<h2>` heading text as a fallback
- `li` rows within those sections, including nested roles grouped under one company
- the `span[aria-hidden="true"]` visible-text convention, which avoids LinkedIn's duplicated screen-reader text

Text is read from the visible DOM. The old trick of reading only `span[aria-hidden="true"]` is applied only where LinkedIn still renders `.visually-hidden` screen-reader twins. In the current layout aria-hidden marks just icons and "·" separators, and the separators are stitched back into lines like "Acme · Full-time". When LinkedIn's markup has no usable lists, as in its 2025–26 layout built from `<div>`s with generated class names, entries are found **by their date ranges**: the extractor finds each "Jan 2020 – Present" line and works out to that entry's block. Grouped roles take their company from the group header. The top card skips pronouns ("He/Him"), connection degree and badges when reading the headline. Current company and school come from the logo links beside the name, or from "@Company" in the headline.

Each row becomes plain text lines, and small parsers turn lines into fields (dates, employment type, location, work mode, "Skills:" lines…). A markup change therefore usually degrades one field rather than breaking the whole sync.

**Own vs. target detection** (`detectOwnProfile`) checks owner-only controls ("Add profile section", "Open to", "Enhance profile", edit links, the "Private to you" analytics card) against viewer-only ones ("Message", "Connect", "Follow", mutual connections). Once you've synced, an exact slug match is definitive.

### Profile schema (abridged)
```jsonc
{
  "schemaVersion": 1,
  "source": { "url", "publicIdentifier", "pageType", "extractedAt" },
  "name", "headline", "location", "pronouns", "connections", "followers",
  "currentCompany", "currentSchool", "about",
  "experience": [{ "title", "company", "employmentType", "dateRange": { "start", "end", "raw" },
                   "duration", "isCurrent", "location", "workMode", "description", "skills": [] }],
  "education": [{ "school", "degree", "field", "dateRange", "grade", "activities", "description" }],
  "skills": ["…"],
  "featured": [{ "type", "title", "snippet", "url" }],
  "activity": [{ "kind", "when", "text", "url" }],
  "certifications", "projects", "volunteering", "honors", "languages", "publications",
  "signals": { "openToWork", "openToWorkDetails", "hiring", "providingServices",
               "mutualConnections": { "count", "text", "names": [] } },
  "meta": { "sectionsFound": [], "warnings": [], "truncated": {} },
  "syncedAt": "…"   // own profile only
}
```

Company pages produce `entityType: "company"` with `name`, `tagline`, `industry`, `headquarters`, `companySize`, `founded`, `website`, `specialties`, `about`, `activity` (posts), `jobs` (`[{title, location}]`), and `signals` (`hiring`, `jobsCount`, connections who work there). Extractions from different tabs are merged in memory (`mergeCompany`).

## Tests

Requires Node 18+ and Playwright with a Chromium build.

```bash
npm test            # extractor in headless Chromium + hook/prompt/generator unit tests
npm run test:e2e    # loads the extension and drives sync, note, floating button, generate, regenerate,
                    # fact-check, favourites, masked key, research (mocked Gemini) and company tabs
# EXT_PATH=/path/to/unzipped npm run test:e2e   runs the same test against a packaged build
# Optional: CHROMIUM_PATH=/path/to/chromium npm test
```

The fixtures copy LinkedIn's markup patterns but are synthetic. LinkedIn changes its DOM regularly, so if a field stops filling in, check it on a live page and adjust the matching parser in `extractor.js`.

## Troubleshooting

**"Test key" or "Generate" takes a while.** Newer Gemini models think before answering, and the free tier is often busy. **Test key** first confirms the key by listing your models (instant), then sends a one-word test to the model, giving up after 25 seconds. A full draft can take 20–60 seconds; the button shows the elapsed time. For faster replies, pick a `flash-lite` model in the Model field.

**"Today's free quota for openai/gpt-oss-120b is used up".** Groq's free tier caps tokens per model per day, and web research uses a lot of them because whole pages are read in. Research therefore runs on `gpt-oss-20b` first, which has its own quota, leaving `gpt-oss-120b` for drafts. When a model's quota is used up, the next model is used for that request only; your default isn't changed. Replies that come wrapped in reasoning (`<think>…</think>`, e.g. Qwen) are handled. If a model still answers in an unusable shape, the next one is tried.

**Tavily error 432.** Tavily refused the search because your plan's or key's usage limit is reached. Check **app.tavily.com → Usage**: the free plan has 1,000 credits a month, and a per-key limit may have been set. Research uses 2 credits per company, and results are saved for 7 days.

**"Rate limit reached".** Free tiers allow only a few requests a minute plus a daily cap, per model. Gemini's web-search allowance is especially small. The message says whether to wait (and for how long) or whether today's quota is used up. Adding a free **Groq** key gives you a second, separate quota: research and drafts switch to it automatically.

**Sync says it couldn't read something, or most sections come back empty.** LinkedIn changes its page layout often. Click **Copy diagnostic report** in the sync result and share it. The report describes the page structure (tags, class names, which section headings were found, counts) and what was extracted. It contains **no names or profile text**, and makes it possible to adjust the extractor to the layout you're seeing.

**"This doesn't look like your profile."** Check **Settings → You**. The name must match how it appears on LinkedIn, and the username must be the part after `linkedin.com/in/` in your profile address.

## Known limitations
- LinkedIn redesigns can break individual selectors. The extractor degrades per field and reports warnings instead of failing silently.
- Some activity/post text only appears after LinkedIn lazy-loads it. Sync and Analyze scroll the page first to trigger that.
- Model names change over time. Every provider's model field is free text.
