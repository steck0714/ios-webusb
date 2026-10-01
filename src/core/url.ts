/** The bridge URL must be ws: or wss:. Returns the parsed URL or throws Error(message). */
export function parseBridgeUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error(`not a valid URL: ${value}`);
  }
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
    throw new Error(`the bridge URL must start with ws:// or wss:// (got ${url.protocol}//)`);
  }
  return url;
}
