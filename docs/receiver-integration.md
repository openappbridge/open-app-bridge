# Receiver integration

A receiver opts in through one bounded JSON declaration and implements every
advertised profile end to end. Discovery, capture, authorization, transient
preview, and explicit Preserve/Discard are all part of conformance. The
normative product behavior, including the one-prompt rule, is in
[`human-interaction-contract.md`](human-interaction-contract.md).

Before implementing preview UI, adopt the normative
[inert preview contract](inert-preview-contract.md). The safest conforming path
is a receiver-owned document model with raw HTML disabled and text-node output;
the reference receiver deliberately renders content with `textContent` only.

Public routes require HTTPS. Browser-trusted loopback HTTP is for development
only.

## 1. Publish canonical JSON discovery

Serve a credential-free, redirect-free CORS `GET` at:

```text
/.well-known/open-app-bridge
```

An example receiver supporting both independent profiles:

```json
{
  "protocol": "org.openapp.bridge",
  "wireVersions": ["1.0"],
  "status": "enabled",
  "endpoint": "/_oab/receive",
  "intents": ["preview"],
  "transports": {
    "link-envelope/1": {
      "representations": ["text/markdown", "text/plain"],
      "assetTypes": [],
      "limits": {
        "maximumUrlBytes": 16384,
        "maximumFragmentBytes": 12288,
        "maximumDecodedBytes": 8192
      }
    },
    "detached-datachannel/1": {
      "representations": ["text/markdown", "text/html", "text/plain"],
      "assetTypes": ["image/png", "image/jpeg", "image/svg+xml"],
      "receiverHelper": "/_oab/detached-helper",
      "limits": {
        "maximumTransferBytes": 16777216,
        "maximumAssets": 32,
        "maximumSignalingBytes": 32768,
        "maximumFrameBytes": 16384
      }
    }
  },
  "senderPolicy": "ask",
  "declarationId": "deployment-2026-08-28-a",
  "discoveryTtl": 300,
  "applicationManifest": "/manifest.webmanifest"
}
```

The top-level object is exact: custom data belongs only under `extensions`.
Known transport configurations and their nested `limits` are exact objects.
Every profile is explicit; omission means unsupported and there is no default.
Unknown profile IDs may be ignored, never reinterpreted as a known profile.

Use these HTTP properties:

```http
Content-Type: application/json
Access-Control-Allow-Origin: *
Cache-Control: public, max-age=300
X-Content-Type-Options: nosniff
```

Do not enable `status` until every advertised path and abuse control works. The
optional `declarationId` is public freshness/configuration binding, not a secret
or authentication proof. Web App Manifest metadata is untrusted display data;
keep the receiver origin visible.

## 2. Harden all receive routes

The receive, helper, and callback routes must be minimal first-party resources.
They must run in a secure, top-level context and refuse framing. Recommended
baseline headers for the receive route and fixed sender callback are:

```http
Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'
Referrer-Policy: no-referrer
Cache-Control: no-store
X-Content-Type-Options: nosniff
```

The detached receiver helper is the deliberate exception to the baseline
referrer policy: its response MUST set `Referrer-Policy: origin`. That browser-
controlled origin referrer supplies browser-observed receiver-origin evidence
for the helper's navigation at the fixed sender callback. It is not
cryptographic attestation and is accepted only with the complete transcript
checks. Do not set `no-referrer`, a stricter policy, or a meta policy
that can suppress it on the helper response. All other hardening headers still
apply.
See the normative [utility-page lifecycle](utility-page-lifecycle.md) for
fallback timing and callback closure semantics.

The restriction lasts for the complete marked receive Document, not only until
fragment scrubbing. The detached receiver helper and fixed sender callback are
restricted OAB utility Documents for their complete lifetimes too. Do not
initialize analytics, telemetry/crash reporting, tag managers, advertisements,
authentication/account prompts, background document sync, remote fonts, CDN
renderer resources, speculative loads, third-party scripts/styles/images, or
ordinary application service workers in any of those Documents. Never fetch a
received or claimed URL there, and never log complete launch or callback URLs.
Strict COOP can remain enabled because the current profiles do not retain
cross-origin window relationships.

`defer` and `type="module"` alone are not scrub-first: their code runs only
after parsing and module-graph loading. Put a tiny parser-blocking classic
script before CSS and visible DOM. It must privately copy exact
`{fragment, href, hadQuery, referrer}`, synchronously call
`history.replaceState()`, and only then dynamically import the helper/callback
module and pass the copy as `scrubbedHandoff`. Keep the copy in a closure, clear
it after installation, and never attach it to `window`. The reference pattern
is `examples/utility-bootstrap.js`.

Discovery, every receive/helper/callback Document, and every transitive
packaged resource loaded by those Documents must remain network-authoritative.
Every HTML, parser-blocking bootstrap, module, stylesheet, and other dependency
request receives no service-worker fetch-event handling and proceeds directly to the network;
`respondWith(fetch(event.request))` is still interception and is
non-conformant. A controlling migration worker must not message or telemeter a
restricted OAB Document or start OAB-related background work. If a historical
worker could control any route, first ship a separate release with discovery
disabled that retires or replaces every historical worker with a verified
non-intercepting worker. Test every historical script/scope combination from a
previously controlled client before enabling OAB in a later release.
Unregistering from the enabling page and moving to a versioned path are
insufficient; use a fresh never-controlled origin or remain disabled when
migration cannot be proven.

The deployment files in `examples/server-configs/` are routing/header
skeletons, not a runnable receiver. Their referenced HTML files and complete
transitive resource graph are application-supplied build outputs. Package every
parser-blocking bootstrap, module and imported module, stylesheet, font, image,
and other dependency of the three restricted Documents below the reserved
`/_oab/resources/` prefix, apply `Cache-Control: no-store`, same-origin resource
policy, no-referrer, and `nosniff` to the prefix, and keep ordinary app assets
out. If a deployment uses different paths, maintain and test an explicit
equivalent inventory; protecting only the three HTML routes is insufficient.

After synchronous capture and scrub, a web receiver SHOULD wait until its
top-level Document is visible and focused before invoking persistent admission
or showing consent UI. Keep the copied handoff only in bounded volatile memory
while waiting, abort on page hide/expiry, and revalidate freshness afterward.
Visibility/focus is abuse resistance, not user activation or identity proof.

## 3A. Receive a link envelope

Run `consumeLinkEnvelope()` before normal application initialization:

```js
const delivery = await consumeLinkEnvelope({
  expectedEndpoint: `${location.origin}/_oab/receive`,
  declarationId: configuredDeclarationId,

  async admitIncomingHandoff(request) {
    return admitReplayAndPendingLeaseAtomically(request);
  },

  async authorizeSender({ source, evidence }) {
    return showUnverifiedSourceConsent({ source, evidence });
  },

  async deliver(value) {
    await showTransientPreview(value);
  },
});
```

The API captures and removes the fragment before its first await, rejects
framed or retained-window launches, validates the exact endpoint and all
limits, and requires one atomic replay-and-capacity admission.
`admitIncomingHandoff` receives `{requestId, channelId: null, transport,
replayExpiresAt, pendingExpiresAt, maximumActiveSessions,
maximumReplayClaims}`. In one linearizable transaction it prunes expired
records, checks replay and both ceilings, and creates both a replay tombstone
and pending lease or neither. It returns exact `{admitted: false, reason:
"replay" | "session-capacity" | "replay-capacity"}` or exact `{admitted:
true, promote(), release()}`. Coordinate the store across tabs, workers, and
reload overlap; per-tab memory and `sessionStorage` are not sufficient.

The pending lease lasts no more than 60 seconds. After Review once, the SDK
calls `promote({expiresAt: envelopeExpiry})` and requires exact `true` before
delivery. The replay tombstone remains until envelope expiry regardless of
denial or release and is never LRU-evicted early. The SDK invokes `release()`
idempotently on success and every error, expiry, cancellation, page-hide, or
denial path. Absence, malformed admission, callback error, admission/promotion
failure, or timeout fails closed.

The host performs promotion as one atomic pending-to-active update. It returns
`false` without mutation when the lease is absent, expired, or not exactly
`pending`, or when the requested expiry is not a future safe integer bounded by
the applicable lifecycle limit plus permitted clock skew. It never creates or
revives a lease, extends an already-active lease, or consumes a second slot.

The link source is always **Unverified app or website**. Its application label
and URL are claims. Never use them for origin allowlists, blocklists, account
binding, or automatic fetches. The profile is one-way, so Preserve/Discard is
local and no result goes to the sender.

After every terminal outcome, including Preserve, Discard, denial, expiry,
cancellation, or error, erase transient state. A content-free terminal message
may remain only while this Document stays restricted. Before ordinary
application startup, close it or perform a full top-level `location.replace()`
to a clean same-origin application URL. Do not select, richly render, or resolve
references from preserved content before that new Document loads. SPA routing
or a widget rebuild retains the restricted Document and is not sufficient.

## 3B. Receive a detached data-channel handoff

The detached profile uses three independent top-level contexts:

- sender main page and fixed sender callback, joined only by a random
  sender-origin `BroadcastChannel`;
- receiver main page and discovered receiver helper, joined only by a random
  receiver-origin `BroadcastChannel`; and
- receiver and sender peers, joined by one ordered, reliable, DTLS-protected
  RTC data channel after validation.

No context receives a cross-origin `WindowProxy`. All new-context links use
`noopener noreferrer` and no referrer.

### Receiver main route

On first script execution:

1. synchronously copy the bounded, profile-marked raw fragment to volatile
   memory and remove it with `history.replaceState()` before any validation,
   logging, rendering, or other work;
2. then require a secure, unframed top-level context with no retained opener;
3. validate the captured endpoint and fragment bounds;
4. perform no logging or received-content rendering and no content-derived or
   third-party network request; only the exact current same-origin discovery
   read needed to bind the declaration may precede authorization, and no offer decode,
   key import, SDP application, candidate addition, or peer creation occurs; and
5. render a branded receiver-controlled **Review shared content** action that
   makes clear the displayed sender identity is still being checked.

Before displaying that action, use `captureDetachedReceiverHandoff()` (or the
profile-dispatching `consumeIncomingHandoff()`) with all required coordination
hooks:

```js
const handoff = captureDetachedReceiverHandoff(receiverDeclaration, {
  async admitIncomingHandoff(request) {
    return admitReplayAndPendingLeaseAtomically(request);
  },

  async reserveIncomingBytes(request) {
    return reserveOriginWideBytesAtomically(request);
  },

  async authorizeOrigin(request, { signal }) {
    return showOnePreviewAuthorization(request, { signal });
  },

  async authorizeManifest(manifest, manifestDigest, { signal }) {
    return evaluateManifestAgainstPreviewAuthorization(
      { manifest, manifestDigest },
      { signal },
    );
  },

  async onPreview(delivery, { signal }) {
    await showTransientPreview(delivery, { signal });
  },
});

const prepared = await handoff.prepare();
```

`admitIncomingHandoff` receives the `(requestId, channelId)` tuple, detached
transport ID, offer expiry, a no-more-than-60-second pending expiry, and local
ceilings. One origin-wide linearizable transaction prunes expiry-indexed state,
checks replay and capacity, and creates both the offer-expiry tombstone and
pending lease or neither. After the one trusted Review action, the SDK calls
`promote()` on that same lease with the 75-minute hard stale expiry before RTC
work. A live tombstone is never evicted early. A pre-verification sender-origin
claim must not partition these limits because it is not yet trusted.
After a manifest passes structural/capability checks and before authorization
or allocation, `reserveIncomingBytes` receives the authenticated transfer size,
IDs, expiry, and the 64 MiB hard origin-wide aggregate ceiling. It must perform
one atomic live-reservation transaction and return `{reserved: false}` or exact
`{reserved: true, release()}`. The SDK grants no bytes without this lease and
releases it on every terminal path. A per-tab counter is not conformant.

Call `prepared.bind(anchor)` to bind the capability to exactly one real anchor.
The SDK installs the prepared URL, target, relationship, and referrer policy,
removes unsafe anchor attributes, clears the DOM capability at expiry, and
validates the same attributes during activation. Its trusted primary click invokes
`prepared.verify(event)` synchronously while the browser performs the native
navigation; do not replace it with `window.open()` or cancel a valid
navigation. The helper must announce ready on the exact random receiver-origin
channel within 15 seconds. Only then does the controller authorize the claimed
origin, validate the captured offer, and call the low-level
`acceptDetachedOffer()` operation.

After an accepted preview-authorization activation, invalidate controller-held access
immediately but retain the helper anchor, its `href`, security attributes, and
containing Document through dispatch and its microtask checkpoint. Cross at
least one event-loop task before removing, disabling, replacing, or unmounting
the anchor, closing/rebuilding its host, or emitting any externally observable
launch-indication callback/event.

`authorizeOrigin` is the one visible preview-authorization surface. Bind its
decision to the request ID, claimed origin, chosen transport, allowed content
classes and sizes, expiry, and session generation. `authorizeManifest` is a
silent policy gate that verifies the exact manifest remains within that
decision; it MUST NOT show the same approval again. A materially broader
manifest is denied or, only when unavoidable, presented as an explicit
scope-expansion decision.

The offer validator bounds and lexically gates the browser-generated,
candidate-free data-only SDP before the browser parses it. It accepts only the
profile's privacy-preserving host candidate policy, uses no STUN/TURN servers,
and rejects media tracks/transceivers. Failure is terminal; do not weaken the
candidate policy.

### Receiver helper route

The helper is the exact same-origin, query-free path advertised as
`receiverHelper`. Its response sets `Referrer-Policy: origin`; its complete
runtime is:

```js
runDetachedReceiverHelper(window);
```

It captures/scrubs its fragment, confirms top-level/no-opener state, announces
readiness over the random local channel, accepts one bounded callback command,
and replaces its own location with the fixed sender-origin callback. It never
sees document content.

Provide `onNavigationFallback({href, senderOrigin})` when the host wants to
render its own branded continuation. If automatic replacement is blocked, the
helper must show a same-tab link to that exact validated `href`, with
`referrerPolicy="origin"`; it is a continuation control, not another approval.
The fallback timer is best effort and is not a transport latency promise.

After `acceptDetachedOffer()` returns, create the encrypted callback URL and
send it through the helper session:

```js
const callbackHref = await createDetachedAnswerCallbackUrl(
  accepted.offer.senderOrigin,
  {
    requestId: accepted.requestId,
    channelId: accepted.channelId,
    receiverOrigin: location.origin,
    envelope: accepted.sealedAnswer,
  },
);

helperSession.navigateToCallback(callbackHref, accepted.offer.senderOrigin);
```

The receiver answer is ephemeral-ECDH/AES-GCM protected and transcript-bound
to the request, channel, origins, declaration, and exact signaling. The helper
cannot redirect to an arbitrary sender path.

### Authorize and receive content

Once the channel is live, call `accepted.receiveTransfer()` with the current
receiver capabilities:

```js
const incoming = accepted.receiveTransfer({
  capabilities: {
    representations: ["text/markdown", "text/html", "text/plain"],
    assetTypes: ["image/png", "image/jpeg", "image/svg+xml"],
    maximumTransferBytes: 16777216,
    maximumAssets: 32,
    maximumFrameBytes: 16384,
  },

  async authorizeVerifiedSender(evidence, { signal }) {
    return authorizePreviouslyConditionedOrigin(evidence, { signal });
  },

  async authorizeManifest(manifest, manifestDigest, { signal }) {
    return evaluateManifestAgainstPreviewAuthorization({
      origin: accepted.offer.senderOrigin,
      manifest,
      manifestDigest,
    }, { signal });
  },

  async onPreview(delivery, { signal }) {
    await showTransientPreview(delivery, { signal });
  },
});

const delivery = await incoming.preview;
```

All four receiver host callbacks receive an immutable abort context. On any
terminal transition the SDK aborts the signal and ignores late settlement. The
host must use it to dismiss consent/preview UI, stop callback-owned work, settle
promptly, and drop arguments/results; a late positive decision must never be
used to mutate UI or persist content.

The required order is:

```text
capabilities -> manifest -> grant -> bounded data frames
-> previewing -> final result
```

The bootstrap and answer carry no content-derived metadata. Do not authorize
from a title, filename, type, digest, or size seen before the live channel.
Within the channel, review the manifest before granting bytes, then recompute
every length and SHA-256 digest before preview.

When the user chooses:

```js
if (userChosePreserve) {
  const localId = createReceiverOwnedDocumentId();
  try {
    await incoming.preserve({
      commit: ({ delivery, signal, dispositionExpiresAt }) =>
        commitAtomically(localId, delivery, { signal, dispositionExpiresAt }),
      rollback: () => deleteDurableDocument(localId),
    });
  } finally {
    await eraseTransientPreviewAndDropReferences();
    location.replace(`/documents/${encodeURIComponent(localId)}`);
  }
} else {
  try {
    await incoming.complete("discarded");
  } finally {
    await eraseEveryTransientByteAndDropReferences(delivery);
    location.replace("/documents");
  }
}
```

`preserve()` is the only valid Preserve path. Its transaction must honor the
abort signal and its rollback must be idempotent and capable of removing the
receiver-owned record whether commit completed, failed, or was aborted. The
SDK waits for a losing commit to settle, invokes rollback, and only then records
Discard. A rollback failure is terminal and is never falsely reported as
Discard. `delivery.dispositionExpiresAt` and
`incoming.dispositionExpiresAt` expose the same user-visible deadline.

When Preserve is activated, disable duplicate activation and display progress
immediately. The atomic durable staging record may be the Preserve boundary;
after it succeeds, release transient OAB state and continue ordinary app import
from that recoverable record after the clean transition. A later import failure
is shown as recoverable work, never rewritten as Discard.

Once `preserve()` succeeds or `complete("discarded")` accepts Discard, the
local disposition is absorbing; losing the best-effort result frame cannot
roll it back. The SDK invokes the admission
lease's idempotent `release()` on Preserve, Discard, denial, expiry, abort,
page hide, close, callback/helper/RTC failure, and every other terminal path.
The host must additionally expire a stale lease after a crashed context. Close
RTC, helper, rendezvous, timers, object URLs, and transient buffers on every
final or error path.

Attempt any available best-effort detached final result before teardown. After
every terminal outcome, including Preserve, Discard, denial, expiry,
cancellation, or error, complete terminal cleanup. A content-free terminal
message may remain only while the receiver Document stays restricted. Before
ordinary application startup, close it or perform a full top-level navigation
to a clean, query-free, fragment-free application URL. The durable
receiver-owned record may be selected and rendered only by that new ordinary
application Document; SPA/history state changes are not an equivalent boundary.

## 4. Consent and sender policy

For link-envelope, show unverified source status and allow only receiver-side
Review once/Not now decisions unless the user creates a separate content policy.
Claimed source labels are not identities.

For detached data-channel, the callback plus live encrypted channel binds the
sender's web origin. Show that canonical origin as primary identity and offer
Allow once, Always allow, Block, and Not now according to local policy. Block
rules take precedence. Keep trust lists local; never publish them in discovery.

Sender-origin verification is not user identity, application attestation, or a
claim that the sender content is safe.

## 5. Active content and persistence

Never inject incoming HTML directly into the receiver document. Sanitize it in
an isolated allowlist renderer or convert it to a safe native document model.
Do not fetch Markdown images, links, claimed source URLs, SVG resources, or
other received references at any time in the restricted receiver Document,
including after consent during transient preview. Reference resolution is an
ordinary application action after Preserve and the clean full-document
transition.

Before Preserve, keep payloads transient and revoke any preview object URLs.
On every terminal outcome, drop all host references to the manifest, delivery,
fulfilled preview value, representations, assets, and receive handle, and
revoke preview object URLs. The SDK cannot revoke a JavaScript object that host
code retained. On Discard, expiry, navigation, or error, erase transient state.
Durable storage begins only after the user's explicit Preserve action.

Preserve does not authorize execution or reference loading in the receive
Document. Treat the durable record as inert until terminal cleanup and the
clean full-document transition described above.
