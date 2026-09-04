# Open App Bridge

Open App Bridge (OAB) is a registry-free, user-mediated protocol for
handing editable content to a web application chosen by domain. It requires no
OAB account, relay, public payload endpoint, browser extension, installed
receiver, central directory, or operating-system integration.

> **Status:** 1.0 Draft for security review and interoperability testing.

## Install the reference SDK

For an application build, install and lock the official package:

```sh
npm install --save-exact open-app-bridge@1.0.0
```

```js
import { discoverReceiver, prepareContent } from "open-app-bridge";
import "open-app-bridge/widget";
```

Each tagged release also provides readable and minified standalone core and
widget bundles, source maps, an integrity manifest, checksums, exact-version CDN
markup, and build provenance. Receiver and utility Documents must self-host
their complete restricted resource graph. See [Distribution and release
policy](DISTRIBUTION.md).

## What OAB guarantees

- The user enters or selects a receiver domain.
- The sender performs a bounded, credential-free HTTPS `GET` of
  `/.well-known/open-app-bridge`.
- The receiver must explicitly advertise every supported profile in a strict
  JSON document.
- Discovery and Send are separate user actions.
- Every browser launch is top-level and `noopener noreferrer`.
- Content is transient until the receiver authorizes it and shows a preview.
- Each incoming request has one visible, request-bound preview authorization;
  origin and manifest verification are internal gates, not repeated approvals.
- Durable storage occurs only after the receiver user chooses **Preserve**.
- The complete receive Document remains a restricted protocol process using
  only packaged first-party resources plus the detached profile's explicitly
  permitted host-only RTC traffic; Preserve does not activate content there.
- Ordinary application startup/rendering follows only after terminal cleanup
  and a clean full-document transition.
- A selected profile fails closed; OAB never silently changes profile.

OAB does not make a claimed application name trustworthy, attest an
application binary, remove the normal consequences of a compromised sender or
receiver origin, or turn a public URL fragment into confidential storage.

## Profiles

| Profile | Use | Content | Sender evidence | Result |
|---|---|---|---|---|
| `link-envelope/1` | Small, non-confidential portable text | Markdown/plain text; no HTML or assets | Unverified claim | Unconfirmed launch only; no receipt |
| `detached-datachannel/1` | Private, larger, or binary direct handoff | Advertised text and assets | Exact sender origin verified through callback + live channel | Previewing, then Preserved/Discarded |

The link profile puts bounded encoded text in local fragment state, scrubs it
synchronously at the receiver, and is intentionally low assurance. A sender
may report only **Launch initiated** after the native task boundary—never sent,
delivered, previewed, accepted, or preserved. The
detached profile uses candidate-free browser SDP, privacy-preserving mDNS or
exact loopback host candidates,
ephemeral P-256 key agreement, an encrypted answer callback, and an ordered
DTLS-protected WebRTC DataChannel. It configures no STUN or TURN service and
accepts only `.local`, `127.0.0.1`, or `::1` host candidates. This constrains network
reachability; it does **not** attest that both peers are on one physical device.
A sender that adds out-of-protocol signaling could relay a connection to a
same-LAN peer, so receiver UI must describe the channel as direct—not
"same-device verified."

## Discovery

A receiver serves a CORS-readable JSON document at the exact well-known path:

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
      "receiverHelper": "/_oab/detached-helper",
      "representations": ["text/markdown", "text/html", "text/plain"],
      "assetTypes": ["image/png", "image/webp", "image/svg+xml"],
      "limits": {
        "maximumSignalingBytes": 32768,
        "maximumFrameBytes": 16384,
        "maximumTransferBytes": 16777216,
        "maximumAssets": 32
      }
    }
  },
  "declarationId": "replace-when-capabilities-change",
  "senderPolicy": "user-controlled",
  "discoveryTtl": 300,
  "applicationManifest": "/manifest.webmanifest",
  "extensions": {}
}
```

Use [`schemas/receiver-declaration.schema.json`](schemas/receiver-declaration.schema.json)
and the deployment examples in [`examples/server-configs`](examples/server-configs).
The Web App Manifest is optional, untrusted display metadata; the verified
domain always remains visible.

Every network read is hard-bounded through body completion: discovery defaults
to 8 seconds (30-second ceiling), while optional manifest and verified-icon
reads each default to 4 seconds (15-second ceilings). `NETWORK_REQUEST_LIMITS`
exposes these immutable SDK bounds; caller cancellation may only shorten them.

Discovery, every receiver/helper/callback Document, and every transitive
packaged resource they load form the network-authoritative OAB resource graph.
All of those requests receive no service-worker fetch-event handling and
proceed directly to the network. Even `respondWith(fetch(event.request))` is
non-conformant interception. A controlling migration worker must not message or
telemeter restricted OAB Documents or start OAB-related background work.
Origins with a historical intercepting worker keep OAB disabled through a
separate, verified migration deployment and enable it only in a later release;
page-time unregister or a new versioned route is not sufficient.
The server-configuration skeletons reserve `/_oab/resources/` for every
transitive restricted bootstrap, module, stylesheet, font, image, and other
asset. They are not a runnable receiver: the referenced HTML and complete
resource graph are application-supplied build outputs. Package that graph there
or maintain an explicit equivalent inventory; headers on the three HTML routes
alone do not establish network authority.

## Sender API

Profile selection is mandatory:

```js
import {
  OAB_TRANSPORTS,
  createHandoff,
  discoverReceiver,
  prepareContent,
} from "open-app-bridge";

const receiver = await discoverReceiver("https://receiver.example", {
  timeoutMs: 8000,
  applicationManifestTimeoutMs: 4000,
});
const content = prepareContent({
  title: "Research note",
  markdown: "# Research note\n\nPortable source.",
  text: "Research note\n\nPortable source.",
});

const handoff = await createHandoff(receiver, content, {
  transport: OAB_TRANSPORTS.linkEnvelope,
  contentClassification: "non-confidential",
});

handoff.bind(sendAnchor);
sendAnchor.addEventListener("click", (event) => {
  handoff.activate(event);
});
```

Accepted activation invalidates the controller-held capability immediately,
but the activated anchor, its security attributes, and its Document must remain
intact through dispatch, its microtask checkpoint, and at least one following
event-loop task. A Promise continuation or `queueMicrotask()` is too early to
remove, disable, replace, or unmount the anchor, close or rebuild its host, or
emit an externally observable launch-indication callback/event. For
`link-envelope/1`, `status: "launched"` remains an unconfirmed local
indication, not receiver evidence.

For `detached-datachannel/1`, the sender must also host the fixed static
callback at `/.well-known/open-app-bridge/callback`. The same API returns a
promise that resolves when the receiver begins previewing; its `completion`
promise resolves to `preserved` or `discarded`. See
[`docs/sender-integration.md`](docs/sender-integration.md).

Receiver products also follow the normative
[`human-interaction-contract`](docs/human-interaction-contract.md): the page
owns its brand and context, asks once to review the incoming item, treats the
helper/callback as non-consent utility states, and makes Save progress and
recovery observable.
The detached helper/callback follow the normative
[`utility-page-lifecycle`](docs/utility-page-lifecycle.md); automatic navigation
and callback closure are best-effort UX, never delivery evidence.

## Receiver API

The receiver must capture and scrub a launch fragment before any await,
render, log, analytics call, or third-party code. It should bundle the current
declaration into its capture route so detached capture is synchronous:

```js
const incoming = consumeIncomingHandoff(currentDeclaration, {
  admitIncomingHandoff,  // both: atomic replay tombstone + pending lease
  reserveIncomingBytes,  // detached: origin-wide aggregate byte lease
  authorizeSender,       // link: unverified sender consent
  deliver,               // link: transient preview only
  authorizeOrigin,       // detached: one conditional preview authorization
  authorizeManifest,     // detached: silent request-bound manifest policy gate
  onPreview,             // detached: transient content preview
});

if (incoming?.transport === "detached-datachannel/1") {
  const prepared = await incoming.prepare();
  prepared.bind(verifyAnchor);
  verifyAnchor.addEventListener("click", async (event) => {
    const verification = prepared.verify(event);
    const transfer = await verification;
    const preview = await transfer.preview;
    renderTransientPreview(preview, {
      deadline: preview.dispositionExpiresAt,
      async onPreserve() {
        const localId = createReceiverOwnedDocumentId();
        try {
          await transfer.preserve({
            commit: ({ delivery, signal }) =>
              commitAtomically(localId, delivery, { signal }),
            rollback: () => deleteDurableDocument(localId),
          });
        } finally {
          await eraseTransientPreviewAndDropReferences();
          location.replace(`/documents/${encodeURIComponent(localId)}`);
        }
      },
      async onDiscard() {
        try {
          await transfer.complete("discarded");
        } finally {
          await eraseTransientPreviewAndDropReferences();
          location.replace("/documents");
        }
      },
    });
  });
}
```

`bind()` is mandatory for the high-level anchor facades. It binds exactly one
native anchor, strips unsafe navigation attributes, validates the same anchor
and security attributes at activation, and removes the DOM `href` on expiry,
failure, close, or consumption. The Preserve transaction is also mandatory:
its commit must honor the abort signal, and rollback must remove the
receiver-owned record if the visible disposition deadline wins the race.

Replay and session admission must be one atomic transaction across tabs,
workers, and reload overlap. It returns an exact reasoned rejection or
`{admitted: true, promote(), release()}`. Rejection creates no record; the
short pending lease is promoted only after Review, while its replay tombstone
remains until offer expiry. Idempotent release and expiry-indexed cleanup are
required on every terminal path.

Scrubbing does not end the receive boundary. While any handoff evidence,
transient preview, transport capability, or Preserve state remains, the marked
Document must not initialize analytics/telemetry, advertising, authentication
or account UI, background sync, remote fonts, CDN renderers, third-party
resources, speculative loads, or an ordinary application service worker.
Preserve stages an inert receiver-owned record. After transient cleanup and any
detached terminal result, close the Document or perform full top-level
navigation to a clean query-free and fragment-free application URL before the
ordinary app selects, opens, richly renders, executes, or resolves references
from that record. SPA/history state is not that transition.

The detached receiver helper and fixed sender callback are restricted OAB
utility Documents under the same no-app-services rule. After any terminal
outcome, a content-free terminal message may remain only while its Document
stays restricted; entering the ordinary app always requires a new clean
Document.

The receiver also hosts its discovered same-origin helper. The helper response
must use `Referrer-Policy: origin`; the fixed sender callback validates the
browser-controlled referrer. Minimal entry points are
`runDetachedReceiverHelper(window)` and `runDetachedSenderCallback(window)`.
Both utility documents need a parser-blocking, same-origin classic bootstrap
as their first executable resource. It privately copies the raw URL evidence,
calls `history.replaceState()` synchronously, and only then imports the module
graph with that exact copy as `options.scrubbedHandoff`. Loading a deferred
module directly is too late because parsing, CSS, or other scripts can run
first. The complete pattern is in `examples/utility-bootstrap.js`.
See [`docs/receiver-integration.md`](docs/receiver-integration.md).

## Drop-in sender widget

`<oab-share>` provides domain search, private in-browser destination history,
Web App Manifest identity, explicit profile selection, and native anchor
activation:

```html
<button id="share">Share</button>
<oab-share
  detached
  trigger="#share"
  content-selector="article"
  source-application="Example editor"
></oab-share>
<script type="module" src="/src/app.js"></script>
```

In the application's bundled JavaScript entry:

```js
import "open-app-bridge/widget";
```

Omit `detached` unless the sender origin deploys the fixed callback resource.
Without it, the widget can offer only an advertised compatible portable-text
profile. Styling is controlled by CSS custom properties and `::part()`.
See [`docs/share-widget.md`](docs/share-widget.md).

For a no-build static sender, download `oab-widget.min.js` and
`oab-widget.css` from the same immutable GitHub release and serve them together,
or use the exact-version SRI-protected CDN tag generated in that release's
`INTEGRATION.md`. Never copy a moving `src/` directory into an application.

Browser conformance claims require more than an SDK event or inspected URL.
Evidence must start with a real trusted click and the exact pre-click `href`,
then observe exactly one new top-level target and its exact initial request to
the discovered endpoint, followed by receiver capture/scrub and prompt or parse
evidence. It must also prove the complete restricted-Document and historical
service-worker migration boundaries on every claimed engine.

## Run the local interoperability example

```bash
npm test
npm run check
npm run example
```

Open the sender at `http://localhost:8080/examples/sender/` and use
`127.0.0.1:8080` as the receiver domain. Loopback HTTP is permitted only for
local development; deployed OAB resources require HTTPS.

The framework-neutral [`<oab-share>` widget](docs/share-widget.md) is the bridge
used by MarkerPad's web sender. MarkerPad implements both protocol roles and is
the product-level interoperability example; the repository examples remain the
minimal, auditable reference harness.

## Protocol and security documents

- [Core protocol](spec/open-app-bridge-1.0.md)
- [Link envelope profile](spec/transports/link-envelope-1.0.md)
- [Detached DataChannel profile](spec/transports/detached-datachannel-1.0.md)
- [Architecture](docs/architecture.md)
- [Threat model](docs/threat-model.md)
- [Human interaction contract](docs/human-interaction-contract.md)
- [Normative inert preview contract](docs/inert-preview-contract.md)
- [Error-code registry](docs/error-codes.md)
- [Utility page lifecycle contract](docs/utility-page-lifecycle.md)
- [Security and privacy questionnaire](docs/security-privacy-questionnaire.md)
- [Interoperability checklist](docs/interoperability-checklist.md)
- [Distribution governance](DISTRIBUTION.md)
- [Governance](GOVERNANCE.md)
- [Security policy](SECURITY.md)

## License

Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
