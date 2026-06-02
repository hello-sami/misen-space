# misen.space

Landing page for **Misen** — a spatial UI launcher and dashboard for a suite of
personal local-first apps. The home of the dollhouse.

Static HTML + one Cloudflare Pages Function for the email signup. Deployed via
GitHub → Cloudflare Pages auto-deploy.

## Layout

```
misen-space/
├── index.html          # the landing page itself
├── styles.css          # all styles
├── app.js              # rotating wordmark + signup form fetch
├── assets/
│   └── favicon.svg     # 7-dot mark, matches the Misen app icon
├── functions/
│   └── api/
│       └── signup.js   # POST /api/signup → writes to KV
├── _routes.json        # Pages Functions: only run on /api/*
├── _headers            # security + cache headers
├── package.json        # wrangler scripts (dev + deploy)
└── README.md
```

## Run it locally

Pure static — no server needed if you just want to look at the page:

```sh
cd ~/Documents/Projects/Sites/misen-space
python3 -m http.server 8000
open http://localhost:8000
```

The signup form will fail when run this way (no `/api/signup` endpoint).
To exercise the Pages Function locally:

```sh
npx wrangler pages dev . --port 8788
open http://localhost:8788
```

`wrangler` simulates the Cloudflare edge runtime so `/api/signup` works.
You'll need a local KV namespace binding — `wrangler` will prompt and
create one in `.wrangler/state/` on first run.

## Deploy

### One-time setup

1. **Push to GitHub** (the repo `samirsmith/misen-space` is what this site
   expects):

   ```sh
   cd ~/Documents/Projects/Sites/misen-space
   git init -b main
   git add .
   git commit -m "init misen.space landing"
   gh repo create samirsmith/misen-space --public --source=. --push
   ```

2. **Cloudflare dashboard → Pages → Create a project → Connect to Git.**
   Pick `samirsmith/misen-space`. Framework preset: **None**.
   Build command: (leave empty)
   Build output directory: (leave empty / `.` — root of the repo).

3. **Create a KV namespace** for the email list:

   - Cloudflare dashboard → Workers & Pages → KV → Create namespace
   - Name it `misen-signups`.

4. **Bind the namespace to the Pages project:**

   - Pages project → Settings → Functions → KV namespace bindings → Add
   - Variable name: `SIGNUPS`
   - KV namespace: `misen-signups`

5. **Add the custom domain `misen.space`:**

   - Pages project → Custom domains → Set up a custom domain → `misen.space`
   - Cloudflare auto-configures the CNAME if the domain is in the same
     account.

Every push to `main` from now on auto-deploys. Branches get preview URLs.

### Read the signups list

From the dashboard, or via `wrangler`:

```sh
npx wrangler kv:key list --binding=SIGNUPS
npx wrangler kv:key get --binding=SIGNUPS "email:hello@example.com"
```

## Editing

- **Add a suite app:** edit the `<ul class="suite-grid">` block in
  `index.html` and the `ROTATIONS` array in `app.js`. Keep colors consistent
  with the dot palette below.
- **Tweak the diorama:** the inline SVG inside `<div class="diorama">` is
  hand-drawn isometric — feel free to swap in furniture/colors as the real
  diorama evolves.

### Palette

| Token   | Hex      | Used for                         |
|---------|----------|----------------------------------|
| ink     | #1a1a1a  | body text, brand wordmark        |
| paper   | #fafaf7  | background                       |
| warm    | #b8541e  | default accent                   |
| olive   | #6b7547  | success states                   |
| blue    | #2c4a6b  | links, secondary accent          |
| ochre   | #BA7517  | app-suite color (studio)         |
| moss    | #256040  | app-suite color (garden)         |
| plum    | #7F77DD  | app-suite color (media)          |
| rose    | #D4537E  | app-suite color (score)          |
