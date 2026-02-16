/**
 * fal.ai Service - Grok Imagine Image Transformation
 */

const FAL_API_URL = 'https://fal.run/xai/grok-imagine-image/edit';

const PIXAR_PROMPT = `Using the uploaded reference image as a strict compositional blueprint, transform the person into a Pixar 3D animated character while matching the exact camera angle, framing, body position, head tilt, gaze direction, and crop of the original photo pixel-for-pixel. Treat this as a 1:1 pose and composition transfer — the only change is rendering style, everything spatial stays identical.
The character's face must occupy the same percentage of the frame as in the reference. Maintain identical head rotation on all axes. Preserve the exact eye-line direction, degree of head tilt, shoulder positioning, torso crop, and distance from camera.
Carefully analyze and translate their most defining features into Pixar style: face shape, jawline, nose, cheekbones, chin, forehead, eye shape and color, eyebrow shape and thickness, lip shape, skin tone, and any freckles, moles, dimples, wrinkles, scars, or birthmarks. Eyes should have the signature Pixar sparkle — large, glossy, with detailed iris color and catchl reflections. Slightly larger eyes, smoother skin with soft subsurface scattering, stylized but immediately recognizable proportions. Their most unique distinguishing feature should be subtly amplified the way Pixar caricatures real people. Amplify their expression slightly to be more cinematic and emotionally readable.
Faithfully recreate all clothing with a clean, simplified Pixar fabric look. Preserve every visible accessory — glasses, jewelry, hats, watches, piercings, tattoos, headwear — stylized to match the Pixar aesthetic while staying accurate to the original.
Place against a clean, soft solid pink background. Soft, warm studio lighting.
Do NOT re-center the subject. Do NOT change the camera angle or focal length. Do NOT mirror or flip the image. Do NOT default to a generic ¾ Pixar portrait pose. The final image must look like a Pixar render composited directly over the original photo with perfect alignment. Pose, angle, crop, and position are non-negotiable.`;

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
