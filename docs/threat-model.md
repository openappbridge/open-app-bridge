# Threat model

This model covers OAB wire version `1.0` with
`link-envelope/1` and `detached-datachannel/1`. Removed draft transports are
outside conformance and MUST NOT be fallback paths.

## Protected outcomes

OAB is designed to prevent:

- a receiver navigating, reloading, or replacing the sender through an OAB
  window reference;
- content being deposited through a public HTTP inbox or relay;
- content transfer before receiver authorization in the detached profile;
- application delivery before strict transport validation;
- persistence without explicit receiver-user Preserve;
- content or asset substitution after an accepted manifest grant;
- replay of short-lived sessions, grants, and signaling;
- silent downgrade from a private profile into a URL-bearing profile;
- unbounded signaling, parsing, framing, prompts, sessions, assets, or bytes;
- framed/clickjacked receiver consent;
- sender authorization based on unverified product branding; and
- claims of evidence the transport did not observe.

## Actors and capabilities

### Malicious receiver origin

The user may mistype or deliberately choose an attacker-controlled receiver.
That origin controls its discovery document, manifest, receiver UI, helper, and
all script served from its domain. It may attempt phishing, protocol
downgrade, excessive allocation, malicious signaling, callback redirection, or
sender-tab navigation.

OAB does not make such a site trustworthy. It prevents an OAB-conformant sender
from granting it a cross-origin window reference and bounds what reaches browser
parsers. Sender UI keeps the canonical receiver domain visible.

### Malicious sender origin

A web sender may claim deceptive content metadata, flood receiver prompts,
offer content different from transfer bytes, inject active HTML/SVG/Markdown,
or attempt to learn receiver policy. A detached sender controls its own callback
resource and any script on its origin.

Receiver policy, one-time grants, manifest/digest verification, rendering
isolation, rate limits, preview, and Preserve protect the receiver. Callback
verification proves only participation by script on the claimed origin.
One request-bound preview authorization avoids prompt fatigue and is consumed
only after the verified origin and exact manifest remain inside its scope.

### Unverified link-envelope producer

Any website, installed application, automation, QR code, bookmark, or local
tool can create a valid link envelope. Discovery JSON and `declarationId` are
public. The digest is recomputable.

The receiver therefore treats every link envelope as an **Unverified app or
website**, uses Review once or Not now, and never derives a durable sender
allow/block rule from claimed source fields.

### Local observer

A browser extension, history/session synchronizer, native URL handler,
screen recorder, crash reporter, managed-device agent, or malware may observe
URL state. Link-envelope explicitly does not protect against this actor. The
detached profile keeps content out of URL state, but a sufficiently privileged
observer may still inspect page memory or browser APIs.

### Network attacker

HTTPS protects discovery and pages. WebRTC DTLS protects detached content.
Fragments are not in HTTP requests. HSTS and normal certificate validation
remain deployment responsibilities. A compromised certificate authority,
browser trust store, endpoint, or TLS implementation is outside the protocol.

### Compromised origin

XSS or compromised dependencies executing on sender or receiver origin have
that application's authority. OAB cannot separate them from the legitimate
application. CSP, dependency integrity, isolated renderers, narrow
helper/callback pages, and supply-chain controls reduce this risk but do not
turn an origin compromise into a protocol-authenticated state.

### Historical service-worker controller

A legacy service worker can control a restricted receiver, helper, or callback
Document and observe or substitute not only its HTML response but any bootstrap,
module, stylesheet, or other transitive packaged resource that Document loads.
Byte-identical `respondWith(fetch(event.request))` remains interception. A
listener that recognizes the route and returns without `respondWith()` still
observes the fetch and is also non-conformant. In both cases, page-time
`unregister()` runs too late to repair the navigation that loaded it.

The complete OAB authority resource graph therefore permits no service-worker
fetch-event handling. An origin with a historically controlling worker keeps
OAB discovery absent or disabled during a separate migration deployment,
updates every historical script URL/scope from a previously controlled client,
and enables OAB only in a later release after browser evidence shows that every
authority-resource request reaches the current network response without worker
inspection, substitution, messaging, telemetry, or OAB background work. If
that evidence cannot be established, the receiver remains disabled or moves to
a fresh never-controlled origin.

## Trust boundaries

### Discovery

Discovery is public, credential-free configuration. The sender trusts only:

- the HTTPS origin it derived from the user's domain;
- successful redirect-free CORS fetch;
- strict bounded JSON validation; and
- exact wire/profile intersection.

Names, descriptions, icons, `senderPolicy`, `declarationId`, and unknown
extensions are not security identity. The declaration can become stale, so
live detached capabilities may only narrow it.

Manifest icons are attacker input even when same-origin with the receiver.
They are fetched without credentials or referrer under redirect, exact-URL,
media-signature, byte, and dimension bounds. Only static PNG and JPEG are
accepted when the manifest-declared—or narrowly pathname-inferred—expected
type, response type, and signature agree. GIF, WebP,
SVG, ICO, animation, and every other format are rejected before image decode.
UI displays only a short-lived verified Blob URL while retaining the canonical
receiver origin. History strips manifest and icon URLs and retains only bounded
display text, validated theme color, and the canonical origin.

A receiver can deliberately stall discovery, manifest, icon, or response-body
reads. Discovery therefore has an unavoidable hard fetch-plus-body deadline
and fails closed. Optional manifest and icon operations have shorter,
independent hard deadlines and degrade only to canonical-domain/local-glyph
presentation. An external cancellation signal can end an operation sooner but
cannot remove the internal deadline. Supported manifest strings containing
lone UTF-16 surrogates reject the complete optional identity, preventing
cross-runtime U+FFFD normalization differences.

### Top-level consent

Receiver, helper, and callback runtimes require `window.top === window` and a
framing-denial response policy. Consent never runs in a cross-origin iframe.
The receiver's Review and Preserve actions require receiver-controlled visible
UI. The receiver page must visibly own its brand/context and must not imitate
browser or operating-system warning UI. This mitigates clickjacking and
confusion; it does not prove that a user understood a deceptive first-party UI.

### No WindowProxy

The former `browser-window/1` transport is removed because cross-origin opener
messaging and navigation authority are inseparable in generally deployed web
platforms. All OAB 1.0 new-context launches use noopener and no-referrer
semantics.

The helper uses `location.replace()` from its own top-level context and serves
`Referrer-Policy: origin`. The callback requires that browser-controlled
referrer origin to equal the transcript-bound receiver origin before relaying
the sealed answer. Empty, stripped, or mismatched referrer fails closed.
The callback HTTP request therefore reveals the receiver origin, but never its
fragment-carried sealed answer, to the sender's server.
Neither receiver main nor helper holds a reference to the sender. The sender
callback also has no opener. Reverse tabnabbing through OAB is therefore absent
rather than guarded by receiver promises.

### Same-origin rendezvous

`BroadcastChannel` is used only between top-level same-origin pages:
receiver/helper and sender/callback. Random 256-bit names make accidental
collision or guessing infeasible. Same-origin malicious script remains part of
the compromised-origin boundary.

The callback carries only opaque AEAD ciphertext. It cannot decrypt or forge a
valid answer. The browser-controlled referrer is necessary origin evidence but
is not sufficient by itself; the AEAD transcript is necessary session and
offer continuity but cannot substitute for the referrer. Both checks must pass.
Receiver/helper messages are same-origin but are still strict, single-session,
bounded, expiring, and state-checked.

### WebRTC parser boundary

Browser-generated SDP is treated as opaque transport material; OAB does not
reconstruct fixed-template SDP. Before calling `setRemoteDescription()`, each
side performs small structural checks: bounded candidate-free text, one
application section, required security attributes, no media, no duplicate
critical attributes.

The browser remains the SDP parser. Browser parser vulnerabilities are not
eliminated, so OAB minimizes and gates exposure:

- the receiver does not import keys, create RTC, or invoke/apply the browser
  SDP parser before receiver-user review;
- signaling is capped at 32 KiB;
- only candidate-free browser descriptions are accepted;
- candidate records are separately browser-parsed and capped;
- only `.local` mDNS or exact loopback host candidates are applied; and
- unexpected media/transceivers terminate the session.

A browser vulnerability in these APIs is an environmental risk handled through
browser security updates, not an excuse for a less safe fallback.

### Signaling cryptography

Ephemeral P-256 ECDH plus HKDF-SHA-256 derives the AES-256-GCM answer key.
Authenticated transcript data binds exact versions, request/channel IDs, both
origins, exact helper and callback paths, the sender public key, current public
declaration ID, and offer hash. The receiver public key participates in ECDH
and is carried in the sealed envelope; replacing it yields an authentication
failure. This protects against callback injection, answer modification,
cross-session mix-up, and replay.

The initial offer is not encrypted, but contains no title, representation body,
asset name, content digest, or document bytes. Its SDP and mDNS candidates may
reveal browser/network implementation metadata to the chosen receiver and
local URL observers. That limited signaling disclosure is explicit.

AEAD cannot protect against a party that already controls one endpoint's origin
or local runtime. The callback path is fixed so a bootstrap cannot nominate an
attacker-controlled return endpoint.

### Data channel

The RTC connection has no STUN/TURN server, media, public/relay candidate, or
second channel. DTLS gives confidentiality and integrity after the signaling
transcript binds its fingerprints.

The application framing layer adds:

- exact state and sequence;
- one-use grant before bytes;
- maximum 16 KiB messages;
- stream and total byte accounting;
- per-item and manifest SHA-256 verification before preview;
- ordered transfer metadata; and
- bounded backpressure.

DTLS integrity does not replace semantic manifest validation. SHA-256 detects
substitution against the granted manifest but is not publisher authentication.

.local/loopback host-only ICE with no STUN/TURN limits reachability but is not a
same-device attestation mechanism. A malicious sender origin can supplement
OAB with its own signaling and connect a reachable same-LAN peer. Receiver UI
and policy therefore rely on the authenticated sender origin and transcript,
never on a claim that both peers share one physical device.

### Content renderer and persistence

Received Markdown, HTML, SVG, URLs, filenames, MIME types, and metadata are
attacker input. Preview occurs in a restrictive renderer boundary with active
scripts, event handlers, dangerous URLs, unapproved network loads, and origin
privileges removed.

Transport completion does not authorize persistence. Preserve is a separate
receiver-user action followed by an SDK-managed transaction with a
signal-aware atomic commit and mandatory idempotent rollback. The durable key
is receiver-generated and add-only, so a sender identifier cannot overwrite an
existing document. If expiry races commit, the controller aborts, waits for
settlement, rolls back, and only then records Discard; rollback failure remains
an explicit indeterminate state. IndexedDB,
Cache Storage, files, local storage, and servers are durable; none may be used
as “temporary” pre-Preserve buffers.

## Profile-specific threats

### Link fragment exposure

The raw encoded body may enter history/session machinery before synchronous
scrubbing. A receiver copies bounded pre-scrub evidence and removes the
fragment before it even rejects a framed, misrouted, or query-bearing marked
launch. OAB limits the whole URL, fragment, and decoded envelope; forbids
confidentiality claims, HTML, assets, and compression; requires no-store and
no-referrer policy; and omits analytics/third parties from capture.

These controls reduce duration and blast radius but do not make the fragment
secret. Sensitive content uses detached transfer or is not sent.

### Link minting and replay

Anyone can mint a structurally valid link. Receiver consent and the unverified
label are primary controls. Expiry, random request IDs, current
`declarationId`, and a required atomic bounded replay-and-capacity admission
reject repeated delivery of the same envelope but do not authenticate the producer.

The claim is coordinated across concurrent receiver tabs and survives reload
only until the envelope expiry. Per-tab replay memory would permit a second tab
to accept the same request and is therefore outside conformance. The host must
also supply the current discovery `declarationId` state explicitly, including
JSON `null`; an authorized delivery records a successful exact match rather
than an optional or unknown result.

The same transaction creates a no-more-than-60-second pending origin-wide lease
or creates no state on capacity failure. A receiver admits at most its
configured 1–4 pending-plus-active sessions, then promotes the lease to
envelope expiry only after Review once. It releases the lease on every terminal
path while retaining the replay tombstone until expiry. Live tombstones are not
LRU-evicted. Per-tab counters do not prevent a tab storm from multiplying
prompts and memory.

Page hide, external cancellation, and envelope expiry abort the shared link
authorization/delivery signal. Generation checks after each asynchronous host
callback prevent a late authorization or preview continuation from reviving an
abandoned handoff.

The web platform does not attest that a top-level navigation was initiated by
benign application code rather than script. A hostile page that obtains browser
permission to open or navigate receiver tabs can therefore occupy the small
pending-session ceiling temporarily. OAB contains that availability effect:
capacity rejection writes no replay state, each unapproved lease expires within
60 seconds, offer tombstones expire within five minutes, and reference web
receivers delay admission until visible and focused. Eliminating even this
bounded local availability loss would require browser/OS mediation, shared
authentication, or a central authority and is outside OAB's decentralized
constraints. Visibility/focus is mitigation, not provenance evidence.

### Detached malicious signaling

An attacker may supply malformed SDP, excessive candidates, raw addresses,
media sections, modified keys, stale answers, or callback ciphertext. Bounds,
an atomic pre-helper replay-tombstone-plus-pending-lease admission, user-gated parsing,
structural checks, candidate policy, fixed routes, AEAD, transcript hashes, and
expiry fail closed.

The atomic admission occurs before helper creation or prompting and caps
distinct concurrent detached sessions at the configured 1–4 maximum across
tabs and workers. Its pending lease expires within 60 seconds. After the user's
trusted Review action, that same lease is promoted in place to the 75-minute
hard expiry after offer creation, held through terminal disposition, and
released on every terminal path. The offer-expiry replay tombstone remains
independent of lease release. Admission and promotion wait five seconds by
default and never longer than 30 seconds.

Changing the sender key or offer can cause denial of service but cannot create a
valid channel with the original sender. Changing the answer, receiver key, or
transcript makes GCM verification fail.

Close and expiry race every asynchronous browser and application operation.
Terminal states are absorbing, and session-generation checks after each await
prevent late key import, RTC creation, helper navigation, grant, or preview
from resurrecting an abandoned transfer.

Preview disposition is also monotonic. Disposition expiry may force Discard
only while the preview is still undecided. After an atomic application commit
and entry into the absorbing `preserved` state, the deadline is cancelled and
result-channel delay or failure cannot convert that outcome to Discard.

### Availability and fingerprinting

WebRTC or mDNS host candidates may be blocked by private mode, VPNs, Tor,
enterprise policy, extensions, WebViews, or browser configuration. Candidate
and API behavior may contribute to browser fingerprinting.

The sender may prepare an ephemeral key, local offer, safe candidates, and
same-origin rendezvous before Send so the trusted anchor click remains purely
native navigation. It exposes that signaling to no receiver until explicit
Send, and the receiver does not import keys or invoke RTC parsing until its
separate Review shared content action. OAB sends no STUN/TURN traffic, exposes no raw address,
retains no long-lived peer identity, and releases all session references on
cancel or terminal state. Browser-managed memory zeroization is not
observable. The SDK clears its frame receiver's terminal manifest, counters,
options, and byte-buffer references. A fulfilled JavaScript Promise or preview
object already retained by host code cannot be revoked by the SDK; a conforming
host drops those references after Preserve, Discard, abort, expiry, or failure.
If safe connection is unavailable, it reports failure and does not
downgrade.

### Callback/helper lifecycle

Popup blocking, tab closure, navigation, throttling, or background suspension
may interrupt the one-click helper/callback chain. Both pages are
content-free, single-use, bounded, time-limited, and safe to abandon. Failure
affects availability, not content confidentiality or sender navigation.

## Abuse controls

Receivers SHOULD combine:

- default Ask or local allowlist policy;
- canonical origin display for detached sessions;
- unverified-source display for links;
- one visible request-bound preview prompt per incoming request;
- bounded pending sessions and replay sets;
- atomic origin-wide replay-plus-pending-lease admission, limited to 4 sessions,
  with no-more-than-60-second pre-Review leases and expiry-indexed cleanup;
- five-second-default and 30-second-maximum admission/promotion waits;
- five-minute signaling, ten-minute connected-to-preview, and 60-minute
  preview-disposition hard deadlines;
- per-origin or unverified-source rejection cooldowns;
- rate, frame, asset, and byte limits;
- exact offer/grant/transfer comparison;
- isolated preview before persistence; and
- clear Preserve and Discard actions.

Proof-of-work is not recommended. It harms accessibility and battery life and
does not prove a human.

## Explicit non-goals

Base OAB does not prove:

- that a sender or receiver user is human;
- that an application name corresponds to a legal publisher;
- native code signing, store installation, or device attestation;
- absence of XSS, malicious dependencies, or deceptive UI;
- protection from compromised browser/OS/local privileged software;
- cross-device or offline delivery; or
- detached availability in every browser/network policy.

Authentication, WebAuthn, app attestation, enterprise policy, CAPTCHA, and
store-and-forward may be separate extensions. None is required for
decentralized baseline interoperability.

## Security release gates

Stable publication requires:

- no normative or runtime path to `browser-window/1`;
- cross-engine tests proving every launch has `opener === null`;
- fuzzing for discovery, fragment, signaling, SDP structural, control, and
  binary-frame validators;
- Chrome, Firefox, Safari, Android, and iOS matrices including private mode,
  VPN, strict COOP/CSP, blocked WebRTC, timeout, and popup-helper cases;
- independent sender and receiver implementations;
- independent security review; and
- documented failure-closed evidence for every unsupported environment.

Until these gates pass, detached support is draft interoperability evidence,
not a claim that all browser-engine risks have been eliminated.
