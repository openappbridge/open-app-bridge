# Open App Bridge Protocol 1.0

**Status:** Breaking draft for interoperability and security testing

**Protocol identifier:** `org.openapp.bridge`

**Wire version:** `1.0`

## 1. Abstract

Open App Bridge (OAB) is a registry-free, user-mediated protocol for
transferring editable content from browser or installed applications to web
applications. A user chooses a receiver domain. The sender verifies a bounded
HTTPS discovery document on that origin and explicitly selects one mutually
supported transport profile. The receiver validates the transfer, asks the
receiver user, presents a transient preview, and persists only after an
explicit Preserve action.

Received content is persisted only after Preserve; validation, authorization,
transfer completion, and preview are not persistence authority.

OAB defines no receiver registry, account system, signaling service, payload
relay, public HTTP content inbox, or required operating-system integration.
Transport profiles MUST NOT give a receiver a navigable reference to a sender
browsing context.

This draft defines two independent profiles:

- [`link-envelope/1`](transports/link-envelope-1.0.md) for bounded,
  non-confidential portable text; and
- [`detached-datachannel/1`](transports/detached-datachannel-1.0.md) for
  confidential, larger, or binary direct transfers over an encrypted
  opener-free data channel.

Neither profile is a fallback for the other. `browser-window/1` and
`native-link/1` are removed draft transports and are not conformant to this
revision.

## 2. Conformance language

The key words **MUST**, **MUST NOT**, **REQUIRED**, **SHALL**, **SHALL NOT**,
**SHOULD**, **SHOULD NOT**, **RECOMMENDED**, **NOT RECOMMENDED**, **MAY**, and
**OPTIONAL** are to be interpreted as described in BCP 14 when, and only when,
they appear in all capitals.

## 3. Terms

- **Sender:** A browser or installed application preparing content.
- **Browser sender:** A sender executing in a secure top-level browsing
  context.
- **Installed sender:** A mobile or desktop application that can perform HTTPS
  discovery and open an HTTPS URL.
- **Receiver:** A web application that explicitly advertises OAB, validates a
  handoff, obtains receiver-user consent, and presents a preview.
- **Receiver domain:** A user-entered hostname or host-and-port without a
  scheme, credentials, path, query, or fragment.
- **Receiver origin:** The canonical HTTPS origin derived from that domain.
- **Sender origin:** For `detached-datachannel/1`, the HTTPS origin hosting the
  live browser sender and its fixed callback resource.
- **Wire version:** An exact protocol grammar selected from the receiver's
  advertised list.
- **Transport profile:** An independently versioned handoff mechanism.
- **Transient:** Held only in volatile runtime state and discarded on denial,
  timeout, reload, or Discard. IndexedDB, local storage, caches, file systems,
  and servers are not transient storage.
- **Preserve:** The receiver user's explicit authorization to write accepted
  content into receiver-controlled durable storage.
- **Preview authorization:** One request-bound receiver-user decision that
  permits sender verification, validation of one compatible manifest, bounded
  transfer, and one inert preview. It does not permit durable storage.
- **Erase:** Remove all application references and durable copies, revoke
  derived object URLs, and overwrite owned mutable buffers where practical.
  Managed browser runtimes do not expose proof of physical memory zeroization.
- **Observed evidence:** A property enforced or directly exposed by the
  transport, rather than claimed by an application.
- **Restricted receiver document:** The top-level Document that captures an
  OAB launch and remains isolated from ordinary application startup until it
  closes or performs the required clean full-document transition.
- **Restricted OAB utility document:** A profile-defined helper or callback
  Document that handles OAB capability or signaling state and remains isolated
  from ordinary application startup for its complete lifetime.
- **OAB authority resource graph:** The discovery response; each restricted
  receiver, helper, or callback Document response; and every transitive
  same-origin packaged script, module import, stylesheet, image, font, worker,
  or other subresource loaded by those Documents. A resource stays in this
  graph even when its URL is shared with a non-OAB page.
- **Launch indication:** A sender-local report that a valid trusted activation
  was given an opportunity to perform native navigation. It is not receiver
  evidence or a delivery receipt.

Unless a field says otherwise, an OAB value described as unpadded base64url
uses the RFC 4648 URL-safe alphabet, contains no `=` padding, decodes without
ignored characters, and MUST reproduce the identical string when those bytes
are re-encoded without padding. This canonical round trip rejects impossible
lengths and non-zero unused pad bits.

## 4. Invariants

Every conforming implementation MUST preserve all of these invariants:

1. There is no mandatory registry or central service.
2. A receiver is disabled unless its origin explicitly opts in through the
   discovery document.
3. Discovery never contains or receives document bodies or private assets.
4. Discovery and Send are separate user interactions.
5. No OAB profile submits content to a public HTTP payload endpoint.
6. A receiver runtime operates only as a top-level browsing context and MUST
   refuse to operate when `window.top !== window`.
7. Every launch that creates a browsing context MUST use `noopener` and
   `noreferrer`. A receiver MUST never obtain or retain a `WindowProxy` for the
   sender. The detached helper's later self-navigation is the sole referrer
   exception and creates no browsing context or opener.
8. A transfer profile MUST be explicitly advertised and explicitly selected.
   There is no implied default.
9. A failed, unavailable, or oversized profile MUST fail closed. It MUST NOT
   silently invoke a different profile.
10. A normal handoff uses one request-bound preview authorization. Internal
    origin, channel, manifest, and policy gates MUST NOT become repeated user
    approvals when scope has not changed. Content remains transient through
    preview and is persisted only after the separate Preserve decision.
11. Claimed names, URLs, titles, manifests, and user-activation statements are
    untrusted unless a profile defines stronger observed evidence.
12. Production discovery, sender, receiver, helper, and callback resources use
    HTTPS and secure contexts. Only browser-trusted loopback development
    origins may use HTTP.
13. The complete OAB authority resource graph is network-authoritative. A
    service worker MUST NOT receive fetch-event authority over, synthesize,
    cache, replay, rewrite, inspect, or telemeter any response in that graph.
14. A marked receiver launch runs in a restricted receiver document. Preserve
    authorizes durable storage, not execution, rich rendering, reference
    resolution, or ordinary application startup in that Document.
15. A `link-envelope/1` launch indication is explicitly unconfirmed and MUST
    NOT be represented as receipt, delivery, preview, acceptance, or Preserve.

## 5. Receiver discovery

### 5.1 Address and request

The sender derives an HTTPS origin from the user-selected receiver domain and
performs a CORS-enabled `GET` request to:

```text
<receiver-origin>/.well-known/open-app-bridge
```

Derivation uses the browser URL Standard: prepend `https://` to domain-only
input, parse it as a URL, require an origin-only value, and serialize its
`origin`. The serialized ASCII host, lower-casing, IPv6 brackets, and omission
of a scheme-default port are therefore canonical. User information, a path
other than `/`, query, fragment, opaque origin, and an input that changes origin
under reparsing are invalid. Product UI may also display Unicode IDN text, but
protocol comparison and security UI retain the canonical ASCII serialization.

The request MUST:

- use `credentials: "omit"`;
- use `redirect: "error"` and follow no redirect;
- use a no-referrer policy;
- bypass ambient HTTP caches for the active check;
- accept at most 8,192 response bytes before JSON parsing; and
- require a successful HTTP status and the final response URL to equal the
  requested URL.

The sender MUST apply a hard deadline to the complete well-known discovery
request, including response-body consumption; aborting only the initial
`fetch()` is insufficient. The recommended default is 8,000 ms and the
deadline MUST NOT exceed 30,000 ms. Expiry aborts the request and fails
discovery closed. A
caller-provided cancellation signal MAY shorten this deadline but MUST NOT
disable or extend its hard ceiling.

The response MUST be valid UTF-8 JSON. Receivers SHOULD serve
`application/json`, but senders MAY accept `application/octet-stream` or
`text/plain` because some static hosts assign generic media types to
extensionless well-known resources. Media-type tolerance never relaxes the
byte limit or JSON validation. JSON nesting deeper than 32 levels is invalid,
and duplicate object member names are rejected before ordinary JSON parsing.

The receiver MUST make the response readable through CORS. It MUST NOT require
cookies, HTTP authentication, client certificates, or application accounts for
public discovery. A sender MUST NOT infer support from HTML, branding, a PWA
manifest, remembered history, or the existence of a receiver route.

### 5.2 Canonical declaration

A declaration has the following form:

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
        "maximumUrlBytes": 65536,
        "maximumFragmentBytes": 32768,
        "maximumDecodedBytes": 24576
      }
    },
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
  },
  "declarationId": "2026-08-28T00:00:00Z",
  "senderPolicy": "user-controlled",
  "discoveryTtl": 300,
  "applicationManifest": "/manifest.webmanifest",
  "extensions": {}
}
```

Required top-level members are:

| Member         | Requirement                                                                                                         |
| -------------- | ------------------------------------------------------------------------------------------------------------------- |
| `protocol`     | Exactly `org.openapp.bridge`                                                                                        |
| `wireVersions` | Non-empty, unique list of supported wire-version strings in receiver preference order                               |
| `status`       | Exactly `enabled`                                                                                                   |
| `endpoint`     | Same-origin absolute path beginning `/`, with no query, fragment, backslash, credentials, or encoded path traversal |
| `intents`      | Unique list containing `preview`                                                                                    |
| `transports`   | Non-empty object whose keys are versioned profile identifiers                                                       |

Each wire-version string matches
`[1-9][0-9]*\.[0-9]+(?:-[a-z0-9.-]+)?`. Each transport identifier matches
`[a-z][a-z0-9-]*/[1-9][0-9]*(?:\.[0-9]+)?`. These are opaque exact
identifiers after syntax validation; senders MUST NOT infer ordering or
compatibility from their components.
`wireVersions` contains at most eight entries. The receiver-declaration 1.0
schema requires `1.0` to be present but permits bounded future identifiers so
an implementation can choose the first receiver-preferred exact version it
actually supports.

JSON member names MUST be unique. Unknown top-level members and known members
with the wrong type or value invalidate the declaration. Extensions appear only
inside the optional `extensions` object and MUST NOT redefine, relax, or
participate in the interpretation of a core member. Values MUST NOT be coerced.
Strings are compared exactly after JSON decoding and are not case-folded.

The endpoint is resolved against the verified receiver origin and MUST remain
on that exact origin. It begins with exactly one `/`; a network-path reference
beginning `//` is invalid. Any raw `%` is invalid, so percent-encoded
separators, traversal, controls, and double-encoding cannot enter this path
grammar. Decoded `.` or `..` path segments, backslashes, and control
characters are also invalid. The serialized absolute endpoint is at most
2,048 UTF-8 bytes.

### 5.3 Optional members

`senderPolicy` is an untrusted public summary such as `ask`, `allowlist`,
or `user-controlled`. When present it matches `[a-z][a-z0-9-]{0,63}`. Live
receiver authorization is authoritative. Per-user allowlists and blocklists
MUST NOT be published in discovery.

`declarationId` MAY be a public opaque ASCII string of 8–512 characters
identifying the current declaration revision. An absent member and JSON `null`
both mean that the receiver did not publish one. Profiles bind either the exact
string or that null state into a handoff to detect stale configuration. It is
readable by every origin, can be copied or replayed, and is neither a secret
nor authentication proof.

`declarationId` is the only optional declaration member for which explicit
JSON `null` is valid. `senderPolicy`, `discoveryTtl`, `applicationManifest`,
top-level `extensions`, and transport-level `extensions` are either omitted or
carry their defined non-null type; explicit `null` invalidates that member.

`discoveryTtl` is a positive integer number of seconds. Values above 3,600 are
invalid. A missing value defaults to 300; a present value MUST be from 1 through
3,600. A sender MUST perform fresh discovery after expiry and SHOULD refresh it
immediately before a high-value detached transfer.

`applicationManifest` MAY be a same-origin, query-free, fragment-free absolute
path to a Web App Manifest and follows the same raw-path traversal rules as the
endpoint, including the 2,048-byte resolved-URL limit. It is untrusted display
metadata, not identity or consent. Fetches
MUST omit credentials and referrer, reject redirects, require the final URL to
equal the requested URL, stay on the receiver origin, require fatal UTF-8, and
accept at most 32 KiB under canonical `Content-Length` and streaming bounds.
Only `application/manifest+json` and `application/json` are accepted.

Application-manifest retrieval is optional and has an independent hard
deadline covering both fetch and body consumption. Its recommended default is
4,000 ms and it MUST NOT exceed 15,000 ms. Expiry aborts that request and falls
back to the canonical receiver domain; it does not invalidate an otherwise
valid discovery declaration.

The manifest and any selected icons MUST be CORS-readable by sender origins.
Senders use at most 80 scalar values of `name`, 40 of `short_name`, 240 of
`description`, a validated hexadecimal `theme_color`, and the first eight safe
same-origin static PNG or JPEG icon candidates. Each selected icon is fetched
separately with an independent hard deadline whose recommended default is
4,000 ms and which MUST NOT exceed 15,000 ms. Icon timeout aborts the request
and falls back to a local non-image glyph. Icon fetches use
credentials and referrer omitted, redirects rejected, exact final URL and
expected media checked, canonical `Content-Length`, and a streaming hard limit
of 262,144 bytes. Raster dimensions are at most 1,024 by 1,024 and at most
1,048,576 pixels. The selected expected media type, response media type, and file
signature MUST agree exactly on static PNG or JPEG. When the manifest omits
`type`, a sender MAY derive the expected type only from an unambiguous lowercase
or case-folded `.png`, `.jpg`, or `.jpeg` URL pathname suffix; response type and
signature still MUST equal that expectation. GIF, WebP, SVG, ICO, every
animated image, and every other format are rejected; a sender MUST NOT invoke
an image decoder for a rejected format.

All supported manifest string members, including icon string members, MUST be
Unicode scalar strings. A JSON escape containing a lone UTF-16 high or low
surrogate invalidates the complete optional manifest metadata; implementations
MUST NOT normalize it into U+FFFD or retain a partially normalized identity.

Only a verified local Blob URL or a non-image local glyph is shown; sender UI
MUST NOT assign an unverified manifest URL directly to an image element. Blob
URLs are revoked after use. The verified receiver domain remains visible
beside every manifest-derived name and icon. Branding never affects
capabilities or authorization. Destination history MAY retain only the
canonical receiver origin plus bounded `name`, `short_name`, `description`,
and validated `theme_color`. It MUST NOT retain `applicationManifest`, icon
URLs, verified Blob URLs, or fetched icon bytes.

### 5.4 Transport declarations

Each member of `transports` is an explicit opt-in. Unknown profile identifiers
whose values are bounded JSON objects are ignored. A known profile object that
is incomplete, has unknown members outside its `extensions` object, or is
invalid disables that profile without making another valid profile available
automatically.

All advertised MIME types are canonical lowercase ASCII `type/subtype` values
without parameters. Each type and subtype component contains 1–127 characters
from the profile grammar, making the complete value at most 255 characters.
They are compared exactly and are never MIME-sniffed into a capability.

`link-envelope/1` requires:

- `representations`: a non-empty subset of `text/markdown` and
  `text/plain`;
- `assetTypes`: exactly the empty list; and
- `limits`: an exact object containing `maximumUrlBytes` no greater than
  65,536, `maximumFragmentBytes` no greater than 32,768, and
  `maximumDecodedBytes` no greater than 24,576. The values bound the complete
  absolute URL, ASCII fragment excluding `#`, and decoded envelope,
  respectively. `maximumDecodedBytes` MUST NOT exceed
  `maximumFragmentBytes`, which MUST NOT exceed `maximumUrlBytes`.

`detached-datachannel/1` requires:

- `receiverHelper`: a same-origin, query-free, fragment-free absolute path
  whose resolved URL is at most 2,048 UTF-8 bytes;
- `representations`: a unique list of accepted representation MIME types,
  possibly empty for an asset-only receiver;
- `assetTypes`: a unique list of accepted asset MIME types, possibly empty;
- `limits`: an exact object containing `maximumSignalingBytes` no greater
  than 32,768 and no less than 1,024, `maximumFrameBytes` no greater than
  16,384,
  `maximumTransferBytes` no greater than 33,554,432, and `maximumAssets`
  no greater than 256.

At least one of `representations` or `assetTypes` MUST be non-empty.
`maximumAssets` MUST be zero exactly when `assetTypes` is empty.
`maximumFrameBytes` MUST be at least 17 and no greater than
`maximumTransferBytes`, because every frame has a 16-byte header and a
non-empty payload. The complete canonical `capabilities` control frame MUST
fit `maximumFrameBytes`. Because a transfer has at most 65,536 data frames,
`maximumTransferBytes` MUST NOT exceed
`(maximumFrameBytes - 16) × 65,536`. Per-item chunk rounding can reduce the
largest actually frameable transfer, so a sender also validates its prepared
transfer's exact global frame count before Send.

## 6. Negotiation and user interaction

### 6.1 Wire version

`wireVersions` is an ordered list, not a minimum or range. A sender selects the
first receiver-preferred version it supports and carries that exact value in
each profile envelope that defines a `wireVersion` member. Detached control
frames inherit the exact version from their transcript-bound live channel and
do not repeat it. If there is no exact match, negotiation stops.

### 6.2 Profile selection

A sender computes the mutually supported profiles and selects exactly one
before navigation. Selection MUST consider content type, assets, encoded size,
confidentiality, browser capability, and user intent.

The profiles are independent. A sender MUST NOT:

- attempt `link-envelope/1` after a detached failure unless the user begins a
  new, visibly identified non-confidential handoff;
- place detached content into a URL because WebRTC is unavailable;
- describe link-envelope as private or origin-authenticated; or
- choose a profile solely because its payload happens to fit.

### 6.3 Required actions

1. The user enters or selects a receiver domain.
2. The sender performs discovery and shows the verified canonical domain.
3. The sender shows the selected profile and its privacy/availability
   properties.
4. The user performs a fresh Send action. At activation time, the sender
   rechecks the prepared handoff expiry. If `now >= expiresAt`, it marks that
   handoff expired, cancels navigation, and requires fresh preparation plus a
   new Send action.
5. The sender opens the exact discovered endpoint according to the selected
   profile.
6. The receiver validates the transport, obtains receiver-user consent, and
   presents a transient preview.
7. The receiver persists only after Preserve.

Browser senders MUST prepare a native anchor and let a fresh, trusted,
unmodified primary `click` event perform its navigation. Every profile
launch opens a new top-level browsing context. The anchor MUST use the exact
profile launch URL, `rel="noopener noreferrer"`, and `target="_blank"`.
Imperative
`window.open()`, scripted anchor activation, and retained `window.opener` are
non-conformant even when called synchronously. A sender MUST NOT initiate a
handoff from page load, a timer, background task, network callback, or
synthetic click. Receivers cannot prove browser or installed-app activation
remotely; activation remains sender conformance evidence.

Only the primary `click` is a valid activation. While armed, the implementation
MUST cancel context-menu, drag, auxiliary-click, and non-primary pointer/mouse
down attempts that could navigate, copy, or extract the capability. The first
such attempt consumes the prepared capability, removes its `href`, enters an
absorbing non-launch state, and reports a local activation error; it MUST NOT
leave the same capability reusable for a later click.

The anchor handler validates trusted activation, current declaration, prepared
state, and expiry synchronously before allowing the browser's default
navigation. On any invalid, modified, synthetic, reused, closed, or expired
activation it MUST synchronously call `preventDefault()`, disable/remove the
launch `href`, enter an absorbing non-launch state, and report the local error.
Throwing an exception alone does not cancel native anchor navigation. A
prepared handoff also schedules expiration that disables/removes its `href`
when `expiresAt` is reached even if no activation occurs; the activation-time
recheck remains mandatory because timers can be delayed.

An accepted activation is single-use too. The controller MUST immediately
invalidate its retained launch URL and prepared capability so its API cannot
activate them again. The activated DOM anchor, its `href`, its security
attributes, and the Document containing it MUST nevertheless remain intact
through the click dispatch and its following microtask checkpoint. The
integration MUST cross at least one event-loop task boundary before it removes,
disables, replaces, or unmounts that anchor, closes or rebuilds its host, or
emits any externally observable launch-indication callback/event. A Promise
continuation or `queueMicrotask()` is not that boundary. This delay gives the
user agent's native default action an opportunity to create and commit the
top-level target; it does not prove that browser policy or an extension allowed
the navigation. Rejected, expired, closed, and failed activations still cancel
synchronously. Every outcome leaves the controller capability single-use, and
accepted-launch DOM cleanup occurs at or after the required task boundary.

A launch indication emitted after that boundary reports only local activation.
For `link-envelope/1` it MUST be named and presented as **launch initiated** or
equivalent unconfirmed language. It MUST NOT be labelled sent, received,
delivered, previewing, accepted, preserved, or otherwise upgraded because a
timeout elapsed or a browsing target appeared.

### 6.4 Installed-sender contract

An installed sender is conformant only for a profile whose complete browser
launch contract it can satisfy. For `link-envelope/1`, it MUST:

1. accept the receiver domain from a foreground user interaction;
2. perform the same credential-free HTTPS discovery with redirects disabled,
   exact final-URL/content-type checks, byte bounds, TTL, and ordinary platform
   TLS certificate validation;
3. show the canonical ASCII receiver origin, selected non-confidential profile,
   and lack of sender-origin proof or receipt;
4. prepare one bounded, expiring link without launching it;
5. require a second fresh foreground Send action and synchronously recheck its
   declaration and expiry; and
6. ask the platform to open the exact HTTPS launch URL in a top-level browser
   context, then erase the retained URL and payload representation.

The app MUST NOT launch from a background service, notification receipt,
timer, automation, or server command. It MUST NOT attach cookies, authorization
headers, referrers, device identifiers, or account tokens to discovery or the
launch URL. Because the receiver cannot observe native activation, these are
sender conformance requirements rather than receiver-verifiable evidence.

`detached-datachannel/1` requires the defined sender-origin browser page, fixed
callback, browser-local rendezvous, and live peer channel. A native process is
not that origin and MUST report this profile unavailable unless it launches and
uses the complete conforming browser sender implementation. Native-to-server
answer relays, custom schemes, loopback agents, background uploads, platform
share registration, and silent profile substitution are not version 1 OAB.

## 7. Common receiver processing

Before profile-specific processing, a receiver MUST:

1. synchronously copy its raw fragment and the pre-scrub origin, path, query,
   and complete URL into bounded volatile memory;
2. synchronously replace the visible URL with the clean fragment-free,
   query-free path before any security validation, await, render, log,
   analytics call, third-party resource, discovery/configuration check, or
   profile-marker parse beyond the minimal bounded copy needed to recognize a
   marked OAB launch;
3. verify it is a secure, unframed top-level context with no opener;
4. validate the copied origin and path against the exact discovered endpoint,
   reject a copied query, and require a non-redirecting deployment;
5. reject an unadvertised profile, unsupported wire version, duplicate
   parameter, malformed encoding, expired request, or excessive size;
6. retain no rejected content; and
7. protect the receiver UI with a response-header
   `Content-Security-Policy: frame-ancestors 'none'` or an equivalent framing
   policy in addition to the runtime check. A CSP meta element is not
   sufficient for `frame-ancestors`.

Scrub-first ordering is deliberate: even a framed, misrouted, query-bearing,
or otherwise invalid marked launch must not leave its fragment in the address
bar or same-document history while validation runs. Validation uses the copied
pre-scrub evidence and still fails closed. A shared receiver dispatcher MUST
capture and scrub once before a marked fragment can fail ambiguity,
unsupported-profile, stale-declaration, or configuration validation; it MUST
NOT rely on a later profile handler to clean up those early failures.

Conformance is measured from document entry, not from the eventual SDK call.
A deferred or module script that captures only after parsing, stylesheet
discovery, another script, rendering, or module-graph evaluation is not
scrub-first. A deployment MAY use a tiny parser-blocking same-origin classic
bootstrap as its first executable resource: it privately copies the exact
bounded location evidence, scrubs synchronously, then imports the main module
and passes the copy through an SDK-validated handoff option. The copied value
MUST remain closure-local, MUST be cleared after adoption, and MUST NOT be
published on a global object.

Receiver policy may Review once, deny, block a verified detached sender origin,
or use a local allowlist. Link-envelope claims MUST NOT create durable sender
allow or block rules because that profile provides no sender-origin evidence.

After structural validation and exact current-discovery binding, and before
creating a helper, showing a receiver prompt, importing a key, invoking RTC, or
delivering content, the receiver MUST perform one atomic origin-wide handoff
admission transaction. The transaction MUST, as one linearizable operation
across every receiver-origin tab, worker, and reload overlap:

1. physically delete expired replay tombstones and session leases;
2. reject a live profile-specific request tuple as `replay`;
3. reject when the origin-wide pending-plus-active session ceiling is full as
   `session-capacity`;
4. reject when the bounded live replay-tombstone store is full as
   `replay-capacity`; or
5. create both the replay tombstone, lasting until the profile offer expiry,
   and a pending session lease lasting no more than 60 seconds.

A rejected admission MUST create neither a replay tombstone nor a session
lease. A live replay tombstone MUST NOT be removed or LRU-evicted before its
profile expiry. The initial 60-second ceiling shortens only the unapproved
session lease; it does not shorten replay protection. The required host result
distinguishes exact `{admitted: false, reason: "replay" |
"session-capacity" | "replay-capacity"}` from exact `{admitted: true,
promote(), release()}`. Absence, malformed output, exception, or timeout fails
closed.

After the user grants the one preview authorization and before cryptographic,
transport, content, or delivery work continues, the receiver MUST atomically
promote that same pending lease in place to the profile's active-session
expiry. Promotion creates no new slot and MUST return exact `true`; failure or
timeout terminates the handoff and releases the lease. The session ceiling is
an implementation value from 1 through 4 and defaults to 4. The replay store
has an implementation-defined finite byte/record ceiling, advertised only to
the local admission adapter; the reference ceiling is 512 live tuples.

The promoted lease is held for the profile lifecycle and released idempotently
on every terminal path. At `now >= expiresAt`, the atomic store MUST exclude a
stale record from all decisions even if physical deletion has not yet run.
Every subsequent admission transaction and ordinary-application startup MUST
physically prune expired records using an expiry-indexed operation. Per-tab
memory and `sessionStorage` are not origin-wide controls. A receiver SHOULD
defer persistent admission until its top-level Document is visible and focused;
this reduces background launch abuse but is neither identity evidence nor a
substitute for the atomic transaction.

Pre-verification quotas MUST NOT be partitioned by a sender origin copied from
the offer: that value is not yet trustworthy and can be spoofed or rotated.
After detached callback verification, a receiver MAY apply a supplementary
per-verified-origin rate limit, but it MUST preserve the replay tombstone and
origin-wide ceilings above.

Authorization to establish a transport is not permission to persist content.
Preview and Preserve remain distinct operations.

Receiver interaction conforms to the
[human interaction and consent contract](../docs/human-interaction-contract.md).
One explicit decision may authorize verification plus one compatible inert
preview. Later manifest and origin checks remain mandatory but normally
consume that request-bound authorization without a second prompt. Only a
material expansion of the previously disclosed scope can justify an
additional decision. The authorization is single-use and bound to the request,
claimed sender origin, receiver origin, selected profile, intent, current
capability ceilings, expiry, and session generation.

### 7.1 Restricted receiver execution and clean transition

The restricted receiver document begins at marked Document entry, before the
scrub-first bootstrap, and continues while any captured evidence, transient
delivery, preview, transport capability, or Preserve-finalization state remains
in that Document. It MUST use only origin-local, packaged resources required
for capture, validation, receiver consent, inert preview, protocol transport,
and the receiver-controlled Preserve transaction. The profile-defined
host-only WebRTC channel is permitted.

Every profile-defined receiver helper and sender callback is a restricted OAB
utility document from marked entry through terminal cleanup. It MUST use only
origin-local, packaged resources required for its exact capture, validation,
local rendezvous, and profile-defined navigation duties. It does not become an
ordinary application page after scrubbing or after completing those duties.

During any restricted receiver or OAB utility Document lifetime, the
implementation MUST NOT initialize or load analytics,
telemetry or crash reporting, advertising or tag managers, login/account
prompts, authentication SDKs, background document synchronization, remote
fonts, CDN-hosted renderer resources, third-party scripts/styles/images,
speculative or preload resources, or ordinary application service workers. It
MUST NOT fetch a received or claimed URL. A response-header CSP MUST enforce a
first-party-only boundary consistent with the selected profile. Merely
scrubbing the fragment before ordinary application startup does not satisfy
this restricted lifetime.

Preserve MAY durably stage or import the validated bytes under a
receiver-generated identity. It MUST NOT select, open, richly render, execute,
or resolve references from that durable document inside the restricted
receiver document. After Preserve finalization, Discard, or another terminal
outcome, the receiver erases transient state, closes transport resources, and
releases every lease. Before ordinary application services start or preserved
content becomes active, it MUST either close the restricted Document or use a
full top-level navigation such as `location.replace()` to a same-origin clean
application URL containing no OAB fragment, query, capability, or sender
identifier. SPA routing, `history.replaceState()`, widget replacement, or a
state-only rebuild is not a clean transition because it retains the same
Document. Any detached best-effort terminal result is attempted before this
teardown.

A receiver MAY leave a content-free terminal message in the still-restricted
Document. That Document remains restricted and MUST NOT start ordinary
application services. Entering the ordinary application after any terminal
outcome, including denial, Discard, expiry, cancellation, or error, requires the
same closure or clean full-document transition.

### 7.2 Network authority and service-worker migration

Every request in the OAB authority resource graph MUST be obtained from the
current origin deployment with its exact response bytes and security headers.
This includes parser-blocking bootstraps, dynamically imported modules, SDK
modules, styles, and other transitive packaged dependencies—not only the
top-level HTML routes. An authority request MUST receive no service-worker
fetch-event handling and MUST proceed directly to the network.
A pass-through strategy such as `respondWith(fetch(event.request))` is
non-conformant: it still intercepts and can inspect or report the request. A
controlling service worker MAY exist only when authority requests bypass its
fetch handling unchanged and the worker cannot answer, cache, rewrite, inspect,
replay, or report them. It MUST NOT exchange messages with a restricted OAB
Document, telemeter that Document, or initiate OAB-related background work.
Page code that calls `unregister()` is insufficient evidence: the navigation
that loaded that code may already have been answered by the old worker.

An origin that previously deployed a service worker capable of controlling any
request in the OAB authority resource graph MUST keep discovery absent or
`status: "disabled"` during a separate migration deployment. That deployment
retires or replaces every historical controlling worker with a verified
non-intercepting worker that also performs none of the messaging, telemetry, or background work
forbidden above, and preserves the historical worker script URLs needed for
dormant clients to update. OAB may be enabled only in a later deployment after
the publisher has browser evidence from previously controlled clients that every
authority-resource request reaches the current network response with its
current headers and bytes.
A deployed-origin claim MUST separately record that the network was reached,
that the expected release bytes and headers were returned, that no applicable
service worker observed a fetch event/message or began OAB background work, and
that every historical worker script/scope migration was exercised from an
already-controlled client. Repository fixtures, source inspection, a
byte-identical pass-through response, page-time `unregister()`, and fresh-profile
testing are not substitutes for that deployment evidence.
A renamed/versioned route does not escape a root-scoped worker. If this cannot
be established for the claimed client population, the receiver MUST remain
disabled or move to a fresh origin that was never controlled by that worker.

## 8. Transport profiles

### 8.1 Link envelope

`link-envelope/1` carries a digest-protected JSON envelope in a fragment. The
content is never part of the HTTP request, but may be observable to local
browser history, session recovery, extensions, native URL handlers, screen
recorders, or other locally privileged software before it is scrubbed.

It supports bounded `text/markdown` and `text/plain` representations only.
It does not support assets, HTML, compression, a callback, delivery receipts,
sender-origin evidence, or confidential-content claims. Receivers label it as
an **Unverified app or website**.

The complete normative profile is
[`link-envelope/1`](transports/link-envelope-1.0.md).

### 8.2 Detached data channel

`detached-datachannel/1` creates no sender/receiver window relationship. It
uses a content-free offer fragment, a top-level helper on the receiver origin,
a fixed callback page on the sender origin, origin-local
`BroadcastChannel` rendezvous, ephemeral ECDH and an AEAD-protected answer
transcript, then a direct WebRTC data channel with no STUN or TURN service.
The candidate restrictions reduce reachability but do not prove physical
same-device execution; see the detached profile's security considerations.

The receiver user's **Review shared content** action opens the receiver helper
with noopener. “Verify” remains an internal protocol transition, not required
user-facing terminology. The
helper and main receiver rendezvous on a random receiver-origin channel. After
validation and answer generation, the helper replaces its location with the
fixed sender callback; the callback scrubs and relays the ciphertext on a
sender-origin channel. No participant obtains a cross-origin `WindowProxy`.

Actual content is transferred only after a live channel-level grant. It may
carry representations and accepted binary assets using bounded frames,
backpressure, ordered sequence numbers, and SHA-256 manifest verification.
Failure to establish a safe host-candidate channel terminates the handoff.

The complete normative profile is
[`detached-datachannel/1`](transports/detached-datachannel-1.0.md).

## 9. Common content model

A handoff has:

- a canonical unpadded-base64url request identifier whose 22–128 characters
  encode at least 128 bits of fresh entropy;
- intent `preview`;
- creation and expiry times;
- an optional title;
- zero or more representations keyed by MIME type; and
- zero or more assets for profiles that support them, with at least one
  representation or asset in the selected profile.

Text representations are UTF-8 and MUST NOT contain ill-formed scalar values
or U+0000 NUL.
A receiver chooses one representation for primary preview and MAY retain
alternatives only after Preserve. `text/html` is untrusted active content and
MUST be sanitized in a separate renderer boundary. Markdown extensions are
receiver-specific unless separately negotiated.

Each detached asset has a stable transfer-local index, MIME type, byte length,
SHA-256 digest, and safe display name. Paths, filenames, titles,
MIME types, SVG, HTML, URLs, and all rendered content are untrusted input.
An asset name is wire metadata, not an authorized local path. A Preserve
adapter MUST choose or validate its own destination name, account for
platform-reserved names and case/normalization collisions, and MUST NOT
silently overwrite an existing file.

Detached manifests, grants, data frames, and completion messages MUST agree
exactly on ordered representation and asset metadata, byte lengths, and
digests. A mismatch terminates and discards the transfer. The detached
bootstrap intentionally carries none of that content metadata.

## 10. Transport evidence

Implementations MUST distinguish these evidence classes:

| Property                                                      | Link envelope | Detached data channel                                                    |
| ------------------------------------------------------------- | ------------- | ------------------------------------------------------------------------ |
| Receiver HTTPS origin verified by sender discovery/navigation | Yes           | Yes                                                                      |
| Sender is human                                               | No            | No                                                                       |
| Fresh sender user activation observed by receiver             | No            | No                                                                       |
| Sender origin verified by receiver                            | No            | Yes, through the fixed sender-origin callback plus transcript continuity |
| Claimed application identity verified                         | No            | No                                                                       |
| Content excluded from URL state                               | No            | Yes                                                                      |
| Content excluded from HTTP payload servers                    | Yes           | Yes                                                                      |
| Encrypted peer channel                                        | No            | Yes                                                                      |
| Delivery/disposition result                                   | No            | Yes                                                                      |

Detached sender-origin evidence means that script executing on the stated
origin participated in the same ephemeral cryptographic transcript. It does
not prove publisher identity, human intent, absence of XSS, or application
integrity.
The callback `Referer` is **browser-observed receiver-origin evidence**: it
observes which origin initiated the helper's top-level callback navigation. It
is neither cryptographic attestation nor independently sufficient origin
authentication; the complete transcript and callback checks remain mandatory.

## 11. Security considerations

Receiver preview rendering MUST conform to the repository's
[inert preview contract](../docs/inert-preview-contract.md). Transport integrity
and sender-origin evidence do not authorize HTML, SVG, URLs, styles, or files to
execute in the receiver origin.

The restricted receiver Document MUST visibly identify itself as
receiver-owned application UI and MUST NOT imitate browser, operating-system,
authentication, malware, or certificate warnings. Before detached verification
it presents the sender origin as conditional and explains that the receiver
will check it. Claimed branding never replaces the canonical origin. Helper
and callback Documents are non-consent utility pages and do not repeat preview
authorization.

Public resources use HTTPS, HSTS where operationally appropriate, and secure
contexts. HTTP is permitted only on browser-trusted loopback development
origins. Cross-origin launches create no opener and receiver consent is
top-level and frame-protected.

Sender UI MUST display canonical ASCII origin form. It MAY additionally show
Unicode IDN form and SHOULD apply a documented, versioned confusable-domain
warning profile (for example, Unicode UTS #39). An implementation that makes
such a warning a conformance claim MUST identify its UTS #39 version/profile
and publish test vectors. The canonical ASCII form always remains visible.
Manifest branding and claimed source metadata never
replace origin provenance.

Request IDs, rendezvous channel names, grants, nonces, and ephemeral private
keys are single-use and expire. Parsers, replay sets, origin-wide admission
leases, pending sessions, prompts, SDP, candidates, frames, assets, total
bytes, replay/admission waits, and every detached lifecycle phase are bounded
before allocation. Detached signaling is transcript-authenticated before
remote answers are applied, and content bytes are forbidden before a live
one-time grant.

A receiver MUST isolate active content and MUST NOT execute received scripts,
event handlers, external resource loads, or dangerous URLs in its application
origin. Denial, timeout, malformed input, reload, channel closure, digest
mismatch, replay, and unsupported capability discard all transient state.

Implementations MUST NOT claim that URL fragments are secret, SHA-256 digests
authenticate a sender, DTLS authenticates a legal publisher, or receiver
consent proves sender user activation. No protocol can protect an already
compromised sender or receiver origin, browser, operating system, or locally
privileged software. OAB responds to uncertainty by failing closed rather than
reintroducing a navigable window, weaker profile, or server inbox.

## 12. Privacy considerations

Discovery discloses the sender's network request and, for browser CORS fetches,
its `Origin` header to the user-selected receiver, but carries no document
metadata or content. Optional application manifests are public. Destination
history is local sender UX. It MAY retain only the canonical receiver origin,
bounded display name/short name/description, validated theme color, and local
last-used time. It MUST NOT retain content, declaration values, request IDs,
channel capabilities, keys, receiver-user policy, application-manifest or icon
URLs, verified Blob URLs, or fetched icon bytes.

Link-envelope content temporarily exists in local URL state. It may be visible
to browser history/session restoration, extensions, native URL handlers, screen
recorders, crash tooling, and other locally privileged software before
synchronous scrub. The profile is therefore restricted to explicitly
non-confidential portable text. Receivers, helpers, and callbacks MUST NOT log
fragments and MUST enforce the restricted receiver-document and
service-worker rules in Section 7. Receiver and callback routes use
no-referrer policy. The detached helper is the sole
exception: it uses `Referrer-Policy: origin` so the sender callback can verify
the browser-controlled origin that initiated answer navigation. Consequently,
the callback HTTP request discloses the receiver origin in its `Referer` header
to the sender's server. It discloses no content or signaling fragment.

Detached bootstrap and callback fragments contain signaling, origins, session
values, ephemeral public keys, browser-generated SDP, and eligible `.local` or
exact loopback host candidates,
but no title, representation body, asset name, content digest, or document
bytes. OAB configures no STUN/TURN service and forbids raw-address candidates,
limiting network-address disclosure. The chosen receiver still learns limited
browser/RTC implementation metadata required to establish the channel.

Content and keys remain only in volatile session state before Preserve.
Receivers MUST disclose their product-specific durable retention and sync
behavior at Preserve time. Discard, denial, expiry, failure, or timeout erases
the session. On every terminal outcome, SDK and host code MUST release their
references to manifests, payloads, preview models, received assets, and
fulfilled preview values after completing the selected disposition. JavaScript
cannot revoke an object that application code has retained, so a host that
keeps such a reference is non-conformant; this boundary is not memory
zeroization. Preserve activation MUST immediately produce observable,
receiver-owned progress UI. A receiver MAY make a recoverable, receiver-owned
durable staging commit the Preserve boundary and complete ordinary application
import after the required clean transition. Once that commit succeeds, later
application work MUST NOT be reported as Discard; the receiver instead exposes
recovery or retry for the preserved record. Protocol errors reveal no content,
SDP, candidate address, key, capability, or private policy detail.

## 13. Error semantics

The link profile has no trusted return channel and therefore defines only local
receiver errors. The detached profile's authenticated `abort` control carries
one reason code from the selected profile's closed wire vocabulary. Wire
version 1 accepts only the ten `detached-datachannel/1` reasons registered by
that profile; an unknown value is a protocol error and MUST be rejected. An
implementation MUST NOT use a reason code to relax validation or resume a
failed session.

Local SDK error names and human-readable diagnostics are not wire values.
Error text is untrusted and MUST NOT be rendered as HTML. Errors and aborts
MUST NOT echo content, capabilities, key material, raw SDP, candidate
addresses, origins, or full fragments.

## 14. Versioning and deprecation

Wire versions and transport versions are independent exact identifiers. A
receiver may advertise multiple wire versions and profiles. Selection uses
explicit intersection; semantic-version range inference is forbidden.

A new grammar, cryptographic suite, signaling format, compression scheme, or
privacy property requires a new wire or transport identifier as appropriate.
An implementation MUST NOT reinterpret `link-envelope/1` or
`detached-datachannel/1` with incompatible semantics.

`browser-window/1` and `native-link/1` were pre-publication drafts.
They have no default or downgrade status in OAB 1.0.

## 15. IANA considerations

Before stable publication, the project intends to request registration of the
well-known URI suffix `open-app-bridge` in the Well-Known URIs registry.
This draft does not allocate an HTTP field name and does not require custom OAB
response headers.

## 16. Conformance claims

Companion JSON Schemas validate representable object shape and local scalar
bounds. They are not standalone protocol validators. Relational limits,
canonical byte reserialization, Unicode normalization, URL-Standard
round-trips, current time/discovery binding, browser-assisted SDP and ICE
checks, capability subsets, sequence, digests, replay, user action, and
lifecycle state require the normative semantic algorithms and conformance
tests in this specification. Passing a schema alone establishes no OAB
conformance.

Claims MUST identify their evidence level as protocol-design,
SDK/reference-implementation, browser-engine, real-device, deployed-origin,
and/or independent-security-review evidence. Every report MUST identify an
immutable commit/release or artifact digest plus dependency lock, test command,
environment versions, failures, and skips. A staged or dirty working tree is
not a reproducible conformance or security-review target.

An implementation MUST name every wire version and transport profile for which
it passes the published conformance suite. Supporting `link-envelope/1` alone
MAY be described as **OAB Compatibility**. A product MUST NOT claim **OAB
Private Transfer** unless it implements and passes
`detached-datachannel/1`.

Self-asserted badges without matching test evidence are non-conformant.

For every claimed browser native-anchor launch, conformance evidence MUST use a
real trusted user click and observe exactly one new top-level target plus its
initial network request to the exact profile-defined destination. That
destination is the discovered receiver `endpoint` for a sender launch and the
discovered `receiverHelper` for the detached Verify anchor. Evidence combines
the exact prepared pre-click `href` with receiver-side capture, synchronous
scrub, and prompt/parse evidence; the fragment is correctly absent from the
HTTP request. Inspecting an `href`, resolving a Promise, receiving
`oab-launched`, or dispatching a synthetic DOM event without the real target
and request is not launch evidence. Detached evidence additionally observes the
helper's later same-target navigation and network request to the fixed sender
callback; that navigation does not create a second target.

Receiver conformance evidence MUST also demonstrate that the restricted
Document makes no third-party or content-derived request, starts no forbidden
application service, and does not activate preserved content before a clean
full-document transition. Deployment evidence for an origin with historical
service workers MUST begin from a previously controlled client and establish
the migration requirements in Section 7.2. Browser-engine claims require this
evidence on every claimed engine; mocked DOM, timer, RTC, or service-worker
tests are regressions, not substitutes.
