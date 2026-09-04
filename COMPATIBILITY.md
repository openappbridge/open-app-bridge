# Compatibility

OAB is a breaking draft. Implementations negotiate exact entries from
`wireVersions` and the `transports` map. There is no implicit wire version,
default profile, or legacy fallback.

## Common web requirements

- secure top-level browsing context;
- HTTPS, with browser-trusted loopback HTTP only for development;
- credential-free CORS `fetch()`;
- bounded UTF-8 and JSON processing;
- SHA-256 through Web Crypto;
- canonical unpadded base64url and fixed-order raw fragment parsing without
  form/query decoding;
- `history.replaceState()`;
- native noopener navigation; and
- receiver framing denial;
- a receiver-host coordination mechanism that atomically creates a replay
  tombstone plus short pending lease (or neither), caps 1–4 pending-plus-active
  incoming sessions across tabs/workers/reloads, and promotes the lease after
  user Review.

The well-known discovery file is static JSON and can be hosted wherever an
8 KiB file can be served with CORS. OAB-specific custom capability headers are
not required. Standard security, CORS, content-type, cache, and referrer headers
still apply to their documented resources. Redirecting discovery is not
compatible.

## `link-envelope/1`

This profile works from browser and installed senders that can open an HTTPS
URL. The receiver requires no sender browsing context.

URL capacity differs across browsers, WebViews, operating-system URL launch
APIs, app bridges, history implementations, and embedding frameworks.
Receivers advertise limits for the complete URL, fragment, and decoded body;
senders apply smaller tested local limits. The protocol hard limits are not a
promise that every platform accepts a URL of that size.

The receiving route SHOULD be excluded from Android App Links and Apple
Universal Links when the user selected a web receiver, unless the installed
handler implements the exact same OAB validation and preview contract.

The receiver's replay and admission stores contain only random IDs, transport,
expiry, and lease state—not received content. Per-tab memory and
`sessionStorage` are insufficient because they cannot make claims and capacity
linearizable across concurrent contexts. An implementation may use a bounded
same-origin transactional store, a shared coordinator, or an equivalent host
primitive, and must expiry-clean stale records.

This profile provides no callback. Browser history/back navigation does not
become a result signal.

## `detached-datachannel/1`

Additional required APIs:

- Web Crypto ECDH P-256, HKDF-SHA-256, and AES-256-GCM;
- `RTCPeerConnection`, `RTCIceCandidate`, and ordered
  `RTCDataChannel`;
- `BroadcastChannel`; and
- cryptographically secure random generation.

The browser sender origin must serve the fixed callback resource. The receiver
origin must serve its advertised helper resource. Both must be top-level and
opener-free.

The receiver endpoint/helper and sender callback routes must remain browser
routes. Deployments that also use Android App Links, Apple Universal Links, or
equivalent native routing exclude these OAB paths unless the installed handler
implements the exact same profile and can preserve the required browser-origin
BroadcastChannel rendezvous. Ordinary native interception cannot do so and
makes the detached profile unavailable.

The helper response must be able to set `Referrer-Policy: origin`. Its
navigation to the callback must produce a non-empty browser-controlled referrer
whose canonical origin is the receiver origin. Privacy tools that strip this
referrer make the detached profile unavailable; the callback fails closed.

The profile intentionally configures no ICE server and accepts only `.local`
mDNS or exact `127.0.0.1`/`::1` host candidates. Browser policy, private
browsing, VPNs, Tor, enterprise management, extensions, WebViews, or mDNS/RTC
restrictions may make it unavailable. That
is a conformant failure when it is reported and no alternate profile is
selected automatically.

Version 1 is a same-browser-device browser-sender profile. The two
`BroadcastChannel` rendezvous steps require the original sender tab and its
callback to share the sender origin's top-level storage partition, and receiver
main/helper to share the receiver origin. It is not a cross-device transport
and is not a general native-app callback mechanism.

## COOP, COEP, and storage partitioning

OAB does not use a cross-origin opener. Sender and receiver applications may
retain `Cross-Origin-Opener-Policy: same-origin` and strict COEP where their
other dependencies permit it.

`BroadcastChannel` is same-origin and used only between top-level pages on
that origin. It does not depend on a third-party iframe storage partition.
The receiver helper uses a top-level same-origin channel before navigating
itself to the sender callback.

If browser policy partitions even those top-level same-origin contexts or
disables BroadcastChannel, detached transfer fails closed.
## Widget requirements

The optional reference sender widget additionally uses Custom Elements, open
shadow DOM, the native `dialog` element, and local storage for destination
history when available. Widget APIs are not protocol requirements.

A widget offering detached transfer must either be hosted on an origin that
deploys the fixed callback or disable that profile. A drop-in script alone can
still implement link-envelope compatibility.

## Published evidence

Compatibility claims must name:

- browser/OS and exact version;
- normal/private/managed mode;
- selected profile;
- COOP/COEP/CSP policy;
- VPN or network policy;
- helper/callback behavior;
- observed `opener` values; and
- maximum successful/rejected bounds.

The Node/unit suite is not browser interoperability evidence. Stable release
requires the cross-engine matrix listed in [ROADMAP.md](ROADMAP.md).
