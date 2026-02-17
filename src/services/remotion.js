/**
 * Remotion Lambda Service - GIF Rendering on AWS
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
 * Render GIF using Remotion Lambda
 *
 * @param {Object} options
 * @param {string} options.originalImageUrl - URL of original image (or base64)
 * @param {string} options.videoUrl - URL of generated video
 * @param {string} options.firstName - User's first name
 * @param {string} options.greeting - Greeting text
 * @param {string} options.ctaText - Call to action text
 * @returns {Promise<string>} - URL to the rendered GIF
 */
async function renderGif({ originalPhotoUrl, silhouetteUrl, pixarImageUrl, videoUrl, firstName, greeting, ctaText }) {
  console.log('[Remotion] Starting Lambda render...');
  console.log(`[Remotion] Props: firstName=${firstName}, greeting="${greeting}", cta="${ctaText}"`);

  const region = process.env.REMOTION_AWS_REGION || 'us-east-1';
  const functionName = process.env.REMOTION_FUNCTION_NAME;
  const serveUrl = process.env.REMOTION_SERVE_URL;

  if (!functionName || !serveUrl) {
    throw new Error('Remotion Lambda not configured. Set REMOTION_FUNCTION_NAME and REMOTION_SERVE_URL');
  }

  // Start the render
  const { renderId, bucketName } = await renderMediaOnLambda({
    region,
    functionName,
    serveUrl,
    composition: 'Main',
    codec: 'gif',
    inputProps: {
      firstName,
      greeting,
      ctaText,
      // Pass URLs for original photo, silhouette, Pixar image, and video
      originalPhotoUrl: originalPhotoUrl,
      silhouetteUrl: silhouetteUrl,
      pixarImageUrl: pixarImageUrl,
      videoUrl: videoUrl
    },
    // GIF optimization settings (~90% size reduction)
    scale: 0.45,          // 1080 -> 486px (smaller dimensions)
    everyNthFrame: 3,     // 30fps -> 10fps (fewer frames)
    imageFormat: 'png',
    // Speed optimizations
    framesPerLambda: 15,  // Split across more Lambdas (parallel rendering)
    timeoutInMilliseconds: 120000,  // 2 min timeout for video loading
    delayRenderTimeoutInMilliseconds: 60000, // 60s for delayRender calls
    // Optional: webhook for async notification
    // webhook: {
    //   url: process.env.REMOTION_WEBHOOK_URL,
    //   secret: process.env.REMOTION_WEBHOOK_SECRET
    // }
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

module.exports = { renderGif, isConfigured };
