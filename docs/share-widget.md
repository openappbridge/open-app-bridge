# Drop-in sender widget

`<oab-share>` is the framework-neutral sender UI for the current OAB 1.0 wire
architecture. Importing `open-app-bridge/widget` registers the custom
element. It prepares content, discovers a receiver by domain, displays the
receiver's advertised profiles, and launches exactly one selected profile from
a separate user action.

The widget supports the two current profiles:

| UI choice              | Profile                  | Appropriate content and result                                                                                                                                                          |
| ---------------------- | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Portable text link** | `link-envelope/1`        | Small, non-confidential Markdown or plain text. The sender is unverified and receives no delivery result.                                                                               |
| **Private transfer**   | `detached-datachannel/1` | Confidential or larger content, HTML, and compatible assets. A callback plus the live channel verifies the sender origin, and the sender receives preview and Preserve/Discard results. |

The two profiles have different security properties. A failure in one never
causes the widget to switch to the other.

## Minimal integration

Install the exact SDK version and let the application's bundler resolve the
module and its stylesheet asset:

```sh
npm install --save-exact open-app-bridge@1.0.0
```

Use an existing trigger and let the widget capture rendered page content:

```html
<article id="document">
  <h1>Portable note</h1>
  <p>This content can move into a willing OAB receiver.</p>
</article>

<button id="share-document" type="button">Share</button>
<oab-share
  trigger="#share-document"
  content-selector="#document"
  content-title="Portable note"
  source-application="Example Writer"
></oab-share>
<script type="module" src="/src/app.js"></script>
```

In the application's bundled JavaScript entry:

```js
import "open-app-bridge/widget";
```

That single module, one `<oab-share>` element, and a content source provide the
complete sender flow: domain history, HTTPS discovery, verified receiver
branding, explicit profile selection, native one-shot launch, progress, and
terminal results. No receiver registry or OAB service account is involved.

For a static sender without a build system, use the exact CDN markup in the
chosen release's generated `INTEGRATION.md`. The versioned minified bundle
loads `oab-widget.css` beside itself and pins that stylesheet's integrity
internally. Alternatively, self-host those two files together. Production CDN
markup must use the release's SHA-384 SRI value and
`crossorigin="anonymous"`; never use `@latest` or a branch URL. Receiver and
utility Documents cannot use this CDN path and must self-host their restricted
resource graph. See [distribution policy](../DISTRIBUTION.md).

MarkerPad is the first product integration exercising both sender and receiver
roles. Enter `markerpad.app` in the example widget to check its production
declaration and share to it after the compatible MarkerPad release is deployed.

Omit `trigger` to use the element's built-in button:

```html
<oab-share content-selector="main" share-label="Share document"></oab-share>
```

If an external trigger is mounted later by a framework, the widget observes the
document and binds it when it appears. Until then, the built-in trigger remains
available.

## Content APIs

At each `open()`, content is resolved in this order:

1. the object or provider passed to `open()`;
2. `contentProvider`;
3. `content`; or
4. automatic page capture.

Application-owned documents should normally use a provider:

```js
import "open-app-bridge/widget";

const share = document.querySelector("oab-share");
share.contentProvider = async () => ({
  title: editor.title,
  markdown: editor.toMarkdown(),
  html: editor.toSafeHtml(),
  text: editor.toPlainText(),
  assets: await editor.embeddableAssets(),
  sourceApplication: "Example Writer",
});
```

The provider runs while the widget opens, before the final Send activation.
This leaves the native click available for navigation and lets preparation fail
before Send is enabled.

For a persistent value or a one-off share:

```js
share.content = {
  title: "Draft",
  markdown: "# Draft",
  text: "Draft",
};

await share.open({
  title: "Selected response",
  markdown: "# Selected response\n\nPortable Markdown.",
  text: "Selected response\n\nPortable Markdown.",
});
```

When a trusted user interface already identifies a destination—for example,
an application directory card—use `openFor()`. It accepts a domain, opens the
same share UI, and performs ordinary discovery immediately. The user must
still choose an advertised transfer profile and activate **Send** separately:

```js
await share.openFor("markerpad.app");
```

`openFor()` is a convenience API only. It does not bypass discovery,
compatibility checks, profile choice, or the final trusted send activation.

Automatic capture uses the current non-collapsed page selection, then
`content-selector`, then the first `main` or `article`, and finally `body`. It
produces `text/html` and `text/plain`. It removes scripts, embedded contexts,
forms and controls, active media, metadata, inline event handlers, and `srcdoc`.
Element capture also removes the widget itself and descendants marked
`data-oab-share-exclude`. This is a capture safeguard, not a substitute for
receiver-side sanitization.

The portable profile sends only the compatible Markdown/plain-text projection;
it never sends HTML or assets. The private profile may send the full prepared
content when it fits the receiver's advertised representations, asset types,
counts, and byte limits.

`sourceUrl` is omitted by default. Add `include-source-url` or provide
`sourceUrl` explicitly only when disclosing the page path is appropriate.
Resolved content without those fields uses `content-title`, then
`document.title`, for its title and `source-application`, then the sender
hostname, for its claimed application label.

## Attributes and methods

| Attribute                       | Purpose                                                                                   |
| ------------------------------- | ----------------------------------------------------------------------------------------- |
| `trigger`                       | CSS selector for an existing button or link; omitted uses the built-in button             |
| `share-label`                   | Built-in button label; defaults to `Share`                                                |
| `content-selector`              | Element captured when no programmatic content is supplied                                 |
| `content-title`                 | Default title for automatically captured content                                          |
| `source-application`            | Optional, untrusted application claim attached to captured content                        |
| `include-source-url`            | Includes the current page URL; absent by default                                          |
| `storage-key`                   | Separates browser-local destination histories                                             |
| `remember-destinations="false"` | Leaves Remember unchecked for a newly checked domain                                      |
| `detached`                      | Enables the private-profile choice only after this sender has deployed the fixed callback |
| `discovery-timeout-ms`          | Complete discovery deadline; default `8000`, allowed `100`–`30000`                        |
| `manifest-timeout-ms`           | Optional manifest deadline; default `4000`, allowed `100`–`15000`                         |
| `icon-timeout-ms`               | Optional verified-icon deadline; default `4000`, allowed `100`–`15000`                    |

The public DOM API is:

```js
share.content = contentObject;
share.contentProvider = () => contentObjectOrPromise;
share.detachedEnabled = true; // Reflects the `detached` attribute.
share.discoveryTimeoutMs = 8000;
share.applicationManifestTimeoutMs = 4000;
share.applicationIconTimeoutMs = 4000;
await share.open(optionalContentOrProvider);
share.close();
share.clearDestinations();
```

`clearDestinations()` affects only this widget's local history. It does not
change receiver policy or stored receiver content.

All three network deadlines include response-body consumption. Remove a
timeout attribute to restore its default. Values outside the documented hard
range are rejected; the widget cannot configure an unbounded request.
Discovery timeout is shown as a check failure. Optional manifest or icon
timeout keeps the verified domain visible and uses local fallback presentation.

## Discovery and explicit profile selection

The destination field accepts a domain or subdomain such as `editor.example`,
not a scheme, credential, path, query, or fragment. A public domain becomes its
canonical HTTPS origin. Browser-trusted loopback hosts use HTTP only for local
development; public sender and receiver pages require HTTPS. Give independent
applications distinct subdomains because an origin, not a path, is the OAB
security identity.

**Check** performs fresh, credential-free, redirect-free discovery at
`/.well-known/open-app-bridge`. Discovery and **Send** remain separate user
actions. The verified domain stays visible. Optional same-origin Web App
Manifest display metadata comes from the declaration's `applicationManifest`
member; its name, description, and icon are untrusted decoration, not identity
evidence. Discovery, manifest, and icon network work is independently bounded
by the hard deadlines above.

After Check, the widget shows both profile choices and enables only those that
the receiver explicitly advertised and that fit the prepared content. Send is
bound to exactly the visible selected profile. When `detached` is enabled and
compatible, Private transfer is initially selected; otherwise a compatible
Portable text link is selected. The user can change between enabled choices
before Send. Incompatible or unadvertised choices remain disabled.

Selecting the portable profile is an explicit non-confidential choice. It puts
bounded encoded text in local URL fragment state until the receiver
synchronously scrubs it, does not prove the sender, and has no receipt. The
private profile keeps content out of URLs, establishes an encrypted direct
channel after receiver authorization, and reports previewing followed by
`preserved` or `discarded`.

## Enabling private transfer

Do not add `detached` merely because a receiver may advertise the private
profile. The attribute asserts that the sender origin already serves this exact
static callback path:

```text
/.well-known/open-app-bridge/callback
```

The callback is a restricted OAB utility Document for its complete lifetime.
It never initializes or loads analytics, third-party resources, authentication,
sync, or ordinary application services. Its parser-blocking capture must run
before any other executable or subresource discovery:

```js
import { runDetachedSenderCallback } from "open-app-bridge";

await runDetachedSenderCallback(window, {
  closeWindow: () => window.close(),
});
```

Only after that callback is deployed should the host enable the profile:

```html
<oab-share detached trigger="#share-document"></oab-share>
```

It must be a non-redirecting, query-free, top-level secure page on the exact
sender origin. It must synchronously capture and scrub its fragment, require a
null opener, validate the browser-controlled receiver-origin referrer, relay
only the sealed answer through the random same-origin channel, avoid storage,
service workers, analytics, and third-party code, and be served cache-free with
the response policies specified by the detached profile. The widget does not
create, deploy, or probe this callback for the host.

If the callback or any required secure browser capability is unavailable, omit
`detached`. The widget can then offer only an advertised, compatible portable
text profile. It does not substitute an upload, form post, clipboard operation,
or weaker profile when private transfer fails.

## Native navigation and opener isolation

The widget prepares the selected launch before enabling its real
`<a part="send-link">`. On a trusted, unmodified primary activation, the anchor
opens a new top-level receiver context with `target="_blank"`,
`rel="noopener noreferrer"`, and `referrerpolicy="no-referrer"`. The receiver
therefore receives no reference to the sender window. The widget does not use a
retained cross-origin window handle, and a synthetic event or stale discovery
fails closed.

Hosts should preserve this native anchor behavior. Do not replace it with
background navigation, opener messaging, or a programmatic popup. Preparing
content and checking discovery may be asynchronous; the final Send handler must
remain the browser's native navigation from fresh user activation.

## Destination history

The widget keeps up to 20 destinations in `localStorage`, ordered by most
recent use. A portable destination is remembered after launch; a private
destination is remembered only after the receiver reports that it is
previewing. Each entry contains only the canonical receiver origin, last-used
time, and bounded untrusted Web App Manifest display metadata. Content, titles,
assets, signaling, keys, declarations, live capabilities, and receiver policy
are never stored in this history.

Users can leave Remember unchecked, remove one destination, or clear the list.
`storage-key` creates a separate local history for another workspace. If
storage is missing or denied, the same interface uses page-lifetime memory.
History is a private sender-side convenience; it is not a trust decision, an
allowlist, or proof that discovery remains fresh.

## Events

All widget events bubble and cross the shadow boundary. Their `detail` objects
are frozen.

| Event                     | `detail`                                                                         |
| ------------------------- | -------------------------------------------------------------------------------- |
| `oab-open`, `oab-close`   | Empty object                                                                     |
| `oab-receiver-verified`   | `origin`, `declaration`                                                          |
| `oab-launched`            | `origin`, `requestId`, `transport: "link-envelope/1"`, `receiptAvailable: false` |
| `oab-previewing`          | `origin`, `requestId`, `transferId`, `transport: "detached-datachannel/1"`       |
| `oab-result`              | Previous private-transfer fields plus `disposition: "preserved" \| "discarded"`  |
| `oab-error`               | Stable `code`, safe `message`, and the `OabError` instance                       |
| `oab-destination-removed` | Removed `origin`                                                                 |

```js
share.addEventListener("oab-result", ({ detail }) => {
  console.log(detail.origin, detail.disposition);
});

share.addEventListener("oab-error", ({ detail }) => {
  showShareError(detail.code, detail.message);
});
```

`oab-launched` means only **Launch initiated (unconfirmed)**: a valid native
activation was given an opportunity to navigate. It does not prove that the
receiver opened and must not be reported as navigation success, preview,
delivery, or persistence. `oab-previewing` means detached content is transiently
previewing; durable storage remains a separate receiver user decision
represented by `oab-result`.

For a portable launch, the widget emits `oab-launched` only after crossing the
native click's task boundary. An integration may close or rebuild its sharing
host in response to that event without cancelling the anchor's default
navigation. Integrations must still treat the event as a launch indication,
not a receiver delivery receipt.

## Styling

The component uses shadow DOM. Set its custom properties on `oab-share` and
target exposed elements with `::part()`:

```css
oab-share {
  --oab-share-font-family: Inter, system-ui, sans-serif;
  --oab-share-accent: #6d28d9;
  --oab-share-accent-color: #fff;
  --oab-share-surface: #fff;
  --oab-share-surface-raised: #f7f5ff;
  --oab-share-color: #1f1633;
  --oab-share-muted-color: #6e6580;
  --oab-share-border-color: #ded7eb;
  --oab-share-danger: #b42318;
  --oab-share-focus: #a78bfa;
  --oab-share-radius: 24px;
  --oab-share-shadow: 0 24px 80px rgb(31 22 51 / 25%);
  --oab-share-backdrop: rgb(31 22 51 / 55%);
}

oab-share::part(send-link) {
  letter-spacing: .02em;
}
```

| Custom property                                     | Controls                           |
| --------------------------------------------------- | ---------------------------------- |
| `--oab-share-font-family`                           | Widget font stack                  |
| `--oab-share-color`, `--oab-share-muted-color`      | Primary and secondary text         |
| `--oab-share-surface`, `--oab-share-surface-raised` | Main and raised surfaces           |
| `--oab-share-border-color`                          | Borders                            |
| `--oab-share-accent`, `--oab-share-accent-color`    | Accent background and text on it   |
| `--oab-share-danger`                                | Error and destructive-action color |
| `--oab-share-focus`                                 | Keyboard focus ring                |
| `--oab-share-radius`                                | Dialog corner radius               |
| `--oab-share-shadow`                                | Dialog shadow                      |
| `--oab-share-backdrop`                              | Modal backdrop                     |

Exposed parts are grouped below:

| Area                | Parts                                                                                                                                                             |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Trigger and shell   | `trigger`, `dialog`, `surface`, `header`, `eyebrow`, `title`, `close-button`, `introduction`                                                                      |
| History             | `history`, `history-title`, `destination-list`, `destination-item`, `destination-choice`, `remove-destination`, `empty-destinations`                              |
| Search and status   | `search-section`, `search-label`, `search-row`, `destination-input`, `check-button`, `status`                                                                     |
| Verified receiver   | `verified`, `verified-identity`, `capabilities`, `application-identity`, `application-icon`, `application-name`, `application-origin`, `application-description`  |
| Profile and actions | `profile-choices`, `profile-title`, `profile-choice`, `profile-note`, `remember-label`, `remember-input`, `actions`, `send-link`, `change-button`, `privacy-note` |

The default styles include a narrow-screen bottom sheet and respect light/dark
and reduced-motion preferences. The host must serve the widget module and its
adjacent stylesheet from locations allowed by the page's Content Security
Policy.

## Security responsibilities

The host application remains responsible for choosing accurate content,
avoiding unwanted `sourceUrl` disclosure, deploying the detached callback
before enabling it, maintaining the sender origin and dependency security, and
handling terminal errors honestly. A receiver's manifest branding does not
attest a company, publisher, application binary, or person; the displayed
canonical domain is the identity available to the user.

The widget provides sender UX, not receiver authorization. Receivers still
control Allow/Verify decisions, validate declared limits, render received HTML
and Markdown safely, keep content transient through preview, and write durable
state only after **Preserve**. Neither profile protects against a compromised
sender origin, receiver origin, browser, operating system, or locally
privileged extension.

See [Sender integration](sender-integration.md), the
[link-envelope profile](../spec/transports/link-envelope-1.0.md), and the
[detached-datachannel profile](../spec/transports/detached-datachannel-1.0.md)
for the full protocol contracts.
