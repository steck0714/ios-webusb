export function bufferSourceToUint8Array(source: unknown): Uint8Array {
  if (source instanceof ArrayBuffer) return new Uint8Array(source);
  if (ArrayBuffer.isView(source)) {
    return new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
  }
  throw new TypeError('data must be a BufferSource (ArrayBuffer or a typed array / DataView)');
}

export function bufferSourceToBase64(source: unknown): string {
  const bytes = bufferSourceToUint8Array(source);
  let binary = '';
  const chunk = 0x2000; // keep String.fromCharCode's argument count small
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function base64ToUint8Array(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
