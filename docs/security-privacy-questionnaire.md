# Security and privacy self-review

This document answers the W3C Security and Privacy Self-Review Questionnaire
for the OAB 1.0 draft. It is review input, not a claim of W3C endorsement.
Answers cover both `link-envelope/1` and `detached-datachannel/1`.

## 1. What information is exposed, and why?

Discovery exposes a receiver's opt-in status, supported wire/profile versions,
accepted media types, limits, receiver route, helper route, optional sender
policy label, and optional Web App Manifest path. A sender needs these values to
decide whether it can create a handoff before asking the user to send.

The link profile exposes the selected non-confidential text, title, expiry,
random request ID, declaration identifier, and unverified source labels in the
receiver URL fragment. The fragment is local browser state rather than an HTTP
request body, but it can be observed by browser history, session restore,
extensions, screenshots, crash reporting, or software with local access until
the receiver scrubs it.

The detached profile exposes ephemeral public key material, browser-generated
data-only SDP, privacy-preserving `.local` or exact loopback host candidates, short-lived random IDs, and an
encrypted answer in navigation fragments. It exposes no title, media type,
size, source label, content digest, or document bytes in signaling. Those
values first cross the authenticated DTLS DataChannel after origin
verification.

## 2. Is exposure minimized?

Yes by design, subject to the disclosed link-fragment tradeoff. Discovery has
an 8 KiB hard bound and carries no user or document data. Link envelopes are
restricted to non-confidential Markdown/plain text and have whole-URL,
fragment, decoded-body, and lifetime bounds. Detached signaling includes no
content-derived metadata. The receiver sees and grants the content manifest
only over the verified live channel. The profile has no STUN/TURN server, does
not expose raw host IP candidates, and uses single-use ephemeral keys and
identifiers.

## 3. Can personal information be exposed?

Yes. Document content selected by a user may contain personal information.
OAB does not infer or classify it. A sender must use the private detached
profile for sensitive content and must never silently downgrade to the link
profile. The receiver must obtain a user decision and show a transient preview
before any Preserve action.

## 4. How is sensitive information handled?

`link-envelope/1` is explicitly unsuitable and forbidden by its API unless the
caller classifies content as non-confidential. `detached-datachannel/1` keeps
content out of signaling URLs and protects the data plane with WebRTC DTLS.
Its answer is additionally bound to both origins, the exact offer, discovery,
expiry, callback/helper paths, and ephemeral ECDH keys using HKDF and AES-GCM.
Receiver applications remain responsible for safe rendering, access control,
and storage after Preserve.

## 5. Can content contain non-obvious information?

Yes. Images, SVG, HTML, Markdown links, filenames, and other assets may contain
metadata, active content, trackers, credentials, or location information. OAB
transports bytes and media declarations; it does not certify their safety.
Receivers must present filenames/types/sizes, sanitize or isolate active
content, avoid automatic external fetches, and let the user discard before
persistence.

## 6. Is persistent state introduced?

The protocol introduces no cross-origin persistent identifier and no content
inbox. Request IDs, channel capabilities, keys, replay tombstones, origin-wide
session-admission leases, and transfer buffers are bounded and single-use.
Replay tombstones and pending/promoted leases may be stored in first-party
receiver state so independently open receiver tabs can admit atomically; they
contain only
random protocol identifiers, profile, and expiry—not document content or a
stable user identity—and must be purged at their bounded expiry. A sender widget
may keep receiver origins and public manifest display metadata in first-party
local storage for user convenience; that optional state contains no content,
capability, or sender identity and the UI must let the user remove it. Preserved
documents are application state created only by the receiver user's explicit
action.

## 7. Is platform information exposed?

Profile availability and failure can reveal coarse support for WebRTC,
BroadcastChannel, Web Crypto, eligible `.local`/loopback host candidates, popup policy, or enterprise
restrictions. The protocol does not expose device lists, network addresses,
hardware identifiers, or a detailed capability probe. Implementations should
report actionable failures to the local user without sending telemetry by
default.

## 8. Is data sent to the underlying platform?

The sender asks the browser or installed host to navigate to an HTTPS URL. Only
HTTPS and browser-trusted loopback HTTP for local development are accepted;
credentials, non-HTTP schemes, redirects, arbitrary callback paths, queries on
protocol endpoints, and retained openers are rejected. The detached profile
also asks the browser's WebRTC implementation to create one data-only peer
connection with no media, STUN, or TURN.

## 9. Are sensors accessed?

No. OAB requests no camera, microphone, location, motion, Bluetooth, USB, or
other sensor capability. A conforming detached peer connection has no media
tracks, senders, receivers, or transceivers.

## 10. Is a new script execution or loading mechanism introduced?

No. OAB uses ordinary top-level HTTPS navigation and scripts already installed
by the sender and receiver origins. Incoming HTML, SVG, Markdown, and assets are
data, never scripts to execute. Receiver preview isolation is mandatory for
active formats.

## 11. Can an origin access other devices?

No profile is cross-device. The link profile performs navigation only. The
detached profile accepts only `.local`, exact `127.0.0.1`, or exact `::1` host candidates generated by the
browser, configures no ICE server, and is scoped to two top-level applications
on the same browser device. If that cannot be established, it fails closed.

## 12. Can an origin control native user-agent UI?

Only to the extent of a user-activated top-level navigation. Cross-origin
windows never retain a `WindowProxy`. The receiver helper can replace only its
own location with one fixed sender-origin callback path. It cannot navigate,
reload, focus, or close either application tab.

## 13. What temporary identifiers are created?

Every handoff creates independent cryptographically random request, channel,
transfer, and replay identifiers. Detached handoffs also create ephemeral P-256
keys and browser-generated WebRTC credentials. They are scoped to one transfer,
are never reused as identity, and are destroyed at completion, cancellation,
timeout, disconnect, or page lifecycle termination. Signaling expires within
at most five minutes. Before Review, an origin-wide admission lease lasts no
more than 60 seconds. After Review it may be promoted to a conservative
75-minute hard stale-record bound—the sum of the maximum setup, connected-to-
preview, and disposition phases—and should normally be released much sooner by
every terminal path.

## 14. How are first- and third-party contexts distinguished?

Protocol endpoints, helper pages, callback pages, and consent UI must run in a
top-level context and reject framing at runtime. Deployments must also send
`frame-ancestors 'none'`. OAB does not work from a third-party iframe and does
not use partitioned third-party storage as a cross-site channel.

## 15. What happens in private browsing?

No attempt is made to detect private mode. Link handoff should work subject to
the browser's URL limits. Detached handoff may fail if WebRTC, mDNS, popup,
BroadcastChannel, or storage partitioning policy is restricted. Failure is an
availability outcome and never triggers a lower-assurance transport. Optional
destination history follows the browser's private storage lifecycle.

## 16. Are security and privacy considerations documented?

Yes. The core specification has separate Security Considerations and Privacy
Considerations, each transport profile documents profile-specific risks, and
`docs/threat-model.md` records trust boundaries, attacker capabilities,
mitigations, and residual availability limits.

## 17. Can origins downgrade default protections?

No. OAB requires secure contexts, allows strict COOP/COEP, retains no opener,
does not relax same-origin policy, and does not require third-party storage.
Detached failure must stop. Link-envelope selection is explicit and requires a
visible non-confidential classification; it is never an automatic fallback.

## 18. What happens in BFCache?

An implementation must close live peer connections and channels on `pagehide`
unless `persisted` lifecycle handling can prove the session remains safe. It
must never resume an expired or terminal handoff from BFCache. Captured
fragments are scrubbed before asynchronous work. Returning to a receiver page
without a fresh fragment cannot replay the transfer.

## 19. What happens when a document disconnects?

Channels, peer connections, timers, cryptographic keys, fragment buffers, and
unpreserved transfer bytes are discarded. The receiver releases its
origin-wide admission lease on every terminal path; if script termination
prevents that release, the host's atomic store treats the stale record as
logically absent at its hard expiry and physically prunes it on the next store
operation or ordinary-app startup. A live context may also schedule deletion;
the protocol does not claim crashed browser script runs at the deadline. Replay
tombstones remain only until their bounded expiry so a
disconnect cannot make a captured launch reusable. The other side receives a
bounded timeout or channel-closed error. A partially received transfer is never
exposed as a valid preview and is never persisted.

## 20. Are errors defined?

Yes. The SDK uses stable error codes for discovery, negotiation, bounds,
activation, framing, replay, expiry, signaling, authentication, channel,
manifest, hash, timeout, preview, and result failures. Errors do not echo
document content, secrets, SDP, candidates, keys, or full fragments.

## 21. Is assistive-technology use exposed?

No. The protocol neither detects nor reports assistive technology. Reference UI
must remain keyboard-operable, screen-reader-labelled, zoom/reflow-safe, and
must not infer activation method as identity or policy evidence.

## 22. What else should be reviewed?

OAB also requires review of reverse-tabnabbing absence, local fragment exposure,
homograph-safe origin presentation, prompt fatigue, malicious-but-conformant
receivers, active-content preview isolation, browser SDP parser exposure,
WebRTC local-candidate privacy, denial-of-service bounds, popup/helper
availability, replay across reload/BFCache, and the risk of applications
misrepresenting claimed branding as verified identity. Review must also verify
that replay tombstones and pending leases are created together in one atomic
same-origin admission transaction, that rejected capacity consumes no replay
entry, that promotion follows the trusted Review action, that the configured
active-session ceiling is enforced before consent or WebRTC creation, and that late asynchronous lease grants are immediately
released after cancellation or admission timeout.

This questionnaire must be revisited after browser interoperability testing,
independent implementation, fuzzing, or any new transport profile.
