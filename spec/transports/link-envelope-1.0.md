# OAB Link Envelope Transport 1.0

- Profile identifier: `link-envelope/1`
- Protocol version: `1.0`
- Intended assurance: Low / opportunistic
- Intended payload: Bounded, non-confidential text

`link-envelope/1` is the broad-compatibility OAB profile for small,
non-confidential text. A browser or installed sender opens the discovered
receiver endpoint and carries a bounded envelope in the URI fragment.
Fragments are excluded from the HTTP request, so the profile creates no public
HTTP content inbox.

The profile deliberately provides no sender-origin proof, application
attestation, encrypted peer channel, asset transfer, callback, delivery
receipt, or confidential-content guarantee. Any website or installed
application can construct it. Receiver UI MUST identify its source as an
**Unverified app or website**.

## 2. Discovery

A receiver opts in only by including this complete transport member in its
canonical discovery JSON:

```json
{
  "transports": {
    "link-envelope/1": {
      "representations": ["text/markdown", "text/plain"],
      "assetTypes": [],
      "limits": {
        "maximumUrlBytes": 65536,
        "maximumFragmentBytes": 32768,
        "maximumDecodedBytes": 24576
      }
    }
  }
}
```

`representations` MUST be a non-empty, unique subset of `text/markdown` and
`text/plain`. `assetTypes` MUST be the empty list. `limits` is an exact
object. `maximumUrlBytes` MUST be an integer from 1 through 65,536 and bounds
the complete absolute URL. `maximumFragmentBytes` MUST be an integer from 1
through 32,768 and bounds the complete ASCII fragment after the leading `#`.
`maximumDecodedBytes` MUST be an integer from 1 through 24,576 and bounds the
UTF-8 envelope before base64url encoding. `maximumDecodedBytes` MUST NOT exceed
`maximumFragmentBytes`, which MUST NOT exceed `maximumUrlBytes`.

Absence or invalidity is refusal. A sender MUST also apply its own tested
browser or platform URL limit; the effective limit is the smaller value.
There is no universally guaranteed URL capacity.

## 3. Appropriate use

A sender MUST expose that this profile:

- places encoded text temporarily in local URL state;
- does not verify the sender;
- provides no result to the sender; and
- is intended for ordinary snippets and notes, not passwords, tokens, private
  keys, medical records, unpublished confidential work, or similarly sensitive
  content.

Fitting under the byte limit does not make content suitable. An API integrating
this profile MUST require the caller or user to select the non-confidential
mode. It MUST NOT silently choose this profile after
`detached-datachannel/1` fails.

## 4. Launch

Discovery and Send are separate actions. The final user action opens:

```text
<endpoint>#oab-link=1&payload=<base64url-envelope>&digest=<base64url-sha256>
```

The raw ASCII fragment MUST match the displayed fixed-order grammar exactly.
The parameters appear exactly once; reordered or unknown parameters,
percent-encoding, `+`, whitespace, empty values, base64 padding, and any other
spelling are invalid. A conforming parser does not run form/query decoding over
this fragment. This single wire form avoids parser differences across
implementations.

- `payload` is unpadded base64url of the exact UTF-8 RFC 8785 JSON
  Canonicalization Scheme (JCS) envelope bytes.
- `digest` is unpadded base64url SHA-256 of those bytes.

The digest detects corruption or truncation. It is not a MAC, signature, or
sender proof; an editor of the payload can recompute it.

Browser senders MUST expose the complete launch URL through a prepared native
anchor and let its fresh trusted activation open a new top-level context. The
anchor MUST use `rel="noopener noreferrer"` and `target="_blank"`.
The prepared capability MUST be bound to exactly one anchor. Binding removes
`download`, `ping`, and attribution-reporting attributes. At activation the
controller MUST verify that `event.currentTarget` is that anchor and that its
absolute `href`, target, exact relationship, and `no-referrer` policy still
equal the prepared values. A mismatch cancels navigation and consumes the
capability. After successful validation, later listeners in that activation
MUST NOT be allowed to mutate those security attributes before default
navigation.
Same-context navigation, imperative `window.open()`, scripted anchor
activation, and any launch that retains `window.opener` are forbidden.

The sender MUST recheck the prepared envelope at activation time. At
`now >= expiresAt` it marks the handoff expired, cancels navigation, destroys
that prepared state, and requires a newly prepared handoff and a new Send
activation. An expired handoff is never refreshed or replaced inside the same
activation. Every rejected activation synchronously calls `preventDefault()`
and disables/removes the anchor `href`; throwing an exception is not a
navigation control. A scheduled expiry disables/removes the `href` even when
the user never activates it; delayed browser timers do not replace the
activation-time check.

After an accepted activation, the controller immediately invalidates its
retained launch URL and prepared envelope capability. The activated DOM anchor,
its `href` and security attributes, and its containing Document MUST remain
intact through dispatch and the following microtask checkpoint. The integration
crosses at least one event-loop task boundary before it removes, disables,
replaces, or unmounts that anchor, closes or rebuilds its host, or emits any
externally observable launch-indication callback/event. A Promise continuation
or `queueMicrotask()` is insufficient. The delay gives
the native default action an opportunity to commit its target but is not a
delivery receipt. Rejected activations still cancel synchronously, and no
activation outcome leaves a reusable controller capability.

The receiver MUST reject a decoded JSON value whose exact bytes are not its JCS
serialization. This provides a language-neutral single digest representation
and rejects duplicate members or alternative encodings. Version 1 uses the OAB
canonical JSON subset: RFC 8785 JCS containing only null, booleans, strings,
arrays, objects with unique non-empty member names, and safe integers.
Floating-point and non-finite numbers are forbidden.

Every unpadded base64url value uses the RFC 4648 URL-safe alphabet with no
`=`. Decoding MUST consume the whole string, and re-encoding the decoded bytes
without padding MUST produce the identical string. Non-canonical pad bits and
impossible encoded lengths are invalid.

Version 1 does not compress its envelope. Compression, binary assets, HTML
representations, and transport-level external asset references are forbidden.
Markdown text may contain ordinary links, but the receiver does not fetch them
to authorize the handoff.

## 5. Envelope

After base64url decoding, the value MUST be a JSON object with unique members:

```json
{
  "protocol": "org.openapp.bridge",
  "wireVersion": "1.0",
  "transport": "link-envelope/1",
  "requestId": "base64url-random-value",
  "intent": "preview",
  "classification": "non-confidential",
  "createdAt": 1787911200000,
  "expiresAt": 1787911320000,
  "declarationId": "optional-public-declaration-value",
  "title": "Portable note",
  "representations": {
    "text/markdown": "# Portable note"
  },
  "source": {
    "application": "Claimed product name",
    "url": "https://example.invalid/item/1"
  }
}
```

Required members and constraints:

| Member            | Requirement                                                                                |
| ----------------- | ------------------------------------------------------------------------------------------ |
| `protocol`        | Exactly `org.openapp.bridge`                                                               |
| `wireVersion`     | Exact mutually selected wire version                                                       |
| `transport`       | Exactly `link-envelope/1`                                                                  |
| `requestId`       | 22–128 canonical unpadded base64url characters encoding at least 128 bits of fresh entropy |
| `intent`          | Exactly `preview`                                                                          |
| `classification`  | Exactly `non-confidential`                                                                 |
| `createdAt`       | Integer Unix epoch milliseconds                                                            |
| `expiresAt`       | Integer after `createdAt`, no more than five minutes later                                 |
| `representations` | Non-empty object containing only advertised and allowed portable text types                |

Every example member is present. `declarationId`, `title`,
`source.application`, and `source.url` may be JSON `null`; other members
may not. Unknown members are invalid.

The timestamps are non-negative safe integers. The lifetime MUST NOT exceed
five minutes and implementations SHOULD default to two minutes. A receiver
allows no more than 30 seconds of future clock skew and accepts only while
`createdAt - 30,000 <= now < expiresAt`.
The receiving browser's local clock is the sole time source for this check.
An HTTP `Date` header is server-controlled metadata and MUST NOT calibrate or
override it. A future timestamp fails as `link_envelope_from_future`; a validly
formed timestamp at or beyond expiry fails as `link_envelope_expired`.

`declarationId` MUST exactly equal the currently accepted public declaration
state: the same string when discovery published one, or JSON `null` when it did
not. A conforming receiver API therefore requires the host to supply this
expected string-or-null state explicitly; omission is not equivalent to
`null`. The member indicates discovery freshness and configuration binding
only. It is public, can be copied, and MUST NOT be described as an
authentication proof.

`title`, when non-null, is NFC-normalized, trimmed, single-line canonical UI
text of at most 240 Unicode scalar values, excludes control and bidirectional
override/isolate characters, and is untrusted. `source` is always an exact object.
`source.application`, when non-null, is at most 120 canonical UI scalar
values under the same normalization and character rules. `source.url`, when
non-null, is a credential-free absolute HTTPS URL of at most 2,048 characters;
the sender removes its query and fragment before constructing the envelope.
Browser-trusted loopback HTTP is permitted only in development. Both source
fields are claims; a receiver MUST NOT use them to authorize, identify,
allowlist, or blocklist the sender.

Each representation value is a string containing at least one non-whitespace
Unicode scalar, and its UTF-8 byte length contributes to all relevant limits.
Implementations MUST reject duplicate MIME keys, unadvertised types,
ill-formed Unicode, NUL, or non-string values. Unknown envelope members are
invalid in version 1.

The representations are alternative encodings of one logical content item,
not separate incoming documents. Receiver UI SHOULD present one item and
choose or let the user inspect an appropriate rendition without multiplying
the authorization count.

## 6. Receiver algorithm

The receiver MUST perform these steps in order:

1. Copy the raw fragment and complete pre-scrub URL into bounded volatile
   memory.
2. Synchronously call `history.replaceState()` with the clean fragment-free,
   query-free receiver path before security validation, await, render, log,
   analytics call, external resource, or third-party script.
3. Refuse operation unless it is a secure unframed top-level context with
   `window.opener === null` and the copied URL identifies the exact discovered,
   query-free, non-redirecting endpoint.
4. Reject the complete absolute URL, raw ASCII fragment, or decoded envelope
   when any independently advertised limit is exceeded.
5. Match the fixed raw ASCII grammar directly; reject reordered, duplicate, or
   unknown names, percent-encoding, `+`, whitespace, empty values,
   non-base64url characters, and padding.
6. Decode base64url under a decoded-size bound, compute SHA-256, and compare the
   digest in constant-time where the platform provides an appropriate primitive.
7. Decode strict UTF-8, reject duplicate JSON members, and validate the exact
   envelope grammar and the explicitly supplied current declaration
   string-or-null state.
8. Apply common representation and transfer limits before constructing preview
   objects.
9. Perform one atomic replay-and-capacity admission through the required host
   hook:

    ```text
    admitIncomingHandoff({
      requestId,
      channelId: null,
      transport: "link-envelope/1",
      replayExpiresAt: expiresAt,
      pendingExpiresAt: min(expiresAt, now + 60000),
      maximumActiveSessions,
      maximumReplayClaims
    }) ->
      {admitted: false, reason: "replay" | "session-capacity" | "replay-capacity"}
      | {admitted: true, promote({expiresAt}), release()}
    ```

   In one linearizable receiver-origin transaction, the host physically prunes
   expired records, checks the replay ID, pending-plus-active session ceiling,
   and live replay-store ceiling, then creates both the tombstone and pending
   lease or creates neither. The replay tombstone lasts until envelope expiry;
   the pending lease lasts at most 60 seconds. Live tombstones are never
   evicted early. `maximumActiveSessions` is 1–4 and defaults to 4;
   `maximumReplayClaims` is finite and defaults to 512. Absence, malformed
   output, exception, or timeout fails closed. The default callback deadline is
   five seconds and the hard maximum is 30 seconds.
10. After **Review once**, atomically promote the admitted lease in place by
    calling `promote({expiresAt})`. Exact `true` is required before preview
    delivery continues. Promotion failure or its five-second-default,
    30-second-hard timeout terminates the handoff. Denial and every terminal
    path call idempotent `release()` while retaining the replay tombstone until
    envelope expiry.
11. Show the receiver application's identity, the **Unverified app or website**
    source label, content types and sizes, and one receiver-controlled
    **Review once** or **Not now** action. The page MUST remain visibly owned by
    the receiver and MUST NOT imitate browser or operating-system security UI.
12. On denial, expiry, error, or navigation, erase the decoded envelope.
13. After Review once, construct a transient preview in an isolated safe
    renderer. Do not ask the same preview-authorization question again.
14. Write to durable storage only after Preserve. Discard erases all transient
    data.

The receiver scrubs before validating top-level, opener, endpoint, or query
evidence so even a marked but invalid launch cannot remain in visible or
same-document URL state. It retains the copied pre-scrub evidence solely for
those checks and erases it on failure.

After successful authorization, delivery evidence records
`declarationIdMatched: true`. No conforming delivery may expose `false` or an
unknown declaration-match state; failure to bind the current declaration is a
pre-delivery fatal error.

The receiver supplies one cancellation signal to its authorization and
transient-delivery callbacks. Page hide, external cancellation, or reaching
`expiresAt` aborts that signal and invalidates the receive generation. Both
callbacks MUST observe cancellation, and every continuation after an await
MUST recheck it before rendering, delivering, or persisting. A late callback
completion cannot revive an expired or abandoned handoff.

The receiver MUST NOT perform a network fetch for a claimed source URL,
Markdown image, link, import, HTML, or any other received reference at any time
in the restricted receiver Document, including after consent while building a
transient preview. Reference resolution is an ordinary application action that
is permitted only after Preserve, terminal cleanup, and the required clean
full-document transition, subject to the receiver's normal URL-safety policy.

The combined admission is linearizable across all concurrent receiver
contexts. Per-tab memory and `sessionStorage` are insufficient. Its tombstone
contains only the random request identifier and expiry, not content or source
claims, so bounded origin storage may hold it before Preserve. It remains until
expiry and never creates sender trust. A capacity rejection creates no
tombstone, preventing rejected traffic from exhausting the replay store.

Replay state and session state retain distinct lifetimes inside that one atomic
admission: replay prevents the same envelope from being processed twice, while
the pending/promoted lease caps simultaneous work across different envelopes.
The promoted lease covers transient delivery through completion or failure of
`deliver`. Completion of that callback is the link protocol's lease boundary;
an application preview that remains afterward does not retain the lease. The
receiver invokes `release()` idempotently at delivery completion or earlier on
denial, expiry, cancellation, page hide, Preserve/Discard performed inside the
callback, or any error. The host release operation MAY be asynchronous and
MUST itself be idempotent. At and after envelope `expiresAt`, the atomic store
MUST exclude a stale lease from admission decisions. Live contexts SHOULD
schedule best-effort deletion, and every later store operation and ordinary-
application startup MUST physically prune it before continuing; browser script
is not assumed to execute at the deadline after every context crashes. A late admission result
after cancellation is released without entering authorization.

## 7. History, logs, and local exposure

Although a fragment is not sent in HTTP, it can be observed by software with
access to browser or OS URL state before removal. Implementations MUST:

- scrub synchronously;
- use `Cache-Control: no-store`, `Referrer-Policy: no-referrer`, and a strict
  CSP on the receiver route;
- maintain the core restricted receiver-document boundary for the complete
  handoff lifetime, not only capture;
- omit analytics/telemetry, auth/account startup, document sync, remote fonts,
  CDN resources, third-party code/media, application service workers, and
  speculative external resources;
- never copy the launch URL into diagnostics; and
- never claim the profile provides secrecy.

A receiver SHOULD use a clean, fragment-free URL for reload and session restore.
It MUST NOT place the envelope into query parameters, history state,
`window.name`, local storage, IndexedDB, caches, crash-report fields, or an
HTTP request before Preserve.

Preserve authorizes only the durable write. The receiver MUST keep the durable
document inert in the restricted receiver Document. Following every terminal
outcome, including Preserve, Discard, denial, expiry, cancellation, or error,
the receiver erases transient state. It MAY leave only a content-free terminal
message in that still-restricted Document. Before ordinary application startup,
rich rendering, or received-reference resolution, it MUST close or perform the
core clean full-document transition. A same-document route/state change is
insufficient. The receiver Document's complete transitive packaged resource
graph and any historical service worker controlling any request in it MUST
also satisfy the core network-authority and migration requirements: every
request in that graph receives no service-worker fetch-event handling, and
pass-through `respondWith(fetch(event.request))` remains non-conformant
interception.

A service-worker fetch listener that recognizes an OAB path and returns
without `respondWith()` still observes the request and does not satisfy the
no-fetch-event invariant. Use a worker generation with no applicable fetch
listener or a fresh origin.

## 8. Result and errors

This profile is one-way. Preserve, Discard, and receiver errors are local
receiver outcomes. The receiver MUST NOT attempt to report them to a claimed
source URL or use an opener, redirect callback, beacon, image request, form
submission, or public HTTP endpoint as an implicit receipt.

If a receipt is required, the sender must begin a separately selected
`detached-datachannel/1` handoff. The receiver MUST NOT transform an active
link-envelope session into that profile.

A sender API, event, or UI may report only **launch initiated**, **launched**,
or equivalent explicitly unconfirmed language after the required task
boundary. It MUST NOT call the outcome sent, received, delivered, previewing,
accepted, or preserved. Observing a target, waiting for a timeout, or receiving
a local navigation event does not upgrade that outcome. “The receiver opened”
or “navigation began” is not explicitly unconfirmed and is non-conformant.

## 9. Evidence statement

A conforming receiver records:

```text
transport = link-envelope/1
receiverOrigin = browser-observed current origin
senderOrigin = unobserved
senderApplication = unverified claim or absent
senderUserActivation = unobserved
contentInLocalUrlState = yes, until synchronous scrub
httpPayloadInboxUsed = no
```

No other provenance may be inferred.

Browser conformance evidence for this profile MUST satisfy core Section 16. It
uses a real trusted click, the exact prepared pre-click `href`, exactly one new
top-level target, that target's initial network request to the discovered
receiver `endpoint`, and receiver capture/scrub plus prompt or parse evidence.
An inspected `href`, synchronous API result, Promise, local event, timer, or
synthetic click without that real target and request is insufficient.
