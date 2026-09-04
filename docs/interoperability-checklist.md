# Interoperability checklist

Use this checklist before claiming compatibility with the current breaking
draft. Test every advertised profile independently; passing one profile does
not imply the other.

## Discovery and common sender behavior

- Accept a user-entered domain without scheme or registry and derive its exact
  canonical HTTPS origin.
- Accept subdomains; reject credentials, paths, queries, fragments, schemes in
  the human field, and public HTTP origins.
- Perform a credential-free, no-referrer, redirect-free JSON `GET` to the
  well-known path.
- Apply a hard deadline to the complete discovery fetch and bounded body read;
  use an 8-second default and never exceed 30 seconds.
- Bound bytes before JSON parsing; reject duplicate members, invalid UTF-8,
  excessive nesting, unknown known-object members, and incompatible versions.
- Accept a bounded advertised wire-version list only when exact local
  intersection succeeds; version `1.0` declarations contain `1.0`, may list
  future versions, and contain no more than eight entries.
- Require `status: "enabled"`, `preview`, and at least one explicit supported
  member of the `transports` map.
- Treat omitted profiles as unsupported; never infer a default transport.
- Keep Send disabled until discovery is complete and fresh.
- Keep the canonical domain visible beside untrusted manifest display metadata.
- Bound optional manifest and icon fetch-plus-body operations independently;
  use 4-second defaults, never exceed 15 seconds, and fall back to domain/local
  glyph presentation on failure.
- Reject complete optional manifest metadata when any supported string member
  contains a lone UTF-16 surrogate; never normalize it into U+FFFD.
- Prepare and size content before the final Send action.
- Select a profile explicitly and explain its security properties.
- Never silently fall back from detached-datachannel to link-envelope.
- After accepted native-anchor activation, invalidate the controller-held
  capability immediately but retain the activated anchor, its attributes, and
  its Document through dispatch, the microtask checkpoint, and at least one
  following event-loop task. Before that boundary do not remove, disable,
  replace, or unmount the anchor, close/rebuild its host, or emit any externally
  observable launch-indication callback/event. A Promise continuation or
  `queueMicrotask()` is insufficient.
- Close all volatile state on timeout, denial, navigation, error, or completion.

## Discovery deployment

- Serve canonical bounded JSON from `/.well-known/open-app-bridge` with
  `Content-Type: application/json` and credential-free CORS.
- Do not redirect the well-known response.
- Include `protocol`, `wireVersions`, `status`, `endpoint`, `intents`, and a
  non-empty explicit `transports` map.
- Put profile representations, `assetTypes`, and nested `limits` under that
  profile; advertise only fully implemented capabilities.
- Keep endpoint and helper values same-origin, query-free, fragment-free paths.
- Treat `declarationId` as public configuration/freshness binding, never proof.
- Advertise `applicationManifest` only for a same-origin standard Web App
  Manifest; keep its branding out of authorization decisions.
- Publish local trust lists, account data, secrets, or per-user policy nowhere
  in discovery.

## Receiver Document and network authority

- Keep the marked receive Document restricted from entry through terminal
  cleanup while any captured evidence, transient content, preview, transport
  capability, or Preserve-finalization state remains.
- Keep the detached receiver helper and fixed sender callback restricted for
  their complete lifetimes; scrubbing does not turn either utility Document
  into an ordinary application page.
- Load only packaged, origin-local protocol/consent/inert-preview resources and
  the host-only RTC traffic required by the selected profile. Do not initialize
  analytics, crash/usage telemetry, ads/tag managers, authentication/account
  UI, document sync, remote fonts, CDN renderers, third-party resources,
  speculative loads, or ordinary application service workers.
- Never fetch a received or claimed URL, and enforce the first-party-only
  boundary with response headers rather than relying on application code.
- Keep discovery, every receiver/helper/callback Document, and every transitive
  packaged resource they load network-authoritative: all HTML, bootstrap,
  module, stylesheet, and other dependency requests receive no service-worker
  fetch-event handling and proceed directly to the network. A pass-through
  `respondWith(fetch(event.request))` handler remains non-conformant
  interception. A controlling migration worker must not message or telemeter
  restricted OAB Documents or start OAB-related background work.
- If a historical worker could control any authority-resource request, keep OAB disabled
  for a separate migration deployment that retires or replaces every historical
  worker with a verified non-intercepting worker. Test every historical
  script/scope combination from a previously controlled client before enabling
  OAB in a later release;
  page-time unregister and a new versioned path are insufficient.
- Preserve may commit only to a receiver-owned durable record. Keep that record
  inert in the restricted Document, erase transient state, attempt any detached
  terminal result, then close the Document or perform a full top-level
  navigation to a clean query-free and fragment-free application URL before
  selecting, opening, richly rendering, executing, or resolving references.
  After any other terminal outcome, a content-free terminal page may remain
  only while it stays restricted; ordinary app startup still requires the same
  closure or full navigation. SPA/history/widget state changes are not a clean
  transition.

## Link-envelope sender

- Require an explicit `non-confidential` classification choice.
- Offer only advertised `text/markdown` and/or `text/plain`.
- Reject HTML, assets, secrets, and content beyond any sender or receiver limit.
- Bound decoded JSON, fragment, and complete URL independently.
- Use fresh request entropy, short expiry, canonical JSON, and SHA-256 digest.
- Describe the digest as corruption detection, not authentication.
- Open only the exact discovered endpoint from the user's action.
- Use a top-level launch with `noopener noreferrer` and no referrer.
- Bind the capability to exactly one native anchor through the SDK; reject
  changed `href`, target, relationship, referrer policy, or unsafe anchor
  attributes, and verify expiry removes the DOM `href` without a click.
- Report only an unconfirmed **Launch initiated** indication after the required
  task boundary. Never call it sent, received, delivered, previewing, accepted,
  preserved, or discarded; a local event, timeout, or target does not upgrade
  it to receiver evidence. “The receiver opened” and “navigation began” are not
  explicitly unconfirmed indications.

## Link-envelope receiver

- Capture and synchronously scrub the fragment before any await, render,
  analytics, logging, network fetch, or third-party code.
- Require a secure, unframed top-level context and refuse retained-window
  launches.
- Check the exact endpoint and all independent byte limits before allocation.
- Reject duplicate/unknown parameters, padding, malformed base64url, invalid
  digest, non-canonical JSON, invalid time bounds, and stale declaration ID.
- Atomically create each expiry-bounded request tombstone and no-more-than-
  60-second pending lease together, or create neither on capacity rejection.
- Enforce pending-plus-active and replay-store ceilings across tabs, workers,
  and reloads; after Review, promote the same lease through delivery and
  release it idempotently on every terminal path without deleting the live
  tombstone.
- Label source application/name/URL as unverified claims.
- Do not apply origin allow/block rules or fetch claimed URLs.
- Authorize before transient preview; persist only after Preserve.
- Present exactly one branded, request-bound preview authorization. Treat
  verified-origin and manifest decisions as silent narrowing gates, not a
  second copy of the same prompt.
- Group alternative Markdown/HTML/plain representations as one logical item
  and show companion assets as attachments.
- On denial, Discard, error, or expiry, erase decoded and preview data.
- Send no implicit receipt, redirect callback, beacon, or HTTP report.

## Detached sender bootstrap and callback

- Require secure Web Crypto, WebRTC data channel, BroadcastChannel, History
  API, strict codecs, and secure randomness before offering the profile.
- Host the fixed callback at
  `/.well-known/open-app-bridge/callback` on the exact sender origin.
- Use a fresh ephemeral P-256 key pair and random request/channel tokens.
- Configure `RTCPeerConnection` with no ICE servers and one ordered reliable
  data channel; create browser-generated candidate-free SDP.
- Filter candidates to `.local`, exact `127.0.0.1`, or exact `::1` host
  addresses; reject every other raw address and all non-host candidates.
- Fail immediately with `detached_ice_no_eligible_candidate` when gathering
  completes without an eligible candidate.
- Put no title, type, size, hash, filename, manifest, or content in bootstrap.
- Arm the sender-origin rendezvous before opening the receiver.
- Launch top-level with no retained cross-origin window relationship.
- In callback, require top-level/no-opener state, scrub before asynchronous
  work, verify the receiver navigation evidence, and accept one exact tuple.
- Authenticate/decrypt and transcript-check the sealed answer before applying
  it; accept the first valid answer only.

## Detached receiver main and helper

- Capture and synchronously scrub bootstrap before logging or external code.
- Atomically create the `(requestId, channelId)` offer-expiry tombstone and
  no-more-than-60-second pending lease together before helper, prompt, crypto,
  SDP, or RTC work; capacity rejection creates neither.
- After trusted Review, promote the same lease to the active-session expiry,
  hold it through preview/disposition, and release idempotently on every
  terminal path without early tombstone eviction.
- Require the receiver's trusted **Review shared content** user activation.
- Open the discovered same-origin helper synchronously with `noopener
  noreferrer`; never retain a cross-origin window reference.
- Require helper readiness on the exact random receiver-origin channel before
  processing signaling.
- Bound signaling before decode and apply lexical data-only SDP gates before
  the browser parser.
- Reject embedded candidates, audio/video/other media, media transceivers,
  excessive candidates, raw-address candidates, STUN/TURN, and relays.
- Generate a fresh receiver key and browser-generated answer.
- Bind answer encryption to the complete transcript, both exact origins,
  current declaration, request/channel IDs, and exact signaling.
- Allow helper navigation only to the fixed sender callback path.
- Ensure helper and callback are minimal top-level pages with no third-party
  scripts and immediate fragment scrub.
- Fail closed if helper, callback, crypto, candidate policy, or channel fails.
- If helper self-navigation does not complete, offer one same-tab continuation
  to the exact callback URL with origin referrer preserved; do not ask again.

## Detached live transfer

- Treat RTC message-event origin as no origin evidence; rely on the completed
  callback/transcript/channel binding.
- Send live capabilities before accepting a manifest.
- Enforce exactly: capabilities, manifest, grant, data, previewing, result.
- Authorize the manifest before granting any content bytes.
- Through the high-level receiver facade, require the SDK—not host UI—to own
  and automatically consume one opaque preview grant bound to request,
  receiver identity/origin, sender origin, profile/intent, capability ceilings,
  actual expiry, and session generation. Expose only frozen non-bearer evidence
  to the silent manifest policy callback. Test mismatch, reuse, expiry, and
  terminal revocation.
- Respect declaration, live-capability, SCTP `maxMessageSize`, frame, count,
  total-byte, timeout, and session limits.
- Use ordered reliable framing with sequence/count/total checks and
  backpressure.
- Recompute per-item, manifest, and final SHA-256 values before preview.
- Reject duplicate, missing, reordered, excessive, or post-completion frames.
- Keep content transient while previewing.
- For Preserve, expose the absolute deadline and use only the SDK-managed
  `preserve({commit, rollback})` transaction. Commit honors abort; rollback
  uses a receiver-owned add-only record ID and completes before a racing
  Discard becomes observable.
- On Preserve activation, show progress immediately, block duplicate action,
  and provide recovery if application import fails after durable staging.
- Send `preserved` only after atomic durable commit; send `discarded` only after
  transient cleanup.
- Close peers, channels, timers, object URLs, and buffers on every terminal path.

## Consent, rendering, and abuse controls

- Prevent framing of discovery-adjacent consent, helper, callback, and preview
  routes with CSP `frame-ancestors 'none'`.
- Use `Cache-Control: no-store`, `Referrer-Policy: no-referrer`, and restrictive
  CSP on signaling routes.
- A service worker that receives the OAB fetch event but returns without
  `respondWith()` still violates network authority; demonstrate no applicable
  fetch listener or use a fresh origin.
- Use the receiving browser clock for timestamp validation. Never calibrate it
  from the receiver's HTTP `Date` header.
- For link-envelope, show **Unverified app or website** and do not offer an
  origin-based persistent trust rule.
- For detached, show the verified canonical web origin; make clear this is not
  user identity, application attestation, or content safety.
- Give block rules precedence and bound prompts, sessions, bytes, and time.
- Sanitize HTML and active SVG in an isolated renderer; never use unsanitized
  `innerHTML`.
- Do not resolve a received or claimed remote reference anywhere in the
  restricted Document, including post-consent transient preview. Resolve it
  only as an ordinary application action after Preserve and a clean
  full-document transition.
- Return generic remote errors and keep sensitive details in local diagnostics
  that never include full signaling URLs or payloads.
- Map SDK failures to bounded primary UI categories and keep the stable machine
  code only in optional technical details; test both without reflecting raw
  exception messages or sender-controlled strings.

## Evidence for an interoperability report

- implementation/version and browser/OS versions;
- exact sender and receiver origins;
- sanitized discovery JSON and selected profile;
- advertised and live representations, asset types, and all effective limits;
- allow, deny, block, replay, expiry, malformed, oversized, timeout, and cleanup
  results;
- proof that all signaling fragments were scrubbed before asynchronous work;
- proof that detached bootstrap contained zero content-derived metadata;
- proof that no detached content byte arrived before manifest authorization;
- proof that preview did not persist automatically;
- proof that no OAB context retained a cross-origin window reference;
- for every native-anchor claim, a real trusted click, the exact prepared
  pre-click `href`, exactly one new top-level target, and that target's exact
  initial navigation request to the exact profile-defined destination—the
  receiver `endpoint` for a sender launch or `receiverHelper` for the detached
  Verify anchor—followed by capture/scrub and prompt or parse evidence; an SDK
  promise, `oab-launched` event, inspected `href`, or synthetic click without
  that target and request is insufficient;
- for detached, proof that the helper's later same-target navigation made the
  exact request to the fixed sender callback without creating another target;
- proof that accepted-launch anchor removal, disablement, replacement or
  unmount, host close/rebuild, and externally observable launch indications
  occurred only after at least one event-loop task, not synchronously or in a
  microtask;
- proof that the restricted receiver Document made no forbidden third-party or
  content-derived request, started no forbidden application service, and did
  not activate a preserved record before a clean full-document transition,
  across Preserve, Discard, denial, expiry, cancellation, and error paths;
- for origins with historical service workers, evidence beginning in a
  previously controlled client that the disabled migration release made every
  authority request bypass fetch-event handling and reach the current network
  response before OAB was enabled, covering every historical script URL and
  scope in the claimed client population;
- proof that profile failure did not trigger automatic fallback; and
- for final results, proof that `preserved` followed commit and `discarded`
  followed cleanup.
