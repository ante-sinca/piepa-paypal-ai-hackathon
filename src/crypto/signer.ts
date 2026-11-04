import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import type { EnvelopePayload, SignedEnvelope } from "../contracts/envelope.js";
import { canonicalJson, sha256Base64Url } from "./canonical-json.js";

export function signEnvelope(payload: EnvelopePayload, privateKeyPem: string, keyId: string): SignedEnvelope {
  const canonicalPayload = canonicalJson(payload);
  const signature = sign(null, Buffer.from(canonicalPayload, "utf8"), createPrivateKey(privateKeyPem));
  return {
    payload,
    signature: {
      algorithm: "Ed25519",
      keyId,
      payloadDigest: sha256Base64Url(canonicalPayload),
      signature: signature.toString("base64url"),
    },
  };
}

export function verifyEnvelope(signed: SignedEnvelope, publicKeyPem: string): boolean {
  if (signed.signature.algorithm !== "Ed25519") return false;
  const canonicalPayload = canonicalJson(signed.payload);
  if (sha256Base64Url(canonicalPayload) !== signed.signature.payloadDigest) return false;
  return verify(
    null,
    Buffer.from(canonicalPayload, "utf8"),
    createPublicKey(publicKeyPem),
    Buffer.from(signed.signature.signature, "base64url"),
  );
}
