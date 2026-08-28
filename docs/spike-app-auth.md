# Spike: GitHub App installation tokens

Run against App ID `4755405`, installation `157364042` (`johnqh`).

## Result: works, with one correction to the plan

```
key format: PKCS#1 -> converted to PKCS#8
installations status: 200
token exchange status: 201   expires_at: 2026-08-28T23:32:38Z  (~1h)
permissions: actions=write administration=write contents=write metadata=read pull_requests=write
repo count: 6 — sudobility* mail_box_components design_system di_web building_blocks cr-spike-b*
manifest read johnqh/sudobility (private=true): status=200  bytes=3369  raw JSON
```

## 1. GitHub issues PKCS#1 keys; Web Crypto only accepts PKCS#8

The plan's original `pemToDer` fed the decoded PEM straight to
`crypto.subtle.importKey("pkcs8", ...)`. Against a real GitHub App key that throws:

```
DataError: Data provided to an operation does not meet requirements
```

because GitHub's downloaded key is **PKCS#1** — `-----BEGIN RSA PRIVATE KEY-----` — while
`importKey` supports only `pkcs8`, `spki`, `raw` and `jwk`. There is no `pkcs1`.

A product cannot ask every customer to run `openssl pkcs8 -topk8`, so the conversion happens
in-process. For RSA it is a fixed DER wrap — no parsing of the key material required:

```
PrivateKeyInfo ::= SEQUENCE {
  version            INTEGER 0,
  privateKeyAlgorithm SEQUENCE { OID 1.2.840.113549.1.1.1 (rsaEncryption), NULL },
  privateKey         OCTET STRING  -- the PKCS#1 RSAPrivateKey, verbatim
}
```

The AlgorithmIdentifier is the constant `30 0d 06 09 2a 86 48 86 f7 0d 01 01 01 05 00`.
Verified: wrapping the PKCS#1 bytes this way imports and signs successfully.

## 2. Private repositories are readable

`sudobility` is private and returned **200** with 3369 bytes. Installation permissions are granted
per repository regardless of visibility, so **the product does not need to restrict itself to public
repos**. This matters commercially: a company with 60 interdependent repos is overwhelmingly running
them private.

The measured private-repo limitation is a different one and unaffected by this: branch protection
*and* rulesets both 403 on a free-tier private repo, which is why the design pairs auto-merge with a
control-plane merge fallback.

## 3. Shapes Tasks 2 and 3 code against

- `accept: application/vnd.github.raw+json` on `/contents/package.json` returns **raw JSON**, not
  base64-in-JSON. No decode step needed.
- Installation tokens last ~1 hour and echo back their granted `permissions`, which is a cheap way to
  detect an under-permissioned installation before attempting a write.
- `/installation/repositories` returns `{ total_count, repositories[] }`; each entry carries
  `full_name`, `private` and `default_branch`. Paginate at `per_page=100`.
