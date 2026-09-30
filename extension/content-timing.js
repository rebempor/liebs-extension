// Centralized pacing and timeout values for content scripts.
// Tuning these in one place keeps UX timing changes predictable.

const EDIT_TIMER_DURATION = 25; // seconds the user can edit text before auto-lock

// Frontend pacing controls only; these do not change backend processing work.
const CAPTURE_STATUS_MIN_MS = 1800;
const CAPTURE_DONE_DWELL_MS = 1500;
const SNAP_MIN_DWELL_MS = 200;
const MIN_LIEBS_PREVIEW_REVEAL_MS = 6500;
const GLOW_UP_PREVIEW_DWELL_MS = 3200;
const ANIMATE_STATUS_MIN_MS = 4500;

const LIEBS_INSERT_READY_TIMEOUT_MS = 8000;
const LIEBS_INSERT_POLL_INTERVAL_MS = 250;

const MIN_MAIN_PROFILE_PHOTO_SIZE = 56;
