# Security policy

## Reporting a vulnerability

Use GitHub's **Report a vulnerability** private reporting feature. If it is not
available, open a content-free issue requesting a private reporting channel.
Do not publish exploit details, private payloads, key material, origin policy,
or an affected deployment URL before maintainers confirm coordinated disclosure
is safe.

Include:

- affected commit, wire version, and transport profile;
- sender, receiver, helper, and callback environments;
- browser/OS versions and security headers;
- smallest safe reproduction;
- expected and observed effect;
- whether navigation authority, content confidentiality, authorization,
  integrity, availability, or persistence is affected; and
- suggested mitigation, if known.

Project targets are acknowledgment within seven days and initial assessment
within fourteen days. They are not a service-level guarantee.

## Supported versions

OAB is a breaking draft. Security fixes apply to the latest default-branch
revision only. `browser-window/1` and `native-link/1` are removed and receive
no compatibility or security support.

Do not deploy the detached profile as a stable-security claim until its browser
matrix and external review gates in [ROADMAP.md](ROADMAP.md) are complete.

## Universal implementation checklist

- Use HTTPS and a secure context; allow HTTP only for browser-trusted loopback
  development.
- Fetch bounded discovery JSON with omitted credentials, no referrer, no
  redirect, strict UTF-8, duplicate-member rejection, and exact known-field
  validation.
- Bound the complete discovery fetch and body read with an eight-second default
  and 30-second hard ceiling. Bound optional manifest and icon operations
  independently with four-second defaults and 15-second hard ceilings. Caller
  cancellation may shorten, never disable, these deadlines.
- Treat JSON Schema as a structural aid, not a complete validator; run every
  normative relational, canonicalization, browser-assisted, replay, and state
  check in code.
- Require `status: "enabled"`, an exact `wireVersions` match, and an
  explicitly declared transport. There is no default.
- Treat `declarationId`, sender policy, PWA metadata, names, icons, and URLs as
  public untrusted metadata.
- Keep the canonical verified domain visible. Defend against IDN confusables.
- Separate discovery, profile selection, Send, receiver authorization, preview,
  and Preserve.
- Run receiver/helper/callback only at top level; combine runtime checks with
  response-header `frame-ancestors 'none'` (not a CSP meta element).
- Launch every new cross-origin context only through a prepared native anchor
  activated directly by a fresh trusted user action, with noopener and
  no-referrer semantics. Imperative `window.open()` and scripted anchor
  activation are forbidden. The detached helper's later self-navigation is
  the sole referrer exception and uses origin-only policy for callback
  provenance.
- Bind each prepared capability to exactly one native anchor through the SDK.
  Reject a missing or different `currentTarget`, any changed URL/target/rel/
  referrer policy, and `download`, `ping`, or attribution attributes. The SDK,
  not application timer code, removes the DOM `href` at expiry and terminal
  cleanup.
- On every rejected, modified, synthetic, reused, closed, or expired anchor
  activation, synchronously call `preventDefault()`, disable/remove its `href`,
  and enter an absorbing non-launch state; throwing does not cancel navigation.
- Schedule every prepared handoff to disable/remove its `href` and release
  volatile state at expiry even without a click, while still rechecking expiry
  synchronously at activation because timers can be delayed.
- After accepted activation, invalidate the controller-held URL/capability
  immediately but preserve the activated DOM anchor and containing Document
  through dispatch and its microtask checkpoint. Cross a full event-loop task
  before removing, disabling, replacing, or unmounting that anchor, rebuilding
  or closing its host, or emitting any externally observable launch-indication
  callback/event. Promise/`queueMicrotask()` cleanup is too early. No outcome
  may leave a reusable controller capability.
- Assert and test `window.opener === null`; never use an opener or
  cross-origin `WindowProxy`.
- Bound raw input before decoding/parsing/allocation and bound active sessions,
  replays, prompts, timers, frames, assets, and total bytes.
- Before prompting or allocating a helper, crypto, RTC, or delivery work, use
  `admitIncomingHandoff` to atomically create both the profile replay tombstone
  and a pending origin-wide session lease, or neither. Configure 1–4 pending-
  plus-active sessions (default 4); distinguish replay, session capacity, and
  replay-store capacity; fail closed on absence, malformed output, error, or
  timeout. Per-tab counters and `sessionStorage` do not satisfy this control.
- Limit an unapproved lease to 60 seconds. After the user's one preview
  authorization, atomically promote that same lease in place before transport
  work continues. Keep every replay tombstone until its offer expiry and never
  LRU-evict a live tombstone.
- Release the lease idempotently on every terminal path, including page hide,
  denial, Discard, Preserve, completion, abort, expiry, and error. The host
  must also expiry-clean stale leases after a crashed context.
- Keep pre-Preserve data out of servers, files, IndexedDB, local storage, Cache
  Storage, history state, and service-worker queues.
- Keep the complete receive-document lifetime restricted to origin-local
  capture/validation/consent/inert-preview resources. Do not initialize
  analytics, crash/usage telemetry, advertising, tag managers, authentication
  or account prompts, document sync, remote fonts, CDN renderers, third-party
  resources, speculative loads, or application service workers.
- Apply the same complete-lifetime restriction to the detached receiver helper
  and fixed sender callback. They are restricted OAB utility Documents, not
  ordinary app pages after scrub or completion.
- Preserve authorizes durable bytes, not activation. Do not select/open/render
  the durable document or resolve its references until transient cleanup and a
  clean full-document navigation (or closure) ends the restricted Document.
  SPA/history/widget state changes do not satisfy this boundary.
- After denial, Discard, expiry, cancellation, or error, a content-free terminal
  message may remain only while the Document stays restricted. Starting the
  ordinary app after any terminal outcome requires the same closure or clean
  full-document transition.
- Render active content in an isolated sanitized boundary.
- Treat asset names as display metadata, not paths; revalidate destination
  names and prevent reserved-name, case-folding, and overwrite collisions.
- Erase transient state on denial, Discard, error, timeout, channel close,
  reload, replay, or mismatch.
- Never automatically substitute another transport after failure.

## Discovery checklist

- Serve `/.well-known/open-app-bridge` as no more than 8,192 bytes.
- Permit credential-free CORS `GET`; do not use cookies or user-specific
  private policy in public discovery.
- Reject all redirects and every raw `%`, backslash, control, or traversal
  segment in endpoint, helper, and manifest paths.
- Advertise only operational profiles and limits enforced live.
- Keep discovery, every receiver/helper/callback Document, and their complete
  transitive packaged resource graphs network-authoritative. Every HTML,
  parser-blocking bootstrap, module, stylesheet, and other packaged dependency
  request receives no service-worker fetch-event handling and proceeds directly
  to the network; `respondWith(fetch(event.request))` is still
  interception and is non-conformant. A controlling migration worker must not
  message or telemeter restricted OAB Documents or start OAB-related background
  work. If a historical worker could control any resource in that graph, keep OAB disabled for a
  separate verified migration deployment; page-time unregister and versioned
  paths do not repair the already-controlled navigation. Use a fresh
  never-controlled origin or stay disabled when migration cannot be established.
- Keep `discoveryTtl` at or below 3,600 seconds and invalidate cached
  declarations when configuration changes.
- Ensure optional manifests and icons are same-origin, credential-free,
  no-referrer, redirect-free, exact-final-URL, bounded, media-verified, and
  display-only. Accept only static PNG or JPEG with exact expected type,
  response type, file signature, and dimensions; when manifest `type` is
  absent, infer only from `.png`, `.jpg`, or `.jpeg`. Cap icons at 256 KiB, 1,024
  pixels per dimension, and 1,048,576 pixels total; reject GIF, WebP, SVG, ICO,
  animation, and every other format. Display only verified Blob URLs and revoke
  them after use. Destination history retains bounded text/theme color and the
  canonical origin, never manifest URLs, icon URLs, Blob URLs, or icon bytes.
- Reject the complete optional manifest identity when any supported string
  member contains a lone UTF-16 surrogate; never normalize it into U+FFFD or
  retain a partially normalized identity.

## Link-envelope checklist

- Advertise and enforce `maximumUrlBytes`, `maximumFragmentBytes`, and
  `maximumDecodedBytes`.
- Support only `text/markdown` and `text/plain`; reject HTML, assets,
  compression, and unknown envelope members.
- Capture and synchronously scrub the fragment before any asynchronous work,
  security validation, render, log, analytics call, or external resource. Copy
  bounded pre-scrub location evidence first, then validate it after scrub.
- In a shared receiver dispatcher, capture and scrub a marked launch before
  profile ambiguity, support, discovery, or configuration validation can
  throw. Do not depend on a later profile handler for early-error cleanup.
- Validate parameter uniqueness, strict unpadded base64url, SHA-256, strict
  UTF-8, duplicate JSON members, exact grammar, times, MIME types, and the
  host-supplied current declaration string-or-null state. Missing declaration
  input is fatal; an authorized delivery always records a successful match.
- Match the raw fragment's fixed parameter order directly; never use
  form/query decoding. Reject percent-encoding, `+`, reordering, duplicate or
  unknown names, whitespace, empty values, padding, and alternative spellings.
- Label every source **Unverified app or website**.
- Do not create durable sender allow/block rules from claimed source fields.
- Warn that local URL/history/extension software may observe content and never
  describe the profile as confidential.
- Atomically admit every request ID and its `channelId: null` pending lease
  through `admitIncomingHandoff`. Keep the tombstone until envelope expiry,
  cap the pending lease at 60 seconds, and promote that lease to envelope
  expiry only after Review once. The transaction must coordinate concurrent
  tabs and survive reload; rejected admission creates no tombstone or lease.
- Propagate one cancellation signal through link authorization and transient
  delivery. Abort it on page hide, external cancellation, or envelope expiry,
  and recheck after every await so late completion cannot preview or persist.
- Do not produce an implicit receipt, callback, beacon, form POST, or redirect.
  Report only an unconfirmed launch indication after the required task
  boundary; never label it sent, delivered, previewing, accepted, or preserved.
  “The receiver opened” and “navigation began” are not explicitly unconfirmed
  launch indications.

## Detached sender checklist

- Require the fixed callback at
  `/.well-known/open-app-bridge/callback`.
- Keep that callback in the browser; exclude it from ordinary App Link,
  Universal Link, or external-protocol interception.
- Generate a request ID with at least 128 bits of entropy, an independent
  256-bit `channelId`, and a non-extractable ephemeral P-256 key.
- Configure `RTCPeerConnection({iceServers: []})`, one ordered reliable
  `oab-1` data channel, and no media.
- Retain exact candidate-free browser-generated SDP; do not reconstruct a fixed
  template.
- Emit only separately parsed `.local` mDNS or exact `127.0.0.1`/`::1` `host`
  candidates. Reject every other raw address, STUN/TURN URL, and
  srflx/prflx/relay type. Fail as soon as gathering completes with none.
- Enforce safe-integer signaling times, a five-minute hard offer lifetime,
  at most 30 seconds of future clock skew, and the exact validity interval
  `createdAt - 30,000 <= now < expiresAt` at parsing and activation boundaries.
  Use the receiving browser clock; never calibrate it from HTTP `Date`.
- Open the receiver with noopener/noreferrer from fresh user Send activation.
  Arm the random sender-origin BroadcastChannel synchronously in that
  activation before native navigation; keep it single-use and expiring.
- Authenticate the complete transcript and callback answer before applying SDP
  or candidates.
- Send no content bytes before receiving a valid one-time grant over the
  authenticated channel.
- Respect data-channel backpressure and frame/stream/total limits.
- Verify the receiver result but do not infer persistence if the result is lost.

## Detached receiver and helper checklist

- Copy bounded location/fragment evidence and synchronously scrub before even
  rejecting a framed, misrouted, or query-bearing marked launch. Then bound,
  decode, and structurally validate the bootstrap before receiver-user review.
  Do not import keys, create RTC, apply
  SDP/candidates, or invoke a browser RTC parser before that action.
- After exact discovery binding and before helper/RTC work, atomically admit
  `(requestId, channelId)` through `admitIncomingHandoff`, creating the replay
  tombstone and a no-more-than-60-second pending lease or neither.
- After the one trusted Review action, promote the same lease to 75 minutes
  after offer creation before RTC work. Hold it through the terminal detached
  lifecycle; preserve the replay tombstone independently until offer expiry.
- Prepare the advertised same-origin helper as a native noopener/noreferrer
  anchor from fresh receiver activation.
- After an accepted helper activation, retain its anchor, `href`, security
  attributes, and containing Document until at least one event-loop task has
  run; do not remove, disable, replace, unmount, close/rebuild the host, or emit
  an externally observable launch indication sooner.
- Keep the receiver entry and helper in the browser; exclude them from ordinary
  native deep-link interception.
- Create an independent `helperRequestId` with at least 128 bits of entropy and
  an independent 256-bit `helperChannelId` for the receiver-origin
  BroadcastChannel; require exact helper/state messages.
- Bound candidate-free SDP before the browser parser; require one application
  section, no media/candidates, expected security attributes, and no duplicate
  critical attributes.
- Generate a fresh non-extractable receiver P-256 key; bind exact origins,
  versions, paths, keys, channels, public declaration ID, and offer hash into JCS
  transcript AAD.
- Encrypt the answer with HKDF-SHA-256 and AES-256-GCM using a unique 96-bit
  nonce.
- Give the helper no private key or plaintext SDP. It may only validate the
  outer instruction and `location.replace()` to the fixed sender callback.
- Serve the helper with `Referrer-Policy: origin`; do not strip that referrer
  on its fixed callback navigation.
- Time out and erase abandoned helper sessions.
- Send live capabilities no broader than discovery.
- Present one branded, request-bound **Review shared content** decision. Send
  live capabilities, validate the metadata-only manifest, and silently require
  it to remain within that authorization before issuing one exact one-use
  grant; do not repeat the same prompt.
- Verify every sequence, byte count, stream digest, and final manifest before
  preview.
- Treat terminal states as absorbing and recheck session generation after
  every asynchronous boundary; a late callback must not recreate resources,
  navigate, grant, or preview after close, expiry, or failure.

## Fixed callback checklist

- Use a minimal static top-level page with no opener.
- Require the exact sender-origin fixed callback path, no credentials or query,
  and no redirecting deployment.
- Set no-store, no-referrer, nosniff, framing denial, strict CSP, and strict
  COOP where supported.
- Load no analytics/telemetry, authentication/account UI, document sync,
  advertising/tag manager, third-party script/style/font/image, remote font or
  CDN resource, speculative resource, form, or application service worker.
- Render no editable field, credential/payment/account/recovery control,
  unrelated link, fake browser chrome, operating-system dialog, or security
  warning. If closure is refused, show only branded content-free settlement.
- Copy bounded referrer/location/fragment evidence and synchronously scrub
  before context, path, query, or referrer validation.
- Before BroadcastChannel relay, require canonical `document.referrer` origin
  to equal the callback envelope's transcript-bound receiver origin. Empty,
  malformed, stripped, or mismatched referrer fails closed.
- Enforce the 32 KiB hard signaling limit and strict outer parameter grammar.
- Parse offer, helper, and answer fragments as their exact fixed-order raw
  ASCII forms; reject percent-encoding, `+`, reordering, duplicates, unknown
  names, whitespace, empty values, padding, and alternative spellings.
- Join only the named random sender-origin BroadcastChannel and broadcast the
  opaque envelope once.
- Never decrypt, parse SDP, follow a supplied URL/path, persist, or submit
  signaling to HTTP.
- Clear state and close, or display a content-free completion message.

## Data-plane checklist

- Enforce a maximum complete frame size of 16,384 bytes or the smaller
  declaration. Reject a declaration or live capability set whose canonical
  capabilities control cannot fit that frame size or whose transfer maximum
  exceeds `(maximumFrameBytes - 16) × 65,536`; still validate the prepared
  transfer's exact global frame count because per-item rounding is stricter.
- Reject unknown control members, state violations, repeated/skipped sequence,
  unknown stream IDs, empty/oversized chunks, and length mismatch.
- Compare capabilities, manifest, grant, data sequence, completion, previewing,
  and final result exactly and in order.
- Retain fresh-discovery capabilities at the sender and reject a live
  capabilities frame that is broader in any list or numeric maximum.
- Monitor the peer connection until terminal cleanup and fail the whole
  session on every extra RTC data channel.
- Account for bytes and limits incrementally, then verify every SHA-256 digest
  before preview; do not trust advertised digests without checking. Streaming
  hashing is optional where the cryptographic API supports it.
- Pause above the high-water backpressure bound and yield during long
  transfers.
- Bound transfer time and aggregate memory independently of the advertised
  content length.
- Expire an unconnected offer within five minutes, connected-to-preview work
  within ten minutes, and preview disposition within 60 minutes. The reference
  defaults are two minutes, two minutes, and 15 minutes respectively; disclose
  the preview deadline and treat its expiry as Discard.
- Commit only through the SDK-managed Preserve transaction. Use a
  receiver-generated collision-resistant record ID and add-only persistence;
  never let a sender ID silently replace a document. Commit must honor its
  abort signal, and mandatory idempotent rollback must erase the record after
  an expiry/failure race. Record Discard only after rollback succeeds; a
  rollback failure is an explicit indeterminate-persistence failure.
- Once that coordinated commit succeeds before the visible deadline, enter the
  absorbing `preserved` state and cancel the disposition timer before
  attempting the best-effort result send; network delay or failure must not
  roll Preserve back to Discard. Enter `discarded` before erasure/result
  signaling and erase all transient bytes.

## Never acceptable as a workaround

- `rel="opener"` or receiver access to a sender `WindowProxy`;
- cross-origin `postMessage()` as an OAB payload transport;
- public form/HTTP POST, beacon, WebSocket, WebTransport, TURN relay, or public
  storage inbox for base-profile content;
- placing detached/private content into a URL;
- iframe consent;
- fixed-template SDP reconstruction;
- accepting raw/private IP or relay candidates;
- falling back silently;
- buffering received content in IndexedDB and calling it “temporary” (bounded
  content-free replay/admission records are permitted); or
- claiming that a digest, declaration ID, manifest, or product name authenticates
  a sender.

See [docs/threat-model.md](docs/threat-model.md) for assumptions and residual
environmental boundaries.
