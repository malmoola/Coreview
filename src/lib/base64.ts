/** Base64 of a UTF-8 string. Plain btoa throws on anything non-ASCII. */
export function utf8ToBase64(text: string): string {
  return bytesToBase64(new TextEncoder().encode(text));
}

/** Base64 of raw bytes, chunked so a large PNG does not blow the argument limit. */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** The other direction of utf8ToBase64 — decodes back to the original text. */
export function base64ToUtf8(b64: string): string {
  const binary = atob(b64);
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}
