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

/**
 * Render MP4 using Remotion Lambda
 *
 * @param {Object} options
 * @param {string} options.originalPhotoUrl - URL of original photo on S3
 * @param {string} options.silhouetteUrl - URL of background-removed silhouette
 * @param {string} options.pixarImageUrl - URL of Pixar-transformed image
 * @param {string} options.videoUrl - URL of generated video
 * @param {string} options.firstName - User's first name
 * @param {string} options.greeting - Greeting text
 * @param {string} options.ctaText - Call to action text
 * @returns {Promise<string>} - URL to the rendered MP4
 */
async function renderMp4({ originalPhotoUrl, silhouetteUrl, pixarImageUrl, videoUrl, firstName, greeting, ctaText }) {
  console.log('[Remotion] Starting Lambda render (MP4)...');
  console.log(`[Remotion] Props: firstName=${firstName}, greeting="${greeting}", cta="${ctaText}"`);

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
    greeting,
    ctaText,
    originalPhotoUrl,
    silhouetteUrl,
    pixarImageUrl,
    videoUrl,
    ...(effectsOverlayUrl ? { effectsOverlayUrl } : {}),
  };

  // Tunable render settings to speed up Lambda renders.
  // Defaults are optimized for current 486px / 10fps output profile.
  const scale = readNumberEnv('REMOTION_SCALE', 0.45, { min: 0.1, max: 1 });
  const everyNthFrame = readNumberEnv('REMOTION_EVERY_NTH_FRAME', 3, { integer: true, min: 1, max: 10 });
  const framesPerLambda = readNumberEnv('REMOTION_FRAMES_PER_LAMBDA', 8, { integer: true, min: 4, max: 200 });
  const concurrency = readNumberEnv('REMOTION_CONCURRENCY', 6, { integer: true, min: 1, max: 1000 });
  const concurrencyPerLambda = readNumberEnv('REMOTION_CONCURRENCY_PER_LAMBDA', 1, { integer: true, min: 1, max: 4 });

  console.log(
    `[Remotion] Render tuning: scale=${scale}, everyNthFrame=${everyNthFrame}, ` +
      `framesPerLambda=${framesPerLambda}, concurrency=${concurrency}, concurrencyPerLambda=${concurrencyPerLambda}`
  );

  // Start the render — MP4 (H.264) is much faster than GIF encoding on Lambda
  const { renderId, bucketName } = await renderMediaOnLambda({
    region,
    functionName,
    serveUrl,
    composition: 'Main',
    codec: 'h264',
    inputProps,
    scale,                // 1080 -> 486px at default 0.45
    everyNthFrame,        // 30fps -> 10fps at default 3
    imageFormat: 'jpeg',  // JPEG is faster than PNG for H.264 pipeline
    framesPerLambda,      // Default 8 -> ~7 Lambda chunks for a 50-frame render
    concurrency,          // Default 6 workers in parallel
    concurrencyPerLambda, // Parallelism inside each Lambda container
    timeoutInMilliseconds: 240000,  // 4 min timeout
    delayRenderTimeoutInMilliseconds: 60000, // 60s for delayRender calls
  });

  console.log(`[Remotion] Render started: ${renderId}`);
  console.log(`[Remotion] Bucket: ${bucketName}`);

  // Poll for completion
  let progress;
  let pollCount = 0;
  const maxPolls = 120; // 4 minutes max (2s intervals)

  do {
    await new Promise(r => setTimeout(r, 2000));
    pollCount++;

    progress = await getRenderProgress({
      renderId,
      bucketName,
      functionName,
      region,
    });

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
