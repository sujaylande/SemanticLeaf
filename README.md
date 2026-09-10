# SemanticLeaf

A folderless place to dump notes, links, and quotes. There's one input box.
Everything you save is automatically grouped into "piles" by *meaning*, not
by folders or tags you have to manage — and later, typing any related
keyword pulls up the whole pile, not just the one item that matched.

**Fully local. No account, no API key, no server, no ongoing cost.**
Your notes never leave your browser.

## How it works

- A small AI model (~25–90MB, [Xenova/all-MiniLM-L6-v2](https://huggingface.co/Xenova/all-MiniLM-L6-v2))
  downloads once, the first time you open the page, from a public CDN. After
  that it's cached by your browser and runs completely offline — no internet
  needed again, ever, unless you clear your browser's site data.
- That model reads the *meaning* of each note you save, and compares it
  against everything you've saved before, so it can group by topic even when
  you use completely different words each time.
- Everything — your notes and the model's cache — is stored in your
  browser's IndexedDB, tied to whatever URL you open this at. It is **not**
  synced anywhere by default (see Backups below).

## Hosting this on GitHub Pages

1. Create a new GitHub repository and push these three files
   (`index.html`, `style.css`, `app.js`) to it.
2. In the repo, go to **Settings → Pages**.
3. Under "Build and deployment", set **Source** to "Deploy from a branch",
   pick your default branch and the `/ (root)` folder, then save.
4. GitHub will give you a URL like `https://yourname.github.io/repo-name/`.
   Open it — the first load will take a moment while the model downloads.

You can also just open `index.html` directly from your own computer
(double-click it) without hosting it anywhere. It works the same way, it'll
just only be on that one device/browser.

## Using it

- **Add:** type or paste anything into the box at the top and hit Save (or
  press Enter). It'll suggest which pile it thinks the note belongs to —
  confirm that, pick a different pile from the dropdown, or let it create a
  new one.
- **Search:** switch to the Search tab and type any related word or phrase.
  You don't need to remember the exact words you used when you saved it —
  it matches by meaning. It shows you the whole pile that note lives in.
- **All piles:** browse everything you've saved, grouped, without searching.
- Every pile can be renamed, merged into another pile ("move all notes to…"),
  or deleted once empty. Every note can be moved to a different pile or
  deleted individually.

## Backups — please read

This data lives only in this browser, on this device, tied to this exact
URL. That means:
- Opening the file from a different browser, computer, or URL starts fresh.
- Clearing your browser's site data / cache will delete everything.

Use the **Export backup** button regularly — it downloads everything as a
plain `.json` file. **Import backup** restores from one (this replaces
whatever is currently saved, so keep old exports if you're not sure).

## Tuning it

Near the top of `app.js` there are two numbers you can adjust if matching
ever feels too loose or too strict:

```js
const MATCH_THRESHOLD = 0.5;   // how similar a note must be to suggest an existing pile
const SEARCH_THRESHOLD = 0.32; // how similar search results must be before showing a full pile
```

Raise `MATCH_THRESHOLD` if it's grouping things together that shouldn't be;
lower it if it's creating too many near-duplicate piles.

## Browser support

Needs a reasonably modern browser (Chrome, Edge, Firefox, or Safari from the
last couple of years) for WebAssembly and IndexedDB support. Works on mobile
browsers too, though the first-time model download is heavier on mobile data
— consider doing that first load on Wi-Fi.

## Troubleshooting

**Console shows a CORS error mentioning `app.js` and origin `'null'`.**
Some browsers block loading local JavaScript *modules* directly from a
`file://` path. This project doesn't rely on module syntax, so it isn't
affected — but if you ever reintroduce `type="module"` on the `<script>` tag
in `index.html`, or the error reappears for another reason, the reliable fix
is to serve the folder over `http://` instead of opening it as a file:
- **Easiest:** host it on GitHub Pages (see above) — this sidesteps the
  issue entirely since it's served over `https://`.
- **Or run a one-line local server** from inside the folder, then open the
  printed `http://localhost` address instead of double-clicking the file:
  - Python 3: `python3 -m http.server 8000`
  - Node.js: `npx serve .`

**Model never finishes loading / status stays on "Loading local model…".**
Usually means the download is blocked — check the browser console for a
network error, confirm you have an internet connection for this one-time
step, and make sure nothing (an ad blocker, a corporate firewall) is
blocking `cdn.jsdelivr.net`.

