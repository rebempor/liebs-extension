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

  // Start the render — MP4 (H.264) is much faster than GIF encoding on Lambda
  const { renderId, bucketName } = await renderMediaOnLambda({
    region,
    functionName,
    serveUrl,
    composition: 'Main',
    codec: 'h264',
    inputProps: {
      firstName,
      greeting,
      ctaText,
      originalPhotoUrl: originalPhotoUrl,
      silhouetteUrl: silhouetteUrl,
      pixarImageUrl: pixarImageUrl,
      videoUrl: videoUrl,
      effectsOverlayUrl: 'https://remotionlambda-useast1-1fylxi4xgh.s3.us-east-1.amazonaws.com/effects-overlay.webm',
    },
    scale: 0.45,          // 1080 -> 486px (final GIF is small anyway)
    everyNthFrame: 3,     // 30fps -> 10fps (fewer frames to render)
    imageFormat: 'jpeg',  // JPEG is faster than PNG for H.264 pipeline
    framesPerLambda: 25,  // 2 Lambda workers (50 frames / 25 = 2)
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
