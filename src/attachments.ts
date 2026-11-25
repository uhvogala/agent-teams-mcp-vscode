import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { decode as decodeJpeg } from 'jpeg-js';
import { PNG } from 'pngjs';

export const maxAttachments = 3;
export const maxAttachmentBytes = 2 * 1024 * 1024;
export const maxAttachmentBase64 = 4 * Math.ceil(maxAttachmentBytes / 3);
const maxDimension = 2048;
const tooLarge = () => new Error('Each image attachment must be 2 MiB or smaller.');
const checkDimensions = (width: number, height: number) => {
  if (width > maxDimension || height > maxDimension) {
    throw new Error('Image attachments must be at most 2048 by 2048 pixels.');
  }
};

function decodeBase64(encoded: string, invalid: () => Error) {
  if (encoded.length > maxAttachmentBase64) throw tooLarge();
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.length > maxAttachmentBytes) throw tooLarge();
  if (bytes.toString('base64') !== encoded) throw invalid();
  return bytes;
}

function encodePng(png: PNG) {
  const clean = PNG.sync.write(png);
  if (clean.length > maxAttachmentBytes) throw tooLarge();
  return clean;
}

export function decodePngAttachment(encoded: string): Buffer {
  const invalid = () => new Error('Attachment is not a valid PNG image.');
  const bytes = decodeBase64(encoded, invalid);
  if (bytes.length < 33 || bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' ||
      bytes.readUInt32BE(8) !== 13 || bytes.toString('ascii', 12, 16) !== 'IHDR') {
    throw invalid();
  }
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (!width || !height) throw invalid();
  checkDimensions(width, height);
  // pngjs's interlaced sync decode does not bound inflated output.
  if (bytes[28] !== 0) throw new Error('Interlaced PNG attachments are not supported.');
  let png: PNG;
  try { png = PNG.sync.read(bytes); }
  catch { throw invalid(); }
  return encodePng(png);
}

export function decodeScreenshot(data: string, mimeType: string) {
  if (mimeType === 'image/png') return decodePngAttachment(data);
  const invalid = () => new Error('Screenshot is not a valid JPEG image.');
  const bytes = decodeBase64(data, invalid);
  if (mimeType !== 'image/jpeg' || bytes[0] !== 0xff || bytes[1] !== 0xd8) throw invalid();
  let decoded: ReturnType<typeof decodeJpeg>;
  try {
    decoded = decodeJpeg(bytes, { maxResolutionInMP: maxDimension ** 2 / 1e6, maxMemoryUsageInMB: 64, tolerantDecoding: false });
  } catch { throw invalid(); }
  checkDimensions(decoded.width, decoded.height);
  const png = new PNG({ width: decoded.width, height: decoded.height });
  png.data = decoded.data;
  return encodePng(png);
}

export async function readPickedPng(path: string) {
  const unavailable = () => new Error('Choose a regular PNG file, not a linked file.');
  const candidate = resolve(path);
  if (await realpath(candidate) !== candidate) throw unavailable();
  const before = await lstat(candidate);
  if (!before.isFile() || before.nlink !== 1) throw unavailable();
  const handle = await open(candidate, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || info.dev !== before.dev || info.ino !== before.ino ||
        await realpath(candidate) !== candidate) throw unavailable();
    if (info.size > maxAttachmentBytes) throw tooLarge();
    const buffer = Buffer.alloc(maxAttachmentBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    return decodePngAttachment(buffer.subarray(0, length).toString('base64'));
  } finally { await handle.close(); }
}
