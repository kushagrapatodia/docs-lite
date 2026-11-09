# QA report

What was tested, how, and what it found. Numbers are from the final run.

## Automated

| Suite | Count | What it covers |
|---|---|---|
| `npm test` | 186 | API and authorisation matrix (owner / editor / viewer / stranger), concurrency and conflicts, live events, comments and replies, versions and named versions, trash, stars, view links, page setup, search, idempotency, observability, sanitiser and style grammar, `.docx` / Markdown / HTML / text conversion, migrations from older databases, rate limits |
| Fuzz and property tests (inside `npm test`) | thousands of cases | Random hostile HTML (every surviving attribute is checked against its exact grammar), mutated `.docx` files, 3,000 random malformed API requests (including page setup, view links, named versions, replies and search), SQL-injection style strings, prototype pollution |
| Stress and scale (inside `npm test`) | 2 | 40 users writing to one document; listing 3,000 documents of about 100 KB each in under 1.5 s |
| `/qa/` in a browser | 43 | Paste cleaner, formatting operations, checklist clicks, picture processing (scaling, PNG to JPEG fallback, rejection of bad files), table of contents, three-way merge at paragraph and word level, writing statistics (Chinese, Arabic) |
| `node scripts/bench.js` | 1 | 40 writers (each on their own document) and 20 readers: roughly 600-1,100 saves per second, p50 about 20-25 ms, p99 about 350-450 ms on a loaded laptop with an in-memory database (13 runs gave 630-1,090) |

## Manual, in a real browser

Run as three different users where relevant, with real clicks and real keystrokes (scripted input hid bugs more than once).

- **Writing:** every toolbar control, markdown shortcuts, slash menu, command palette, find and replace, checklist ticking, tables, pictures (file picker, drop, paste), link popover, page breaks, table of contents (auto-refresh on save, link clicks), templates, page setup, drawing dialog, word count.
- **Collaboration:** two windows editing, presence, live selections with name flags, comments with replies, a conflict that merged automatically (different paragraphs), a conflict dialog for true overlaps, role changes and revocation while a document is open, viewer mode.
- **Safety nets:** version history and named versions, restore, trash and undo, draft recovery, offline retry, session expiry mid-edit.
- **Sharing:** view link opened signed out (also dark mode), link turned off and replaced, a trashed document's link.
- **Files:** `.docx` / `.md` / `.txt` import, export to Word, Markdown, HTML, text; Word output opened with python-docx (pictures, header and footer, orientation, page breaks, checklists).
- **Responsive and themes:** 375 px phone width (dialogs, toolbar, picture bar, templates), light, dark and auto, reduced motion, an automated check that every interactive element has an accessible name.
- **Operations:** Docker image built and run (non-root, data survives a restart, health check, metrics, token redaction in logs).

## Known gaps (not hidden)

- **Service worker / offline** was written and its registration bug fixed, but the embedded browser used for testing refuses to fetch the worker script, so offline opening and cached reading are **not verified end to end**. It only activates on HTTPS or localhost.
- **Live selection painting** was verified with a second user's selection injected through the API and seen in the first user's editor; two real browsers editing at once was not exercised.
- Word-level merge is capped at about 4,000 tokens per document; larger documents fall back to the conflict dialog.
- No automated end-to-end browser tests run in CI (the `/qa/` page is run by hand).

## Independent reviews

Two read-only review agents that did not write the code were pointed at the server and at the client near the end of the work. Their findings and what was done about them:

**Server review (done): 14 findings, 13 fixed, 1 partly.**

| # | Finding | Result |
|---|---|---|
| 1 | Crafted HTML (a few hundred KB of unclosed `<svg`, `<!--`, `<![CDATA[`, `<a`) froze the server for minutes (quadratic regexes) | Fixed: one linear pass; 400-600 KB of each now sanitises in under 60 ms; regression test |
| 2 | A tiny `.docx` with repeated unclosed `<w:del`/`<w:tbl`/`<mc:Fallback` did the same | Fixed: linear scans, smaller inflate cap; regression test |
| 3 | A spoofed `X-Forwarded-For` bypassed every rate limit behind a proxy | Fixed: the proxy-appended (rightmost) address is used; test |
| 4 | Huge usernames inflated rate-limiter keys (memory) | Fixed: key length capped; test |
| 5 | Two writers could silently overwrite each other when one upload was slow | Fixed: the document is re-read after the body arrives, in the same tick as the write |
| 6 | Page-setup header text could close the `<style>` element in the HTML export | Fixed: `<`, `>`, `&` are CSS-escaped; test |
| 7 | Erased documents stayed in the search index | Fixed for the index. Cached idempotency responses are now purged hourly after one hour (so they live up to about two hours) |
| 8 | Idempotency matched on body length, and stored huge responses | Fixed: body hash in the fingerprint; responses over 100 KB are not stored |
| 9 | A non-ASCII `Authorization` header made `/metrics` return 500 | Fixed: digests are compared |
| 10 | Word export: control characters and zero-size pictures could produce a file Word rejects | Fixed |
| 11 | Public link response was cacheable | Fixed: `no-store` |
| 12 | Restoring a version skipped the sanitiser | Fixed |
| 13 | Migrations were not atomic | Fixed: one transaction |
| 14 | Markdown export could carry live HTML | Fixed: `<` and `&` escaped |

**Client review (done): 15 findings; the serious ones are fixed.**

| # | Finding | Result |
|---|---|---|
| 1 | Auto-merge switched itself off after the first successful save (stale base) | Fixed and re-verified in the browser: a local edit after a save merged with a remote edit to another paragraph |
| 2 | A closed editor kept retrying its save after sign-out and could save as the next user | Fixed: no retries after teardown, a 401 keeps a draft and stops |
| 3 | The offline cache was not tied to a user | Fixed: cleared on login and on 401 (sign-out already did) |
| 5 | A word-level merge could produce unbalanced tags | Fixed: refused unless the tags balance; test |
| 6 | Restoring an old draft could overwrite newer edits silently | Fixed: an older draft goes through the conflict dialog |
| 9 | The slash menu took over Enter in ordinary text such as "and / or" | Fixed: opens only at the start of a line |
| 10 | Formatter listener leaked on every document opened | Fixed |
| 14 | A merge left the conflict banner showing | Fixed |
| 15 | The service worker served one-version-old scripts | Fixed: scripts and styles are network-first, cache name versioned |
| 4, 7, 8, 11, 12, 13 | Caret shift after remote updates, edits lost when leaving during a conflict or preview, slow open racing navigation, async inserts into a closed editor, version rollback race, palette focus trap and menu keyboard support | Fixed in a second pass (block-relative caret, draft stash on leave, route check, connectivity checks, version guard, palette focus trap, arrow-key menus). The link popover now also opens from the keyboard (Alt+Enter on a link) |

## UI / UX audit

A separate design-audit agent (senior product-design persona, with web research and measured values from the running app) sent 38 findings. Applied:

| Area | What changed |
|---|---|
| Contrast | Form-control borders now 3:1; status colours, avatars, peer flags, hero text, danger button and dark-mode toasts at 4.5:1 or better; placeholders; resolved comments no longer fade below readable |
| Keyboard and screen readers | One toolbar tab stop with arrow keys; `aria-expanded` and Escape on menus; cards are real links; filters are a button group instead of fake tabs; auth errors tied to fields; skip link; live-region fix for toasts |
| Layout | One control height; 12 px minimum text; compact editor header; toolbar wraps on tablets and scrolls on phones; side panels float over the page below 1280 px; phone toolbar docked above the keyboard |
| Documents page | Grid or list, grouped by recency, dates visible, quieter "Owner" pill, tips only for new users |
| Editor | Selection bar, commented text tinted, outline follows scrolling, page stays white in dark mode, document spacing and heading scale |
| Dialogs | First field focused, footer order, backdrop drag no longer closes a dialog and discards typing, toasts pause on hover, new-document dialog with template thumbnails |
| Share | Drive-style: people first, then "General access: Restricted / Anyone with the link" with one Copy link button |
| Foundations | Motion tokens and reduced-motion fix, type / radius scales added, icon stroke consistency, Mac key labels |

Not applied (reasons): self-hosting a web font (needs a download; the system font is used), a live paper preview in Page setup, a full oklch colour-token rewrite, a toolbar overflow menu, an onboarding progress checklist, per-field validation on every form.

## Late audit round (performance, UX, visual design)

Three more agents audited performance (50,000-document database, 2,000 live streams), usability and visual design. Fixed: live-stream connect/disconnect cost, slow-client memory growth, serialising each event once, trash and search stale-answer guards, error toast overlap, document title clipping, Replace button in the find bar, toolbar and card alignment, dark-mode thumbnails, public page layout, paper colour tone, touch target heights, a higher shared API limit (2,400/min per address) and a per-user save limit (300/min). Also added: PNG app icons, a logo that matches the favicon, Share in the card menu, a table-size prompt, Rename in the document menu, a proper not-found page, a trash search filter, a neutral info banner, select chevrons. Also: large-document `refetch` announcements are limited to one a second per document. Not done: caching large-document downloads, compressing version snapshots, hover-only card actions.

## Final code audit

Six more agents audited server code, client code, security (black box), production readiness, front-end standards and the submission against the brief, and a seventh wrote extra tests. Fixed from them: sign-up race (500 to 409), purged documents left in the search index, non-text titles, login spraying across usernames, oversized bodies refused before reading, a Word export bug that added a line break each round trip, a migration that left word counts at 0, a forged `.docx` entry size that could use hundreds of MB, idempotency stored only for routes that create something (it was filling the disk through `/api/convert`), the duplicate button failing in the browser, the `/qa/` gate being bypassable by URL encoding, link targets that could break Markdown, navigation errors, listener leaks, a hung-request timeout, a router error boundary, a longer keep-alive timeout behind proxies, `scripts/` in the Docker image, a health check path in `render.yaml`, and a CI job on Node 22.16. Remaining, by design: a very large sanitise still runs on the main thread, version history is outside the storage quota, demo accounts seed unless `SEED_DEMO=0`, the editor module is large, and static files revalidate on every load.
