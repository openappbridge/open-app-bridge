import { OabError } from "./errors.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const BASE64URL = /^[A-Za-z0-9_-]+$/u;
const P256_COORDINATE_LENGTH = 43;
const ANSWER_ALGORITHM = "ECDH-P256+HKDF-SHA256+A256GCM";
const KEY_DERIVATION_INFO = encoder.encode(
  "org.openapp.bridge detached-datachannel/1 answer",
);

function cryptoProvider(value) {
  const provider = value ?? globalThis.crypto;
  if (
    !provider?.subtle ||
    typeof provider.getRandomValues !== "function"
  ) {
    throw new OabError(
      "crypto_unavailable",
      "detached-datachannel/1 requires the Web Crypto API.",
    );
  }
  return provider;
}

function plainObject(value) {
  return Boolean(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.getPrototypeOf(value) === Object.prototype
  );
}

function unicodeScalarString(value) {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function canonicalValue(value, depth = 0) {
  if (depth > 32) {
    throw new OabError(
      "invalid_transcript",
      "The detached-channel transcript is nested too deeply.",
    );
  }
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (!unicodeScalarString(value)) {
      throw new OabError(
        "invalid_transcript",
        "Canonical detached JSON must contain Unicode scalar strings.",
      );
    }
    return value;
  }
  if (
    typeof value === "number" &&
    Number.isFinite(value) &&
    Number.isSafeInteger(value)
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => canonicalValue(item, depth + 1));
  }
  if (plainObject(value)) {
    const result = {};
    for (const key of Object.keys(value).sort()) {
      if (
        !key ||
        !unicodeScalarString(key) ||
        ["__proto__", "constructor", "prototype"].includes(key) ||
        typeof value[key] === "undefined"
      ) {
        throw new OabError(
          "invalid_transcript",
          "The detached-channel transcript is not canonical JSON.",
        );
      }
      Object.defineProperty(result, key, {
        value: canonicalValue(value[key], depth + 1),
        enumerable: true,
        configurable: false,
        writable: false,
      });
    }
    return result;
  }
  throw new OabError(
    "invalid_transcript",
    "The detached-channel transcript must contain JSON values only.",
  );
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalValue(value));
}

export function encodeBase64Url(bytesValue) {
  const bytes = bytesValue instanceof Uint8Array
    ? bytesValue
    : ArrayBuffer.isView(bytesValue)
      ? new Uint8Array(
          bytesValue.buffer,
          bytesValue.byteOffset,
          bytesValue.byteLength,
        )
      : new Uint8Array(bytesValue);
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  if (typeof globalThis.btoa === "function") {
    return globalThis.btoa(binary)
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replace(/=+$/u, "");
  }
  if (typeof Buffer !== "undefined") {
    return Buffer.from(bytes).toString("base64url");
  }
  throw new OabError(
    "base64_unavailable",
    "A base64url encoder is required.",
  );
}

export function decodeBase64Url(value, maximumBytes = 128 * 1024) {
  if (
    typeof value !== "string" ||
    !value ||
    !BASE64URL.test(value) ||
    value.length > Math.ceil((maximumBytes * 4) / 3) + 4
  ) {
    throw new OabError(
      "invalid_base64url",
      "The detached-channel value is not bounded unpadded base64url data.",
    );
  }
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  let bytes;
  try {
    if (typeof globalThis.atob === "function") {
      const binary = globalThis.atob(padded);
      bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    } else if (typeof Buffer !== "undefined") {
      bytes = new Uint8Array(Buffer.from(value, "base64url"));
    } else {
      throw new Error("No decoder is available.");
    }
  } catch (error) {
    throw new OabError(
      "invalid_base64url",
      "The detached-channel value could not be decoded.",
      { cause: error },
    );
  }
  if (bytes.byteLength > maximumBytes) {
    throw new OabError(
      "invalid_base64url",
      `The decoded value exceeds ${maximumBytes} bytes.`,
    );
  }
  if (encodeBase64Url(bytes) !== value) {
    throw new OabError(
      "invalid_base64url",
      "The detached-channel value is not canonical unpadded base64url data.",
    );
  }
  return bytes;
}

export function normalizeP256PublicJwk(value) {
  if (
    !plainObject(value) ||
    Object.keys(value).length !== 4 ||
    !["crv", "kty", "x", "y"].every((key) => Object.hasOwn(value, key)) ||
    value.kty !== "EC" ||
    value.crv !== "P-256" ||
    typeof value.x !== "string" ||
    typeof value.y !== "string" ||
    value.x.length !== P256_COORDINATE_LENGTH ||
    value.y.length !== P256_COORDINATE_LENGTH ||
    !BASE64URL.test(value.x) ||
    !BASE64URL.test(value.y)
  ) {
    throw new OabError(
      "invalid_detached_key",
      "The detached-channel public key must be a P-256 public JWK.",
    );
  }
  try {
    if (
      decodeBase64Url(value.x, 32).byteLength !== 32 ||
      decodeBase64Url(value.y, 32).byteLength !== 32
    ) {
      throw new Error("Unexpected P-256 coordinate length.");
    }
  } catch (error) {
    throw new OabError(
      "invalid_detached_key",
      "The detached-channel public key coordinates are not canonical.",
      { cause: error },
    );
  }
  return Object.freeze({ kty: "EC", crv: "P-256", x: value.x, y: value.y });
}

async function importPublicKey(jwk, cryptoRef) {
  const provider = cryptoProvider(cryptoRef);
  try {
    return await provider.subtle.importKey(
      "jwk",
      normalizeP256PublicJwk(jwk),
      { name: "ECDH", namedCurve: "P-256" },
      false,
      [],
    );
  } catch (error) {
    throw new OabError(
      "invalid_detached_key",
      "The detached-channel public key could not be imported.",
      { cause: error },
    );
  }
}

async function deriveAnswerKey({ privateKey, publicKey, salt, transcript, cryptoRef }) {
  const provider = cryptoProvider(cryptoRef);
  let shared;
  try {
    shared = await provider.subtle.deriveBits(
      { name: "ECDH", public: publicKey },
      privateKey,
      256,
    );
  } catch (error) {
    throw new OabError(
      "detached_key_agreement_failed",
      "The detached-channel key agreement failed.",
      { cause: error },
    );
  }
  const keyMaterial = await provider.subtle.importKey(
    "raw",
    shared,
    "HKDF",
    false,
    ["deriveKey"],
  );
  new Uint8Array(shared).fill(0);
  const transcriptDigest = await provider.subtle.digest(
    "SHA-256",
    encoder.encode(canonicalJson(transcript)),
  );
  const info = new Uint8Array(
    KEY_DERIVATION_INFO.byteLength + transcriptDigest.byteLength,
  );
  info.set(KEY_DERIVATION_INFO, 0);
  info.set(new Uint8Array(transcriptDigest), KEY_DERIVATION_INFO.byteLength);
  return provider.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt, info },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function sha256Base64Url(value, options = {}) {
  const provider = cryptoProvider(options.crypto);
  const bytes = typeof value === "string"
    ? encoder.encode(value)
    : value instanceof Uint8Array
      ? value
      : ArrayBuffer.isView(value)
        ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
        : new Uint8Array(value);
  const digest = await provider.subtle.digest("SHA-256", bytes);
  return encodeBase64Url(new Uint8Array(digest));
}

export async function createDetachedKeyPair(options = {}) {
  const provider = cryptoProvider(options.crypto);
  let keyPair;
  try {
    keyPair = await provider.subtle.generateKey(
      { name: "ECDH", namedCurve: "P-256" },
      false,
      ["deriveBits"],
    );
  } catch (error) {
    throw new OabError(
      "detached_key_generation_failed",
      "A detached-channel P-256 key pair could not be generated.",
      { cause: error },
    );
  }
  const exported = await provider.subtle.exportKey("jwk", keyPair.publicKey);
  // WebCrypto exports metadata such as `ext` and `key_ops`. Those fields are
  // local API metadata, not part of OAB's exact four-member wire JWK.
  const wirePublicKey = {
    kty: exported.kty,
    crv: exported.crv,
    x: exported.x,
    y: exported.y,
  };
  return Object.freeze({
    privateKey: keyPair.privateKey,
    publicKey: normalizeP256PublicJwk(wirePublicKey),
  });
}

export async function sealDetachedAnswer(answer, options = {}) {
  const provider = cryptoProvider(options.crypto);
  const transcript = canonicalValue(options.transcript);
  const senderPublicKey = await importPublicKey(
    options.senderPublicKey,
    provider,
  );
  const receiverKeys = await createDetachedKeyPair({ crypto: provider });
  const salt = new Uint8Array(16);
  const iv = new Uint8Array(12);
  provider.getRandomValues(salt);
  provider.getRandomValues(iv);
  const key = await deriveAnswerKey({
    privateKey: receiverKeys.privateKey,
    publicKey: senderPublicKey,
    salt,
    transcript,
    cryptoRef: provider,
  });
  const transcriptHash = await sha256Base64Url(
    canonicalJson({ transcript, answer }),
    { crypto: provider },
  );
  const plaintext = encoder.encode(canonicalJson({ answer, transcriptHash }));
  const additionalData = encoder.encode(canonicalJson(transcript));
  let ciphertext;
  try {
    ciphertext = await provider.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData, tagLength: 128 },
      key,
      plaintext,
    );
  } catch (error) {
    throw new OabError(
      "detached_answer_seal_failed",
      "The detached-channel answer could not be sealed.",
      { cause: error },
    );
  }
  return Object.freeze({
    algorithm: ANSWER_ALGORITHM,
    receiverPublicKey: receiverKeys.publicKey,
    salt: encodeBase64Url(salt),
    iv: encodeBase64Url(iv),
    ciphertext: encodeBase64Url(new Uint8Array(ciphertext)),
  });
}

export async function openDetachedAnswer(envelope, options = {}) {
  if (
    !plainObject(envelope) ||
    envelope.algorithm !== ANSWER_ALGORITHM ||
    typeof envelope.salt !== "string" ||
    typeof envelope.iv !== "string" ||
    typeof envelope.ciphertext !== "string"
  ) {
    throw new OabError(
      "invalid_detached_answer",
      "The detached-channel answer envelope is malformed.",
    );
  }
  const allowed = new Set([
    "algorithm",
    "receiverPublicKey",
    "salt",
    "iv",
    "ciphertext",
  ]);
  if (Object.keys(envelope).some((key) => !allowed.has(key))) {
    throw new OabError(
      "invalid_detached_answer",
      "The detached-channel answer envelope contains unknown fields.",
    );
  }
  const provider = cryptoProvider(options.crypto);
  const transcript = canonicalValue(options.transcript);
  const receiverPublicKey = await importPublicKey(
    envelope.receiverPublicKey,
    provider,
  );
  const salt = decodeBase64Url(envelope.salt, 16);
  const iv = decodeBase64Url(envelope.iv, 12);
  if (salt.byteLength !== 16 || iv.byteLength !== 12) {
    throw new OabError(
      "invalid_detached_answer",
      "The detached-channel answer has invalid cryptographic parameters.",
    );
  }
  const ciphertext = decodeBase64Url(envelope.ciphertext, 128 * 1024);
  const key = await deriveAnswerKey({
    privateKey: options.senderPrivateKey,
    publicKey: receiverPublicKey,
    salt,
    transcript,
    cryptoRef: provider,
  });
  let plaintext;
  try {
    plaintext = await provider.subtle.decrypt(
      {
        name: "AES-GCM",
        iv,
        additionalData: encoder.encode(canonicalJson(transcript)),
        tagLength: 128,
      },
      key,
      ciphertext,
    );
  } catch (error) {
    throw new OabError(
      "detached_answer_authentication_failed",
      "The detached-channel answer failed authentication.",
      { cause: error },
    );
  }
  let decoded;
  let plaintextText;
  try {
    plaintextText = decoder.decode(plaintext);
    decoded = JSON.parse(plaintextText);
  } catch (error) {
    throw new OabError(
      "invalid_detached_answer",
      "The detached-channel answer plaintext is invalid.",
      { cause: error },
    );
  }
  if (plaintextText !== canonicalJson(decoded)) {
    throw new OabError(
      "invalid_detached_answer",
      "The detached-channel answer plaintext is not canonical JSON.",
    );
  }
  if (
    !plainObject(decoded) ||
    Object.keys(decoded).length !== 2 ||
    !Object.hasOwn(decoded, "answer") ||
    typeof decoded.transcriptHash !== "string"
  ) {
    throw new OabError(
      "invalid_detached_answer",
      "The detached-channel answer plaintext is not canonical.",
    );
  }
  const expectedHash = await sha256Base64Url(
    canonicalJson({ transcript, answer: decoded.answer }),
    { crypto: provider },
  );
  if (decoded.transcriptHash !== expectedHash) {
    throw new OabError(
      "detached_transcript_mismatch",
      "The detached-channel answer does not match the offer transcript.",
    );
  }
  return decoded.answer;
}

export const DETACHED_ANSWER_ALGORITHM = ANSWER_ALGORITHM;
