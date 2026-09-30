# Liebs Chrome extension

The Manifest V3 browser extension for Liebs: create personalized GIFs from LinkedIn profiles, customize greetings, and work with generated media in the message composer.

This folder contains the complete 20-file package imported from `Downloads/liebs-extension`, whose source files were dated **April 18, 2026**. Its manifest version is **2.0.0**. The imported application files are unchanged; macOS `.DS_Store` metadata was excluded.

## Install in Chrome

No build step or npm installation is required for the extension.

1. Clone this repository, or select **Code → Download ZIP** on GitHub and extract it.
2. Open `chrome://extensions` in Chrome.
3. Enable **Developer mode**.
4. Select **Load unpacked** and choose this **`extension/` folder**, which contains `manifest.json`. Do not select the repository root.
5. Open the Liebs popup and select **Continue in browser** to connect your account.
6. Open or refresh a LinkedIn page to load the extension's page controls.

The unpacked installation steps follow [Chrome's extension development guide](https://developer.chrome.com/docs/extensions/get-started/tutorial/hello-world#load-unpacked). After updating the files, reload the extension from `chrome://extensions` and refresh the LinkedIn page.

## Service dependencies

The package currently connects to **`https://api.liebs.app`** and signs in through **`https://liebs.app`**. Successful use requires those services and a compatible Liebs account. Source completeness and JavaScript syntax have been checked; a live sign-in or generation session has not been verified.

The backend at the repository root is an older implementation and does **not** provide every endpoint this extension calls. Examples include:

| Endpoint | Extension use |
| :--- | :--- |
| `/api/auth/extension/exchange` | Complete browser-based extension sign-in. |
| `/api/generate/jobs/status` | Fetch job statuses in batches. |
| `/api/generate/pre-process` | Prepare a profile for generation. |

Running the root backend locally is not sufficient to reproduce the current product. Keep this dependency in mind before changing `API_BASE_URL` or `WEB_APP_URL` in [`shared-core.js`](shared-core.js).

## Included interface and behavior

- Browser-based account connection and a Liebs popup.
- Greeting templates with `{name}` and `{lastName}`, plus a custom call to action.
- GIF/video launch controls, history tabs, and credit/subscription display.
- Profile-photo detection and LinkedIn composer integration.
- Background job polling, persisted generation recovery, and cancellation requests.
- Outreach Mode controls and profile pre-processing requests.
- PostHog analytics and Sentry error reporting configured in the imported package.

The manifest enables page scripts on LinkedIn while excluding Sales Navigator paths. Some interface actions depend on backend features absent from the root checkout.

## File map

| Files | Responsibility |
| :--- | :--- |
| `manifest.json` | Permissions, page scripts, popup, and background worker. |
| `background.js`, `shared-core.js` | API communication, background generation, shared helpers. |
| `content.js`, `content.css`, `content-*.js` | In-page interface, timing, photo handling, and control placement. |
| `profile.js`, `composer.js` | LinkedIn profile and message-composer integration. |
| `popup/` | Account connection, templates, launch controls, and history. |
| `auth-callback.html`, `auth-callback.js` | Browser sign-in callback. |
| `analytics.js`, `lib/posthog.js` | Analytics helpers and bundled library. |
| `sentry-init.js`, `vendor/sentry.min.js` | Error-reporting setup and bundled library. |

See the [main README](../README.md) for the product demo and backend documentation.
