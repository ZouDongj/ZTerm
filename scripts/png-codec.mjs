import { inflateSync } from 'node:zlib';

// This decoder is the existing native PNG comparison decoder extracted for reuse
// by the self-test's captured-image cell probe.
export function pngDecode(data) {
  const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (!bytes.subarray(0, 8).equals(signature)) throw new Error('PNG signature missing');
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idat = [];
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    const chunk = bytes.subarray(offset + 8, offset + 8 + length);
    offset += 12 + length;
    if (type === 'IHDR') {
      width = chunk.readUInt32BE(0);
      height = chunk.readUInt32BE(4);
      bitDepth = chunk[8];
      colorType = chunk[9];
      if (bitDepth !== 8) throw new Error(`Unsupported PNG bit depth ${bitDepth}`);
    } else if (type === 'IDAT') idat.push(chunk);
    else if (type === 'IEND') break;
  }
  if (!width || !height || idat.length === 0) throw new Error('Incomplete PNG');
  const channelsByType = { 0: 1, 2: 3, 4: 2, 6: 4 };
  const channels = channelsByType[colorType];
  if (!channels) throw new Error(`Unsupported PNG color type ${colorType}`);
  const rowBytes = width * channels;
  const filtered = inflateSync(Buffer.concat(idat));
  const expectedLength = height * (rowBytes + 1);
  if (filtered.length < expectedLength) throw new Error(`PNG scanline data truncated (${filtered.length}/${expectedLength})`);
  const raw = Buffer.alloc(height * rowBytes);
  let sourceOffset = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = filtered[sourceOffset++];
    const rowStart = y * rowBytes;
    for (let x = 0; x < rowBytes; x += 1) {
      const value = filtered[sourceOffset++];
      const left = x >= channels ? raw[rowStart + x - channels] : 0;
      const above = y > 0 ? raw[rowStart - rowBytes + x] : 0;
      const upperLeft = y > 0 && x >= channels ? raw[rowStart - rowBytes + x - channels] : 0;
      let reconstructed;
      if (filter === 0) reconstructed = value;
      else if (filter === 1) reconstructed = value + left;
      else if (filter === 2) reconstructed = value + above;
      else if (filter === 3) reconstructed = value + Math.floor((left + above) / 2);
      else if (filter === 4) {
        const predictor = left + above - upperLeft;
        const pa = Math.abs(predictor - left);
        const pb = Math.abs(predictor - above);
        const pc = Math.abs(predictor - upperLeft);
        reconstructed = value + (pa <= pb && pa <= pc ? left : pb <= pc ? above : upperLeft);
      } else throw new Error(`Unsupported PNG filter ${filter}`);
      raw[rowStart + x] = reconstructed & 0xff;
    }
  }
  const rgba = Buffer.alloc(width * height * 4);
  for (let index = 0; index < width * height; index += 1) {
    const source = index * channels;
    const target = index * 4;
    if (colorType === 6) raw.copy(rgba, target, source, source + 4);
    else if (colorType === 2) {
      rgba[target] = raw[source];
      rgba[target + 1] = raw[source + 1];
      rgba[target + 2] = raw[source + 2];
      rgba[target + 3] = 255;
    } else if (colorType === 4) {
      rgba[target] = raw[source];
      rgba[target + 1] = raw[source];
      rgba[target + 2] = raw[source];
      rgba[target + 3] = raw[source + 1];
    } else {
      rgba[target] = raw[source];
      rgba[target + 1] = raw[source];
      rgba[target + 2] = raw[source];
      rgba[target + 3] = 255;
    }
  }
  return { width, height, rgba };
}
