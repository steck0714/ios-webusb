// The bridge reports failures as "KindError: detail". This is the union of the
// prefixes used by fox-webusb, pyside6-webusb and tauri-webusb (same seven entries).
export const KNOWN_ERROR_PREFIXES = [
  'SecurityError',
  'InvalidStateError',
  'NotFoundError',
  'InvalidAccessError',
  'IndexSizeError',
  'DataError',
  'NotSupportedError',
] as const;

/** Turn a transport/bridge failure into the DOMException a real WebUSB would throw. */
export function throwFromRpcError(err: unknown, defaultName: string = 'NetworkError'): never {
  const message = err instanceof Error ? err.message : String(err);
  for (const prefix of KNOWN_ERROR_PREFIXES) {
    if (message.startsWith(prefix + ': ')) {
      throw new DOMException(message.slice(prefix.length + 2), prefix);
    }
  }
  throw new DOMException(message, defaultName);
}
