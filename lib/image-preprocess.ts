import sharp from 'sharp';
import fs from 'fs';
import path from 'path';

export interface PreprocessOptions {
  enabled: boolean;
  targetMaxSide: number; // 1024 / 1536 / 2048
  jpegQuality: number;   // 70-95
}

export interface PreprocessResult {
  originalPath: string;
  processedPath: string;
  originalWidth: number;
  originalHeight: number;
  processedWidth: number;
  processedHeight: number;
  originalSizeBytes: number;
  processedSizeBytes: number;
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp';
}

const DEFAULT_OPTIONS: PreprocessOptions = {
  enabled: true,
  targetMaxSide: 1536,
  jpegQuality: 85,
};

/**
 * Preprocess an image: resize large images and convert to JPEG if no alpha.
 * The original is preserved; a processed copy is returned for API calls.
 */
export async function preprocessImage(
  inputPath: string,
  mimeType: string,
  outputDir: string,
  options: PreprocessOptions = DEFAULT_OPTIONS
): Promise<PreprocessResult> {
  const originalBuffer = fs.readFileSync(inputPath);
  const metadata = await sharp(originalBuffer).metadata();

  const originalWidth = metadata.width || 0;
  const originalHeight = metadata.height || 0;
  const originalSizeBytes = originalBuffer.length;
  const hasAlpha = metadata.hasAlpha ?? false;

  if (!options.enabled) {
    // Preprocessing disabled: return original as both
    return {
      originalPath: inputPath,
      processedPath: inputPath,
      originalWidth,
      originalHeight,
      processedWidth: originalWidth,
      processedHeight: originalHeight,
      originalSizeBytes,
      processedSizeBytes: originalSizeBytes,
      mimeType: mimeType as PreprocessResult['mimeType'],
    };
  }

  const longestSide = Math.max(originalWidth, originalHeight);
  let pipeline = sharp(originalBuffer);
  let resizeApplied = false;

  if (longestSide > options.targetMaxSide) {
    pipeline = pipeline.resize(options.targetMaxSide, options.targetMaxSide, {
      fit: 'inside',
      withoutEnlargement: true,
    });
    resizeApplied = true;
  }

  // Determine output format
  let outputMime: PreprocessResult['mimeType'];
  if (hasAlpha) {
    outputMime = 'image/png';
  } else {
    outputMime = 'image/jpeg';
  }
  pipeline = pipeline[outputMime === 'image/png' ? 'png' : 'jpeg']({
    quality: options.jpegQuality,
  });

  const processedBuffer = await pipeline.toBuffer();
  const processedMetadata = await sharp(processedBuffer).metadata();

  // Generate output filename
  const ext = outputMime === 'image/png' ? '.png' : '.jpg';
  const baseName = path.basename(inputPath, path.extname(inputPath));
  const outputFilename = `${baseName}_p${options.targetMaxSide}${ext}`;
  const processedPath = path.join(outputDir, outputFilename);

  // Ensure output dir exists
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  fs.writeFileSync(processedPath, processedBuffer);

  return {
    originalPath: inputPath,
    processedPath,
    originalWidth,
    originalHeight,
    processedWidth: processedMetadata.width || 0,
    processedHeight: processedMetadata.height || 0,
    originalSizeBytes,
    processedSizeBytes: processedBuffer.length,
    mimeType: outputMime,
  };
}

export { DEFAULT_OPTIONS };

/**
 * Contain-pad an image to a target size. The image is scaled to fit entirely
 * within the target dimensions, then centered and padded with white/transparent
 * bars to fill the remaining space. Preserves alpha channels.
 *
 * @param inputPath  - Path to the image to process.
 * @param outputPath - Where to save the result.
 * @param targetW    - Target width.
 * @param targetH    - Target height.
 * @param background - Padding color as CSS string (default: 'white').
 */
export async function containPadImage(
  inputPath: string,
  outputPath: string,
  targetW: number,
  targetH: number,
  background: string = 'white'
): Promise<void> {
  const inputBuffer = fs.readFileSync(inputPath);
  const metadata = await sharp(inputBuffer).metadata();
  const hasAlpha = metadata.hasAlpha ?? false;

  // Resize to fit within target, preserving aspect ratio
  const resized = await sharp(inputBuffer)
    .resize(targetW, targetH, { fit: 'inside', withoutEnlargement: true })
    .toBuffer();

  // Pad to exact target size, centered
  await sharp({
    create: {
      width: targetW,
      height: targetH,
      channels: hasAlpha ? 4 : 3,
      background: hasAlpha ? { r: 0, g: 0, b: 0, alpha: 0 } : background,
    },
  })
    .composite([{ input: resized, gravity: 'center' }])
    .png()
    .toFile(outputPath);
}

