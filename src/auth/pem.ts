// GitHub downloads App keys as PKCS#1 (-----BEGIN RSA PRIVATE KEY-----), but
// crypto.subtle.importKey supports only pkcs8/spki/raw/jwk — there is no "pkcs1".
// Feeding it PKCS#1 throws `DataError`. Measured against a real App key; see
// docs/spike-app-auth.md. A product cannot ask customers to run openssl, so we wrap
// the PKCS#1 body in the fixed PKCS#8 envelope. No key parsing is needed.

function derLength(n: number): number[] {
  if (n < 0x80) return [n];
  const bytes: number[] = [];
  let v = n;
  while (v > 0) { bytes.unshift(v & 0xff); v >>= 8; }
  return [0x80 | bytes.length, ...bytes];
}

function derWrap(tag: number, content: Uint8Array): Uint8Array<ArrayBuffer> {
  const len = derLength(content.length);
  const out = new Uint8Array(1 + len.length + content.length);
  out[0] = tag;
  out.set(len, 1);
  out.set(content, 1 + len.length);
  return out;
}

/** rsaEncryption AlgorithmIdentifier: SEQUENCE { OID 1.2.840.113549.1.1.1, NULL } */
const RSA_ALGORITHM_ID = new Uint8Array([
  0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86,
  0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00,
]);

export function pkcs1ToPkcs8(pkcs1: Uint8Array): Uint8Array<ArrayBuffer> {
  const version = new Uint8Array([0x02, 0x01, 0x00]); // INTEGER 0
  const privateKey = derWrap(0x04, pkcs1); // OCTET STRING
  const body = new Uint8Array(version.length + RSA_ALGORITHM_ID.length + privateKey.length);
  body.set(version, 0);
  body.set(RSA_ALGORITHM_ID, version.length);
  body.set(privateKey, version.length + RSA_ALGORITHM_ID.length);
  return derWrap(0x30, body); // SEQUENCE
}

/** Returns PKCS#8 DER regardless of whether the PEM was PKCS#1 or PKCS#8. */
export function pemToPkcs8Der(pem: string): Uint8Array<ArrayBuffer> {
  const isPkcs1 = /BEGIN RSA PRIVATE KEY/.test(pem);
  const hasArmour = /-----BEGIN [^-]+-----[\s\S]*-----END [^-]+-----/.test(pem);
  const body = pem.replace(/-----BEGIN [^-]+-----|-----END [^-]+-----/g, "").replace(/\s/g, "");
  if (!hasArmour || body.length === 0 || !/^[A-Za-z0-9+/=]+$/.test(body)) {
    throw new Error("not a PEM-encoded key");
  }
  const raw = atob(body);
  const der = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) der[i] = raw.charCodeAt(i);
  return isPkcs1 ? pkcs1ToPkcs8(der) : der;
}
