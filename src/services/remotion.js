/**
 * Remotion Lambda Service - MP4 Rendering on AWS
 *
 * Renders as MP4 (H.264) on Lambda for speed, then converts to GIF server-side.
 *
 * Prerequisites:
 * 1. Deploy Remotion Lambda: npx remotion lambda deploy
 * 2. Deploy your site: npx remotion lambda sites create src/index.ts
 * 3. Set environment variables (function name, serve URL, region)
 *
 * See: https://www.remotion.dev/docs/lambda
 */

const { renderMediaOnLambda, getRenderProgress } = require('@remotion/lambda/client');
const GENERATION_CANCELLED_CODE = 'GENERATION_CANCELLED';

function createGenerationCancelledError(message = 'Generation cancelled by user') {
  const err = new Error(message);
  err.code = GENERATION_CANCELLED_CODE;
  return err;
}

function throwIfCancelled(signal) {
  if (signal?.aborted) {
    throw createGenerationCancelledError();
  }
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(createGenerationCancelledError());
      return;
    }

    const timeoutId = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);

    function onAbort() {
      clearTimeout(timeoutId);
      cleanup();
      reject(createGenerationCancelledError());
    }

    function cleanup() {
      signal?.removeEventListener('abort', onAbort);
    }

    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function normalizeOptionalHttpUrl(value) {
  if (!value) {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`unsupported protocol "${parsed.protocol}"`);
    }
    return trimmed;
  } catch (err) {
    console.warn(`[Remotion] Ignoring invalid EFFECTS_OVERLAY_URL: ${err.message}`);
    return null;
  }
}

function readNumberEnv(name, fallback, { integer = false, min, max } = {}) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || raw.trim() === '') {
    return fallback;
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    console.warn(`[Remotion] Invalid ${name}="${raw}". Using fallback ${fallback}.`);
    return fallback;
  }

  if (integer && !Number.isInteger(parsed)) {
    console.warn(`[Remotion] ${name} must be an integer. Using fallback ${fallback}.`);
    return fallback;
  }

  if (min !== undefined && parsed < min) {
    console.warn(`[Remotion] ${name} must be >= ${min}. Using fallback ${fallback}.`);
    return fallback;
  }

  if (max !== undefined && parsed > max) {
    console.warn(`[Remotion] ${name} must be <= ${max}. Using fallback ${fallback}.`);
    return fallback;
  }

  return parsed;
}

function readOptionalNumberEnv(name, { integer = false, min, max } = {}) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || raw.trim() === '') {
    return null;
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    console.warn(`[Remotion] Invalid ${name}="${raw}". Ignoring.`);
    return null;
  }

  if (integer && !Number.isInteger(parsed)) {
    console.warn(`[Remotion] ${name} must be an integer. Ignoring.`);
    return null;
  }

  if (min !== undefined && parsed < min) {
    console.warn(`[Remotion] ${name} must be >= ${min}. Ignoring.`);
    return null;
  }

  if (max !== undefined && parsed > max) {
    console.warn(`[Remotion] ${name} must be <= ${max}. Ignoring.`);
    return null;
  }

  return parsed;
}

/**
 * Render MP4 using Remotion Lambda
 *
 * @param {Object} options
 * @param {string} options.originalPhotoUrl - URL of original photo on S3
 * @param {string} options.silhouetteUrl - URL of background-removed silhouette
 * @param {string} options.pixarImageUrl - URL of Pixar-transformed image
 * @param {string} options.videoUrl - URL of generated video
 * @param {string} options.firstName - User's first name
 * @param {number[]} [options.frameRange] - Optional [start, end] frame range to render
 * @param {AbortSignal} [options.signal] - Optional abort signal for cancellation
 * @returns {Promise<string>} - URL to the rendered MP4
 */
async function renderMp4({
  originalPhotoUrl,
  silhouetteUrl,
  pixarImageUrl,
  videoUrl,
  firstName,
  frameRange,
  signal,
}) {
  const rangeLabel = frameRange ? ` (frames ${frameRange[0]}-${frameRange[1]})` : '';
  console.log(`[Remotion] Starting Lambda render (MP4)${rangeLabel}...`);
  console.log(`[Remotion] Props: firstName=${firstName}`);
  throwIfCancelled(signal);

  const region = process.env.REMOTION_AWS_REGION || 'us-east-1';
  const functionName = process.env.REMOTION_FUNCTION_NAME;
  const serveUrl = process.env.REMOTION_SERVE_URL;

  if (!functionName || !serveUrl) {
    throw new Error('Remotion Lambda not configured. Set REMOTION_FUNCTION_NAME and REMOTION_SERVE_URL');
  }

  const effectsOverlayUrl = normalizeOptionalHttpUrl(process.env.EFFECTS_OVERLAY_URL);
  if (effectsOverlayUrl) {
    console.log(`[Remotion] Using pre-rendered effects overlay: ${effectsOverlayUrl}`);
  } else {
    console.log('[Remotion] EFFECTS_OVERLAY_URL not set. Rendering inline fallback effects.');
  }

  const inputProps = {
    firstName,
    originalPhotoUrl,
    silhouetteUrl,
    pixarImageUrl,
    videoUrl,
    ...(effectsOverlayUrl ? { effectsOverlayUrl } : {}),
  };

  // Tunable render settings to speed up Lambda renders.
  // Defaults are optimized for current 486px / 10fps output profile.
  // Note: Remotion Lambda v4 allows either `concurrency` OR `framesPerLambda`, not both.
  const scale = readNumberEnv('REMOTION_SCALE', 0.45, { min: 0.1, max: 1 });
  const everyNthFrame = readNumberEnv('REMOTION_EVERY_NTH_FRAME', 3, { integer: true, min: 1, max: 10 });
  const framesPerLambdaEnv = readOptionalNumberEnv('REMOTION_FRAMES_PER_LAMBDA', { integer: true, min: 4, max: 200 });
  const concurrencyEnv = readOptionalNumberEnv('REMOTION_CONCURRENCY', { integer: true, min: 1, max: 1000 });
  const concurrencyPerLambda = readNumberEnv('REMOTION_CONCURRENCY_PER_LAMBDA', 1, { integer: true, min: 1, max: 4 });

  let chunkingMode;
  const chunkingOptions = {};

  if (concurrencyEnv !== null && framesPerLambdaEnv !== null) {
    console.warn(
      '[Remotion] Both REMOTION_CONCURRENCY and REMOTION_FRAMES_PER_LAMBDA were set. ' +
      'Using REMOTION_CONCURRENCY and ignoring REMOTION_FRAMES_PER_LAMBDA.'
    );
    chunkingMode = `concurrency:${concurrencyEnv}`;
    chunkingOptions.concurrency = concurrencyEnv;
  } else if (concurrencyEnv !== null) {
    chunkingMode = `concurrency:${concurrencyEnv}`;
    chunkingOptions.concurrency = concurrencyEnv;
  } else if (framesPerLambdaEnv !== null) {
    chunkingMode = `framesPerLambda:${framesPerLambdaEnv}`;
    chunkingOptions.framesPerLambda = framesPerLambdaEnv;
  } else {
    // Default to concurrency-driven fan-out for faster short renders.
    const defaultConcurrency = 24;
    chunkingMode = `concurrency:${defaultConcurrency} (default)`;
    chunkingOptions.concurrency = defaultConcurrency;
  }

  console.log(
    `[Remotion] Render tuning: scale=${scale}, everyNthFrame=${everyNthFrame}, ` +
      `chunking=${chunkingMode}, concurrencyPerLambda=${concurrencyPerLambda}`
  );

  // Start the render — MP4 (H.264) is much faster than GIF encoding on Lambda
  const renderParams = {
    region,
    functionName,
    serveUrl,
    composition: 'Main',
    codec: 'h264',
    inputProps,
    scale,                // 1080 -> 486px at default 0.45
    everyNthFrame,        // 30fps -> 10fps at default 3
    imageFormat: 'jpeg',  // JPEG is faster than PNG for H.264 pipeline
    concurrencyPerLambda, // Parallelism inside each Lambda container
    ...chunkingOptions,   // Set either `concurrency` or `framesPerLambda`
    timeoutInMilliseconds: 240000,  // 4 min timeout
    delayRenderTimeoutInMilliseconds: 60000, // 60s for delayRender calls
  };

  if (frameRange) {
    renderParams.frameRange = frameRange;
    console.log(`[Remotion] Frame range: ${frameRange[0]}-${frameRange[1]}`);
  }

  const { renderId, bucketName } = await renderMediaOnLambda(renderParams);

  console.log(`[Remotion] Render started: ${renderId}`);
  console.log(`[Remotion] Bucket: ${bucketName}`);
  throwIfCancelled(signal);

  // Poll for completion
  let progress;
  let pollCount = 0;
  const maxPolls = 120; // 4 minutes max (2s intervals)

  do {
    await sleep(2000, signal);
    pollCount++;
    throwIfCancelled(signal);

    progress = await getRenderProgress({
      renderId,
      bucketName,
      functionName,
      region,
    });
    throwIfCancelled(signal);

    const pct = Math.round(progress.overallProgress * 100);
    console.log(`[Remotion] Progress: ${pct}% (poll ${pollCount})`);

    if (progress.fatalErrorEncountered) {
      const errorMsg = progress.errors?.[0]?.message || 'Unknown render error';
      throw new Error(`Remotion render failed: ${errorMsg}`);
    }

    if (pollCount >= maxPolls) {
      throw new Error('Remotion render timed out');
    }

  } while (!progress.done);

  if (!progress.outputFile) {
    throw new Error('Render completed but no output file URL');
  }

  console.log(`[Remotion] Render complete: ${progress.outputFile}`);
  console.log(`[Remotion] Size: ${(progress.outputSizeInBytes / 1024 / 1024).toFixed(2)} MB`);
  console.log(`[Remotion] Cost: ${progress.costs?.displayCost || 'unknown'}`);

  return progress.outputFile;
}

/**
 * Check if Remotion Lambda is configured
 */
function isConfigured() {
  return !!(process.env.REMOTION_FUNCTION_NAME && process.env.REMOTION_SERVE_URL);
}

module.exports = { renderMp4, isConfigured };
