# FretLab Companion

Phone-first lesson companion. Same Supabase project, same tables, same user
as FretLab — log a lesson here, it's in FretLab; add a song there, it's here.
Installs to your phone's home screen as a PWA and opens full-screen.

## The one architectural rule

`src/LessonLog.jsx` is **the exact same file** as FretLab's. That's the whole
sync story — both apps speak the same schema because they run the same code.
When you update the module in FretLab, copy the file here and redeploy.
Never edit the two copies separately.

## Deploy (~10 minutes)

1. **New repo** — push this folder to a new GitHub repo
   (e.g. `fretlab-companion`).

2. **New Netlify site** — import the repo. Build settings come from
   `netlify.toml` (build `npm run build`, publish `dist`).

3. **Env vars** — in Netlify → Site settings → Environment variables, add the
   SAME two values FretLab uses:
   - `VITE_SUPABASE_URL`
   - `VITE_SUPABASE_ANON_KEY`

   Copy them from the FretLab site's settings or your local `.env`.

4. **Auth redirect** — Supabase dashboard → Authentication → URL
   Configuration → add the new Netlify URL (e.g.
   `https://fretlab-companion.netlify.app`) to **Redirect URLs**. Without
   this, magic links sent from the companion bounce back to FretLab's URL.

5. **Deploy**, open the URL on your phone, sign in with your usual email.

No SQL to run — the companion reads the tables and bucket that already exist.

## Install to home screen

- **Android/Chrome**: menu → "Add to Home screen" (Chrome usually offers an
  install prompt on its own).
- **iPhone/Safari**: Share → "Add to Home Screen".

After that it launches like an app: full screen, dark theme, faceplate header.

## Lesson-day workflow

Open the app → + Log lesson → + Add photos → your phone offers the camera
directly → snap the whiteboard → toggle the songs covered → Save. The jewel
goes green and it's on your desktop before you're out of the building.

## Local dev

    npm install
    cp .env.example .env    # fill in the two values
    npm run dev

## Notes

- Works offline/signed-out in local-only mode (banner shows); everything
  merges up on next sign-in, newest wins.
- The service worker caches only the app shell for fast launches — data
  always comes live from Supabase.
- Bump the `CACHE` name in `public/sw.js` when you ship significant updates
  so phones pick up the new shell promptly.
