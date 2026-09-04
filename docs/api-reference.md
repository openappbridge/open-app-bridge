# Reference SDK API

The dependency-free JavaScript SDK is the executable reference implementation
of the current breaking draft. Its public exports are declared in
`types/index.d.ts`. OAB has two independent transports. Calling a transport API
is an explicit profile choice; no API silently changes profile after a failure.

## Discovery

### `discoverReceiver(origin, options?)`

Fetches `/.well-known/open-app-bridge` with a credential-free,
redirect-free CORS `GET`, parses its bounded JSON declaration, negotiates a
wire version, and returns a frozen `ReceiverDeclaration`. Expected failures
throw `OabError`.

Useful options include:

- `requiredTransport`, which fails unless that profile is explicitly present;
- `supportedWireVersions`, which limits version negotiation;
- `fetchApplicationManifest: false`, which skips optional display metadata;
- `maximumDiscoveryBytes`, which may only tighten the SDK hard limit;
- `timeoutMs`, which defaults to 8,000 ms and is bounded from 100 through
  30,000 ms for the complete discovery fetch and body read;
- `applicationManifestTimeoutMs`, which defaults to 4,000 ms and is bounded
  from 100 through 15,000 ms for optional display metadata; and
- `fetchImpl` and `signal` for integration and cancellation.

The SDK deadline is always active. `signal` may cancel sooner but cannot make a
request unbounded. Discovery timeout throws `discovery_timeout`. Optional
manifest timeout falls back to the verified domain and leaves
`receiver.application` as `null`.

The returned declaration includes:

- `origin`, `endpoint`, `selectedVersion`, `wireVersions`, and `intents`;
- `transports`, a frozen map keyed by transport identifier;
- `transportIds` and `supportsTransport(identifier)`;
- `linkEnvelope` and `detachedDataChannel`, each `null` when absent;
- `declarationId`, `senderPolicy`, `checkedAt`, and `expiresAt`; and
- optional normalized Web App Manifest metadata in `application`.

There is no default transport. Unknown transport identifiers may be retained in
`advertisedTransportIds`, but they are not treated as supported by this SDK.

### `assertFreshDeclaration(value, now?)`

Returns a valid, unexpired `ReceiverDeclaration` or throws. Call it again at
the final handoff boundary if preparation or user choice took appreciable time.

### Application display metadata

- `normalizeApplicationManifest(value, options)` normalizes the supported
  standard manifest members into bounded display-only metadata. A lone UTF-16
  surrogate in any supported string member rejects the complete optional
  metadata rather than silently introducing U+FFFD.
- `fetchReceiverApplicationManifest(origin, manifestValue, options?)` reads an
  advertised, same-origin manifest without credentials, referrer, or
  redirects and validates the bounded response at its exact declared URL.
  `options.timeoutMs` defaults to 4,000 ms and is bounded from 100 through
  15,000 ms; timeout throws `application_manifest_timeout` when called
  directly.
- `selectApplicationIcon(application, preferredSize?)` selects a safe icon
  descriptor; it does not fetch or trust the image.
- `fetchReceiverApplicationIcon(application, options?)` fetches the selected
  exact same-origin static PNG/JPEG with credentials omitted, no referrer, and
  redirects forbidden. It enforces the 256 KiB byte cap, exact declared and
  response media type, PNG/JPEG signature, no APNG, dimensions no greater than
  1,024 by 1,024 or 1,048,576 pixels, and returns verified bytes plus a local
  `Blob`. Its `options.timeoutMs` has the same 4,000 ms default and 15,000 ms
  ceiling; timeout throws `application_icon_timeout`. GIF, WebP, SVG, and ICO
  are not protocol identity icons.

`NETWORK_REQUEST_LIMITS` exposes the immutable SDK minimum, defaults, and hard
ceilings for discovery, application-manifest, and application-icon operations.

Manifest names, descriptions, and icons improve destination UI. They never
replace the canonical receiver origin in identity, consent, or policy.
Render only a locally created Blob URL from `fetchReceiverApplicationIcon()`;
never place an unverified manifest icon URL directly into the page. Revoke the
Blob URL after use, and do not persist manifest URLs, icon URLs, Blob URLs, or
icon bytes in destination history.

Public origins must be HTTPS. `receiverInputToOrigin(domain)` converts a human
domain entry to a canonical HTTPS origin; `receiverOriginToDomain(origin)`
provides a display value. Browser-trusted loopback is the only HTTP exception.

## Content preparation

### `prepareContent(content, limits?)`

Normalizes equivalent Markdown, HTML, and plain-text representations plus
path-free binary assets into `PreparedContent`. It validates representation
types, asset MIME/extension agreement, safe display metadata, and byte limits.
Preparing content does not select or launch a transport.

### `prepareDetachedTransfer(content, options)`

Builds the immutable manifest, bounded data frames, per-item SHA-256 digests,
and final completion frame used by `detached-datachannel/1`. The options object
is required because it must contain a fresh `transferId`; its framing and byte
limit fields are optional. The returned object exposes `manifest`,
`manifestDigest`, `manifestFrame`, `dataFrames()`, `completionFrame`,
`totalFrames`, and the manifest's `totalBytes`.

## Link-envelope sender API

### `createLinkEnvelopeHandoff(receiver, content, options)`

Creates the low-assurance `link-envelope/1` launch object. The caller must set
`contentClassification: "non-confidential"`; omission is an error. The profile
accepts only advertised `text/markdown` and/or `text/plain`, rejects assets and
HTML, and applies both sender and receiver URL/fragment/decoded-byte limits.

The returned frozen value includes `href`, `requestId`, `expiresAt`, byte
counts, `rel: "noopener noreferrer"`, and `referrerPolicy: "no-referrer"`.
It contains no status or receipt. This low-level encoding object does not prove
that a browser navigation was attempted. The profile is one-way and has no
preview or final-disposition receipt.

```js
const encoded = await createLinkEnvelopeHandoff(receiver, preparedContent, {
  contentClassification: "non-confidential",
});
```

This low-level object does not own a DOM node or validate activation. Browser
applications MUST use `createLinkAnchorHandoff()`, call its mandatory
`bind(anchor)` method, and call `activate(event)` from that anchor's trusted
click, unless an audited lower-level adapter reproduces that facade's complete
binding, activation, expiry, single-use, task-boundary, and cleanup contract.
The bound facade validates
exact `href`, `_blank`, `noopener noreferrer`, and `no-referrer` values,
rejects unsafe `download`, `ping`, or attribution attributes, and removes the
actual DOM capability on expiry and every terminal path.

Only a trusted unmodified primary `click` is accepted. Auxiliary clicks,
context menus, drag extraction, and non-primary pointer/mouse down are canceled
and consume the capability into an absorbing non-launch state. Supply
`options.onActivationError({error, eventType})` to update local UI for one of
these guarded gestures; the SDK consumes the capability even when that callback
is omitted or throws.

For an accepted activation, controller-held access is invalidated immediately,
but native default navigation still owns the activated DOM anchor. A manual
low-level integration must keep that anchor, its security attributes, and its
containing Document intact through dispatch and the microtask checkpoint, then
cross at least one complete event-loop task before removing, disabling,
replacing, or unmounting it, closing/rebuilding its host, or emitting any
externally observable launch-indication callback/event. A Promise continuation
or `queueMicrotask()` is insufficient.

### `decodeLinkEnvelopeFragment(fragment, options)`

Strictly validates the canonical fragment, independent byte limits, digest,
strict UTF-8/JCS JSON, wire version, lifetime, declaration binding, source
claims, and portable text. The options object is required because `launchUrl`
binds decoding to the exact receiver launch URL; its limit and clock fields are
optional. It returns a frozen transient offer. It neither authorizes nor
persists it.

### `consumeLinkEnvelope(options)`

Receiver convenience API. It synchronously captures and removes a matching
fragment before its first asynchronous operation, requires a top-level secure
context with no retained cross-origin window relationship, validates the exact
`expectedEndpoint`, atomically admits the replay tombstone plus pending
origin-wide lease through `admitIncomingHandoff`, obtains explicit consent
through `authorizeSender`, promotes the lease, and invokes `deliver` with
transient preview content.

`admitIncomingHandoff({requestId, channelId: null, transport,
replayExpiresAt, pendingExpiresAt, maximumActiveSessions,
maximumReplayClaims})` must coordinate across receiver-origin tabs, workers,
and reload overlap. It returns exact `{admitted: false, reason: "replay" |
"session-capacity" | "replay-capacity"}` or exact `{admitted: true,
promote(), release()}`. A rejection creates no records. The tombstone lasts to
envelope expiry; the pending lease lasts at most 60 seconds and is promoted in
place to envelope expiry only after authorization. The SDK invokes
`release()` idempotently on every terminal path. Missing hooks, malformed
results, errors, and admission/promotion timeouts fail closed.

It returns the delivery or `null` when the URL is not a link-envelope launch.
The source is always unverified (`source.origin === null` and
`evidence.originVerified === false`). Do not apply origin allow/block rules to
claimed application names or URLs.

## High-level native-anchor sender facades

### `createLinkAnchorHandoff(receiver, content, options)`

Builds a one-shot `link-envelope/1` handoff and owns its native-navigation
capability. Call `bind(anchor)` exactly once, then call `activate(event)`
synchronously from that anchor's trusted click. The facade removes unsafe
anchor attributes, validates the exact anchor and navigation policy, invalidates
its retained URL immediately, and clears the accepted activation's DOM `href`
only after at least one event-loop task. Rejected activation and expiry still
fail closed. `activate()` returns a Promise that resolves no earlier than the
required task boundary to a `LinkLaunchIndication` with
`receiptAvailable: false`. It is an unconfirmed local launch indication, not
evidence from the receiver. Validation failures still throw synchronously so
the click handler can cancel native navigation.

### `createDetachedAnchorHandoff(receiver, content, options?)`

Builds the content-free detached offer, transfer manifest/frames, callback
waiter, RTC session, and one-shot anchor capability. Its frozen facade exposes
`requestId`, `expiresAt`, `href`, `state`, `result`, `bind(anchor)`,
`activate(event)`, and `close()`. `activate()` resolves to the sender preview
handle; that handle's `completion` resolves only to the receiver's final
`preserved` or `discarded` result. No failure invokes another profile.

Accepted activation consumes controller-held access immediately while leaving
the activated anchor and Document intact through the required event-loop task.
A host must not synchronously or in a microtask remove, disable, replace, or
unmount that anchor, close/rebuild its host, or emit an externally observable
launch indication. The later preview and completion results are detached
transport evidence; the native navigation itself is not.

### `createHandoff(receiver, content, options)`

Dispatches only on the caller's explicit `options.transport` selection and
returns the corresponding bound-anchor facade. Omission, an unknown profile,
or an unsupported selected profile fails; there is no default or fallback.

## Detached-datachannel sender API

### `createDetachedSenderSession(options)`

Creates a fresh ephemeral P-256 key pair, a browser-generated candidate-free
data-only RTC offer, privacy-preserving host candidates, and the opener-free
receiver launch URL. Required integration values include `senderOrigin`,
`receiverOrigin`, the discovered `receiverEndpoint`, and discovered
`receiverHelper`; pass the exact current public `declarationId`, including
explicit `null` when the declaration omits an identifier.

The returned single-use session exposes:

- `launchHref`, `target`, `rel`, and `referrerPolicy` for the final native link;
- `requestId`, `channelId`, `offer`, and `state`;
- `acceptSealedAnswer(envelope)`, which authenticates/decrypts and applies the
  receiver answer; and
- `sendTransfer(preparedTransfer, options?)`, which runs the live transfer and
  resolves at transient preview with a separate `completion` promise for
  `preserved` or `discarded`.

The prepared transfer is required. The second argument is optional, and every
field in it only tunes bounded timeouts, framing/backpressure, yielding, or
progress reporting. Control-response and per-backpressure waits have a hard
30-second ceiling; the receiver-disposition wait has the separate 60-minute
hard ceiling defined by the profile.

`sendTransfer()` enforces this wire order:

```text
receiver capabilities -> sender manifest -> receiver grant -> sender data
-> receiver previewing -> receiver final result
```

No content-derived title, type, size, hash, filename, or preview metadata is
placed in the signaling bootstrap. Content starts only after a verified live
channel, receiver authorization, capabilities, manifest review, and grant.

### `waitForDetachedAnswer(value, options?)`

Opens the random sender-origin `BroadcastChannel` before launch and returns
`{promise, close}`. The promise yields the sealed answer relayed by the fixed
sender callback page. It accepts only the exact request/channel/receiver tuple.

### `runDetachedSenderCallback(window, options?)`

Runs only at the fixed sender-origin path
`/.well-known/open-app-bridge/callback`. It requires a secure, unframed,
top-level context with no retained cross-origin window relationship, captures
and immediately scrubs the encrypted fragment, verifies that navigation came
from the expected receiver origin, relays the opaque sealed answer over the
random sender-origin channel, releases all rendezvous identifiers, and may
close the callback tab. It resolves with no value so a completed callback
cannot retain request or channel capabilities through its result.

Production helper/callback pages should scrub before their module graph is
evaluated. A parser-blocking classic bootstrap copies exact
`{fragment, href, hadQuery, referrer}`, synchronously removes fragment and
query, then passes that private copy as `options.scrubbedHandoff` to
`runDetachedReceiverHelper()` or `runDetachedSenderCallback()`. The SDK
revalidates that the copy matches the already-clean current origin and path.
See `examples/utility-bootstrap.js`; do not expose the copied object globally.

## Detached-datachannel receiver API

### Signaling and helper functions

- `captureDetachedOfferFromWindow(window, options?)` synchronously captures and
  scrubs a receiver launch. Pass its result to
  `inspectCapturedDetachedOffer(capture, options?)` for validation. A hardened
  route must capture/scrub immediately and defer inspection, offer application,
  and peer creation until the receiver's **Review shared content** action.
- `createDetachedReceiverHelperSession(value, options?)` prepares the
  receiver-origin helper link and same-origin rendezvous. Open its `href` from
  that trusted user action, wait for the content-free `waitUntilReady()`
  completion, then use
  `navigateToCallback(href, senderOrigin)` exactly once. Its bound Verify
  anchor follows the same accepted-activation rule: retain it and its Document
  through at least one event-loop task; a microtask is too early for teardown.
- `runDetachedReceiverHelper(window, options?)` runs on the discovered static
  helper page. It captures/scrubs, announces readiness on the random
  receiver-origin channel, and replaces its own location only with the fixed
  sender-origin callback URL. A scrub-first bootstrap may pass the exact
  private copy as `options.scrubbedHandoff`. `navigationFallbackDelayMs`
  (250–5,000 ms; default 1,500 ms) controls when a same-tab continuation is
  offered if automatic replacement does not complete.
  `onNavigationFallback({href, senderOrigin})` may render that branded control;
  returning exact `true` declares it handled. The link must preserve an origin
  referrer and must not become a second consent step. The fallback delay is a
  best-effort UI threshold, not a navigation or transport SLA.
- `createDetachedAnswerCallbackUrl(senderOrigin, value, options?)` creates the
  bounded encrypted callback URL after answer generation.

The helper and callback carry only signaling. They never carry document
content or persist a delivery.

### `acceptDetachedOffer(offer, options)`

After receiver activation and helper readiness, validates the offer against
the receiver origin, performs bounded browser parsing, creates an ephemeral
receiver key and browser-generated answer, accepts only allowed host
candidates, and returns an accepted session with `sealedAnswer`, a `connected`
promise, and a `channel` that is `null` until connection completes. Its
`receiveTransfer(options)` options object is required: it must provide
`capabilities`, `authorizeVerifiedSender`, `authorizeManifest`, and `onPreview`.
Timeout, rate, item, byte, and crypto-provider fields are optional.

The high- and low-level receiver callbacks are abort-aware. Their signatures
are `authorizeOrigin(evidence, {signal})`,
`authorizeVerifiedSender(evidence, {signal})`,
`authorizeManifest(manifest, digest, {signal, previewAuthorization})`, and
`onPreview(delivery, {signal})`. Terminal cleanup aborts the shared signal and
races every pending callback against invalidation, so a late callback result
cannot resume the state machine. Hosts must honor abort, settle promptly, close
callback-owned UI, and release their argument/result references.

`authorizeOrigin` is the single visible, request-bound preview authorization.
`authorizeManifest` is a post-verification policy gate over that same decision,
not a second prompt. It returns a positive result only when the exact manifest
fits the authorized content/size scope and current session generation.
When the high-level facade invokes it, `previewAuthorization` is frozen evidence
that the SDK has just consumed its closure-private one-use grant bound to the
request, receiver identity/origin, sender origin, profile/intent, exact
capability ceilings, actual expiry, and lifecycle generation. It is descriptive
evidence, not a reusable bearer token. Application code does not create, store,
consume, or revoke the grant. A low-level receiver callback may omit this field;
such an integration owns the burden of reproducing the complete binding.

This is a low-level operation, not a replay or workload-admission boundary. A
receiver must first atomically succeed at
`admitIncomingHandoff({requestId, channelId, transport, replayExpiresAt,
pendingExpiresAt, maximumActiveSessions, maximumReplayClaims})`. This creates
the offer-expiry replay tombstone and short pending lease together or neither,
and returns the exact decision shapes documented above. It must be linearizable
across origin tabs, workers, and reload overlap; missing hooks, malformed
results, errors, or timeout fail closed. Use `captureDetachedReceiverHandoff()` or
`consumeIncomingHandoff()` to have the SDK enforce this ordering before helper,
prompt, crypto, or RTC work.

The pending lease is capped at 60 seconds. After the trusted Review action, the
SDK promotes that same lease in place to `offer.createdAt +
maximumSessionLifetimeMs`, where the hard session envelope is 75 minutes. The
promoted lease remains held through the complete detached lifecycle; the SDK invokes `release()`
idempotently after Preserve, Discard, denial, expiry, abort, page hide, close,
callback/helper/RTC failure, and all other terminal outcomes. The host must
make release idempotent and expiry-clean stale leases after a crashed context.
Promotion returns `false` without mutation unless the existing lease is
unexpired and exactly `pending`, the requested expiry is a future safe integer,
and it does not exceed the host's current time plus the 75-minute lifecycle
limit and permitted clock skew. Promotion is one atomic pending-to-active
transition; it never creates, revives, re-promotes, extends, or consumes a
second slot.

### `receiveDetachedTransfer(channel, options)`

Advertises bounded live `capabilities`, accepts one manifest, calls
`authorizeManifest(manifest, digest, {signal})` before issuing a grant, verifies ordered
frames and all advertised hashes/lengths, then calls
`onPreview(delivery, {signal})`.
The returned handle exposes `preview`, `completion`,
`dispositionExpiresAt`, `preserve(transaction)`, `complete("discarded")`, and
`abort(reason?)`. `preserve()` requires exact `commit(context)` and
`rollback(context)` functions. The commit receives the transient delivery, a
mandatory abort signal, and the user-visible absolute disposition deadline.
It must settle after abort. Rollback must idempotently remove the
receiver-owned durable record even if commit partially or fully completed.
The SDK waits for commit settlement before rollback, records Preserve only
when commit wins the deadline, and records Discard only after successful
rollback. Direct `complete("preserved")` fails closed with
`preserve_transaction_required`.

Preserve activation must immediately expose progress and block duplicate
activation. A conforming receiver may treat a recoverable atomic staging
commit as the Preserve boundary and complete application import after the clean
transition. Failures after that boundary are recovery states, not Discard.

Detached delivery evidence identifies the live sender origin only after the
fixed callback and encrypted peer channel have completed. RTC message events
themselves do not provide a web origin.

## Receiver host and deployment boundary

Every API that adopts a marked handoff runs inside the restricted receiver
Document defined by the core specification. That restriction begins before
capture/scrub and lasts through consent, inert preview, terminal protocol work,
and Preserve finalization. The host must not start analytics/crash telemetry,
advertising/tag managers, authentication or account UI, document sync, remote
fonts, CDN renderers, third-party resources, speculative loads, or ordinary
application service workers in that Document. Received and claimed URLs are
never fetched.

The detached receiver helper and fixed sender callback are restricted OAB
utility Documents for their complete lifetimes and follow the same application-
service/resource prohibition. Scrubbing or completing their utility work does
not turn them into ordinary application pages.

Preserve commits only an inert receiver-owned durable record. Following every
terminal outcome, including Preserve, Discard, denial, expiry, cancellation, or
error, finish transient cleanup and attempt any available best-effort detached
final result. A content-free terminal message may remain only while the
Document stays restricted. Before ordinary application startup, close it or use
full top-level navigation to a clean query-free and fragment-free application
URL. Only the new ordinary application Document may select, open, richly
render, execute, or resolve references from the record. A SPA, history, or
widget state change is not this transition.

Discovery, every receiver/helper/callback Document, and their complete
transitive packaged resource graphs are network-authoritative. Every request in
that graph receives no service-worker fetch-event handling and proceeds
directly to the network; `respondWith(fetch(event.request))` remains
non-conformant interception. A controlling migration worker must not message or
telemeter restricted OAB Documents or start OAB-related background work. If any
historical worker could control any authority-resource request, keep OAB disabled for a
separate migration deployment that retires or replaces every historical worker,
verify every historical script/scope combination from a previously controlled
client, and enable OAB only in a later deployment. Calling `unregister()` from
the already controlled page or moving to a new versioned path is insufficient.

## Local sender policy helpers

`normalizeSenderPolicy`, `evaluateSender`, `allowOrigin`, `blockOrigin`, and
`removeOriginRule` implement exact-origin allow/block/ask primitives for
verified detached senders. Block rules take precedence. Link-envelope sources
are unverified and require a separate consent policy; claimed labels or URLs
must not become origin rules.

## Error handling and cleanup

Expected failures use `OabError` with a stable `code`. Branch on `code`, not
message text, and render unknown remote failures generically. Every terminal
path must close peer connections, data channels, rendezvous channels, timers,
object URLs, and transient payloads. A detached failure must fail closed; it
must never initiate link-envelope automatically.
