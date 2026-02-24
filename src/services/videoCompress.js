/**
 * Video Compression Service
 * Downloads and compresses video for faster Remotion rendering
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

function readIntegerEnv(name, fallback, { min, max } = {}) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || raw.trim() === '') {
    return fallback;
  }

  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) {
    console.warn(`[MP4toGIF] Invalid ${name}="${raw}". Using fallback ${fallback}.`);
    return fallback;
  }

  if (min !== undefined && parsed < min) {
    console.warn(`[MP4toGIF] ${name} must be >= ${min}. Using fallback ${fallback}.`);
    return fallback;
  }

  if (max !== undefined && parsed > max) {
    console.warn(`[MP4toGIF] ${name} must be <= ${max}. Using fallback ${fallback}.`);
    return fallback;
  }

  return parsed;
}

function normalizeGifProfileName(value) {
  if (!value || typeof value !== 'string') {
    return 'optimized';
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === 'legacy') {
    return 'legacy';
  }
  if (normalized === 'optimized') {
    return 'optimized';
  }

  console.warn(`[MP4toGIF] Unknown GIF profile "${value}". Falling back to optimized.`);
  return 'optimized';
}

function resolveGifProfile(profileName) {
  const selectedProfile = normalizeGifProfileName(profileName);

  if (selectedProfile === 'legacy') {
    return {
      name: 'legacy',
      fps: 10,
      width: null,
      maxColors: 256,
      bayerScale: 3,
    };
  }

  return {
    name: 'optimized',
    fps: readIntegerEnv('GIF_FPS', 8, { min: 4, max: 20 }),
    width: readIntegerEnv('GIF_WIDTH', 360, { min: 180, max: 1080 }),
    maxColors: readIntegerEnv('GIF_MAX_COLORS', 96, { min: 16, max: 256 }),
    bayerScale: readIntegerEnv('GIF_BAYER_SCALE', 2, { min: 0, max: 5 }),
  };
}

function buildGifFilter(profile) {
  const preSplit = [];

  if (profile.width) {
    preSplit.push(`scale=${profile.width}:-1:flags=lanczos`);
  }

  preSplit.push(`fps=${profile.fps}`);

  return (
    `${preSplit.join(',')},` +
    `split[s0][s1];` +
    `[s0]palettegen=stats_mode=diff:max_colors=${profile.maxColors}[p];` +
    `[s1][p]paletteuse=dither=bayer:bayer_scale=${profile.bayerScale}`
  );
}

function formatMegabytes(bytes) {
  return (bytes / 1024 / 1024).toFixed(2);
}

/**
 * Download file from URL
 */
function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    const client = url.startsWith('https') ? https : http;

    client.get(url, (response) => {
      if (response.statusCode === 302 || response.statusCode === 301) {
        // Follow redirect
        downloadFile(response.headers.location, destPath)
          .then(resolve)
          .catch(reject);
        return;
      }

      response.pipe(file);
      file.on('finish', () => {
        file.close();
        resolve();
      });
    }).on('error', (err) => {
      fs.unlink(destPath, () => {});
      reject(err);
    });
  });
}

/**
 * Compress video using ffmpeg
 * @param {string} inputPath - Path to input video
 * @param {string} outputPath - Path to output video
 * @param {Object} options - Compression options
 */
async function compressVideo(inputPath, outputPath, options = {}) {
  const {
    width = 480,        // Reduce to 480p
    crf = 28,           // Quality (higher = smaller, 23-28 is good)
    fps = 15,           // Reduce framerate
  } = options;

  // ffmpeg command: resize, reduce fps, compress
  const cmd = `ffmpeg -y -i "${inputPath}" -vf "scale=${width}:-2,fps=${fps}" -c:v libx264 -crf ${crf} -preset fast -an "${outputPath}"`;

  console.log('[VideoCompress] Running ffmpeg...');
  await execAsync(cmd);
  console.log('[VideoCompress] Compression complete');
}

/**
 * Upload file to S3
 */
async function uploadToS3(filePath, key, contentType = 'video/mp4') {
  const bucketName = 'remotionlambda-useast1-1fylxi4xgh'; // Same bucket as Remotion

  const fileContent = fs.readFileSync(filePath);

  await s3Client.send(new PutObjectCommand({
    Bucket: bucketName,
    Key: key,
    Body: fileContent,
    ContentType: contentType,
  }));

  return `https://${bucketName}.s3.us-east-1.amazonaws.com/${key}`;
}

/**
 * Download, compress, and upload video
 * @param {string} videoUrl - URL of the video to compress
 * @returns {Promise<string>} - URL of compressed video on S3
 */
async function compressAndUpload(videoUrl) {
  const tmpDir = '/tmp';
  const timestamp = Date.now();
  const inputPath = path.join(tmpDir, `input-${timestamp}.mp4`);
  const outputPath = path.join(tmpDir, `compressed-${timestamp}.mp4`);

  try {
    console.log('[VideoCompress] Downloading video...');
    await downloadFile(videoUrl, inputPath);

    const inputSize = fs.statSync(inputPath).size;
    console.log(`[VideoCompress] Input size: ${(inputSize / 1024 / 1024).toFixed(2)} MB`);

    await compressVideo(inputPath, outputPath);

    const outputSize = fs.statSync(outputPath).size;
    console.log(`[VideoCompress] Output size: ${(outputSize / 1024 / 1024).toFixed(2)} MB`);
    console.log(`[VideoCompress] Reduction: ${((1 - outputSize/inputSize) * 100).toFixed(0)}%`);

    console.log('[VideoCompress] Uploading to S3...');
    const s3Key = `compressed-videos/${timestamp}.mp4`;
    const s3Url = await uploadToS3(outputPath, s3Key);
    console.log(`[VideoCompress] Uploaded: ${s3Url}`);

    // Cleanup temp files
    fs.unlinkSync(inputPath);
    fs.unlinkSync(outputPath);

    return s3Url;
  } catch (error) {
    // Cleanup on error
    if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
    if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
    throw error;
  }
}

/**
 * Upload base64 image to S3
 * @param {string} base64Data - Base64 encoded image (with or without data URI prefix)
 * @returns {Promise<string>} - S3 URL of uploaded image
 */
async function uploadBase64ImageToS3(base64Data) {
  const bucketName = 'remotionlambda-useast1-1fylxi4xgh';
  const timestamp = Date.now();
  const key = `original-photos/${timestamp}.jpg`;

  // Remove data URI prefix if present
  const base64Clean = base64Data.replace(/^data:image\/\w+;base64,/, '');
  const buffer = Buffer.from(base64Clean, 'base64');

  console.log(`[S3Upload] Uploading original photo (${(buffer.length / 1024).toFixed(1)} KB)...`);

  await s3Client.send(new PutObjectCommand({
    Bucket: bucketName,
    Key: key,
    Body: buffer,
    ContentType: 'image/jpeg',
  }));

  const s3Url = `https://${bucketName}.s3.us-east-1.amazonaws.com/${key}`;
  console.log(`[S3Upload] Uploaded: ${s3Url}`);

  return s3Url;
}

/**
 * Convert local MP4 file to GIF with a selectable profile.
 * @param {Object} options
 * @param {string} options.inputPath - Local path to MP4 input
 * @param {string} options.outputPath - Local path for GIF output
 * @param {string} [options.profileName] - "legacy" or "optimized"
 * @returns {Promise<{outputSize: number, elapsedMs: number, profile: Object}>}
 */
async function convertLocalMp4ToGif({ inputPath, outputPath, profileName }) {
  const profile = resolveGifProfile(profileName || process.env.GIF_OUTPUT_PROFILE || 'optimized');
  const filter = buildGifFilter(profile);
  const startedAt = Date.now();

  const cmd =
    `ffmpeg -y -i "${inputPath}" ` +
    `-vf "${filter}" ` +
    `-gifflags -offsetting ` +
    `"${outputPath}"`;

  console.log(
    `[MP4toGIF] Converting with profile=${profile.name} ` +
      `(${profile.width || 'source'}px, ${profile.fps}fps, ${profile.maxColors} colors)...`
  );

  await execAsync(cmd);

  const elapsedMs = Date.now() - startedAt;
  const outputSize = fs.statSync(outputPath).size;
  console.log(`[MP4toGIF] GIF size: ${formatMegabytes(outputSize)} MB`);
  console.log(`[MP4toGIF] Conversion time: ${(elapsedMs / 1000).toFixed(2)}s`);

  return {
    outputSize,
    elapsedMs,
    profile,
  };
}

/**
 * Convert MP4 to GIF using FFmpeg two-pass palettegen
 * @param {string} mp4Url - URL of the MP4 to convert
 * @param {Object} [options]
 * @param {string} [options.profileName] - "legacy" or "optimized"
 * @returns {Promise<string>} - S3 URL of the generated GIF
 */
async function convertMp4ToGif(mp4Url, options = {}) {
  const tmpDir = '/tmp';
  const timestamp = Date.now();
  const inputPath = path.join(tmpDir, `gif-input-${timestamp}.mp4`);
  const outputPath = path.join(tmpDir, `output-${timestamp}.gif`);
  const { profileName } = options;

  try {
    console.log('[MP4toGIF] Downloading MP4...');
    await downloadFile(mp4Url, inputPath);

    const inputSize = fs.statSync(inputPath).size;
    console.log(`[MP4toGIF] Input size: ${formatMegabytes(inputSize)} MB`);

    const { outputSize, profile } = await convertLocalMp4ToGif({
      inputPath,
      outputPath,
      profileName,
    });
    console.log(`[MP4toGIF] Reduction vs input: ${((1 - outputSize / inputSize) * 100).toFixed(0)}%`);
    console.log(`[MP4toGIF] Active profile: ${profile.name}`);

    console.log('[MP4toGIF] Uploading GIF to S3...');
    const s3Key = `generated-gifs/${timestamp}.gif`;
    const s3Url = await uploadToS3(outputPath, s3Key, 'image/gif');
    console.log(`[MP4toGIF] Uploaded: ${s3Url}`);

    fs.unlinkSync(inputPath);
    fs.unlinkSync(outputPath);

    return s3Url;
  } catch (error) {
    if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
    if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
    throw error;
  }
}

/**
 * Concatenate two MP4s using FFmpeg stream copy (no re-encoding)
 * @param {string} url1 - URL of the first MP4
 * @param {string} url2 - URL of the second MP4
 * @returns {Promise<string>} - S3 URL of the concatenated MP4
 */
async function concatMp4s(url1, url2) {
  const tmpDir = '/tmp';
  const timestamp = Date.now();
  const part1Path = path.join(tmpDir, `concat-part1-${timestamp}.mp4`);
  const part2Path = path.join(tmpDir, `concat-part2-${timestamp}.mp4`);
  const listPath = path.join(tmpDir, `concat-list-${timestamp}.txt`);
  const outputPath = path.join(tmpDir, `concat-output-${timestamp}.mp4`);

  try {
    console.log('[ConcatMP4] Downloading parts...');
    await Promise.all([
      downloadFile(url1, part1Path),
      downloadFile(url2, part2Path),
    ]);

    // Create concat demuxer list
    fs.writeFileSync(listPath, `file '${part1Path}'\nfile '${part2Path}'\n`);

    // Stream copy — no re-encoding, nearly instant
    const cmd = `ffmpeg -y -f concat -safe 0 -i "${listPath}" -c copy "${outputPath}"`;
    console.log('[ConcatMP4] Concatenating with FFmpeg (stream copy)...');
    await execAsync(cmd);

    const outputSize = fs.statSync(outputPath).size;
    console.log(`[ConcatMP4] Output size: ${(outputSize / 1024 / 1024).toFixed(2)} MB`);

    console.log('[ConcatMP4] Uploading to S3...');
    const s3Key = `rendered-mp4s/${timestamp}.mp4`;
    const s3Url = await uploadToS3(outputPath, s3Key);
    console.log(`[ConcatMP4] Uploaded: ${s3Url}`);

    // Cleanup
    fs.unlinkSync(part1Path);
    fs.unlinkSync(part2Path);
    fs.unlinkSync(listPath);
    fs.unlinkSync(outputPath);

    return s3Url;
  } catch (error) {
    for (const f of [part1Path, part2Path, listPath, outputPath]) {
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
    throw error;
  }
}

module.exports = {
  resolveGifProfile,
  buildGifFilter,
  compressAndUpload,
  convertMp4ToGif,
  uploadBase64ImageToS3,
  concatMp4s,
};
