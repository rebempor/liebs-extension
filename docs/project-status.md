# Project status

[← Back to Liebs](../README.md)

**An implemented backend prototype, with integration work still to finish.** The repository includes the AI/media pipeline and SaaS foundations; the complete extension-to-backend experience is not yet reproducible from this repository alone.

### Extension source and companion projects

The newest local extension package is now versioned in [`extension/`](../extension/). Its 20 original source files were copied without changes, excluding macOS metadata. The inventory below records its origin and the other copies found on the owner’s laptop:

| Folder | Role |
| :--- | :--- |
| `Downloads/liebs-extension/` → [`extension/`](../extension/) | Imported package: 20 files, with source file timestamps of April 18, 2026. Liebs branding, background job polling/recovery, composer integration, authentication callback, and analytics/error reporting. Calls `api.liebs.app`. |
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

## Security audit follow-up

The September 30, 2026 audit found three private credentials in the initial commit’s historical `.env`: a Supabase service-role key, a fal.ai key, and a Replicate token. The file is absent from the current checkout, but remains in history. Rotation/revocation and coordinated history cleanup have not been completed in this chat. GitHub secret scanning was disabled at the time of review. No credential values are reproduced here.
