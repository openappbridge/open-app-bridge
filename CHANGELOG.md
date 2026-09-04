# Changelog

All notable project changes will be documented here.

## [1.0.0] - 2026-09-03

### Added

- Initial release of Open App Bridge (OAB) Protocol 1.0 and SDK (`open-app-bridge`).
- Canonical, bounded JSON discovery at `/.well-known/open-app-bridge`, with exact wire/profile negotiation and no redirects, credentials, implicit defaults, or centralized registry.
- `link-envelope/1`, an explicit low-assurance, text-only profile for non-confidential Markdown and plain text over synchronously scrubbed URL fragments.
- `detached-datachannel/1`, an opener-free private profile using ephemeral P-256 ECDH, HKDF-SHA-256, AES-GCM-bound signaling, host-only WebRTC, bounded binary framing, backpressure, and end-to-end hashes.
- Same-origin receiver-helper and fixed sender-callback pages (`/.well-known/open-app-bridge/callback`) that rendezvous through single-use `BroadcastChannel` capabilities without giving either application a cross-origin `WindowProxy`.
- SDK-owned, closure-private preview authorization grants bound to the exact request, origins, receiver declaration, profile/intent, capability ceilings, enforced expiry, and lifecycle generation.
- A normative human-interaction contract: receiver-branded context, one request-bound review decision, non-consent helper/callback states, representation grouping, and observable Preserve progress/recovery.
- Exact loopback ICE support (`127.0.0.1` and `::1`) alongside `.local` host candidates, with immediate no-eligible-candidate failure and local clock/referrer diagnostics.
- Whole-lifetime restricted receiver-Document boundary, inert Preserve staging, clean full-document transition, and network-authoritative service-worker deployment/migration requirements.
- Drop-in framework-neutral `<oab-share>` custom element supporting in-browser destination history and native anchor activation.
- `OpenAppShareElement.openFor(destination, contentOverride)`, a convenience
  API for user-invoked application-directory actions that preselects and
  discovers a known receiver without bypassing profile choice or the final
  trusted Send activation.
- Atomic pending-to-active admission promotion hardened against missing,
  expired, already-active, and overlong session leases.
- Closed machine-readable error registry (`OabError`) and non-diagnostic wire abort vocabulary.
- Normative inert-preview contract and active-content attack test corpus.
- Chromium, Firefox, and WebKit automated conformance and integration suite.
