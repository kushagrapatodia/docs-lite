# Walkthrough video script (about 4 minutes)

Record the screen with your voice (Loom, QuickTime, or Google Meet recording). Use two browser windows side by side: a normal one signed in as **alice** and a private one signed in as **bob**. Keep the demo data fresh: run the app from a clean `DATA_DIR`.

## 0:00 - 0:30 What it is
"This is Docs Lite, a collaborative document editor. Node with no npm dependencies, SQLite, and vanilla JavaScript. I focused on access control, not losing people's work, and files that open in Word." Show the documents page: Owned vs Shared tabs, stars, search.

## 0:30 - 1:30 Writing
- New document, pick the **Meeting notes** template.
- Change a font and colour, make a checklist and tick it, insert a table, insert a picture (drag one in), add a page break (Ctrl+Enter).
- Find and replace, word count, zoom.
- Say: "Everything is sanitised on the server with an allow-list, so pasted or crafted HTML cannot run script."

## 1:30 - 2:30 Sharing and live collaboration
- Click **Share**, add **bob** as editor, **carol** as viewer.
- In Bob's window: open the document, type; show presence avatars and live updates in Alice's window.
- Add a comment on a selected passage in one window, reply in the other, resolve.
- Make both windows edit at once. Edit **different paragraphs** to show the automatic merge; edit the **same sentence** differently to show the **conflict dialog** (use theirs / keep mine / save mine as a copy).
- Sign in as carol: read-only banner, disabled toolbar. Mention the API returns 403 even if the UI is bypassed.

## 2:30 - 3:15 Safety nets
- **History**: name a version, preview an older one, restore. "Restore appends, it never rewrites history."
- Delete a document, show **Undo** and the **Trash**.
- Create a **view link** and open it in a private window with nobody signed in; turn it off and refresh: 404.

## 3:15 - 3:45 Files
- Import a `.docx`; export Word and open it (pictures, table, header / footer from **Page setup**).
- Mention the `.docx` reader and writer are written from the OOXML spec and cross-checked with python-docx.

## 3:45 - 4:15 Engineering and AI workflow
- `npm test`: 186 tests, including fuzz tests; open `http://localhost:3000/qa/` (locally, not the deployed site) for the browser suite.
- "I used Claude Code as a pair programmer and a real browser to verify. It got several things wrong that I caught, for example Chrome's invalid nested lists, a document with only a picture being saved as empty, and a list-depth denial of service found by the fuzz tests. Those are listed in AI_WORKFLOW.md."
- What I cut and what I would do next: CRDT / TipTap, suggesting mode, email invites.
