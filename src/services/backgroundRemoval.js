/**
 * Background Removal Service
 * Uses Replicate's remove-bg model to extract person silhouette
 */

const Replicate = require('replicate');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const https = require('https');
const http = require('http');

const replicate = new Replicate({
  auth: process.env.REPLICATE_API_KEY,
});

const s3Client = new S3Client({ region: process.env.REMOTION_AWS_REGION || 'us-east-1' });
const S3_BUCKET = 'remotionlambda-useast1-1fylxi4xgh';

/**
 * Download file from URL and return as buffer
 */
function downloadAsBuffer(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;

    client.get(url, (response) => {
      if (response.statusCode === 302 || response.statusCode === 301) {
        downloadAsBuffer(response.headers.location)
          .then(resolve)
          .catch(reject);
        return;
      }

      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve(Buffer.concat(chunks)));
      response.on('error', reject);
    }).on('error', reject);
  });
}

/**
 * Upload buffer to S3
 */
async function uploadToS3(buffer, key, contentType = 'image/png') {
  await s3Client.send(new PutObjectCommand({
    Bucket: S3_BUCKET,
    Key: key,
    Body: buffer,
    ContentType: contentType,
  }));

  return `https://${S3_BUCKET}.s3.us-east-1.amazonaws.com/${key}`;
}

/**
 * Remove background from image using Replicate
 * @param {string} imageUrl - URL of the image (must be publicly accessible)
 * @returns {Promise<string>} - S3 URL of the silhouette PNG
 */
async function removeBackground(imageUrl) {
  console.log('[BackgroundRemoval] Starting background removal...');
  console.log('[BackgroundRemoval] Input:', imageUrl);

  try {
    // Call Replicate's remove-bg model
    const output = await replicate.run(
      "lucataco/remove-bg:95fcc2a26d3899cd6c2691c900465aaeff466285a65c14638cc5f36f34befaf1",
      {
        input: {
          image: imageUrl
        }
      }
    );

    console.log('[BackgroundRemoval] Replicate output type:', typeof output);

    // New Replicate SDK returns a ReadableStream, consume it directly
    let buffer;
    if (output && typeof output[Symbol.asyncIterator] === 'function') {
      // It's a stream - consume it
      console.log('[BackgroundRemoval] Consuming stream...');
      const chunks = [];
      for await (const chunk of output) {
        chunks.push(chunk);
      }
      buffer = Buffer.concat(chunks);
    } else if (typeof output === 'string') {
      // It's a URL - download it
      console.log('[BackgroundRemoval] Downloading from URL...');
      buffer = await downloadAsBuffer(output);
    } else {
      throw new Error('Unexpected output format from Replicate');
    }

    console.log(`[BackgroundRemoval] Got ${(buffer.length / 1024).toFixed(1)} KB`);

    // Upload to S3 for reliable access from Remotion Lambda
    const timestamp = Date.now();
    const s3Key = `silhouettes/${timestamp}.png`;
    const s3Url = await uploadToS3(buffer, s3Key);

    console.log('[BackgroundRemoval] Uploaded to S3:', s3Url);

    return s3Url;
  } catch (error) {
    console.error('[BackgroundRemoval] Error:', error.message);
    throw new Error(`Background removal failed: ${error.message}`);
  }
}

module.exports = { removeBackground };
