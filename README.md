# Teleprompter

A dependency-free teleprompter web app built for an iPad sitting in a beam-splitter prompter rig.

## Features

- **Script editor**: paste or type, or import **.docx**, **.rtf** and **.txt** files (button or drag-and-drop). Files are parsed in the browser with no libraries, so it works offline.
- **Prompter**: smooth scrolling, speed control, text size, line spacing, margins, alignment, font and weight, ALL CAPS.
- **Mirroring**: horizontal mirror for the glass, plus a vertical flip. The reading marker, countdown and toasts are mirrored too, so the talent can read them.
- **Reading marker** with adjustable position, edge fade, 3-2-1 countdown, progress bar and time remaining.
- **Light and dark mode**, or match the system setting.
- **Presentation clicker / keyboard**: Next and Prev change speed by default. You can switch them to jump mode or hybrid mode in Settings.
- **Game controller** (Gamepad API): play/pause, speed, analog scrolling with the sticks and triggers, and text size. The full mapping is in Settings.
- **Touch**: tap the text to play/pause, drag to reposition.
- Keeps the screen awake (Wake Lock), supports fullscreen, remembers your script and settings, and can be installed as a PWA for offline use.

## Run it locally

```bash
cd teleprompter
python3 -m http.server 8000
```

Open http://localhost:8000 on the Mac. On the iPad (same Wi-Fi), open `http://<your-mac-ip>:8000`.

## Recommended setup for a shoot: host it on HTTPS

Some browser features **only work over HTTPS** (or on localhost): the service worker (offline mode) and the screen Wake Lock. On some browsers that also applies to the Gamepad API. Clicker and keyboard control work fine over plain HTTP.

Any static host works. You just upload the folder:

- **Netlify Drop**: drag the folder onto https://app.netlify.com/drop
- **GitHub Pages**, **Cloudflare Pages** or **Vercel** also work.

Then on the iPad open the HTTPS URL in Safari and choose **Share → Add to Home Screen**. When you launch it from the home screen, it runs fullscreen with no browser UI and works offline.

## iPad tips

- Pair a game controller (Xbox, PlayStation, MFi, 8BitDo...) in **Settings → Bluetooth**, then press a button while the page is open so Safari detects it.
- Presentation clickers act like Bluetooth keyboards. They usually send PageUp/PageDown or arrow keys, which the app handles.
- Turn on **Mirror** (⇋) when the iPad sits under the glass.
- Turn off Auto-Lock or rely on Wake Lock (HTTPS) so the screen stays on.

## Files

| File | Purpose |
| --- | --- |
| `index.html` | Markup for the editor, prompter and settings |
| `styles.css` | Themes and layout |
| `app.js` | Scrolling engine, controls, clicker and gamepad input, settings |
| `importers.js` | DOCX / RTF / TXT to plain text |
| `sw.js`, `manifest.webmanifest` | Offline / installable PWA |
