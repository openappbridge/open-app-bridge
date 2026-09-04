# OAB Detached Data Channel Transport 1.0

**Transport identifier:** `detached-datachannel/1`

**Status:** Breaking draft for interoperability and security testing

## 1. Purpose and security goal

`detached-datachannel/1` transfers confidential text and binary assets
between a browser sender and a web receiver on the same user device. It uses
only existing browser primitives and requires no OAB registry, account,
signaling server, STUN server, TURN relay, browser extension, installed
receiver, or operating-system integration.

The defining property is that neither receiver page ever receives a
`WindowProxy` for the sender. Sender, receiver, helper, and callback are
opened or navigated with no opener relationship. Cross-origin navigation
authority is therefore absent by construction.

Signaling exists only in synchronously scrubbed URL fragments. Content does not
enter a URL or HTTP request. Content travels over an ordered DTLS-protected
WebRTC data channel after live authorization.

Version 1 supports browser senders. A native application that cannot execute a
top-level page on its claimed sender origin and participate in the same-origin
callback channel is not a detached-profile sender.

## 2. Discovery

A receiver opts in with:

```json
{
  "transports": {
    "detached-datachannel/1": {
      "receiverHelper": "/_oab/detached-helper",
      "representations": ["text/markdown", "text/html", "text/plain"],
      "assetTypes": ["image/png", "image/jpeg", "image/webp", "image/svg+xml"],
      "limits": {
        "maximumSignalingBytes": 32768,
        "maximumFrameBytes": 16384,
        "maximumTransferBytes": 16777216,
        "maximumAssets": 32
      }
    }
  }
}
```

Requirements:

| Member                         | Requirement                                                                                     |
| ------------------------------ | ----------------------------------------------------------------------------------------------- |
| `receiverHelper`               | Same-origin, query-free and fragment-free absolute path; resolved URL at most 2,048 UTF-8 bytes |
| `representations`              | Unique list of accepted MIME types; may be empty for an asset-only receiver                     |
| `assetTypes`                   | Unique list of accepted asset MIME types; may be empty                                          |
| `limits`                       | Exact object containing all four maximum values below                                           |
| `limits.maximumSignalingBytes` | Integer 1,024–32,768; bounds each complete ASCII bootstrap or callback fragment excluding `#`   |
| `limits.maximumFrameBytes`     | Integer 17–16,384; bounds each complete RTCDataChannel message                                  |
| `limits.maximumTransferBytes`  | Integer 1–33,554,432 (16,777,216 recommended default)                                           |
| `limits.maximumAssets`         | Integer 0–256                                                                                   |

At least one of `representations` or `assetTypes` MUST be non-empty.
`maximumAssets` MUST be zero exactly when `assetTypes` is empty.
`maximumFrameBytes` MUST NOT exceed `maximumTransferBytes`. The exact canonical
`capabilities` control frame for these values MUST fit `maximumFrameBytes`.
Because the whole transfer, not each item, is limited to 65,536 data frames,
`maximumTransferBytes` MUST NOT exceed
`(maximumFrameBytes - 16) × 65,536`. Per-item chunk rounding may lower the
largest frameable transfer, and the sender MUST validate the exact global frame
count for its prepared content before Send.

Every representation or asset MIME value is canonical lowercase ASCII
`type/subtype` without parameters. Each component is 1–127 characters and
begins with an ASCII letter or digit; later characters are letters, digits,
`!#$&^_.+-`. The complete value is therefore at most 255 characters.

The helper path is resolved against and MUST remain on the discovered receiver
origin. It MUST NOT contain any raw `%`, backslash, control, or `.`/`..`
traversal segment. The sender callback is not advertised by the receiver: it
is always the fixed sender-origin path:

```text
/.well-known/open-app-bridge/callback
```

Absence or invalidity of any required member disables this profile. A sender
also applies smaller local implementation limits.

The helper response MUST set `Referrer-Policy: origin`. This is a deliberate
exception to the no-referrer policy on other OAB routes. Its later top-level
navigation to the sender callback must produce a browser-controlled receiver
origin referrer.

## 3. Required browser capabilities

Both applications require secure-context implementations of:

- Web Crypto ECDH P-256, HKDF-SHA-256, SHA-256, and AES-256-GCM;
- `RTCPeerConnection` and ordered `RTCDataChannel`;
- `BroadcastChannel`;
- `history.replaceState()`;
- strict UTF-8, base64url, and bounded JSON processing; and
- cryptographically secure random generation.

The sender MUST host the fixed static callback resource on its exact origin.
No service worker, extension, or background process is required. If any
required primitive or fixed resource is unavailable, the profile is
unavailable and fails closed.

## 4. Cryptographic suite

Version 1 fixes this suite:

| Function                        | Algorithm                                   |
| ------------------------------- | ------------------------------------------- |
| Ephemeral agreement             | ECDH on NIST P-256                          |
| KDF                             | HKDF with SHA-256                           |
| Signaling encryption            | AES-GCM with a 256-bit key and 96-bit nonce |
| Digests                         | SHA-256                                     |
| Canonical transcript JSON       | JSON Canonicalization Scheme (RFC 8785)     |
| Data-plane encryption/integrity | Browser WebRTC DTLS/SCTP                    |

Every session creates new sender and receiver ECDH key pairs. Private keys are
non-extractable Web Crypto keys, remain in the creating page's volatile memory,
and every application reference to them is released on completion, failure,
timeout, or navigation. Web Crypto exposes no verifiable zeroization API;
physical memory reclamation remains a browser-runtime property and MUST NOT be
claimed as protocol-observed erasure.

Public keys are exact P-256 public JWK objects
`{kty:"EC",crv:"P-256",x,y}` with canonical unpadded base64url coordinates
and no private `d` member. Each coordinate decodes to exactly 32 bytes. Request
IDs provide at least 128 bits of entropy;
`channelId`, which names the sender/callback rendezvous, contains 32 random
bytes. For its main/helper rendezvous, the receiver creates a separate
`helperRequestId` with at least 128 bits of entropy and a 32-byte
`helperChannelId` capability.
AES-GCM IVs contain 12 random bytes and MUST NOT be reused with a derived key.

Every value described as canonical JSON in this profile uses the OAB canonical
JSON subset: an RFC 8785 JCS serialization containing only null, booleans,
strings, arrays, objects with unique non-empty member names, and safe integers.
Floating-point and non-finite numbers are forbidden. Implementations MUST
produce the exact UTF-8 JCS bytes and reject a decoded value whose input bytes
differ from that serialization.

Every unpadded base64url value uses the RFC 4648 URL-safe alphabet with no
`=`. Decoding MUST consume the whole string, and re-encoding the decoded bytes
without padding MUST produce the identical string. Non-canonical pad bits and
impossible encoded lengths are invalid.

## 5. Browser-generated signaling

Implementations MUST use exact browser-generated session descriptions. They
MUST NOT reconstruct SDP from templates or implement an independent full SDP
parser.

The sender:

1. creates `RTCPeerConnection({iceServers: []})`;
2. creates exactly one ordered data channel labeled `oab-1`;
3. calls `createOffer()` and retains that candidate-free returned SDP;
4. applies it with `setLocalDescription()`; and
5. collects candidate events separately.

The receiver performs the corresponding candidate-free `createAnswer()`
sequence only after the receiver user's **Review shared content** action.

Before any remote description is given to the browser, an implementation MUST
apply bounded structural checks:

- UTF-8 byte length at most 65,536 and always small enough to keep the complete
  signaling fragment within the stricter 32,768-byte profile limit;
- at most 512 non-empty lines and at most 4,096 UTF-8 bytes per line;
- only printable ASCII plus tab and CRLF or LF line endings;
- exactly one `m=application` section;
- no `m=audio`, `m=video`, or other media section;
- exactly one SHA-256 DTLS fingerprint;
- required ICE username/password and SCTP port attributes;
- no `a=candidate` lines; and
- no duplicate security-critical SDP attributes.

These checks reject obviously unsafe structure; the browser remains the SDP
parser. An exception or browser-normalized result inconsistent with exactly one
data channel terminates the session. Both peers MUST confirm that no media
track, receiver, sender, or transceiver was created.

The pre-browser structural grammar is exact:

| Element              | Requirement                                                                                                    |
| -------------------- | -------------------------------------------------------------------------------------------------------------- |
| Description object   | Exactly `{type, sdp}`; `type` is the phase-expected `offer` or `answer`                                        |
| First non-empty line | Exactly `v=0`                                                                                                  |
| Lines                | 1–512; LF or CRLF; each at most 4,096 UTF-8 bytes; tab or printable ASCII only                                 |
| Media sections       | Exactly one `m=` line and it begins `m=application `                                                           |
| ICE username         | Exactly one line matching `a=ice-ufrag:[A-Za-z0-9+/]{4,256}`                                                   |
| ICE password         | Exactly one line matching `a=ice-pwd:[A-Za-z0-9+/]{22,256}`                                                    |
| Fingerprint          | Exactly one fingerprint line; algorithm exactly `sha-256`; 32 colon-separated hex octets                       |
| SCTP                 | Exactly one line beginning `a=sctp-port:` or `a=sctpmap:`                                                      |
| MID                  | Exactly one `a=mid:` line with 1–64 non-whitespace characters                                                  |
| DTLS setup           | Exactly one `a=setup:actpass`, `active`, or `passive` line                                                     |
| Forbidden            | Every `a=candidate`, `a=end-of-candidates`, second critical attribute, and every non-application media section |

This lexical gate deliberately does not define or normalize the rest of SDP.
Only the browser may decide whether the complete browser-generated description
is syntactically/semantically valid. Implementations MUST compare the browser's
resulting connection shape with the single-channel/no-media postconditions.

## 6. Candidate policy

ICE candidates travel as a unique list of 1–32 separately bounded
`RTCIceCandidateInit` records. Each record is an exact object containing
`candidate`, `sdpMid`, `sdpMLineIndex`, and `usernameFragment`.
`candidate` is at most 2,048 UTF-8 bytes with no newline or NUL; `sdpMid` is at
most 64 characters; `sdpMLineIndex` is exactly zero; and `usernameFragment` is
either null or 4–256 valid ICE credential characters. A candidate is parsed
through the browser's `RTCIceCandidate` implementation before use.

Version 1 accepts only:

- candidate type `host`;
- no related address or related port;
- no STUN/TURN URL;
- either an mDNS hostname ending in `.local` or the exact loopback address
  `127.0.0.1` or `::1`; and
- component ID exactly `1`, a valid unsigned 32-bit ICE priority, a valid
  `udp` or `tcp` protocol/port combination, and `sdpMid`/`sdpMLineIndex` for
  the sole application section.

`srflx`, `prflx`, `relay`, every other raw IPv4/IPv6 address (including
RFC 1918, link-local, public, and other `127.0.0.0/8` values), malformed,
excessive, or unexpected candidates are rejected. A peer MUST NOT configure STUN, TURN,
or an ICE relay and MUST NOT send a candidate merely because the browser
generated it.

Candidate collection continues until the browser emits the end-of-candidates
marker or reaches ICE gathering state `complete`. If gathering completes with
no eligible candidate, the implementation MUST fail immediately with
`detached_ice_no_eligible_candidate`; it MUST NOT wait for the later connection
timeout or silently weaken this policy. Exact loopback candidates improve
same-device compatibility without disclosing interface topology. They do not
make the profile a general VPN, private-LAN, or cross-device transport, and a
browser is not required to emit one.

This policy intentionally sacrifices availability on browsers or networks that
cannot establish the constrained direct channel with privacy-preserving host
candidates. It MUST NOT be weakened automatically.

The candidate policy is a reachability constraint, not physical-device
attestation. A conforming sender uses only the browser-local callback and
BroadcastChannel rendezvous defined here, but a malicious sender origin can
add out-of-protocol signaling and relay an answer to another browser that can
reach the mDNS host candidate, including a same-LAN peer. Receivers MUST NOT
display "same device verified" or make authorization decisions from an assumed
device boundary. The verified fact is the sender origin's participation in the
authenticated transcript and live encrypted channel.

## 7. Phase A: sender bootstrap

Before the user's Send action, the browser sender:

1. completes fresh discovery and selects this profile;
2. creates a fresh `requestId`, 32-byte `channelId`, and ephemeral sender
   ECDH key pair;
3. creates the candidate-free RTC offer and safe candidate list;
4. prepares the exact random sender-origin rendezvous named by `requestId` and
   `channelId`;
5. constructs the bootstrap object below;
6. verifies the complete encoded signaling fragment fits the receiver's
   `maximumSignalingBytes`; and
7. prepares the exact receiver endpoint link.

The sender arms the corresponding `BroadcastChannel` synchronously inside the
fresh Send activation, before the anchor's native navigation proceeds. It does
not open the channel from page load or a background task, and it does not wait
for asynchronous work before allowing that navigation.

Bootstrap JSON:

```json
{
  "protocol": "org.openapp.bridge",
  "wireVersion": "1.0",
  "transport": "detached-datachannel/1",
  "transportVersion": "1",
  "requestId": "base64url-random-value",
  "channelId": "base64url-32-random-bytes",
  "createdAt": 1787911200000,
  "expiresAt": 1787911320000,
  "declarationId": "optional-current-public-value",
  "senderOrigin": "https://sender.example",
  "receiverOrigin": "https://receiver.example",
  "receiverHelper": "https://receiver.example/_oab/detached-helper",
  "senderPublicKey": {
    "kty": "EC",
    "crv": "P-256",
    "x": "base64url-coordinate",
    "y": "base64url-coordinate"
  },
  "description": {
    "type": "offer",
    "sdp": "browser-generated-candidate-free-sdp"
  },
  "candidates": [
    {
      "candidate": "candidate:...",
      "sdpMid": "0",
      "sdpMLineIndex": 0,
      "usernameFragment": "..."
    }
  ]
}
```

Unknown or duplicate members are invalid. `createdAt` and `expiresAt` are
non-negative safe-integer Unix epoch milliseconds, with `expiresAt` strictly
after `createdAt`. The maximum lifetime is five minutes; implementations
SHOULD use two minutes. A receiver permits at most 30 seconds of future clock
skew and accepts only while `createdAt - 30,000 <= now < expiresAt`.
The receiving browser's local clock is the sole time source for this check.
An HTTP `Date` header is server-controlled metadata and MUST NOT calibrate or
override it. A future timestamp fails as `detached_signal_from_future`; a
validly formed timestamp at or beyond expiry fails as
`detached_signal_expired`.
`senderOrigin` MUST equal the canonical secure origin of the sender page.
`receiverOrigin` and `receiverHelper` MUST equal current discovery. The
callback path is fixed and MUST NOT appear in the bootstrap. No title, source
claim, MIME type, size, content/manifest digest, body, or asset metadata is
permitted.

`requestId` is 22–128 canonical unpadded base64url characters encoding at
least 128 bits of fresh entropy. `channelId` is exactly 32 fresh random bytes encoded as
43 unpadded base64url characters. `declarationId` is the current public
declaration value, or JSON `null` when discovery omitted it. It is
freshness/configuration binding, not authentication. `transportVersion` is
exactly `1`.

The launch URL is:

```text
<receiver-endpoint>#oab-detached=1&payload=<base64url-jcs-offer>&digest=<base64url-sha256>
```

The raw ASCII fragment MUST match the displayed fixed-order grammar exactly.
Reordered, duplicate, or unknown parameters, percent-encoding, `+`,
whitespace, empty values, base64 padding, and any other spelling are invalid;
a conforming parser does not run form/query decoding over the fragment. The
digest is SHA-256 of the exact JCS offer bytes and detects corruption only.
The browser sender opens the receiver as a
new top-level context using a prepared native anchor with `target="_blank"`,
`rel="noopener noreferrer"`, and `referrerpolicy="no-referrer"`. The fresh
trusted activation itself MUST perform the native navigation. Imperative
`window.open()`, scripted anchor activation, and any launch that retains
`window.opener` are forbidden.

The prepared capability MUST be bound to exactly one native anchor. Binding
removes `download`, `ping`, and attribution-reporting attributes. Activation
MUST verify the bound anchor identity plus exact absolute `href`, `_blank`,
`noopener noreferrer`, and `no-referrer` values, then prevent later listeners
in that dispatch from mutating them before default navigation. A missing,
misbound, or modified anchor fails closed and is consumed.

At activation the sender rechecks that the offer and discovery declaration are
current, that the handoff is still in its single-use ready state, and that
`now < expiresAt`. Any invalid, modified, synthetic, reused, closed, or expired
activation synchronously calls `preventDefault()`, disables/removes the launch
`href`, and enters an absorbing non-launch state. Throwing an exception alone
does not cancel native navigation. A scheduled offer expiry disables/removes
the `href` and closes its volatile session even without activation; delayed
browser timers do not replace the activation-time check.

After accepted Send activation, the sender controller immediately invalidates
its retained offer URL and prepared launch capability. The activated DOM
anchor, its `href` and security attributes, and its containing Document MUST
remain intact through dispatch and the following microtask checkpoint. The
integration crosses at least one event-loop task boundary before it removes,
disables, replaces, or unmounts that anchor, closes or rebuilds its host, or
emits any externally observable launch-indication callback/event. A Promise
continuation or `queueMicrotask()` is insufficient. This
gives native default navigation an opportunity to commit without making that
local timing event receiver or delivery evidence. No success, rejection,
expiry, close, or failure path leaves a reusable controller capability.

## 8. Phase B: receiver capture and one-click helper

On load, the receiver main page:

1. synchronously copies its raw fragment and pre-scrub origin, path, and query
   into bounded volatile memory, then scrubs to the clean query-free,
   fragment-free path before other work;
2. confirms it is a secure top-level context with `window.opener === null`;
3. requires the copied origin and path to equal the exact discovered receiver
   endpoint, rejects a copied query, and requires a non-redirecting deployment;
4. rejects it immediately if the raw fragment exceeds
   `maximumSignalingBytes`; and
5. decodes and structurally validates the bounded bootstrap, current
   declaration, claimed sender/receiver origins, candidate-free SDP text, and
   candidate records in volatile memory.

The main page is the core restricted receiver Document from marked entry
through terminal cleanup and clean transition. Scrubbing does not permit it to
start analytics, authentication/account UI, document sync, remote fonts/CDN
renderers, third-party resources, speculative loads, or application service
workers. Its complete transitive packaged resource graph and every worker
historically capable of controlling any request in it MUST satisfy the core
network-authority and migration requirements. Main, helper, callback, bootstrap,
module, stylesheet, and other dependency requests receive no service-worker
fetch-event handling; pass-through `respondWith(fetch(event.request))` remains
non-conformant interception.

A fetch listener that recognizes an OAB route and merely returns without
calling `respondWith()` still receives and can observe that request. It does
not establish the no-fetch-event invariant. Deployments MUST instead use a
worker generation whose applicable fetch handler is absent, or a fresh origin,
as specified by the core migration rules.

The receiver helper and fixed sender callback are restricted OAB utility
Documents under core Section 7.1 for their complete lifetimes. Scrubbing does
not convert either into an ordinary application page.

Before fresh receiver-user activation it MUST NOT import an ECDH key, create a
peer connection, call `setRemoteDescription()`, add a candidate, or invoke
another browser RTC parser. Sender origin is displayed as **unverified pending
verification**. The receiver MUST identify itself as an application page and
say that the displayed sender origin is a claim that will be checked. Any
authorization decision is conditional until the callback and live
transcript-bound channel verify that exact origin.

The receiver creates an independent 22–128-character canonical unpadded
base64url `helperRequestId` encoding at least 128 bits of entropy and an exact
32-byte `helperChannelId`, represented by 43 canonical unpadded base64url
characters. It opens a
same-origin receiver channel named by those values and prepares a native anchor
containing only this bounded helper envelope:

```text
<receiverHelper>#oab-detached-helper=1&payload=<base64url-jcs-helper-envelope>
```

```json
{
  "protocol": "org.openapp.bridge",
  "transport": "detached-datachannel/1",
  "helperRequestId": "base64url-random-request-id",
  "helperChannelId": "base64url-32-random-bytes",
  "receiverOrigin": "https://receiver.example",
  "receiverHelper": "https://receiver.example/_oab/detached-helper"
}
```

The helper fragment excluding `#` MUST fit 4,096 ASCII bytes. The envelope is
encoded as OAB canonical JSON and then base64url encoded. It contains no
original offer IDs or sender claim, and has no digest because the high-entropy
channel values provide the same-origin rendezvous capability. The link uses
`target="_blank"`, `rel="noopener noreferrer"`, and a no-referrer policy.
The helper fragment also uses the exact displayed raw ASCII order. It rejects
reordered, duplicate, or unknown parameters, percent-encoding, `+`,
whitespace, an empty payload, padding, and every non-base64url character.

Its visible action is **Review shared content**. The receiver main page opens:

```text
oab:detached:receiver:<helperRequestId>:<helperChannelId>
```

The receiver MUST require a trusted, unmodified, primary activation with active
browser user activation. In that click handler it records the conditional,
request-bound preview authorization, commits the already prepared single-use
rendezvous to that activation, permits the native anchor navigation, and begins
the authorized cryptographic and RTC work. Work may
continue asynchronously after the transient browser activation ends; the
recorded decision remains conditional on callback and live-channel
verification.

The helper capability uses the same exact one-anchor binding, unsafe-attribute
removal, activation-time identity/attribute validation, and scheduled DOM
`href` cleanup as the sender launch. These checks are not delegated to sample
application code.

Before allowing that navigation, the receiver rechecks the current declaration,
offer expiry, single-use state, and trusted event. A rejected activation MUST
synchronously call `preventDefault()`, disable/remove the helper `href`, close
the prepared rendezvous, and enter an absorbing terminal state.

After an accepted preview-authorization activation, the receiver invalidates its retained
helper URL and prepared capability immediately. The helper DOM anchor and its
containing Document remain unchanged through dispatch and its microtask
checkpoint. The integration crosses at least one event-loop task boundary
before it removes, disables, replaces, or unmounts that anchor, closes or
rebuilds its host, or emits any externally observable launch-indication
callback/event. Every activation outcome consumes or destroys the controller
capability without cancelling accepted native default navigation.

The top-level helper:

1. synchronously copies its small fragment and pre-scrub location evidence,
   then scrubs to the clean query-free, fragment-free path;
2. verifies its origin, secure top-level status, and `opener === null`;
3. validates the exact helper envelope and copied current helper endpoint and
   rejects a copied query;
4. opens the matching same-origin BroadcastChannel;
5. repeatedly announces the exact bounded message below until a valid
   navigation instruction or terminal timeout; and
6. waits at most 30 seconds for one exact callback-navigation instruction.

These requirements apply from document entry. A deferred/module-only helper
that renders or completes module-graph evaluation before capture is
non-conforming. A parser-blocking, same-origin classic scrub bootstrap MAY keep
the copied evidence in a private closure, scrub synchronously, and then pass
that copy to the helper module for exact origin/path/query/size revalidation.

```json
{
  "type": "helper-ready",
  "requestId": "<helperRequestId>",
  "channelId": "<helperChannelId>"
}
```

The receiver main MUST observe a matching ready message within 15 seconds.
Unknown, malformed, excessive, or mismatched messages are ignored and do not
extend either deadline.

After the click, the receiver main imports the sender key, creates the peer
connection, applies the already structurally checked offer/candidates, then
generates its ephemeral ECDH key, answer, and safe candidates. It sends a
callback instruction only when both that work and an exact matching
`helper-ready` have completed. Any failure closes the local channel and all
session state; the helper reaches its own terminal timeout without navigating.

This helper design uses one receiver-user click. The native anchor reliably
creates a top-level helper without exposing a window reference to either
origin; the helper's later self-navigation does not require another click.

The helper is a restricted minimal page. It uses only packaged, origin-local
protocol resources and the required local rendezvous plus fixed
self-navigation. It MUST NOT initialize analytics, crash/usage telemetry,
advertising/tag managers, authentication/account UI, document sync, remote
fonts, CDN resources, third-party code/media, speculative loads, or application
service workers. Its response policy is:

```http
Cache-Control: no-store
Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'
Cross-Origin-Opener-Policy: same-origin
Referrer-Policy: origin
X-Content-Type-Options: nosniff
```

The helper MUST visibly identify the receiver application by a local product
name or packaged mark and explain in ordinary language that it is preparing the
requested preview. It is a utility state, not another consent surface. If
automatic callback navigation is unavailable, it MUST expose a same-tab native
link to the exact already-validated callback URL. That link MUST preserve the
origin-only referrer required below and MUST NOT open another context or ask
for another approval.
The SDK's bounded fallback timer is a best-effort usability threshold, not a
latency SLA, timeout for channel establishment, receipt, or evidence that
navigation committed. The reference default is 1,500 ms and the allowed range
is 250–5,000 ms.

The `origin` referrer is required only for the helper's self-navigation to the
fixed callback. The initial main-receiver-to-helper anchor remains
`noreferrer`.

## 9. Phase C: answer encryption and callback

The receiver computes `offerDigest` as unpadded base64url SHA-256 of the exact
OAB canonical JSON bytes of
`{"description": <validated-description>, "candidates": <validated-list>}`.

The transcript associated data is JCS of:

```json
{
  "protocol": "org.openapp.bridge",
  "wireVersion": "1.0",
  "transport": "detached-datachannel/1",
  "transportVersion": "1",
  "requestId": "...",
  "channelId": "...",
  "createdAt": 1787911200000,
  "expiresAt": 1787911320000,
  "senderOrigin": "https://sender.example",
  "receiverOrigin": "https://receiver.example",
  "receiverHelper": "https://receiver.example/_oab/detached-helper",
  "callbackPath": "/.well-known/open-app-bridge/callback",
  "declarationId": "optional-current-public-value",
  "senderPublicKey": {"kty": "EC", "crv": "P-256", "x": "...", "y": "..."},
  "offerDigest": "..."
}
```

Both peers derive:

```text
sharedSecret = ECDH(localPrivateKey, remotePublicKey)
salt = random 16 bytes carried in the sealed-answer envelope
info = UTF8("org.openapp.bridge detached-datachannel/1 answer")
       || SHA-256(JCS(transcript))
answerKey = HKDF-SHA-256(sharedSecret, salt, info, 32)
```

`||` is byte concatenation: `info` is the 84 exact bytes formed by the
52-byte ASCII/UTF-8 label followed immediately by the 32-byte transcript
digest. AES-GCM uses a 128-bit authentication tag; the `ciphertext` member is
the canonical base64url encoding of ciphertext followed by that tag, as
returned by Web Crypto.

The semantic answer is this exact object:

```json
{
  "description": {"type": "answer", "sdp": "candidate-free-sdp"},
  "candidates": [
    {
      "candidate": "candidate:...",
      "sdpMid": "0",
      "sdpMLineIndex": 0,
      "usernameFragment": "..."
    }
  ]
}
```

The receiver computes `transcriptHash` as unpadded base64url SHA-256 of the OAB
canonical JSON object `{"transcript": <transcript>, "answer": <answer>}`. The
sealed plaintext is the exact OAB canonical JSON object:

```json
{
  "answer": {
    "description": {"type": "answer", "sdp": "candidate-free-sdp"},
    "candidates": [
      {
        "candidate": "candidate:...",
        "sdpMid": "0",
        "sdpMLineIndex": 0,
        "usernameFragment": "..."
      }
    ]
  },
  "transcriptHash": "base64url-sha256"
}
```

`transcriptAAD` is the exact UTF-8 OAB canonical JSON serialization of the
transcript. The receiver encrypts the sealed plaintext with AES-256-GCM using
those bytes as additional authenticated data.

The exact sealed-answer envelope is:

```json
{
  "algorithm": "ECDH-P256+HKDF-SHA256+A256GCM",
  "receiverPublicKey": {
    "kty": "EC",
    "crv": "P-256",
    "x": "base64url-coordinate",
    "y": "base64url-coordinate"
  },
  "salt": "base64url-16-bytes",
  "iv": "base64url-12-bytes",
  "ciphertext": "base64url-ciphertext-and-gcm-tag"
}
```

The receiver main first constructs the exact fixed callback URL containing the
sealed wrapper below. It then sends the helper exactly one bounded local
message:

```json
{
  "type": "navigate-callback",
  "requestId": "<helperRequestId>",
  "channelId": "<helperChannelId>",
  "senderOrigin": "https://sender.example",
  "href": "https://sender.example/.well-known/open-app-bridge/callback#..."
}
```

The helper validates the exact message shape, its helper IDs, canonical sender
origin, fixed callback path, absent query, active session lifetime, and byte
bounds. It treats the fragment as opaque and MUST NOT receive a private key or
plaintext answer. Every helper BroadcastChannel message is at most 65,536
UTF-8 bytes in OAB canonical JSON form. The helper processes at most one valid
navigation message. It closes its BroadcastChannel and uses
`location.replace()` to navigate the `href`, whose fragment decodes to:

```json
{
  "protocol": "org.openapp.bridge",
  "transport": "detached-datachannel/1",
  "type": "sealed-answer",
  "requestId": "...",
  "channelId": "...",
  "receiverOrigin": "https://receiver.example",
  "envelope": {
    "algorithm": "ECDH-P256+HKDF-SHA256+A256GCM",
    "receiverPublicKey": {"kty": "EC", "crv": "P-256", "x": "...", "y": "..."},
    "salt": "...",
    "iv": "...",
    "ciphertext": "..."
  }
}
```

That wrapper is JCS/base64url encoded and navigated as:

```text
https://sender.example/.well-known/open-app-bridge/callback#oab-detached-answer=1&payload=<base64url-jcs-wrapper>&digest=<base64url-sha256>
```

The example is line-wrapped only; the real URL contains no whitespace. The
complete callback fragment MUST fit `maximumSignalingBytes`. The fragment is
not sent in the callback HTTP request. Its raw ASCII spelling and parameter
order are exact; reordered, duplicate, or unknown parameters,
percent-encoding, `+`, whitespace, empty values, padding, and alternative
spellings are invalid.

## 10. Sender callback contract

The fixed callback is a minimal static resource. It MUST:

1. synchronously copy `document.referrer`, the raw fragment, and pre-scrub
   origin, path, and query into bounded volatile values;
2. synchronously scrub to the clean query-free, fragment-free callback path
   before validation, decoding, awaiting, rendering, logging, or opening a
   channel;
3. verify it is a top-level secure context with `opener === null`;
4. require the copied origin and path to be the expected sender origin and
   `/.well-known/open-app-bridge/callback`, reject a copied query, and
   require a non-redirecting deployment;
5. canonicalize the copied referrer to an origin and fail closed with
   `detached_receiver_referrer_missing` when it is empty, stripped, or
   malformed;
6. match the fixed raw ASCII grammar directly and reject reordered,
   duplicate, or unknown parameters, percent-encoding, `+`, whitespace, empty
   values, invalid base64url, padding, or a fragment over 32,768 bytes;
7. require the canonical referrer origin to equal the parsed callback
   envelope's exact receiver origin, otherwise failing with
   `detached_receiver_origin_mismatch`;
8. open only
   `oab:detached:sender:<requestId>:<channelId>`;
9. broadcast the exact opaque outer envelope once;
10. clear all local state; and
11. attempt to close, or display a content-free “Connection established; this
   tab may be closed” page. Script closure is best effort; browser refusal to
   close is not a protocol failure and changes no delivery/disposition state.

For its complete lifetime, the callback MUST NOT contain or create a form,
text field, password field, payment control, account chooser, credential
request, `contenteditable` region, or unrelated navigation. It MUST NOT imitate
browser chrome, an operating-system dialog, an authentication screen, a
security warning, or another product. Its only protocol actions are the
one-use local relay described above and best-effort closure. If it remains
visible, its origin-controlled presentation may identify the sender product
and show only a calm, content-free settlement or failure state telling the user
to return to the original application. Branding and localization are allowed;
interactive authentication, payment, and recovery flows are not.

These restrictions define conforming sender behavior. A receiver cannot force
an independently controlled or compromised sender origin to render an honest
callback. Receiver authorization UI therefore MUST disclose, before the one
user decision, that a temporary page at the canonical sender origin may appear
and that receiving content never requires credentials or payment. This is an
informational warning inside the single preview-authorization surface, not a
second prompt.

The complete normative utility-page behavior is defined by
[`docs/utility-page-lifecycle.md`](../../docs/utility-page-lifecycle.md).

The callback's capture includes `document.referrer` and MUST happen at document
entry. A deferred/module-only callback is non-conforming if parsing, CSS,
rendering, another script, or module-graph evaluation occurs first. A tiny
parser-blocking same-origin bootstrap MAY scrub first and pass a closure-local
copy to the callback module; it MUST clear that copy after one adoption and
MUST NOT expose it through `window`, DOM, storage, logs, or network requests.

It MUST NOT decrypt, parse SDP, fetch a URL supplied in the fragment, write
storage, register or communicate with a service worker, initialize
authentication/account UI or document sync, load remote fonts, CDN resources,
third-party code/media, or speculative resources, run analytics or telemetry,
or send the envelope to a server.

Recommended response policy:

```http
Cache-Control: no-store
Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'
Cross-Origin-Opener-Policy: same-origin
Referrer-Policy: no-referrer
X-Content-Type-Options: nosniff
```

The sender receives the outer envelope only from its random same-origin
BroadcastChannel. It validates request/channel IDs, expiry, receiver origin and
key, recomputes the transcript, derives `answerKey`, verifies AES-GCM, validates
the plaintext and answer structure, and verifies `transcriptHash` before it
applies the remote answer and safe candidates. A callback injection,
modification, replay, or transcript mismatch cannot produce a valid GCM tag and
terminates the session.

The callback's referrer check is browser-observed receiver-origin evidence that
the answer navigation was initiated from a top-level page served by the stated
receiver origin. It is not cryptographic attestation. The sender separately
binds that origin cryptographically to the originally selected receiver and
MUST NOT accept referrer alone as sufficient transcript authentication.

## 11. Phase D: channel establishment

The channel MUST be:

- labeled `oab-1`;
- ordered;
- reliable, with no partial-reliability option;
- binary type `arraybuffer`; and
- the sole RTC data channel for the peer connection.

Connection, ICE, DTLS, or channel setup exceeding 30 seconds terminates the
session. Both peers close the RTC connection, channels, keys, and transient
state on failure.

Both peers monitor `datachannel` events through terminal cleanup. The sender
rejects every remotely created channel. The receiver accepts only the single
expected `oab-1` channel and rejects every additional channel, including one
created after the expected channel opened. Closing only the unexpected channel
is insufficient; an extra channel makes the whole peer connection fatal.

The authenticated signaling transcript and successfully opened DTLS channel
bind this connection to the callback-verified sender origin. No redundant
`hello` is sent. The receiver's first frame is `capabilities`, no broader
than discovery.

## 12. Framing

Every data-channel message is a binary OAB frame bounded by the smaller live
`capabilities.maximumFrameBytes`, whose protocol hard maximum is 16,384 bytes.
All multi-byte integers use network byte order:

```text
offset  size  field
0       2     magic: ASCII "OA" (0x4f41)
2       1     frame version: 1
3       1     frame type
4       2     unsigned item index
6       4     unsigned sequence
10      4     unsigned total frame count
14      2     unsigned payload byte length
16      N     payload
```

The declared payload length MUST equal `N`; the complete frame MUST not exceed
the negotiated limit, so `N` MUST NOT exceed `maximumFrameBytes - 16`. There
may be at most 65,536 data frames. The type mapping is fixed:

| Value | Name           | Direction         |
| ----: | -------------- | ----------------- |
|     1 | `capabilities` | receiver → sender |
|     2 | `manifest`     | sender → receiver |
|     3 | `grant`        | receiver → sender |
|     4 | `data`         | sender → receiver |
|     5 | `complete`     | sender → receiver |
|     6 | `previewing`   | receiver → sender |
|     7 | `result`       | receiver → sender |
|     8 | `abort`        | either direction  |

Control frames use item index `0xffff`, sequence zero, and total frame count
one. Their payload is exact RFC 8785 JCS UTF-8 JSON with unique members. Data
frames use an item index from zero through `0xfffe`; their payload is raw
content and MUST NOT be empty.

Data sequence is global to the transfer, begins at zero, and is contiguous.
`total frame count` is the exact number of data frames in the transfer. Item
indexes refer to the ordered manifest and MUST be non-decreasing; bytes for one
item are contiguous before the next item begins. Duplicate, skipped,
out-of-order, excessive, or state-inappropriate frames terminate and erase the
session.

## 13. Control state machine

The only allowed successful order is:

```text
receiver user Review shared content
authenticated channel opens
  receiver -> capabilities
  sender   -> manifest
  receiver -> grant | abort
  sender   -> data (ordered, one or more)
  sender   -> complete
  receiver -> previewing | abort
  receiver -> result(preserved | discarded) | abort
close
```

The sender and receiver state machines are independent and fail closed:

| Sender state   | Accepted input/action                                         | Next state                 |
| -------------- | ------------------------------------------------------------- | -------------------------- |
| `offered`      | one authenticated sealed answer before offer expiry           | `connecting`               |
| `connecting`   | exact answer, candidates, and one open `oab-1` channel        | `connected`                |
| `connected`    | one local prepared transfer; one receiver `capabilities`      | `transferring`             |
| `transferring` | matching `grant`, then matching `previewing` after all frames | `previewing`               |
| `previewing`   | one matching `result`                                         | `preserved` or `discarded` |

| Receiver/session state | Accepted input/action                                         | Next state                            |
| ---------------------- | ------------------------------------------------------------- | ------------------------------------- |
| `setting-up`           | validated offer after Verify; generate sealed answer          | `answer-ready`                        |
| `answer-ready`         | exactly one open `oab-1` channel                              | `connected`                           |
| `authorizing-sender`   | local authorization and successful `capabilities` send        | `awaiting-manifest`                   |
| `awaiting-manifest`    | one valid `manifest`                                          | `authorizing-manifest`                |
| `authorizing-manifest` | aggregate byte lease, local decision, allocation, and `grant` | `receiving`                           |
| `receiving`            | contiguous data then exact `complete`                         | `presenting-preview`                  |
| `presenting-preview`   | inert local preview callback and successful acknowledgement   | `previewing`                          |
| `previewing`           | local Discard or transactional Preserve                       | `discarded` or `preserving`           |
| `preserving`           | bounded atomic commit, or abort plus bounded rollback         | `preserved`, `discarded`, or `failed` |

`preserved`, `discarded`, `failed`, `expired`, `aborted`, and `closed` are
absorbing. Any frame not named for the current state, any repeated transition,
channel replacement, timeout, close/error, generation mismatch, or failed
local callback enters one terminal state, cancels timers/listeners, releases
session and byte leases, wipes transient buffers, and closes the channel. The
only exception is best-effort delivery of the already-decided final result;
its failure never changes a local Preserved/Discarded decision.

The receiver invokes each asynchronous host-controlled authorization or
presentation callback with a second/final immutable context argument containing
an `AbortSignal`: `authorizeOrigin(evidence, {signal})`,
`authorizeVerifiedSender(evidence, {signal})`,
`authorizeManifest(manifest, manifestDigest, {signal,
previewAuthorization})`, and
`onPreview(delivery, {signal})`. Every receiver terminal transition MUST abort
that signal synchronously and MUST race callback settlement against lifecycle
invalidation. A conforming host MUST observe the signal, close or invalidate any
UI/work it created for the callback, and settle promptly. A callback resolution
or rejection after abort is ignored and MUST NOT re-arm the protocol, send a
frame, present content, or persist content. The host also drops its own
callback arguments, Promise fulfillment values, preview objects, and assets on
terminal settlement; ECMAScript cannot revoke copies that host code deliberately
retains.

The high-level receiver facade MUST create and own an opaque single-use preview
authorization after the one visible `authorizeOrigin` decision. Application
code MUST NOT create, store, mark consumed, or otherwise manage that capability.
The SDK binds it to the request ID, receiver declaration ID and origin, sender
origin, `detached-datachannel/1` transport, `preview` intent, exact live
capability ceilings, an enforced absolute expiry, and the current lifecycle
generation. The SDK consumes it automatically at the one manifest authorization
boundary and invalidates it on mismatch, reuse, expiry, or any terminal state.

After consumption, `authorizeManifest` additionally receives frozen
`previewAuthorization` evidence describing that binding. This evidence is not
a bearer capability and cannot authorize a second manifest. The callback is a
silent local narrowing gate and MUST NOT display a second copy of the preview
authorization. Low-level `receiveDetachedTransfer()` integrations that bypass
the facade must reproduce and demonstrate the same one-use binding contract.

`capabilities` is an exact object:

```json
{
  "representations": ["text/markdown", "text/plain"],
  "assetTypes": ["image/png"],
  "maximumTransferBytes": 16777216,
  "maximumAssets": 32,
  "maximumFrameBytes": 16384
}
```

These live values MUST be no broader than discovery. The capabilities frame
itself fits the discovered frame limit. Before revealing content metadata, the
sender compares every list and numeric maximum with the exact capabilities it
retained from fresh discovery. A low-level sender session MUST receive that
expected declaration snapshot; absence or a live value broader than the
snapshot is fatal. `maximumFrameBytes` applies to every later control and data
frame and cannot change during the transfer. Live
`representations` contains at most 16 unique MIME types; `assetTypes` contains
at most 64. At least one list is non-empty, and `maximumAssets` is zero exactly
when `assetTypes` is empty.

Representations are alternative encodings of one logical content item, not
separate documents. Receiver UI SHOULD group them as one item and choose the
safest supported rendition. Assets are companion attachments and MUST remain
visually associated with that item rather than inflating the apparent item
count.

`manifest` is an exact wrapper:

```json
{
  "manifest": {
    "protocol": "org.openapp.bridge",
    "transport": "detached-datachannel/1",
    "frameVersion": 1,
    "transferId": "fresh-random-transfer-id",
    "title": "Document title",
    "source": {
      "application": "Claimed sender application",
      "url": "https://sender.example/item"
    },
    "items": [
      {
        "index": 0,
        "kind": "representation",
        "mimeType": "text/markdown",
        "name": null,
        "bytes": 1024,
        "sha256": "base64url-sha256"
      }
    ],
    "totalBytes": 1024
  },
  "manifestDigest": "base64url-sha256-of-jcs-manifest"
}
```

The manifest contains no body. Representation items have unique MIME types and
`name: null`. Asset items use `kind: "asset"` and a receiver-safe unique
name. Indexes are canonical consecutive integers starting at zero. The
manifest has 1–272 items: at most 16 representations and no more assets than
the live `maximumAssets` value, whose hard maximum is 256. Every item has a
positive exact byte length and unpadded base64url SHA-256. `totalBytes` equals
their sum and does not exceed live `maximumTransferBytes`. `transferId` is a
fresh 22–128-character canonical unpadded base64url value encoding at least
128 bits of entropy. Source and title remain untrusted claims.

`title` is null or canonical NFC-normalized single-line display text of at most
240 Unicode scalar values. `source` is exact: `application` is null or the same
kind of text limited to 120 scalars, and `url` is null or a credential-free
HTTPS URL of at most 2,048 characters with no query or fragment. Asset names
are NFC-normalized, path-free display names of at most 240 scalars; `.`, `..`,
slashes, backslashes, controls, and bidirectional override/isolate characters
are forbidden. Names are unique within the transfer. Browser-trusted loopback
HTTP source claims are permitted only in development.

Asset-name uniqueness is an exact wire-string comparison. Names remain
untrusted display metadata: a Preserve adapter revalidates them for its target
platform, resolves reserved-name and case-collision rules, and never treats
them as paths or silently overwrites an existing file.

The receiver checks the manifest digest, live capabilities, hard limits, and
local product policy. The signaling offer made no content commitment. It then
evaluates the exact manifest against the still-live request-bound preview
authorization and its declared content and size ceilings. This is an internal
policy gate, not a second user prompt. A receiver MUST NOT repeat the preview
authorization merely because the verified manifest is now available. A new
prompt is permitted only when the manifest materially exceeds the scope shown
and authorized before launch; otherwise the receiver denies it. Only after a
positive gate does it send the one-time wire grant:

```json
{
  "transferId": "...",
  "manifestDigest": "..."
}
```

as `grant`. The grant is valid only in this exact channel state and exactly
once. The sender MUST NOT send a data frame before validating it.

After all data frames, `complete` is:

```json
{
  "transferId": "...",
  "manifestDigest": "...",
  "totalFrames": 17,
  "completionDigest": "base64url-sha256"
}
```

`completionDigest` is unpadded base64url SHA-256 of the OAB canonical JSON
object `{"transferId": ..., "manifestDigest": ..., "itemDigests": [...],
"totalFrames": ...}`, where `itemDigests` contains each manifest item
`sha256` value in increasing index order. The receiver independently verifies
exact item sizes, item digests, frame count, total bytes, manifest digest, and
completion digest.

Only after complete validation and construction of an isolated transient
preview does the receiver send:

```json
{"transferId": "...", "status": "previewing"}
```

as `previewing`. This is not persistence. After explicit Preserve or Discard,
the receiver sends exactly:

```json
{"transferId": "...", "disposition": "preserved"}
```

or `discarded` as `result`. An `abort` is exactly `{"reason": <code>}`, where
`code` is exactly one of `expired`, `integrity_failure`, `internal_error`,
`policy_denied`, `protocol_error`, `receiver_cancelled`, `resource_limit`,
`sender_cancelled`, `unavailable`, or `user_rejected`. Unknown values are a
protocol error. An abort MUST NOT echo content, metadata, SDP, candidates,
origins, policy explanations, exception messages, or key material.

The receiver incrementally counts bytes and enforces item/transfer limits into
bounded transient storage. Before preview it computes and verifies every item
digest, decodes every representation as strict UTF-8, and rejects U+0000 NUL.
Implementations MAY hash incrementally where their cryptographic API supports
it, but streaming hashing is not a version 1 requirement. The receiver rejects
overrun before allocation and erases every item on a single mismatch.

The sender observes `RTCDataChannel.bufferedAmount`, sets bounded high/low
water marks, and pauses until the low-water event after crossing the high-water
mark. Implementations MUST yield to the event loop during long transfers and
MUST NOT enqueue the entire document at once.

## 14. Persistence and cleanup

Authorization, grant, complete transfer, and preview do not authorize durable
storage. Until Preserve, received content remains only in volatile bounded
runtime memory. Planned cleanup does not make a durable facility transient:
IndexedDB, local storage, Cache Storage, OPFS or ordinary files, download
staging, service-worker queues, and server writes are forbidden before
Preserve.

On Preserve, the application supplies the protocol controller with a
pre-registered transaction containing both `commit(context)` and idempotent
`rollback(context)`. The context contains the transient delivery, a mandatory
abort signal, the same absolute user-visible disposition deadline, and a fresh
SDK-generated `transactionId`. The durable key is receiver-generated; a sender
`requestId` or `transferId` MUST NOT be used as an overwrite-capable storage
key. Commit MUST atomically stage/add a record under `transactionId`, honor
abort, and settle after abort. Rollback MUST remove that record whether commit
did not start, partially ran, or fully committed. Both operations MUST be
idempotent and MUST settle within the receiver's configured cleanup interval,
whose hard maximum is 15 seconds.

The controller enters `preserving` before invoking commit. If commit settles
successfully strictly before the deadline and the abort signal is not set, the
receiver enters the absorbing `preserved` state and cancels the disposition
deadline before attempting the best-effort `result: preserved` send. A direct
or uncoordinated `complete(preserved)` operation is forbidden.
Backpressure, channel failure, or a lost result MUST NOT roll an already
committed Preserve back to Discard. On Discard, the receiver enters the
absorbing `discarded` state, erases all transient bytes, cancels the deadline,
and best-effort sends `result: discarded`. A lost result never changes either
local disposition.

An unconnected offer expires no later than five minutes after creation; the
normal lifetime is two minutes. From authenticated channel connection through
the `previewing` frame, the hard deadline is ten minutes. A receiver SHOULD
default to the smaller two-minute connected-to-preview deadline, while the
sender independently enforces the ten-minute hard ceiling.

A preview awaiting Preserve or Discard MUST have a receiver-controlled,
user-visible disposition deadline. The reference default is 15 minutes and the
hard maximum is 60 minutes. Expiry is a Discard outcome: the receiver erases
the transient delivery, sends `result: discarded` when the channel remains
available, and closes the session. The expiry callback MUST NOT convert a
Preserve operation that already entered `preserved` after successful atomic
commit into Discard. If expiry or another terminal event races an in-progress
commit, the controller aborts it, waits for it to settle, invokes rollback,
and records Discard only after rollback succeeds. A rollback failure is a
terminal indeterminate-persistence error and MUST NOT be labelled Discard.
If commit ignores cancellation or commit/rollback fails to settle within the
hard cleanup interval, the controller terminates with
`preserve_commit_unresponsive` or `preserve_rollback_failed`, wipes transient
bytes, and reports neither Preserved nor Discarded. It schedules another
idempotent rollback if the non-conforming commit later settles. A receiver that
cannot provide the atomic staging, abort, idempotence, and bounded-settlement
contract MUST NOT advertise this profile.

The local outcome is determined exactly as follows:

| Event                                                                           | Required local outcome                       |
| ------------------------------------------------------------------------------- | -------------------------------------------- |
| Atomic durable commit succeeds before its deadline                              | `preserved`                                  |
| User chooses Discard before Preserve                                            | `discarded`                                  |
| Preview expires before Preserve begins                                          | `discarded`                                  |
| Commit fails or is cancelled and rollback proves the durable record is absent   | `discarded`                                  |
| Commit is indeterminate, ignores cancellation, or rollback cannot prove absence | `failed`; never `discarded`                  |
| Durable staging succeeds and later application import/indexing fails            | `preserved`, with a recoverable import state |

Preserve activation MUST immediately expose a busy/progress state and prevent
duplicate activation. A receiver MAY make its atomic receiver-owned staging
commit the user-visible Preserve boundary, release all transient transport
state, perform the clean transition, and finish application import from that
recoverable record. Failure after that boundary is a recoverable import error,
not Discard.
The preview API exposes the absolute deadline before presenting preview UI.
Products MAY choose a shorter disclosed deadline. The
sender independently bounds its wait for `result`, using the same
15-minute default and 60-minute hard maximum. A sender-side timeout is an
unknown remote disposition, not evidence of Discard. Keys, rendezvous names,
grants, buffers, object URLs, and RTC resources have all application references
released at terminal state.

The durable record remains inert inside the restricted receiver Document.
Following every terminal outcome, including Preserve, Discard, denial, expiry,
cancellation, or error, the receiver completes terminal cleanup. It MAY leave
only a content-free terminal message in that still-restricted Document. Before
ordinary application startup or selecting, opening, richly rendering,
executing, or resolving references from a preserved document, it MUST close the
restricted Document or perform the core full top-level clean transition. A
same-Document SPA/state transition is insufficient. Any available best-effort
final result is attempted before that transition.

## 15. Replay, concurrency, and abuse limits

After structural validation and exact current-discovery binding, but before
helper creation, user prompting, key import, or RTC work, the receiver MUST
perform one atomic replay-and-capacity admission through this required host
hook:

```text
admitIncomingHandoff({
  requestId,
  channelId,
  transport: "detached-datachannel/1",
  replayExpiresAt: offer.expiresAt,
  pendingExpiresAt: min(offer.expiresAt, now + 60000),
  maximumActiveSessions,
  maximumReplayClaims
}) ->
  {admitted: false, reason: "replay" | "session-capacity" | "replay-capacity"}
  | {admitted: true, promote({expiresAt}), release()}
```

In one linearizable transaction across all receiver-origin tabs, workers, and
reload overlap, the host physically prunes expired records, rejects a live
`(requestId, channelId)` tuple as `replay`, rejects a full
pending-plus-active lease set as `session-capacity`, rejects a full bounded
replay store as `replay-capacity`, or creates both one tuple tombstone and one
pending lease. Rejection creates neither record. The tombstone remains until
the original offer `expiresAt`; the pending lease lasts at most 60 seconds.
Live tombstones MUST NOT be evicted early, including by LRU. A sender-origin
claim copied from the unverified offer MUST NOT partition or relax these
pre-verification limits because it can be spoofed or rotated.

`maximumActiveSessions` MUST be an integer from 1 through 4 and defaults to 4.
`maximumReplayClaims` is an implementation-defined finite ceiling and defaults
to 512 in the reference receiver. The admission callback contains only random
identifiers, expiry, transport state, and local ceilings; it contains no sender
metadata or content. Per-tab memory and `sessionStorage` do not conform.
Absence, malformed output, exception, or timeout fails closed. The default
admission deadline is five seconds and the hard maximum is 30 seconds.

After the receiver user's one trusted preview authorization and before key
import, RTC work, callback navigation, or content transfer continues, the SDK
calls `promote({expiresAt: offer.createdAt + maximumSessionLifetimeMs})` on the
same lease. The host atomically changes that existing lease from pending to
active without acquiring another slot and returns exact `true`. Promotion
failure or timeout terminates the handoff. The default promotion deadline is
five seconds and the hard maximum is 30 seconds.
`maximumSessionLifetimeMs` is the 75-minute hard lifecycle envelope formed by
the five-minute bootstrap, ten-minute connected-to-preview, and 60-minute
preview-disposition ceilings. Independent helper capabilities, sender callback
listeners, transcript acceptance, grants, and terminal controls remain exact-
state, single-use, and expiring within their session.

The host MUST return `false` without changing storage unless the existing lease
is present, unexpired, and exactly `pending`, and the requested expiry is a safe
integer later than the host's current time. It MUST also reject an expiry later
than the host's current time plus `maximumSessionLifetimeMs` and the permitted
clock-skew allowance. Promotion MUST be a single atomic pending-to-active
transition: it MUST NOT create a missing lease, revive an expired lease,
re-promote or extend an active lease, or acquire a second capacity slot.

After validating a manifest against live capabilities, but before local
manifest authorization, Grant, or transfer-buffer allocation, the receiver
MUST acquire an origin-wide aggregate byte lease through a second atomic host
hook:

```text
reserveIncomingBytes({
  requestId,
  channelId,
  transferId,
  transport: "detached-datachannel/1",
  totalBytes,
  maximumAggregateTransferBytes,
  expiresAt
}) -> {reserved: true, release()}
```

The recommended aggregate ceiling is 33,554,432 bytes and the hard ceiling is
67,108,864 bytes across all live OAB transfers on the receiver origin. The
callback MUST atomically remove expired reservations, sum every remaining live
reservation, reject duplicates and an over-ceiling sum, and add the new
reservation in one linearizable transaction. It returns exact
`{reserved: true, release()}` or fails closed. Its default wait is five seconds
and hard maximum is 30 seconds. The SDK releases the lease on authorization
denial, failure, Discard, Preserve, abort, expiry, channel close, and teardown.
Per-tab counters and check-then-add transactions are non-conformant.

The receiver allocates at most the manifest-declared item buffers after this
lease is acquired. Incoming frames are copied directly into those fixed-size
buffers and the frame copies are released. It MUST NOT retain a complete chunk
list and then allocate a second complete transfer copy.

The promoted lease caps simultaneous work across different offers. It remains
held through the whole detached session and is released idempotently on Preserve, Discard,
denial, expiry, abort, callback/helper/RTC failure, page hide, close, or any
other terminal state. The host `release` operation MAY be asynchronous and
MUST itself be idempotent. At and after the supplied expiry, the atomic store
MUST exclude a stale record from admission counts and aggregate-byte sums.
Live contexts SHOULD schedule best-effort deletion; every later store operation
and ordinary-application startup MUST physically prune expired records before
continuing. No execution at the exact deadline is assumed after every origin
context crashes. A late admission result after
session invalidation is released without creating a helper or prompting.

Every admission transaction and ordinary-application startup physically prunes
expired tombstones and leases using an expiry-indexed operation. A receiver
SHOULD defer persistent admission until its top-level Document is visible and
focused. This limits background launch abuse; visibility and focus are not
proof of user activation, sender identity, or benign intent. After callback
verification, a supplementary per-verified-origin token bucket MAY be applied,
but it does not replace the origin-wide transaction or permit early tombstone
eviction.

Every terminal state is absorbing. Close, page hide, denial, expiry, abort, or
failure invalidates a session generation before releasing resources. After
every asynchronous authorization, cryptographic, helper, callback, RTC, or
application await, an implementation rechecks that generation before changing
state, creating resources, navigating, granting, previewing, or delivering.
Late promise completion MUST NOT resurrect a closed or expired session.

At most one visible preview-authorization prompt may exist across the receiver
origin for one incoming request, and the protocol flow MUST NOT repeat it after
origin or manifest verification. Implementations MUST bound total pending sessions, channels,
helpers, callbacks, prompts, frame rate, asset count, and aggregate bytes.

Repeated invalid signaling or denied offers may trigger temporary local
cooldowns. A receiver MUST NOT disclose private allowlists or rejection history
through discovery or detailed cross-origin errors.

## 16. Failure behavior

The following are fatal and fail closed:

- any opener or framed context;
- missing secure context;
- stale discovery or unsupported exact version/profile;
- signaling, SDP, candidate, frame, or transfer bound violation;
- non-host, raw-address, STUN, TURN, or relay candidate;
- callback path deviation;
- ECDH, HKDF, AES-GCM, transcript, or digest failure;
- replay or sequence mismatch;
- unexpected media or data channel;
- timeout or premature navigation; and
- browser policy preventing safe connection.

No fatal condition may trigger `link-envelope/1`, clipboard, form POST, HTTP
upload, opener messaging, or another delivery mechanism. A product may offer a
separate new handoff only after clearly reporting failure and receiving a new
user decision.

## 17. Honest guarantees

This profile provides:

- no receiver reference to the sender window;
- callback-verified sender-origin participation;
- encrypted and integrity-protected direct content transport;
- exclusion of content from URL and HTTP payload servers;
- bounded live authorization, preview, Preserve/Discard, and disposition result.

It does not prove:

- the identity of a company, publisher, application, or human;
- that either origin is free of XSS or compromised dependencies;
- sender user activation to the receiver;
- that both peers execute on the same physical device or that a malicious
  sender did not add an out-of-protocol same-LAN signaling relay;
- protection from a compromised browser/OS or locally privileged extension; or
- availability where WebRTC, eligible `.local`/loopback host candidates, callbacks, or
  BroadcastChannel are disabled.

Those limitations MUST be represented as environmental boundaries, never
repaired by an unsafe transport.

Browser conformance evidence for this profile MUST satisfy core Section 16. It
observes a real trusted sender click, the exact pre-click receiver `endpoint`
anchor, exactly one receiver target and that target's initial endpoint request.
It separately observes the real trusted Verify click, exact pre-click
`receiverHelper` anchor, exactly one helper target and its initial helper
request, then that helper target's later same-target navigation and request to
the fixed sender callback. An inspected URL, synchronous API result, Promise,
local event, timer, or synthetic click without the real targets and requests is
insufficient.
