# Architecture note

## What I prioritised, and why

The brief asks for depth in a few important areas over shallow coverage everywhere. I put the effort where a real reviewer would test correctness and trust: **access control, data safety, persistence, and an editor that does not lose or corrupt people's work**. Features beyond the brief (pictures, page setup, view links, replies, templates) were added on top of that core, each with tests, and none of them is allowed to weaken it.

1. **One access model, enforced on the server.** Every document has one owner and zero or more shares with the role `viewer` or `editor`. All checks go through one function (`loadDoc` in `src/app.js`): no access returns **404** (so the existence of a document is never leaked), read-only access to a write returns **403**, and only the owner can share, unshare, trash, erase or manage the view link. The UI mirrors this (disabled toolbar, banner, hidden buttons) but is never the source of truth. Roles can change while someone has a document open; the change is pushed live.
2. **Safe rich text.** The editor is a `contenteditable`, so content is user-controlled HTML. Every save passes through an allow-list sanitiser (`src/sanitize.js`) that keeps a small set of tags, **drops every attribute except a short list whose values are re-validated** (`href`; `style` rebuilt from a strict grammar in `src/styles.js`: colour, size, font from a fixed list, alignment, spacing, indent; picture `src` / `alt` / `width`; checklist, page-break and table-of-contents markers; heading `id`s of the form `h-xxxxxxxx` and same-document links to them), repairs invalid nesting the way an HTML parser would (Chrome produces `<p><ul>`), and caps nesting depth so no consumer can be recursed into a stack overflow. It is idempotent, so what is stored is already what is rendered. A fuzz test asserts the exact grammar of every attribute that survives.
3. **Never lose work.** Autosave with a single in-flight request; optimistic concurrency (`base_version`, **409** with the current version when someone else saved first, and a UI to keep yours, take theirs, or save yours as a copy); version history with preview and a restore that appends rather than rewrites; named versions that are never merged or pruned; a Trash with Undo and 30-day retention; local draft recovery after a failed save or session expiry; offline retry; save-on-hide for backgrounded tabs.
4. **Live collaboration without a framework.** Server-sent events (one stream per open document) carry presence, edits, comments, role changes, page-setup changes and revocation. It is a one-way channel on top of plain HTTP: it works through proxies, reconnects by itself, and needs no WebSocket library. Conflicts are merged automatically when the two edits do not overlap (paragraph level, then word level, refused when the result would break the tag structure), and the user chooses explicitly only when the same words were changed differently: an honest line between what a last-write-wins editor can promise and what needs a human. Large documents (with pictures) are announced with `refetch` instead of pushing megabytes to every collaborator on every save.
5. **Interoperable files.** `.docx` import and export are implemented from the OOXML spec with `node:zlib` (no libraries): headings (including localized style names), bullet, numbered and legacy list styles, nested lists, checklists, tables, links, inline formatting (colours, fonts, sizes, highlight, sub / superscript), alignment and spacing, pictures (media parts), page breaks, and page setup (paper size, orientation, margins, header, footer, `PAGE` field). Import guards against zip bombs. I validated both directions against **python-docx** (a third-party reader opens my output, including pictures, header and footer; a python-docx file, whose template mirrors Word, imports correctly) and keep a Word-like file as a test fixture. Markdown, HTML and plain-text export share one tiny parser for the sanitised subset.

## Design decisions worth knowing

- **Pictures are stored inline as base64 data URLs.** It keeps a document a single self-contained row (versions, copies, exports and the public link all just work, nothing to garbage-collect, nothing that can 404). The cost is size, so the client downscales to 1280 px and re-encodes (PNG stays PNG while it fits, otherwise JPEG), the server caps 20 pictures and about 1.1 MB per picture (1.5 M base64 characters; a larger picture is dropped by the sanitiser), text keeps its own 500 KB limit, and the SSE channel does not push big documents. SVG is rejected because it can carry script.
- **"Anyone with the link" is a capability token, not a login bypass.** 144 random bits, stored per document, read-only through a separate `GET /api/public/:token` that returns only title, content, owner display name, time and page setup (no ids, no emails, no shares). Creating a new link replaces the old one; turning it off or trashing the document makes it 404; tokens are redacted from the request log; responses are `no-store` and `noindex`.
- **Page setup is a document property, not content.** It lives in a validated JSON column, does not create a version, and is pushed live. Printing uses an `@page` rule injected as a constructable stylesheet (an inline `<style>` would violate the CSP); Word export writes real section properties and header / footer parts.
- **Comments are threaded one level deep** (`parent_id`, cascade delete). Resolving applies to the whole thread.
- **The table of contents is ordinary content.** Headings get random ids (`h-` + 8 hex), the TOC is a `<ul data-type="toc">` of same-document links that is regenerated on save (never while the caret is inside it). The sanitiser accepts only ids and links of exactly that shape, and Word / Markdown exports flatten the links to text rather than pointing at anchors that do not exist.
- **Conflict handling is a three-way merge, not a prompt.** The client keeps the last server version it saw (`base`); on a conflict it diffs `base→mine` and `base→theirs` (longest-common-subsequence) over top-level blocks and, failing that, over words and tags, applies both when the changes do not overlap, and falls back to the dialog on a real overlap or for very large documents. A failed merge changes nothing.
- **Live selections use the CSS Custom Highlight API.** A position is a path of child indexes plus an offset, relayed through the server (validated, never stored); the painter builds Ranges and highlights them, so the editable DOM, the undo stack and the saved HTML are never touched.
- **Search is SQLite FTS5 with the trigram tokenizer** (substring matches, case-insensitive), joined to the access rules in the same SQL statement, so a document a user cannot open never appears in their results; the index is updated with every save and rows of deleted documents are ignored by the join.
- **Retries are safe by construction:** `Idempotency-Key` claims a row before the handler runs, replays the stored response, answers 409 while the first attempt is still running and 422 for a reused key with a different request, and forgets failures.
- **The list never reads document bodies:** preview text and word count are maintained on write.
- **Stars are per user** (a join table), so starring a shared document never changes what others see.

## Stack choices

- **Node.js with zero npm dependencies.** `node:http`, `node:sqlite`, `node:zlib`, `node:crypto`, `node:test`. Reviewers run `npm start` with nothing to install, there is no supply chain to audit, and the Docker image is small.
- **SQLite** (WAL mode, foreign keys, cascading deletes, in-place migrations that upgrade databases created by earlier versions; schema version 14). One file, trivially backed up, ample for this scope.
- **Vanilla ES modules, no build step.** Small modules under `public/js` (editor, formatting, find, images, dialogs, comments, history, share, list, public view). A framework would add setup cost without adding reviewable value at this size, and the strict CSP (no inline scripts, no `<style>` elements) is easy to keep.
- **`document.execCommand` for formatting.** Deprecated on paper, supported by every browser, and it gives native undo and caret behaviour for very little code. Its quirks are handled where they show up (sanitiser normalisation, paste cleaning, explicit handlers for Ctrl+B/I/U so they produce tags rather than style spans, `<tag>` formatBlock values for Safari and Firefox). In a longer project I would move to ProseMirror or TipTap.

## Quality and non-functional work

- **Tests (186, plus a 43-test in-browser suite):** API and authorisation matrix, concurrency (including 40 parallel writers on one document), live events, sanitiser, styles, converters, migrations, rate limits, compression. **Seeded fuzz and property tests** throw thousands of hostile documents, mutated `.docx` files and 3,000 random malformed API requests at the code; they found real bugs (loose text in lists and tables, list-level and nesting bombs, `<hr>` fidelity, ordering after nested lists) that are pinned as regression tests. Client logic that needs a DOM (paste cleaner, formatting operations, checklist clicks, picture processing) is tested at `/qa/`.
- **Security:** strict CSP, scrypt password hashing, HttpOnly SameSite cookies with expiry, JSON-only writes plus an origin check, login limits per address and username and a per-address API limit, response compression, constant-time password comparison, no stack traces to clients, health endpoint, graceful shutdown, request-log redaction of view-link tokens.
- **Operations:** non-root Docker image with a health check and a data volume (verified: data survives a container restart), request logging, environment configuration, CI workflow.
- **Accessibility and responsiveness:** keyboard-operable dialogs with focus return, labelled controls, live regions for status, reduced-motion support, light / dark / auto themes, per-paragraph text direction (Arabic, Hebrew), usable at 375 px, print stylesheet for PDF export.

## Deliberately cut

- **Operational transforms or CRDTs.** Simultaneous typing in the very same words is out of scope. What exists instead: presence, live selections, live updates when the other is idle, an automatic three-way merge (paragraph level, then word level) when both have unsaved changes, and a clear choice only when the same words were changed differently.
- Suggesting mode / tracked changes, email invitations and notifications, password reset and email verification, charts and an equation editor.
- Pictures are not stored as separate files; a document with many large pictures is bounded by the limits above rather than streamed.

### Considered and rejected on purpose
Researched, sized, and left out to protect the core and the review timeline. Each would be a reasonable next step.

| Idea | Why not now |
|---|---|
| Suggesting mode with accept / reject | Needs a new commenter role, new sanitiser rules and an equality check on the server; big surface for the time |
| @-mentions, smart chips, notification inbox | New tables, new events and new access questions (does a mention grant access?) |
| Request-access flow and a commenter role | Changes the access model that everything else relies on |
| API tokens, OpenAPI docs, outgoing webhooks | New authentication paths and outbound network calls: too much security surface to add late |
| Multi-process scale-out (`node:cluster` + SQLite event outbox) | Would change event delivery under the code being reviewed; documented as the next scale step |
| Load shedding and slow-client defences | Reasonable, but needs its own load test to be trustworthy |
| Table formulas, Notion-style block handles, toggles and callouts | Large editor changes with new sanitiser rules |
| Navigation API router, popover-based menus | Rewrites of working code for small visible gain |
| Version compaction and grouped history | Storage optimisation that is not a problem at this scale |
| Share-target and installed-app shortcuts | Depends on the offline worker, which could not be verified in the test browser |
| Mobile gesture pack (swipe rows, pull to refresh) | Hard to test properly; the layout itself is checked at 375 px |

## What I would build next with another 2-4 hours

1. Move the editor to TipTap / ProseMirror and add a CRDT (Yjs) so simultaneous edits merge instead of asking, with remote cursors.
2. Suggesting mode, and table-of-contents fields that Word can update.
3. Playwright end-to-end tests for the share and conflict flows against a deployed build.
4. Email invitations and notifications for shares, mentions and comments.
