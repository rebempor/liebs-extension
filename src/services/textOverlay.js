/**
 * Text Overlay Service
 *
 * Applies greeting and CTA text onto a pre-rendered MP4 using ffmpeg's drawtext
 * filter. This replaces the previous approach of baking text into the Remotion
 * render, allowing text to be changed cheaply without re-running the expensive
 * Lambda render.
 *
 * Text timing matches the original Remotion composition (30fps, 150 frames):
 *   Greeting: frames 0–60  (0.000–2.000s), fade in 0–0.267s, fade out 1.600–2.000s
 *   CTA:      frames 100–150 (3.333–5.000s), fade in 3.333–3.833s
 *
 * Font sizes are designed for the original 1080×1080 Remotion canvas and scaled
 * dynamically based on the actual video dimensions (e.g. 486px at 0.45 scale).
 *
 * Font configuration:
 *   Set DRAWTEXT_FONT_PATH env var to the path of a bold TTF/OTF font on the
 *   server. Falls back to common Ubuntu/Debian system font locations.
 */

const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

const s3Client = new S3Client({ region: process.env.REMOTION_AWS_REGION || 'us-east-1' });
const S3_BUCKET = 'remotionlambda-useast1-1fylxi4xgh';

// Font fallback locations — tried in order until one exists
const FONT_FALLBACKS = [
  process.env.DRAWTEXT_FONT_PATH,
  '/usr/share/fonts/truetype/noto/NotoSans-Bold.ttf',
  '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
  '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf',
  '/usr/share/fonts/truetype/ubuntu/Ubuntu-B.ttf',
  '/System/Library/Fonts/Helvetica.ttc',              // macOS dev
  '/System/Library/Fonts/SFNSDisplay.ttf',            // macOS dev
].filter(Boolean);

function resolveFontPath() {
  for (const candidate of FONT_FALLBACKS) {
    if (fs.existsSync(candidate)) return candidate;
  }
  console.warn('[TextOverlay] No font file found. Text may render in default ffmpeg font.');
  return null;
}

/**
 * Download an HTTP/HTTPS URL to a local file path, following redirects.
 */
function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    const client = url.startsWith('https') ? https : http;

    client.get(url, (response) => {
      if (response.statusCode === 301 || response.statusCode === 302) {
        downloadFile(response.headers.location, destPath).then(resolve).catch(reject);
        return;
      }
      response.pipe(file);
      file.on('finish', () => { file.close(); resolve(); });
    }).on('error', (err) => {
      fs.unlink(destPath, () => {});
      reject(err);
    });
  });
}

/**
 * Upload a local file to S3 and return its public URL.
 */
async function uploadToS3(filePath, key, contentType = 'video/mp4') {
  const fileContent = fs.readFileSync(filePath);
  await s3Client.send(new PutObjectCommand({
    Bucket: S3_BUCKET,
    Key: key,
    Body: fileContent,
    ContentType: contentType,
  }));
  return `https://${S3_BUCKET}.s3.us-east-1.amazonaws.com/${key}`;
}

// Original Remotion canvas size — font sizes are designed for this resolution
const DESIGN_WIDTH = 1080;

/**
 * Probe the width of a local video file using ffprobe.
 */
async function probeVideoWidth(filePath) {
  const { stdout } = await execAsync(
    `ffprobe -v error -select_streams v:0 -show_entries stream=width -of csv=p=0 "${filePath}"`
  );
  const width = parseInt(stdout.trim(), 10);
  if (!width || isNaN(width)) {
    console.warn('[TextOverlay] Could not probe video width, assuming 1080');
    return DESIGN_WIDTH;
  }
  return width;
}

/**
 * Scale a font size for the actual video width, with an overflow guard
 * that shrinks text if it would be wider than maxWidthRatio of the video.
 *
 * @param {number} designFontSize  Font size at 1080px design resolution
 * @param {number} scaleFactor     actualWidth / DESIGN_WIDTH
 * @param {string} text            The text string to check for overflow
 * @param {number} videoWidth      Actual video width in pixels
 * @param {number} [maxWidthRatio] Max fraction of video width text may occupy
 */
function scaleFontSize(designFontSize, scaleFactor, text, videoWidth, maxWidthRatio = 0.85) {
  let fontSize = Math.round(designFontSize * scaleFactor);
  // Rough heuristic: average char width ≈ 0.6 × fontSize for bold sans-serif
  const estimatedTextWidth = text.length * fontSize * 0.6;
  const maxPx = videoWidth * maxWidthRatio;
  if (estimatedTextWidth > maxPx && text.length > 0) {
    fontSize = Math.floor(maxPx / (text.length * 0.6));
  }
  return Math.max(fontSize, 8); // floor at 8px
}

/**
 * Build the ffmpeg drawtext filter string for one text layer.
 *
 * Uses a textfile instead of inline text= to avoid shell-escaping issues
 * with arbitrary user input (apostrophes, commas, colons, etc.).
 *
 * @param {Object} opts
 * @param {string} opts.textfilePath  Path to temp file containing the text
 * @param {string|null} opts.fontPath Path to the bold TTF font (or null)
 * @param {number} opts.fontSize      Font size in pixels (already scaled)
 * @param {number} opts.borderw       Border width in pixels (already scaled)
 * @param {number} opts.yOffset       Bottom padding in pixels (already scaled)
 * @param {number} opts.startTime     Start of visibility window (seconds)
 * @param {number} opts.endTime       End of visibility window (seconds)
 * @param {number} opts.fadeInStart   Start of fade-in (seconds)
 * @param {number} opts.fadeInEnd     End of fade-in (seconds)
 * @param {number|null} opts.fadeOutStart Start of fade-out (null = no fade-out)
 * @param {number|null} opts.fadeOutEnd   End of fade-out (null = no fade-out)
 */
function buildDrawtextFilter(opts) {
  const {
    textfilePath,
    fontPath,
    fontSize,
    borderw,
    yOffset,
    startTime,
    endTime,
    fadeInStart,
    fadeInEnd,
    fadeOutStart,
    fadeOutEnd,
  } = opts;

  const fadeInDur = fadeInEnd - fadeInStart;

  let alphaExpr;
  if (fadeOutStart !== null && fadeOutEnd !== null) {
    const fadeOutDur = fadeOutEnd - fadeOutStart;
    alphaExpr =
      `if(lt(t,${fadeInStart}),0,` +
      `if(lt(t,${fadeInEnd}),(t-${fadeInStart})/${fadeInDur},` +
      `if(lt(t,${fadeOutStart}),1,` +
      `if(lt(t,${fadeOutEnd}),(${fadeOutEnd}-t)/${fadeOutDur},0))))`;
  } else {
    alphaExpr =
      `if(lt(t,${fadeInStart}),0,` +
      `if(lt(t,${fadeInEnd}),(t-${fadeInStart})/${fadeInDur},1))`;
  }

  const fontPart = fontPath ? `fontfile='${fontPath}':` : '';

  return (
    `drawtext=${fontPart}` +
    `textfile='${textfilePath}':` +
    `fontsize=${fontSize}:` +
    `fontcolor=white:` +
    `borderw=${borderw}:` +
    `bordercolor=black:` +
    `x=(w-text_w)/2:` +
    `y=h-text_h-${yOffset}:` +
    `alpha='${alphaExpr}':` +
    `enable='between(t,${startTime},${endTime})'`
  );
}

/**
 * Apply greeting and CTA text overlays onto an MP4 via ffmpeg drawtext.
 *
 * @param {string} mp4Url    S3/HTTPS URL of the pre-rendered MP4 (no text)
 * @param {Object} opts
 * @param {string} opts.greeting  Greeting text (e.g. "Hey, John!")
 * @param {string} opts.ctaText   CTA text (e.g. "Open to talk?")
 * @returns {Promise<string>} S3 URL of the new MP4 with text baked in
 */
async function applyTextOverlay(mp4Url, { greeting, ctaText }) {
  const tmpDir = '/tmp';
  const timestamp = Date.now();

  const inputPath = path.join(tmpDir, `text-input-${timestamp}.mp4`);
  const outputPath = path.join(tmpDir, `text-output-${timestamp}.mp4`);
  const greetingTextPath = path.join(tmpDir, `greeting-${timestamp}.txt`);
  const ctaTextPath = path.join(tmpDir, `cta-${timestamp}.txt`);

  const tempFiles = [inputPath, outputPath, greetingTextPath, ctaTextPath];

  try {
    console.log('[TextOverlay] Downloading MP4...');
    await downloadFile(mp4Url, inputPath);

    const fontPath = resolveFontPath();
    if (fontPath) {
      console.log(`[TextOverlay] Using font: ${fontPath}`);
    }

    // Probe actual video width to scale font sizes proportionally
    const videoWidth = await probeVideoWidth(inputPath);
    const scale = videoWidth / DESIGN_WIDTH;
    console.log(`[TextOverlay] Video width: ${videoWidth}px (scale: ${scale.toFixed(2)} vs ${DESIGN_WIDTH}px design)`);

    const greetingText = greeting || '';
    const ctaTextStr = ctaText || '';

    // Scale all pixel values from 1080px design to actual video size
    const greetingFontSize = scaleFontSize(90, scale, greetingText, videoWidth);
    const ctaFontSize = scaleFontSize(72, scale, ctaTextStr, videoWidth);
    const borderW = Math.max(2, Math.round(6 * scale));
    const yOffset = Math.max(10, Math.round(80 * scale));

    console.log(`[TextOverlay] Scaled sizes: greeting=${greetingFontSize}px, cta=${ctaFontSize}px, border=${borderW}px, yOffset=${yOffset}px`);

    // Write text to temp files to avoid shell-escaping problems
    fs.writeFileSync(greetingTextPath, greetingText);
    fs.writeFileSync(ctaTextPath, ctaTextStr);

    // Greeting: frames 0–60 at 30fps = 0.000–2.000s
    //   fade in:  frames 0–8   = 0.000–0.267s
    //   fade out: frames 48–60 = 1.600–2.000s
    const greetingFilter = buildDrawtextFilter({
      textfilePath: greetingTextPath,
      fontPath,
      fontSize: greetingFontSize,
      borderw: borderW,
      yOffset,
      startTime: 0,
      endTime: 2.0,
      fadeInStart: 0,
      fadeInEnd: 0.267,
      fadeOutStart: 1.6,
      fadeOutEnd: 2.0,
    });

    // CTA: frames 100–150 at 30fps = 3.333–5.000s
    //   fade in: frames 100–115 = 3.333–3.833s
    //   no fade out (plays to end)
    const ctaFilter = buildDrawtextFilter({
      textfilePath: ctaTextPath,
      fontPath,
      fontSize: ctaFontSize,
      borderw: borderW,
      yOffset,
      startTime: 3.333,
      endTime: 5.0,
      fadeInStart: 3.333,
      fadeInEnd: 3.833,
      fadeOutStart: null,
      fadeOutEnd: null,
    });

    const vfChain = `${greetingFilter},${ctaFilter}`;
    // Re-encode at high quality (CRF 15) since this output feeds the GIF converter
    const cmd =
      `ffmpeg -y -i "${inputPath}" ` +
      `-vf "${vfChain}" ` +
      `-c:v libx264 -crf 15 -preset fast -an ` +
      `"${outputPath}"`;

    console.log('[TextOverlay] Applying text overlays...');
    await execAsync(cmd);

    console.log('[TextOverlay] Uploading result to S3...');
    const s3Key = `text-overlaid-mp4s/${timestamp}.mp4`;
    const s3Url = await uploadToS3(outputPath, s3Key);

    console.log(`[TextOverlay] Done: ${s3Url}`);
    return s3Url;
  } finally {
    for (const f of tempFiles) {
      if (fs.existsSync(f)) {
        try { fs.unlinkSync(f); } catch (_) { /* ignore cleanup errors */ }
      }
    }
  }
}

module.exports = { applyTextOverlay };
