// Robowski Studio - Browser-native zero-dependency ZIP reader
// Supports stored (compression method 0) and Deflate (compression method 8 via DecompressionStream)

export async function unzipStore(
  buffer: Uint8Array | ArrayBuffer
): Promise<Record<string, Uint8Array>> {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const result: Record<string, Uint8Array> = {};

  if (bytes.length < 22) return result;

  // Search backwards for End of Central Directory Record (0x06054b50)
  let eocdOffset = -1;
  const maxSearch = Math.min(bytes.length, 65557 + 22);
  for (let i = bytes.length - 22; i >= bytes.length - maxSearch; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }

  if (eocdOffset !== -1) {
    const totalEntries = view.getUint16(eocdOffset + 10, true);
    const cdirOffset = view.getUint32(eocdOffset + 16, true);

    let pos = cdirOffset;
    for (let i = 0; i < totalEntries && pos + 46 <= bytes.length; i++) {
      const sig = view.getUint32(pos, true);
      if (sig !== 0x02014b50) break;

      const compression = view.getUint16(pos + 10, true);
      const compSize = view.getUint32(pos + 20, true);
      const nameLen = view.getUint16(pos + 28, true);
      const extraLen = view.getUint16(pos + 30, true);
      const commentLen = view.getUint16(pos + 32, true);
      const localHeaderOffset = view.getUint32(pos + 42, true);

      const nameBytes = bytes.subarray(pos + 46, pos + 46 + nameLen);
      const fileName = new TextDecoder().decode(nameBytes);

      // Read from local file header
      if (localHeaderOffset + 30 <= bytes.length) {
        const localSig = view.getUint32(localHeaderOffset, true);
        if (localSig === 0x04034b50) {
          const locNameLen = view.getUint16(localHeaderOffset + 26, true);
          const locExtraLen = view.getUint16(localHeaderOffset + 28, true);
          const dataStart = localHeaderOffset + 30 + locNameLen + locExtraLen;
          const compressedData = bytes.subarray(dataStart, dataStart + compSize);

          if (compression === 0) {
            result[fileName] = compressedData;
          } else if (compression === 8) {
            try {
              result[fileName] = await decompressDeflateRaw(compressedData);
            } catch {
              result[fileName] = compressedData;
            }
          } else {
            result[fileName] = compressedData;
          }
        }
      }

      pos += 46 + nameLen + extraLen + commentLen;
    }
    return result;
  }

  // Fallback: sequential scan through local file headers
  return unzipSequential(bytes, view);
}

async function decompressDeflateRaw(compressed: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream !== 'undefined') {
    const ds = new DecompressionStream('deflate-raw');
    const writer = ds.writable.getWriter();
    writer.write(compressed as any);
    writer.close();
    const ab = await new Response(ds.readable).arrayBuffer();
    return new Uint8Array(ab);
  }
  return compressed;
}

async function unzipSequential(
  bytes: Uint8Array,
  view: DataView
): Promise<Record<string, Uint8Array>> {
  const result: Record<string, Uint8Array> = {};
  let pos = 0;
  while (pos + 30 <= bytes.length) {
    const sig = view.getUint32(pos, true);
    if (sig !== 0x04034b50) break;

    const compression = view.getUint16(pos + 8, true);
    const compSize = view.getUint32(pos + 18, true);
    const nameLen = view.getUint16(pos + 26, true);
    const extraLen = view.getUint16(pos + 28, true);

    const nameBytes = bytes.subarray(pos + 30, pos + 30 + nameLen);
    const fileName = new TextDecoder().decode(nameBytes);
    const dataStart = pos + 30 + nameLen + extraLen;
    const raw = bytes.subarray(dataStart, dataStart + compSize);

    if (compression === 0) {
      result[fileName] = raw;
    } else if (compression === 8) {
      try {
        result[fileName] = await decompressDeflateRaw(raw);
      } catch {
        result[fileName] = raw;
      }
    } else {
      result[fileName] = raw;
    }

    pos = dataStart + compSize;
  }
  return result;
}
