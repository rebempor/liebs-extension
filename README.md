<p align="center">
  <img src="docs/assets/readme-banner.svg" alt="Liebs — A little character. A better hello. Profile photo → AI character → personal greeting." width="100%" />
</p>

<p align="center">
  <strong>Liebs · Personalized animated greetings, created from a LinkedIn profile.</strong><br />
  A Chrome extension and backend that turn a profile photo into a stylized 3D character,<br />
  brings it to life, and adds a greeting made for that person.
</p>

<p align="center">
  <img alt="Status: prototype" src="https://img.shields.io/badge/status-prototype-bba7ff?style=flat-square" />
  <img alt="Node.js and Express" src="https://img.shields.io/badge/API-Node.js_%2B_Express-30364a?style=flat-square" />
  <img alt="Supabase" src="https://img.shields.io/badge/data-Supabase-3ecf8e?style=flat-square" />
  <img alt="Remotion Lambda" src="https://img.shields.io/badge/rendering-Remotion_Lambda-95c7ff?style=flat-square" />
</p>

<p align="center">
  <a href="#see-liebs">See Liebs</a> ·
  <a href="#the-idea">The idea</a> ·
  <a href="#the-experience">The experience</a> ·
  <a href="#how-it-works">How it works</a> ·
  <a href="#install-the-extension">Install extension</a> ·
  <a href="#getting-started">Backend setup</a> ·
  <a href="#project-status">Project status</a>
</p>

---

## See Liebs

### A personal hello, in motion

<p align="center">
  <img src="docs/assets/liebs-example.gif" alt="Liebs conversation demo: Jensen Huang's portrait transforms into a waving 3D character with the greeting Hey, Jensen! and the call to action Open to talk?" width="497" />
</p>

<p align="center"><em>A conversation demo supplied by the project owner. The original GIF shows the full transformation and message presentation.</em></p>

### From profile photo to animated greeting

| 01 · The profile photo | 02 · The transformation | 03 · The personal greeting |
| :---: | :---: | :---: |
| <img src="docs/assets/liebs-demo-profile.png" alt="Original portrait in the supplied conversation demo." width="300" /> | <img src="docs/assets/liebs-demo-transform.png" alt="Portrait transition with the personalized greeting Hey, Jensen!" width="300" /> | <img src="docs/assets/liebs-demo-greeting.png" alt="Stylized character waving with the call to action Open to talk?" width="300" /> |

These screenshots are unaltered frames from the supplied demo, not captures of a newly verified live session. The newer companion package is branded **Liebs GIF Generator**; older Desktop prototypes retain the Pixar GIF Generator name.

## The idea

A name in a message is a start. A tiny animated version of the person waving hello makes the greeting feel personal before they read a word.

**Liebs** is a credit-based SaaS concept for people who want to open a conversation with a memorable visual. From a LinkedIn profile, the companion Chrome extension captures the person's name and photo. The backend creates a stylized character, animates a wave, and produces a GIF with a custom greeting and call to action.

> **Example:** a profile photo becomes a waving 3D character, introduced with “Hey, Alex!” and followed by “Open to talk?”

The product combines a browser workflow with server-side AI generation, rendering, accounts, and credits. The repository retains its original `linkedin-pixar-backend` name. This repository contains the **backend** and the latest local **[Chrome extension package](extension/)**. The Remotion composition remains a separate companion project.

## The experience

| Step | What the user does | What the product does |
| :--- | :--- | :--- |
| **01 · Choose a person** | Open a LinkedIn profile and use the **Liebs** extension controls. | Read the profile name and photo. |
| **02 · Make it personal** | Set a greeting and call to action in the extension. | Carry that copy into the generated greeting. |
| **03 · Bring it to life** | Start a generation using a credit. | Transform the portrait, animate a wave, and compose the finished media. |
| **04 · Start a conversation** | Review the result and use it in a message. | The companion extension attempts to attach the GIF to the composer, with a preview/download fallback. |

The companion extension's intended workflow leaves sending the message to the user. The newer local package already supports background job polling; compatibility with this backend checkout still needs validation, as described under [Project status](#project-status).

## What's in the backend

| Capability | Implementation |
| :--- | :--- |
| **Accounts** | Email/password signup and login through Supabase, with bearer-token authentication. |
| **Portrait transformation** | fal.ai image editing with a prompt designed to preserve the person's pose, framing, clothing, and recognizable features. |
| **Character animation** | Replicate video generation for a short wave and smile. |
| **Media composition** | Remotion Lambda renders MP4; FFmpeg adds greeting/CTA text and exports the final MP4 and GIF. |
| **Text revisions** | Re-stamp a saved generation's text using its stored MP4, without repeating AI generation. |
| **Background jobs** | A database-backed queue, polling endpoint, configurable worker concurrency, and stale-job handling. |
| **Credits** | One credit deducted when the pipeline starts; a refund is attempted if that pipeline fails. Stripe Checkout routes provide credit-pack purchases. |
| **History and monitoring** | Recent generations, credit transactions, error events, and user/admin reliability summaries. |

These describe the checked-in code. Live service availability and a complete production deployment have not been verified.

## How it works

```mermaid
flowchart LR
    A[Chrome extension] -->|Photo + name + greeting| B[Express API]
    B --> C[(Supabase job queue)]
    C --> D[Generation worker]
    D --> E[fal.ai portrait edit]
    E --> F[Replicate animation]
    F --> G[Remotion Lambda]
    G --> H[FFmpeg text + GIF export]
    H --> I[(S3 media)]
    D -->|Status + result URLs| C
    A -->|Poll job status| B
```

Supabase also stores accounts, balances, generation history, and errors. Stripe handles checkout. For base64 photo input, the pipeline uploads the original to S3 and attempts background removal; it can render the opening segment while character animation runs.

The current service configuration uses **Grok Imagine image editing through fal.ai** and **Seedance 1 Lite through Replicate**. The renderer expects a deployed Remotion composition named **`Main`**.

### Generation API

Authenticated endpoints use `Authorization: Bearer <Supabase access token>`.

1. Submit a photo and name to `POST /api/generate/pixar-gif`.
2. Save the `jobId` returned with **HTTP 202**.
3. Poll `GET /api/generate/jobs/:id` until `status` is `completed` or `failed`.
4. On completion, use `gifUrl` or `mp4Url`; on failure, inspect `error` and `errorCode`.

Example request body:

```json
{
  "photoBase64": "data:image/jpeg;base64,<image-data>",
  "firstName": "Alex",
  "greeting": "Hey, Alex!",
  "ctaText": "Open to talk?"
}
```

`photoUrl` can be supplied instead of `photoBase64`. Generation requires an available credit. The initial response contains a job reference, not the finished GIF.

<details>
<summary><strong>API reference</strong></summary>

| Method | Endpoint | Purpose |
| :--- | :--- | :--- |
| `GET` | `/health` | Process health response; does not verify upstream services. |
| `POST` | `/api/auth/signup` | Create an account with `email` and `password`. |
| `POST` | `/api/auth/login` | Return account details and an access token. |
| `GET` | `/api/auth/me` | Read the current account and credit balance. |
| `GET` | `/api/credits/packs` | List configured credit packs. |
| `GET` | `/api/credits/balance` | Read the current user's balance. |
| `POST` | `/api/credits/purchase` | Create a checkout session using `packId`. |
| `POST` | `/api/credits/webhook` | Receive Stripe payment events. |
| `GET` | `/api/credits/history` | Read up to 50 recent transactions. |
| `POST` | `/api/generate/pixar-gif` | Queue a generation. |
| `GET` | `/api/generate/jobs/:id` | Read the user's job status and result. |
| `GET` | `/api/generate/history` | Read up to 20 recent generations. |
| `POST` | `/api/generate/generations/:id/restamp-text` | Update a saved GIF using `greeting` and `ctaText`. |
| `GET` | `/api/monitoring/summary` | Read the current user's reliability summary. |
| `GET` | `/api/monitoring/admin/summary` | Read global metrics using `MONITORING_API_KEY`. |

Health, signup, login, and pack listing do not require a user token. The webhook uses a Stripe signature; the admin summary uses `x-monitoring-key` or a bearer monitoring key. Other endpoints above require a user token.

The code also declares a cancellation route, but its worker implementation is incomplete; see the status notes below.

</details>

## Install the extension

The complete April 18, 2026 Liebs extension package is included in [`extension/`](extension/), with no build step required. Download or clone this repository, then follow the [Chrome installation instructions](extension/README.md#install-in-chrome).

The extension connects to `api.liebs.app` and `liebs.app`. The root backend does not yet implement all of its authentication and generation endpoints; see [service dependencies](extension/README.md#service-dependencies).

## Getting started

The following setup is for the backend service and its external dependencies. The extension is included in this repository; the Remotion composition is still separate.

### 1. Prepare the services

- Node.js 20 or newer, as required by the locked Supabase and AWS SDK dependencies, and npm.
- FFmpeg and FFprobe available on `PATH`, including FFmpeg's `drawtext` filter.
- A Supabase project with Auth and Postgres.
- fal.ai and Replicate credentials with generation access.
- AWS credentials, accessible S3 storage, and a deployed Remotion Lambda function/site containing **`Main`**.
- Stripe credentials. Use test mode while validating checkout.

The server runs the queue worker in the same process as Express. Use a persistent Node.js process for this implementation.

### 2. Install and configure

```bash
git clone https://github.com/rebempor/linkedin-pixar-backend.git
cd linkedin-pixar-backend
npm ci
cp .env.example .env
```

Fill in `.env` using [`.env.example`](.env.example). Keep service-role, payment, AI, and AWS secrets on the backend.

| Configuration | Variables |
| :--- | :--- |
| Supabase | `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_KEY` |
| AI generation | `FAL_API_KEY`, `REPLICATE_API_KEY` |
| Rendering | `REMOTION_AWS_REGION`, `REMOTION_FUNCTION_NAME`, `REMOTION_SERVE_URL` |
| Payments | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `FRONTEND_URL` |
| Server | `PORT` — defaults to `3000` |
| Admin metrics | `MONITORING_API_KEY` |

AWS authentication uses the SDK's credential chain; `.env.example` also shows the access-key variables. `FRONTEND_URL` supplies the allowed web origin and checkout redirect base; the frontend must provide `/success` and `/cancel` pages.

**Storage setup:** the media services currently contain hard-coded bucket names in [`videoCompress.js`](src/services/videoCompress.js), [`backgroundRemoval.js`](src/services/backgroundRemoval.js), and [`textOverlay.js`](src/services/textOverlay.js). Adapt those values and URL construction to your storage before using a different AWS deployment. Setting the Remotion environment variables alone does not change these buckets.

<details>
<summary><strong>Optional rendering and worker settings</strong></summary>

- `GENERATION_JOB_POLL_MS` — queue polling interval; default `3000`.
- `GENERATION_JOB_WORKER_CONCURRENCY` — concurrent jobs per process; default `4`.
- `GENERATION_JOB_STALE_MINUTES` — stale-processing threshold; default `30`.
- `EFFECTS_OVERLAY_URL` — optional pre-rendered effects overlay.
- `REMOTION_SCALE`, `REMOTION_EVERY_NTH_FRAME`, and the concurrency settings in `.env.example` — render tuning. Set only one chunking strategy: `REMOTION_CONCURRENCY` or `REMOTION_FRAMES_PER_LAMBDA`.
- `GIF_OUTPUT_PROFILE` — `optimized` by default, or `legacy`. Optimized defaults are 360px wide, 8fps, and 96 colors, with additional `GIF_*` overrides in [`videoCompress.js`](src/services/videoCompress.js).
- `DRAWTEXT_FONT_PATH` — optional absolute font path. To use the bundled font, point it to `fonts/Poppins-Bold.ttf` in your checkout.

</details>

### 3. Initialize the database

Run these SQL files in order in the Supabase SQL editor:

1. [`supabase-schema.sql`](supabase-schema.sql)
2. [`migrations/20260223_job_queue_and_monitoring.sql`](migrations/20260223_job_queue_and_monitoring.sql)
3. [`migrations/20260224_add_current_step.sql`](migrations/20260224_add_current_step.sql)
4. [`migrations/20260224_add_mp4_no_text_url.sql`](migrations/20260224_add_mp4_no_text_url.sql)

These create the credit ledger, generation history, queue, error tracking, and fields used for text revisions. Signup starts with zero credits. If email confirmation is enabled in Supabase, signup may not immediately return an access token.

### 4. Start the backend

```bash
npm run dev
```

For a regular server process, use `npm start`. Check that it responds:

```bash
curl http://localhost:3000/health
```

A successful health response confirms the HTTP server is running. Validate database access, rendering, and payments separately before relying on a complete generation flow.

## Repository map

```text
extension/                    Complete Liebs Chrome extension package
src/
├── index.js                  Express app and worker startup
├── config/env.js             Supabase configuration and aliases
├── middleware/auth.js        Access-token verification
├── routes/                   Auth, credits, generation, monitoring
└── services/
    ├── generationJobs.js     Database queue and worker
    ├── generationPipeline.js End-to-end generation orchestration
    ├── fal.js                Portrait transformation
    ├── replicate.js          Character animation
    ├── backgroundRemoval.js  Optional silhouette extraction
    ├── remotion.js           Lambda rendering
    ├── textOverlay.js        Text composition and GIF export
    ├── videoCompress.js      Media conversion and uploads
    └── errorTracker.js       Error-event recording
migrations/                   Incremental database changes
fonts/                        Bundled Poppins Bold font
supabase-schema.sql           Base schema and credit functions
.env.example                  Configuration template
```

## Project status

**An implemented backend prototype, with integration work still to finish.** The repository includes the AI/media pipeline and SaaS foundations; the complete extension-to-backend experience is not yet reproducible from this repository alone.

### Extension source and companion projects

The newest local extension package is now versioned in [`extension/`](extension/). Its 20 original source files were copied without changes, excluding macOS metadata. The inventory below records its origin and the other copies found on the owner’s laptop:

| Folder | Role |
| :--- | :--- |
| `Downloads/liebs-extension/` → [`extension/`](extension/) | Imported package: 20 files, with source file timestamps of April 18, 2026. Liebs branding, background job polling/recovery, composer integration, authentication callback, and analytics/error reporting. Calls `api.liebs.app`. |
| `Downloads/liebs-orbita-new/` | Closely related April 16, 2026 package. Four files differ from the April 18 package, including profile-photo detection and interface changes. |
| `Desktop/Claude/linkedin-pixar-saas/extension/` | Older February 2026 SaaS prototype with seven files; expects the earlier synchronous generation response. |
| `linkedin-pixar-saas/remotion/` | Render source with the `Main` and `ParticlesOnly` compositions. |
| `linkedin-pixar-saas/backend/` | An older local backend checkout; GitHub contains newer pipeline and job-queue work. |
| `linkedin-pixar-extension/` | Earlier standalone extension with direct AI integrations and a native-host renderer. |

The source paths above refer to the owner’s local inventory; only the imported `extension/` folder is available in a fresh clone. Both recent extension packages still declare version `2.0.0`, so the version number alone does not establish which is newer. All local files referenced by the April 18 package’s manifest, HTML, and literal `importScripts` calls were present during inspection. This verifies package completeness, not a live generation flow. The banner above illustrates the product concept, not a captured application screen.

### Next integration milestones

- [x] Version the latest local Chrome extension package with installation instructions.
- [ ] Version and link the companion Remotion render source so the full product can be reproduced.
- [ ] Locate and version the backend matching the newer Liebs extension. That package already polls jobs and calls browser authentication (`/api/auth/extension/exchange`), batch status (`/api/generate/jobs/status`), and pre-processing (`/api/generate/pre-process`) endpoints that are absent from this checkout. Confirm the source of the deployed `api.liebs.app` service before treating this repository as the complete current backend.
- [ ] Finish cancellation and live progress wiring. The cancel route references a worker function that is not exported; the worker does not forward the pipeline's progress callback.
- [ ] Complete payment validation. The global JSON body parser runs before the Stripe webhook's raw-body parser; signature verification needs the original request bytes. Also add duplicate-event protection to credit fulfillment.
- [ ] Make storage configuration portable and verify a fresh deployment end to end.

<details>
<summary><strong>Development and verification notes</strong></summary>

`package.json` currently provides `start` and `dev` scripts, with no automated test script. This README is based on inspection of the backend and companion source; it does not certify live AI generation, payment fulfillment, Chrome Web Store availability, or production readiness.

</details>
