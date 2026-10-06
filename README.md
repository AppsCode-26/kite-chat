# Kite

A personal chat client for the Gemini API. Static site — no build step, no server of its own.

- **Accounts and sync** — Firebase Auth (email + password) and Firestore. Chats, settings, usage counters and your Gemini API key live under your account and follow you to every device.
- **Gemini** — requests go straight from the browser to the Gemini Interactions API using the key you save in Settings. The key is stored in your private Firestore profile, never in this repository.
- **Usage** — Settings shows tokens and requests per day and per model, counted from the usage numbers the API returns.

Unofficial: not affiliated with or endorsed by Google.

## Files

| File | What it does |
|---|---|
| `index.html`, `styles.css` | Markup and styling |
| `app.js` | All UI logic |
| `gemini.js` | Gemini API client (model list, streaming) |
| `backend-firebase.js` | Accounts and cloud storage |
| `backend-local.js` | Local-only stand-in for development (`http://localhost:…/?local=1`) |
| `config.js` | App name and the Firebase project config |
| `firebase-web-key.txt` | The Firebase project's web API key (a public identifier, not a secret). The site shows a setup screen until this file exists |
| `firestore.rules` | Security rules: each account can only touch its own data |

## Running locally

Serve the folder with any static server, for example `python3 -m http.server 8765`, then open `http://localhost:8765/`.
