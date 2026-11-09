# AI workflow note

## Tools used
- **Claude Code** (Claude Sonnet 5.5, in the Claude desktop app) as the pair-programming agent: wrote the code, tests and docs in this repository, running them as it went.
- **Claude's built-in browser pane** to drive the running app with real clicks and keystrokes (login, editing, sharing, conflicts, uploads, mobile and dark mode, console and CSP errors), instead of trusting that code "looks right".
- **python-docx** (a third-party Word library) as an independent oracle for the `.docx` import and export code.
- **Independent review subagents**: read-only review subagents that had not written the code and were told to hunt for bugs: server and client reviewers first, then security, performance, usability, visual design and document-claims audits (see `QA_REPORT.md`), run once the feature set was largely frozen.
- **A research subagent** that searched the web for what current editors (Google Docs, Notion, Linear, Figma) and modern engineering write-ups do, and sent back ranked, implementable ideas while I kept building. About 30 ideas arrived; I built the ones with the best impact for the effort (command palette and slash menu were already done; live selections, observability, idempotency, full-text search, view transitions, a modern CSS layer, offline shell, drawing, writing insights) and skipped the rest on purpose (suggesting mode, mentions and notifications, request-access flow, Trusted Types, e2e over the DevTools protocol, version compaction). Its claims were not taken on trust: it was told to verify, I re-checked each one in the browser or with a test, and it admitted some ideas came from memory rather than opened sources.

## Where AI materially sped things up
- **The whole slice in one structured pass:** access model first, then persistence, then UI, with tests written alongside each route instead of after.
- **Breadth that would normally cost days:** a dependency-free `.docx` reader and writer, live collaboration over server-sent events, version history, comments, trash, tables, an in-browser test page. Each came with tests.
- **Test generation at scale:** the authorisation matrix (owner / editor / viewer / stranger), the concurrency tests, and especially the seeded **fuzz and property tests** that generate thousands of hostile inputs. Writing those by hand is tedious; they were the single most productive use of AI here.
- **Fast verification loops:** the agent ran the app in a real browser after every change and could check a screenshot, the DOM, the console and the network in seconds.

## What AI got wrong, and how it was caught (the honest list)
Left unchecked, the first version of each of these would have shipped:

| Problem | How it surfaced |
|---|---|
| Chrome produces invalid `<p><ul>…</ul></p>`; my exporters silently dropped the list bullets | A real-browser test with the toolbar, then fixed in the sanitiser with a regression test |
| The paste cleaner lost bold/italic from Google Docs and Word (inline styles), and wrongly bolded everything Google Docs wraps in `<b style="font-weight:normal">` | A synthetic paste in the browser; now covered by `/qa/` |
| Typing `## ` / `- ` shortcuts appeared to fail | Scripted typing could not reproduce them; real keystrokes via the browser tool confirmed they work. I stopped trusting the synthetic test |
| A crafted `.docx` declaring list level 99999 built a 100,000-deep list (denial of service), and 50,000 nested `<b>` made exports overflow the stack | Fuzz tests; fixed with clamps and a nesting-depth cap |
| Text directly inside a list or table was dropped on export; text after a nested list was reordered; `<hr>` became the literal string "* * *" in Word | Property tests (random document → Word → back must preserve the text) |
| After restoring a version, the author got a toast telling them *they* had updated the document | Manual QA in the browser |
| Session expiry in the middle of typing lost the edit | I tried it deliberately; added draft stash and recovery |
| A directory URL (`/qa/`) returned 404; the zip writer wrote an invalid all-zero DOS date | Browser check; python-docx/unzip inspection |
| The CSP blocked the browser's own editing commands and spammed the console | Checked the console during real editing; narrowed the policy to allow style *attributes* only |
| `node --test test/` did not resolve in Node 25 | The first test run failed; fixed with a glob |
| A document that contained only a picture was saved as an empty document (autosave treated "no text" as "empty") | Real-browser test of the first picture insert: the server copy stayed `<p><br></p>`; fixed and pinned by a test |
| The star on a document card flipped back (the card edited a copy of the data, the next redraw used the original) | Clicking it for real in the browser; fixed to update the source list |
| New-document templates looked broken (title right, body empty) | I had not restarted the dev server after changing the API; found by checking the response, not by trusting the UI |
| The service worker never registered (the `load` event had already fired when the module ran) | Checked `navigator.serviceWorker.getRegistrations()` in the browser; fixed. The embedded browser still refuses to fetch the worker script, so offline behaviour is **not** verified end to end |
| The Word export of a page break produced an extra empty paragraph on re-import | Round-trip test (HTML to Word to HTML) |
| A tall dialog pushed its buttons off a phone screen | 375 px viewport check; dialogs now scroll inside |
| A shell `sed -i` that worked on Linux silently failed on macOS and the following commands in the chain never ran | The expected test never appeared; I now check that a test exists before trusting a green run |
| Crafted input could freeze the whole server (regexes that rescanned the file for every unclosed tag, in the HTML sanitiser, the Markdown converter and the `.docx` reader), and one malformed request line could end the process | A black-box security-audit agent, then regression tests. My first `.docx` fix only counted tags, so the same agent showed it was bypassable and I replaced it with an order-checking pass |
| Password hashing blocked the event loop (a login burst froze everyone else) and an unknown user answered much faster than a wrong password | A performance-audit agent and the security agent; fixed with asynchronous scrypt and a dummy hash check |
| The seeded "Welcome" card showed the text "undefined" on a fresh database | Looking at a clean instance's screenshot, not the long-lived dev database; fixed and pinned by a test |
| Docs overclaimed: a benchmark number measured once on an idle machine, a stale test count, a contradiction about conflict merging, "drawing" listed as cut though built, a wrong Node version | A fact-checking agent and a fresh-eyes reviewer agent each checked every claim against the code and by running it |

## What was changed or rejected on purpose
- **Rejected a framework + ORM stack** (Express, React, Prisma) for zero dependencies, so reviewers install nothing and there is no supply chain to audit.
- **Rejected an unconditional auto-merge** for simultaneous edits. A wrong merge is worse than a clear choice, so conflicts merge only when the changes do not overlap and the result is structurally valid; otherwise a dialog asks (use theirs / keep mine / save mine as a copy).
- **Chose not to build** CRDT co-editing, suggesting mode and email invitations. Cuts are listed in `ARCHITECTURE.md`.
- **Server is the authority on access.** The first UI sketch only hid buttons for viewers; the design was changed so every rule is enforced and tested on the server, with the UI merely reflecting it.

## How correctness, UX and reliability were verified
- `npm test`: 186 automated tests (including fuzz and 3,000 random malformed API calls, a 40-user concurrency stress test, a 3,000-document list-speed test, migration from an older database, and a real Word-style fixture).
- `/qa/`: a browser-run suite (43 tests) for client logic that needs a real DOM: paste cleaner, formatting, picture processing, table of contents, the three-way merge, writing statistics.
- Manual end-to-end checks in a real browser, including live selections between two users, conflicts that merge, offline recovery, session expiry, imports and exports, pictures by drag, drop and paste, public links signed out, and a 375 px phone viewport.
- `.docx` output opened with python-docx (pictures, header and footer, orientation, page breaks).
- Docker image built and run: non-root, data survives a restart, health check goes healthy, request log redacts view-link tokens.
- Independent agents audited the server code, the client code, security (black box), performance, the visual design, usability and accessibility, the documents' claims, and acted as a skeptical reviewer scoring against the brief. Their findings and what was fixed are in `QA_REPORT.md`.

## Human review
The code was written by an AI agent (Claude Code) under my direction. The agent checked its work with automated tests, a real browser, python-docx and Docker, and independent review agents audited it (see `QA_REPORT.md`). I did not implement every individual change myself. My part was to set the goals and constraints, read the code and run the tests, review the audit findings, and decide which categories of change were appropriate for a final stabilisation pass. I did not rely on the agent's own report that it works.

**Time spent.** About 3 hours of my own time: reviewing the implementation, evaluating the audit findings, testing, prioritising fixes and preparing the submission. The code was generated by the agent, which ran for much longer.

**How I prioritised the final audit.** By user impact, production risk and the chance of introducing a regression, not by trying to fix everything the audits reported. I preferred small, targeted fixes over broad refactoring close to the deadline: a working, well-tested implementation was worth more than a large cleanup that could break something. I treated the final audit as a stabilisation pass, not a rewrite.

**What I chose to fix first**
- The Duplicate button failing in the browser, because a reviewer would find it within minutes.
- Idempotency caching: restricted to routes that create something, instead of caching a response for every request that carries a key.
- The `/qa/` test page being reachable in production through URL encoding.
- Resource abuse: forged `.docx` entry sizes and pathological or oversized document content.
- Reliability on the client: errors during fast navigation, a stalled request freezing navigation away from the editor, and live updates that never reconnected after a temporary proxy error (retries stop when the user leaves the document).
- Front-end lifecycle: leaked listeners, uncancelled debounces, callbacks running after the editor closed, double submission of Create, and the documents list redrawing (and dropping keyboard focus) when nothing had changed. Focus now returns correctly when the History and Comments panels close.
- I kept the existing server-side sanitisation model and added only targeted checks, so what users are allowed to write did not change.

**What I chose not to change, and why**
- Splitting the large editor module: too big a change for a final pass.
- The merge algorithm: changing it could alter conflict behaviour that is already tested.
- Larger CSS consolidation: risk of subtle cascade regressions.
- Redesigning the service worker: offline caching needs broader cross-browser testing.
- Broader keyboard-shortcut changes: they would change established interactions and need dedicated testing (I only stopped arrow keys being captured away from the card list).
- Client-side re-checking of link URLs, Mac shortcut-label handling and returning focus after the theme toggle: reviewed, judged low-risk and not blocking, left for later.
- Speculative performance work: measured editor performance was already acceptable for the document sizes tested.

**Verification I asked for.** Automated tests for fixes where practical and a full test run after the changes; browser smoke tests of the important flows and the visible fixes; a Docker build and readiness check, so the submission is deployable and not only passing locally; and the remaining limitations written down in `QA_REPORT.md` and `README.md` instead of presenting the project as having no trade-offs.
