# Roadmap

OAB is a breaking pre-publication draft. The current repository contains a
complete reference design, but that is not yet independent interoperability or
an externally reviewed security claim.

## Draft foundation implemented

The following work is present in the current draft and remains subject to the
publication gates below:

- Discovery is one credential-free, redirect-free, bounded JSON `GET` with
  exact wire/profile negotiation, strict known-field validation, no header or
  representation defaults, and exact public declaration binding.
- `link-envelope/1` has one canonical fixed-order URL grammar, independent URL,
  fragment, and decoded limits, explicit non-confidential classification,
  replay/admission controls, scrub-first processing, and no receipt.
- `detached-datachannel/1` has content-free signaling, browser-generated
  candidate-free SDP, `.local`/exact-loopback host candidates, an opener-free receiver
  helper and fixed sender callback, browser-observed receiver-origin referrer
  evidence, P-256/HKDF/AES-GCM
  transcript binding, and no signaling or payload server.
- The detached live channel implements bounded capabilities, manifest, grant,
  binary data, completion, previewing, and Preserve/Discard result states with
  exact sequencing, digest checks, backpressure, and absorbing cleanup.
- The high-level receiver owns a closure-private, one-use preview grant bound
  to the exact request/session scope; application policy receives only frozen
  non-bearer evidence at the manifest boundary.
- Replay tombstones and short pending session leases are created together by a
  host-coordinated, bounded, linearizable, expiry-cleaned admission, then the
  lease is promoted only after Review. Bootstrap, connection, transfer-to-preview, and preview-disposition
  phases have absolute hard deadlines.
- High-level navigation capabilities are bound to one exact native anchor and
  own DOM expiry cleanup. Accepted activation preserves the anchor and host
  through at least one event-loop task (microtasks are insufficient), and
  link-envelope reports only an unconfirmed launch indication. Detached durable
  Preserve is coordinated by a deadline-aware commit/rollback transaction, and
  the reference receiver uses receiver-owned add-only document identifiers.
- The entire marked receive Document is a restricted first-party-only process.
  Preserve stages an inert durable record, and normal application startup or
  rendering begins only after terminal cleanup and a clean full-document
  transition.
- Discovery, all restricted Documents, and every transitive script, module,
  stylesheet, and asset in their complete authority resource graph are
  exact-network resources. Historical intercepting service workers require a separate
  OAB-disabled migration deployment verified from a previously controlled
  client before a later deployment enables OAB.
- Optional Web App Manifest branding is display-only. Fetches are bounded,
  credentialless, no-referrer, redirect-free, and exact-URL; protocol identity
  icons are verified static PNG/JPEG only and destination history retains no
  remote or Blob URLs or icon bytes.
- The reference suite includes schemas, negative parser/state tests,
  repository invariants, sender/receiver examples, and deployment-header
  examples for the new profiles.

## Publication gates

The package remains marked `private` until independent review is complete;
removing that guard is an explicit release decision, not a development convenience.

These are required before describing the specification as final:

- Freeze normative JSON schemas and publish language-neutral golden vectors
  for discovery, JCS, link fragments, SDP/candidate records, helper/callback
  envelopes, transcript/AEAD derivation, controls, and binary frames.
- Add a third-party conformance runner with corpus-based mutation/fuzz tests
  for duplicate members, Unicode, percent/canonical encodings, byte-boundary
  conditions, SDP ambiguity, replay/admission races, frame/state violations,
  cancellation, and delayed asynchronous completion.
- Run and publish a reproducible browser matrix for current Chrome, Firefox,
  and Safari desktop/mobile engines, including private mode, Android/iOS
  browser handoff, strict COOP/CSP, blocked popups/helpers, throttled background
  tabs, storage partitioning, WebRTC disabled, VPN policy, mDNS rejection,
  reload, crash, expiry, cross-tab replay/admission races, accepted-launch task
  ordering, restricted receive-Document isolation, and clean transitions.
- Verify deployed response headers, redirect behavior, fixed paths, referrer
  behavior, CORS, service-worker network authority and historical migration,
  and `opener === null` with an automated live-origin harness. Every launch
  claim must observe a real trusted click, exactly one top-level target, and its
  exact initial request; sender events and inspected URLs are not browser
  evidence.
- Demonstrate that every profile failure is terminal and never silently invokes
  link-envelope, HTTP upload, clipboard, opener messaging, or another transport.
- Obtain at least one independent sender and receiver implementation for each
  claimed profile and publish bidirectional interoperability results.
- Commission an external protocol and reference-implementation security/privacy
  review and resolve every critical or high finding before stable 1.0.

## Specification publication

- Review, version, and publish the existing W3C TAG Security and Privacy
  Questionnaire alongside each specification snapshot.
- Publish formal versioning, deprecation, errata, and supported-security-version
  policies.
- Add specification-appropriate copyright and patent commitments alongside the
  Apache-2.0 code license.
- Render stable section anchors and versioned specification snapshots.
- Submit an Internet-Draft and request IANA registration for
  `/.well-known/open-app-bridge` only after the grammar is frozen.
- Enable and exercise private vulnerability reporting; publish `security.txt`
  on the specification site.
- Establish naming, repository governance, maintainer succession, and the
  decision process for future profiles.

## Stable 1.0 gate

Stable 1.0 requires all publication gates plus:

- frozen discovery and profile grammars with reproducible vectors;
- reproducible cross-engine and independent-implementation results;
- no known unmitigated protocol-level critical or high risk;
- conformance badges generated from test results rather than self-assertion;
  and
- a documented migration policy for future wire and profile versions.

## Adoption work

- Maintain a public sender/receiver testbed that is neither a registry nor a
  relay.
- Ship a minimal receiver integration and reusable sender widget.
- Publish integrations demonstrating AI-response, Markdown-document, and
  asset handoff.
- Publish prior-art and limitation comparisons, including fragment exposure,
  constrained direct-channel scope, sender-origin evidence, and detached availability.
- Recruit independent implementers, maintainers, accessibility reviewers, and
  security reviewers.

## Possible future profiles

- A decentralized installed-app-to-web private callback profile.
- Explicit app/platform attestation evidence.
- Cross-device encrypted transfer as a separately threat-modeled profile.
- Additional portable representations.
- A separately versioned compression profile with decompression limits.
- Optional dynamic origin-bound declaration freshness.

Future work MUST NOT:

- reintroduce receiver navigation authority over a sender;
- silently downgrade privacy;
- create a mandatory central registry;
- submit content to a public HTTP inbox;
- treat claimed branding as identity; or
- persist before receiver preview and Preserve.
