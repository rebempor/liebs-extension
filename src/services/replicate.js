/**
 * Replicate Service - Seedance Video Generation
 */

const REPLICATE_API_URL = 'https://api.replicate.com/v1';
const SEEDANCE_MODEL = 'bytedance/seedance-1-lite';

/**
 * Generate animated video from Pixar image
 * @param {string} imageUrl - URL of the Pixar-style image
 * @returns {Promise<string>} - URL of generated video
 */
async function generateVideo(imageUrl) {
  console.log('[Replicate] Generating video from Pixar image...');

  // Create prediction
  const response = await fetch(`${REPLICATE_API_URL}/models/${SEEDANCE_MODEL}/predictions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.REPLICATE_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      input: {
        image: imageUrl,
        prompt: 'the character looks at the camera and waves hello in one simple wave gesture and smiles enthusiastically',
        duration: 3,
        resolution: '480p'
      }
    })
  });

  if (!response.ok) {
    const error = await response.text();
    console.error('[Replicate] Error:', error);
    throw new Error(`Replicate error: ${response.status}`);
  }

  const prediction = await response.json();
  console.log('[Replicate] Prediction created:', prediction.id);

  // Poll for result
  const videoUrl = await pollForResult(prediction.id);
  console.log('[Replicate] Video generated:', videoUrl);

  return videoUrl;
}

/**
 * Poll Replicate for prediction result
 */
async function pollForResult(predictionId, maxAttempts = 120) {
  const pollUrl = `${REPLICATE_API_URL}/predictions/${predictionId}`;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const response = await fetch(pollUrl, {
      headers: { 'Authorization': `Bearer ${process.env.REPLICATE_API_KEY}` }
    });

    if (!response.ok) {
      throw new Error(`Failed to poll prediction: ${response.status}`);
    }

    const prediction = await response.json();
    console.log(`[Replicate] Poll ${attempt + 1}: ${prediction.status}`);

    if (prediction.status === 'succeeded') {
      return Array.isArray(prediction.output) ? prediction.output[0] : prediction.output;
    }
    if (prediction.status === 'failed') {
      throw new Error(`Prediction failed: ${prediction.error}`);
    }
    if (prediction.status === 'canceled') {
      throw new Error('Prediction canceled');
    }

    await new Promise(r => setTimeout(r, 2000));
  }

  throw new Error('Prediction timed out');
}

module.exports = { generateVideo };
