# Sender integration

OAB sender UX has four explicit stages: discover a receiver, prepare content,
choose one advertised transport, and launch it from a user action. The two
transports have different security properties and are never automatic
fallbacks for one another.

## 1. Discover a receiver

Ask for a domain such as `editor.example`, not a full URL. Subdomains identify
independent applications. Paths, schemes, credentials, queries, and fragments
are rejected because the canonical HTTPS origin is the receiver identity.

```js
import {
  discoverReceiver,
  receiverInputToOrigin,
} from "open-app-bridge";

const origin = receiverInputToOrigin(receiverInput.value);
const receiver = await discoverReceiver(origin);
```

Discovery is a credential-free, no-referrer, redirect-free JSON `GET` to
`/.well-known/open-app-bridge`. Keep Send disabled unless the document is
valid, `status` is `enabled`, a wire version is mutually supported, and at
least one known profile is explicitly advertised in `transports`.

The SDK bounds the complete discovery fetch and body read to 8 seconds by
default (30-second hard ceiling). Optional manifest branding and icon probing
have separate 4-second defaults (15-second hard ceilings), so an unresponsive
decorative resource cannot indefinitely block destination verification or the
widget. A caller `AbortSignal` can cancel earlier but never removes these
deadlines.

For a predetermined workflow, require the exact profile:

```js
const receiver = await discoverReceiver(origin, {
  requiredTransport: "detached-datachannel/1",
});
```

Optional `receiver.application` metadata comes from the receiver's standard Web
App Manifest. It is display-only and potentially deceptive. Always show the
canonical receiver domain beside its name and icon. If metadata times out,
fails validation, or contains a lone UTF-16 surrogate, use the domain and a
local glyph; do not retain a partially normalized identity.

## 2. Prepare content once

```js
import { prepareContent } from "open-app-bridge";

const content = prepareContent({
  title: "Portable note",
  markdown: "# Portable note",
  html: "<h1>Portable note</h1>",
  text: "Portable note",
  assets: [{
    name: "diagram.svg",
    mimeType: "image/svg+xml",
    data: svgBlob,
  }],
  sourceApplication: "Example Writer",
  sourceUrl: document.location.href,
});
```

Preparation validates the local payload; it does not imply the receiver will
accept every representation. Profile selection must consider confidentiality,
asset presence, size, required receipt, and the explicit declaration.

## 3. Choose a profile explicitly

| Need | Eligible profile |
|---|---|
| Small, ordinary Markdown/plain text; no receipt required | `link-envelope/1` |
| Confidential text, HTML, assets, large content, or final receipt | `detached-datachannel/1` |

`link-envelope/1` exposes encoded text to local URL/history/browser machinery
until the receiver scrubs it and provides no sender verification or result. It
must never be presented as secure transfer. `detached-datachannel/1` keeps
content out of URLs and transfers it through an encrypted direct channel,
but requires the RTC, Web Crypto, BroadcastChannel, helper, and callback
capabilities described below.

If the chosen profile is unsupported or fails, show that failure. Offer the
other profile only as a fresh, explicit user choice with its properties shown.

## 4A. Send a link envelope

This path rejects HTML and assets. The explicit classification acknowledgement
is required:

```js
import { createLinkAnchorHandoff } from "open-app-bridge";

const launch = await createLinkAnchorHandoff(receiver, content, {
  contentClassification: "non-confidential",
});

launch.bind(link);
link.addEventListener("click", (event) => launch.activate(event));
```

Enable the native anchor only after the URL has been built and bounded. An
accepted activation consumes the controller-held URL/capability immediately,
but the activated anchor, its security attributes, and its containing Document
must remain intact through click dispatch, its microtask checkpoint, and at
least one following event-loop task. Do not remove or replace the anchor,
disable its `href`, unmount it, close/rebuild its host, or emit any externally
observable launch-indication callback/event before that task boundary. A
Promise continuation or `queueMicrotask()` is too early.

After that boundary the sender may report only **Launch initiated** (or
equivalent explicitly unconfirmed language). The profile has no receiver
return path, so a local event, elapsed timeout, or newly observed browsing
target does not prove that content was received. Never label the outcome sent,
delivered, previewed, accepted, preserved, or discarded.

## 4B. Send over a detached data channel

The sender must serve a small static callback page at its exact-origin path:

```text
/.well-known/open-app-bridge/callback
```

That page is a restricted OAB utility Document for its complete lifetime. It
never initializes or loads analytics, external resources, authentication, sync,
or ordinary application services. It must be top-level, unframed, cache-free,
and free of third-party code; its parser-blocking capture runs before any other
executable or subresource discovery.

A deferred module cannot meet that order by itself. Use a parser-blocking,
same-origin classic bootstrap before CSS or visible DOM. It privately copies
the fragment, complete URL, query presence, and `document.referrer`, scrubs the
URL synchronously, then imports the callback module and passes the copy as
`scrubbedHandoff`. See `examples/utility-bootstrap.js`.

Before enabling Send, use the high-level facade so the SDK owns capability
binding, expiry cleanup, activation validation, signaling, and transfer:

1. assert fresh discovery and explicit `detached-datachannel/1` support;
2. call `createDetachedAnchorHandoff()` with the prepared content;
3. call `bind()` on exactly one native anchor; and
4. call `activate(event)` directly from its trusted click.

Pass `onActivationError` to surface guarded auxiliary-click, context-menu,
drag, or non-primary pointer attempts. The SDK cancels the gesture and consumes
the prepared capability even if the callback is absent or throws; prepare a
fresh handoff before offering Send again.

```js
const handoff = await createDetachedAnchorHandoff(receiver, content);
handoff.bind(sendLink);
sendLink.addEventListener("click", (event) => {
  const previewing = handoff.activate(event);
  void previewing.then(async (preview) => {
    showPreviewing();
    showFinalDisposition(await preview.completion);
  });
});
```

The final Send click performs only the already-prepared native navigation. The
same task-boundary rule applies: retain the activated anchor, `href`, security
attributes, and Document through dispatch and its microtask checkpoint, then
cross at least one event-loop task before removal, disablement, replacement,
unmount, host close/rebuild, or any externally observable launch-indication
callback/event. The new receiver context must have no cross-origin window
reference.

The receiver's **Review shared content** action opens its same-origin helper. The
helper later navigates itself to the fixed sender callback with an encrypted
answer fragment. The callback scrubs that fragment and relays the opaque answer
through the random sender-origin channel. Low-level signaling and framing APIs
remain available for audited adapters, but such adapters must reproduce the
facade's exact anchor binding, expiry, callback, capability, and cleanup rules;
they are not a shortcut around them.

An audited low-level adapter must generate at least 128 bits of transfer-ID
entropy rather than using a structured identifier with fewer random bits:

```js
import { encodeBase64Url } from "open-app-bridge";

const transferId = encodeBase64Url(
  crypto.getRandomValues(new Uint8Array(16)),
);
```

The signaling bootstrap contains no content-derived metadata. After connection,
the required order is capabilities, manifest, grant, bounded data frames,
previewing acknowledgement, and final result. Never transmit the manifest or
content before receiver authorization and live capabilities.

## Destination history

History, favourites, labels, folders, and synchronization are sender UX. A
local record may contain the canonical origin, user label, selected manifest
display metadata, favourite state, and last-used time. It must not contain
content, signaling, ephemeral keys, declaration IDs beyond their TTL, live
capabilities, or receiver policy. Refresh discovery when its TTL expires.

## Installed senders

An installed application may implement `link-envelope/1` by performing the
same HTTPS JSON discovery and opening the bounded HTTPS URL from the user's
Send action. The source remains unverified and receives no result; the host may
report only that launch was initiated, never that content was sent, delivered,
previewed, accepted, or preserved.

The native implementation must match the core specification's installed-sender
contract: foreground domain choice, credential-free/redirect-free bounded
discovery with normal TLS validation, canonical origin and privacy UI, separate
fresh Send action, activation-time freshness checks, one exact browser launch,
and immediate erasure of the prepared URL. Background services, notifications,
automations, server commands, auth headers, account/device identifiers, and
automatic retries are not valid activation evidence.

`detached-datachannel/1` currently requires a browser sender page on the claimed
sender origin so the fixed callback and same-origin rendezvous can complete. A
native host that cannot provide that environment must report the profile as
unavailable; it must not upload to a server or silently switch profiles.

## Failure handling

Treat expiry, discovery change, signaling rejection, helper/callback timeout,
unsupported candidate policy, peer failure, malformed frame, hash mismatch,
receiver denial, and disposal as visible terminal failures. Close every
session resource. Do not retry automatically with weaker privacy semantics.
