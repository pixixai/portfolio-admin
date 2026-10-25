import { imageDimensions } from '../renderer/scripts/content.mjs';
import { fail } from './validation.mjs';

export function inspectMedia(bytes, name, hint = '') {
  try {
    const dimensions = imageDimensions(bytes);
    if (!dimensions.width || !dimensions.height || dimensions.width > 60000 || dimensions.height > 120000 || dimensions.width * dimensions.height > 150000000) fail('图片尺寸过大或无效。');
    const extension = bytes.subarray(0, 4).toString() === 'RIFF' ? 'webp' : bytes[0] === 0x89 ? 'png' : bytes[0] === 0xff ? 'jpg' : 'gif';
    return { ...dimensions, extension, mime: { webp: 'image/webp', png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif' }[extension] };
  } catch (error) { if (error.status) throw error; }
  if (bytes.length < 16) fail('媒体文件不完整。');
  const head = bytes.subarray(0, 4096), ascii = head.toString('latin1');
  let mime, extension;
  if (head.toString('ascii', 0, 4) === 'RIFF' && head.toString('ascii', 8, 12) === 'WAVE') { mime = 'audio/wav'; extension = 'wav'; }
  else if (head.toString('ascii', 4, 8) === 'ftyp' && bytes.readUInt32BE(0) >= 16) {
    const audio = /\.m4a$/i.test(name) || /M4[AB] /.test(head.toString('ascii', 8, 32));
    mime = audio ? 'audio/mp4' : 'video/mp4'; extension = audio ? 'm4a' : 'mp4';
  } else if (head.toString('hex', 0, 4) === '1a45dfa3' && ascii.includes('webm')) { mime = hint === 'audio/webm' ? 'audio/webm' : 'video/webm'; extension = 'webm'; }
  else if (head.toString('ascii', 0, 4) === 'OggS') { mime = 'audio/ogg'; extension = 'ogg'; }
  else if (head.toString('ascii', 0, 3) === 'ID3' || head[0] === 0xff && (head[1] & 0xe0) === 0xe0 && (head[1] & 0x06) !== 0) { mime = 'audio/mpeg'; extension = 'mp3'; }
  else fail('支持图片、MP4 / WebM 视频、MP3 / WAV / OGG / M4A 音频。');
  return { width: 0, height: 0, mime, extension };
}
