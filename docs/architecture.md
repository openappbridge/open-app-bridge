# Reference architecture

OAB separates receiver discovery, profile selection, transport mechanics,
authorization, application preview, and persistence. Transport code never
writes application storage. Application code never weakens transport validation
to improve availability.

## System shape

```text
User-selected domain
        │
        ▼
bounded credential-free JSON discovery
        │
        ├── exact wire-version intersection
        ├── exact transport-profile intersection
        └── verified receiver origin + same-origin endpoint
        │
        ▼
explicit profile choice before Send
        │
        ├── link-envelope/1
        │     noopener navigation
        │     bounded non-confidential text fragment
        │     synchronous scrub → validate → Review once
        │
        └── detached-datachannel/1
              noopener receiver + noopener helper
              receiver-origin BroadcastChannel rendezvous
              helper replaces itself with fixed sender callback
              sender-origin BroadcastChannel rendezvous
              ECDH/HKDF/AEAD-bound WebRTC signaling
              constrained host-only DTLS data channel
              capabilities → manifest → grant → bounded streams
        │
        ▼
transient isolated preview
        │
        ├── Discard → erase
        └── Preserve → atomic application commit
```

The two profiles are independent. This diagram is not a fallback ladder.

## Security boundaries

### Origin discovery

Discovery is a bounded `GET` to the receiver's well-known JSON resource. It
omits credentials and rejects redirects. Declared endpoint, helper, and
manifest paths use an unencoded grammar that rejects every `%`, backslash,
control, and traversal segment before URL resolution. The HTTPS origin, not a
manifest name or user-entered label, is receiver identity.

The discovery parser validates known members strictly. Unknown transport IDs
are ignored. Extensions cannot change the meaning of a known member. Every
profile and wire version is selected through exact intersection. The sender
retains the selected detached limits and later requires every live capability
to be an equal or narrower subset.

### No WindowProxy boundary

All cross-origin top-level launches are opener-free. There is no
`postMessage()` session between sender and receiver and no receiver
`WindowProxy` for the sender. This is an architectural invariant, not a
best-effort receiver behavior.

Same-origin `BroadcastChannel` is used only for two local rendezvous:

- receiver main page ↔ receiver helper; and
- sender callback ↔ original sender page.

Each channel name contains 256 random bits, is single-use, expires, and carries
only bounded signaling. Same-origin rendezvous never carries document content.

### Link-envelope boundary

The link profile crosses the receiver boundary as local URL state. Its capture
path is deliberately tiny:

```text
capture raw fragment → scrub URL → bound → decode → digest → schema
→ atomic replay tombstone + short pending lease
→ receiver consent → lease promotion → transient safe preview
```

No content is fetched or rendered before validation and consent. The receiver
does not derive durable trust from claimed source metadata.

### Detached signaling boundary

The detached receiver initially captures, scrubs, bounds, decodes, and
structurally validates a content-free offer. It does not import keys, create
RTC, or invoke the browser SDP parser. It waits for the receiver user's
**Review shared content** action. That single request-bound authorization opens
the same-origin helper with
noopener and authorizes RTC work while the helper initializes independently.
Before creating that helper or showing the prompt, the receiver atomically
creates both the replay tombstone and a bounded short pending lease or neither.
After Review, it promotes the same lease before RTC work.

After the main/helper same-origin rendezvous, the receiver validates and applies
the candidate-free offer, generates its answer, and encrypts it. The helper
uses `location.replace()` to the fixed callback on the sender origin. Its
origin-only referrer lets the callback require browser-observed receiver-origin
evidence equal to the transcript-bound receiver origin. That evidence is not
cryptographic attestation and is insufficient without the complete transcript.
The callback scrubs the
ciphertext and forwards it over the random sender-origin channel. It has
neither key material nor SDP plaintext.

The ephemeral ECDH transcript binds:

- wire and transport versions;
- request/channel IDs and expiry;
- sender and receiver origins;
- fixed callback path;
- the sender ephemeral public key;
- the current public declaration ID;
- offer hash; and
- callback rendezvous channel.

Only the original sender holds the private key needed to validate and decrypt
the answer. WebRTC's DTLS fingerprint is inside the bound descriptions.

### Data plane

The RTC peer connection has no STUN or TURN configuration, no media, one
ordered reliable data channel, and only `.local` mDNS or exact loopback
(`127.0.0.1`/`::1`) host candidates.
Control messages and binary frames have independent hard limits. Transfers use:

- a content-free signaling offer;
- receiver-controlled live capabilities;
- a metadata-only manifest;
- an explicit one-time grant;
- ordered stream IDs and chunk sequences;
- complete per-item SHA-256 verification before preview;
- bounded backpressure; and
- exact manifest, completion, and byte-count comparison.

Any mismatch destroys the whole transient transfer.

Lifecycle state is monotonic. Terminal close, expiry, denial, or failure
invalidates a session generation; every asynchronous continuation checks that
generation before it can allocate, navigate, grant, or deliver. Both peers
monitor the RTC connection through cleanup and terminate the whole session if
an additional data channel appears.

### Application boundary

Transport output becomes an immutable transient application value only after
transport authorization and complete validation. The application owns preview,
sanitization, and Preserve/Discard UI. Durable storage is supplied as a
receiver adapter to the SDK-managed Preserve transaction: commit receives an
abort signal and deadline, rollback is mandatory and idempotent, and the
protocol state machine decides the terminal disposition.

HTML, SVG, Markdown links, data URLs, file names, and MIME declarations remain
untrusted. Active content renders in a separate restrictive boundary. No
application adapter may interpret “transport complete” as Preserve.

The normative receiver experience is defined in
[`human-interaction-contract.md`](human-interaction-contract.md). A single
preview-authorization decision authorizes inspecting the content;
later origin and manifest checks narrow that grant and do not normally create
new consent screens.

## Recommended module ownership

- **Discovery codec:** fetch policy, JSON byte/schema validation, version and
  profile negotiation, declaration caching.
- **Destination UI:** canonical domain entry/history and untrusted manifest
  presentation. Icon display accepts only verified static PNG/JPEG Blob URLs.
  History stores only bounded display text, validated theme color, and the
  canonical origin—never manifest or icon URLs, Blob URLs, icon bytes, content,
  or capabilities.
- **Link codec:** deterministic envelope encoding, size accounting, digest,
  synchronous capture, strict decoding, atomic replay-plus-admission, lease
  promotion, and cancellation propagation.
- **Detached signaling:** ECDH lifecycle, candidate-free SDP checks, candidate
  filtering, atomic replay tombstone plus pending session admission, lease
  promotion, helper/callback transcript, bounded callback waits, and
  absolute phase timeouts.
- **Detached data plane:** state machine, control grammar, binary framing,
  hashing, backpressure, preview-disposition expiry, and cleanup.
- **Receiver policy:** local allow/block/ask decisions based only on available
  evidence.
- **Application adapter:** transient preview plus a signal-aware, add-only
  commit and idempotent rollback for SDK-coordinated Preserve/Discard.

These dependencies point inward:

```text
UI/adapters → protocol use cases → transport interfaces → browser primitives
```

A transport implementation does not import workspace persistence. A persistence
adapter does not access raw signaling.

The receiver host owns two small, content-free coordination stores. Its replay
store atomically claims random request identifiers until protocol expiry. Its
admission store atomically leases no more than the configured 1–4 concurrent
incoming sessions across tabs, workers, and reload overlap. The SDK releases a
lease idempotently on every terminal path; the host additionally expiry-cleans
stale leases after crashes. Per-tab memory and `sessionStorage` cannot satisfy
either origin-wide invariant.

## Deployment routes

A full receiver publishes:

- `/.well-known/open-app-bridge` — bounded discovery JSON;
- the declared receiver endpoint — top-level capture and consent;
- the declared receiver helper — minimal top-level helper.

A detached browser sender additionally publishes:

- `/.well-known/open-app-bridge/callback` — static callback resource.

Receiver, helper, and callback routes use no-store caching, no framing, no
third-party code or analytics, and strict CSP. Receiver and callback routes use
no-referrer policy; the helper deliberately uses origin-only referrer for its
fixed callback navigation. Main applications may retain strict COOP/COEP; OAB
no longer needs an `unsafe-none` opener bridge.

## Availability rule

Unavailable WebRTC, rejected host candidates, blocked callback execution,
private-mode storage partitioning, VPN policy, or enterprise browser policy may
make the detached profile unavailable. That is an availability outcome.

The implementation reports it and stops. It never revives
`browser-window/1`, uploads content, or places private content in a fragment.
