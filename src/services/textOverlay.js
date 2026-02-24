/**
 * Text Overlay / Compose Service
 *
 * Applies greeting and CTA text onto a pre-rendered MP4 using ffmpeg's drawtext
 * filter and optionally converts to GIF in the same ffmpeg invocation.
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
const { resolveGifProfile, buildGifFilter } = require('./videoCompress');

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
  console.warn('[Compose] No font file found. Text may render in default ffmpeg font.');
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
    console.warn('[Compose] Could not probe video width, assuming 1080');
    return DESIGN_WIDTH;
  }
  return width;
}

/**
 * Scale a font size for the actual video width, with an overflow guard
 * that shrinks text if it would be wider than maxWidthRatio of the video.
 */
function scaleFontSize(designFontSize, scaleFactor, text, videoWidth, maxWidthRatio = 0.85) {
  let fontSize = Math.round(designFontSize * scaleFactor);
  const estimatedTextWidth = text.length * fontSize * 0.6;
  const maxPx = videoWidth * maxWidthRatio;
  if (estimatedTextWidth > maxPx && text.length > 0) {
    fontSize = Math.floor(maxPx / (text.length * 0.6));
  }
  return Math.max(fontSize, 8);
}

/**
 * Build the ffmpeg drawtext filter string for one text layer.
 */
function buildDrawtextFilter(opts) {
  const {
    textfilePath, fontPath, fontSize, borderw, yOffset,
    startTime, endTime, fadeInStart, fadeInEnd, fadeOutStart, fadeOutEnd,
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
 * Shared helper: download MP4, probe dimensions, scale fonts, build drawtext filters.
 * Returns the local paths, filter chain, and scale info for the caller to compose
 * into a full ffmpeg command.
 */
async function prepareTextFilters(mp4Url, { greeting, ctaText }) {
  const tmpDir = '/tmp';
  const timestamp = Date.now();

  const inputPath = path.join(tmpDir, `compose-input-${timestamp}.mp4`);
  const greetingTextPath = path.join(tmpDir, `greeting-${timestamp}.txt`);
  const ctaTextPath = path.join(tmpDir, `cta-${timestamp}.txt`);

  console.log('[Compose] Downloading MP4...');
  await downloadFile(mp4Url, inputPath);

  const fontPath = resolveFontPath();
  if (fontPath) {
    console.log(`[Compose] Using font: ${fontPath}`);
  }

  const videoWidth = await probeVideoWidth(inputPath);
  const scale = videoWidth / DESIGN_WIDTH;
  console.log(`[Compose] Video width: ${videoWidth}px (scale: ${scale.toFixed(2)} vs ${DESIGN_WIDTH}px design)`);

  const greetingText = greeting || '';
  const ctaTextStr = ctaText || '';

  const greetingFontSize = scaleFontSize(90, scale, greetingText, videoWidth);
  const ctaFontSize = scaleFontSize(72, scale, ctaTextStr, videoWidth);
  const borderW = Math.max(2, Math.round(6 * scale));
  const yOffset = Math.max(10, Math.round(80 * scale));

  console.log(`[Compose] Scaled sizes: greeting=${greetingFontSize}px, cta=${ctaFontSize}px, border=${borderW}px, yOffset=${yOffset}px`);

  fs.writeFileSync(greetingTextPath, greetingText);
  fs.writeFileSync(ctaTextPath, ctaTextStr);

  const greetingFilter = buildDrawtextFilter({
    textfilePath: greetingTextPath, fontPath,
    fontSize: greetingFontSize, borderw: borderW, yOffset,
    startTime: 0, endTime: 2.0,
    fadeInStart: 0, fadeInEnd: 0.267,
    fadeOutStart: 1.6, fadeOutEnd: 2.0,
  });

  const ctaFilter = buildDrawtextFilter({
    textfilePath: ctaTextPath, fontPath,
    fontSize: ctaFontSize, borderw: borderW, yOffset,
    startTime: 3.333, endTime: 5.0,
    fadeInStart: 3.333, fadeInEnd: 3.833,
    fadeOutStart: null, fadeOutEnd: null,
  });

  const drawtextChain = `${greetingFilter},${ctaFilter}`;

  return {
    inputPath,
    greetingTextPath,
    ctaTextPath,
    drawtextChain,
    timestamp,
  };
}

function formatMB(bytes) {
  return (bytes / 1024 / 1024).toFixed(2);
}

/**
 * Apply text overlay AND convert to GIF in a single ffmpeg invocation.
 *
 * Produces two outputs:
 *   1. Text-overlaid MP4 (stored for re-stamp backup)
 *   2. Optimized GIF (final deliverable)
 *
 * @param {string} mp4Url    S3/HTTPS URL of the pre-rendered MP4 (no text)
 * @param {Object} opts
 * @param {string} opts.greeting  Greeting text
 * @param {string} opts.ctaText   CTA text
 * @returns {Promise<{mp4WithTextUrl: string, gifUrl: string}>}
 */
async function applyTextAndConvertToGif(mp4Url, { greeting, ctaText }) {
  const {
    inputPath, greetingTextPath, ctaTextPath, drawtextChain, timestamp,
  } = await prepareTextFilters(mp4Url, { greeting, ctaText });

  const mp4OutputPath = path.join('/tmp', `compose-mp4-${timestamp}.mp4`);
  const gifOutputPath = path.join('/tmp', `compose-gif-${timestamp}.gif`);
  const tempFiles = [inputPath, mp4OutputPath, gifOutputPath, greetingTextPath, ctaTextPath];

  try {
    const gifProfile = resolveGifProfile(process.env.GIF_OUTPUT_PROFILE);
    const gifFilter = buildGifFilter(gifProfile);

    console.log(
      `[Compose] GIF profile: ${gifProfile.name} ` +
      `(${gifProfile.width || 'source'}px, ${gifProfile.fps}fps, ${gifProfile.maxColors} colors)`
    );

    // Single ffmpeg command: drawtext → split → MP4 + GIF
    const filterComplex =
      `[0:v]${drawtextChain},split=2[mp4][gifpipe];` +
      `[gifpipe]${gifFilter}[gif]`;

    const cmd =
      `ffmpeg -y -i "${inputPath}" ` +
      `-filter_complex "${filterComplex}" ` +
      `-map "[mp4]" -c:v libx264 -crf 18 -preset ultrafast -an "${mp4OutputPath}" ` +
      `-map "[gif]" -gifflags -offsetting "${gifOutputPath}"`;

    console.log('[Compose] Running combined text+GIF ffmpeg...');
    const startedAt = Date.now();
    await execAsync(cmd);
    const elapsedMs = Date.now() - startedAt;

    const mp4Size = fs.statSync(mp4OutputPath).size;
    const gifSize = fs.statSync(gifOutputPath).size;
    console.log(`[Compose] MP4: ${formatMB(mp4Size)} MB, GIF: ${formatMB(gifSize)} MB (${(elapsedMs / 1000).toFixed(1)}s)`);

    console.log('[Compose] Uploading MP4 and GIF to S3...');
    const [mp4WithTextUrl, gifUrl] = await Promise.all([
      uploadToS3(mp4OutputPath, `text-overlaid-mp4s/${timestamp}.mp4`),
      uploadToS3(gifOutputPath, `generated-gifs/${timestamp}.gif`, 'image/gif'),
    ]);

    console.log(`[Compose] Done: MP4=${mp4WithTextUrl}`);
    console.log(`[Compose] Done: GIF=${gifUrl}`);

    return { mp4WithTextUrl, gifUrl };
  } finally {
    for (const f of tempFiles) {
      if (fs.existsSync(f)) {
        try { fs.unlinkSync(f); } catch (_) { /* ignore */ }
      }
    }
  }
}

/**
 * Apply text overlay only (no GIF conversion).
 * Used by the restamp-text endpoint when only the MP4 is needed standalone.
 */
async function applyTextOverlay(mp4Url, { greeting, ctaText }) {
  const {
    inputPath, greetingTextPath, ctaTextPath, drawtextChain, timestamp,
  } = await prepareTextFilters(mp4Url, { greeting, ctaText });

  const outputPath = path.join('/tmp', `text-output-${timestamp}.mp4`);
  const tempFiles = [inputPath, outputPath, greetingTextPath, ctaTextPath];

  try {
    const cmd =
      `ffmpeg -y -i "${inputPath}" ` +
      `-vf "${drawtextChain}" ` +
      `-c:v libx264 -crf 15 -preset fast -an ` +
      `"${outputPath}"`;

    console.log('[Compose] Applying text overlays (MP4 only)...');
    await execAsync(cmd);

    const s3Key = `text-overlaid-mp4s/${timestamp}.mp4`;
    const s3Url = await uploadToS3(outputPath, s3Key);
    console.log(`[Compose] Done: ${s3Url}`);
    return s3Url;
  } finally {
    for (const f of tempFiles) {
      if (fs.existsSync(f)) {
        try { fs.unlinkSync(f); } catch (_) { /* ignore */ }
      }
    }
  }
}

module.exports = { applyTextOverlay, applyTextAndConvertToGif };
