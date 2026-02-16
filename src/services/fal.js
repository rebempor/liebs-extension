/**
 * fal.ai Service - Grok Imagine Image Transformation
 */

const FAL_API_URL = 'https://fal.run/xai/grok-imagine-image/edit';

const PIXAR_PROMPT = `Transform the person in this image into a Pixar 3D animated character. Carefully analyze their most defining features: face shape, jawline, nose shape, cheekbones, chin, forehead, eye shape and color, eyebrow shape and thickness, lip shape and fullness, skin tone, freckles, moles, dimples, wrinkles, scars, birthmarks, hairstyle, hair texture and color, facial hair, body type, posture, and expression. Also preserve all accessories and distinguishing details: glasses, sunglasses, earrings, piercings, necklaces, rings, watches, headbands, hats, tattoos, and any other visible jewelry or accessories. Translate each of these features into a Pixar-style 3D character with exaggerated charm — slightly larger eyes, smoother skin with soft subsurface scattering, stylized but recognizable proportions. Their most unique and distinguishing feature should be subtly amplified the way Pixar caricatures real people to make them more expressive and memorable. Clothing should be faithfully recreated with that clean, silified Pixar fabric look. All accessories should be stylized to match the Pixar aesthetic while remaining accurate to the original. The person must remain immediately recognizable. Eyes should have the signature Pixar sparkle — large, glossy, with detailed iris color and catchlight reflections. Amplify their facial expression slightly — make it more cinematic and emotionally readable. Place the character against a clean, soft solid pink background — smooth and minimal with no objects or distractions. Soft, warm studio lighting on the character. The final result should look like an official Pixar character reveal. Make this person look like the main protagonist of their own Pixar movie.`;

/**
 * Generate Pixar-style image from original photo
 * @param {string} imageBase64 - Base64 encoded image (data URL)
 * @returns {Promise<string>} - URL of generated Pixar image
 */
async function generatePixarImage(imageBase64) {
  console.log('[fal.ai] Generating Pixar image...');

  const response = await fetch(FAL_API_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Key ${process.env.FAL_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      prompt: PIXAR_PROMPT,
      image_url: imageBase64,
      num_images: 1
    })
  });

  if (!response.ok) {
    const error = await response.text();
    console.error('[fal.ai] Error:', error);
    throw new Error(`fal.ai error: ${response.status}`);
  }

  const result = await response.json();

  if (!result.images || result.images.length === 0) {
    throw new Error('No images returned from fal.ai');
  }

  console.log('[fal.ai] Pixar image generated:', result.images[0].url);
  return result.images[0].url;
}

module.exports = { generatePixarImage };
