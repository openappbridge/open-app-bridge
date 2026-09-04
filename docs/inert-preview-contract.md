# Inert preview contract

Status: normative receiver integration profile for OAB 1.0 draft.

OAB delivers untrusted text and bytes. Integrity and sender-origin evidence do
not make that content safe to execute. A conforming receiver MUST keep every
delivery transient and inert until Preserve completes, and MUST use one of the
two rendering paths below. Preserve authorizes a durable write only: the
durable record remains inert in the restricted receiver Document until its
terminal cleanup and clean full-document transition. Merely sanitizing HTML
with an unspecified library is not a conformance claim.

## Restricted receive Document

The complete marked receive Document is a restricted protocol process, not an
ordinary application page. From entry through consent, transient preview,
Preserve finalization, and terminal cleanup it MUST use only packaged,
origin-local capture/validation/consent/preview resources and any host-only RTC
traffic required by the selected profile. It MUST NOT initialize analytics,
crash or usage telemetry, advertising or tag managers, authentication/account
UI, document sync, remote fonts, CDN renderer resources, third-party
scripts/styles/images, speculative loads, or ordinary application service
workers. It MUST NOT fetch a received or claimed URL.

The detached receiver helper and fixed sender callback are restricted OAB
utility Documents for their complete lifetimes. They use only packaged,
origin-local resources for their exact protocol duties and MUST NOT initialize
any of the application services or resource classes forbidden above. Scrubbing
or finishing their utility task does not convert them into ordinary app pages.

Discovery, receiver/helper/callback Documents, and every transitive packaged
resource they load are one network-authoritative resource graph. Every request
in that graph receives no service-worker fetch-event handling and proceeds
directly to the network. A pass-through
`respondWith(fetch(event.request))` handler is still interception and is
non-conformant. A controlling migration worker must not message or telemeter a
restricted OAB Document or start OAB-related background work. An origin with a
historical intercepting worker MUST keep OAB disabled during a separate worker
migration, verify every historical script/scope replacement from a previously
controlled client, and enable OAB only in a later deployment. Page-time
unregister and versioned paths do not repair the navigation already controlled
by the old worker.

## Path A — native safe document model

This is the recommended path. Parse Markdown with raw HTML disabled and map it
to receiver-owned, allowlisted view nodes. Insert all text through text-node or
equivalent non-markup APIs. The preview model MUST NOT create network requests,
forms, navigation, scripts, event handlers, embedded browsing contexts, SVG or
MathML DOM, CSS, custom elements, or executable URL values.

The reference receiver follows this path: it displays representations with
`textContent` and lists binary assets as metadata. It does not render received
HTML, SVG, images, or other active-capable bytes.

## Path B — unique-origin sandbox

A receiver that needs a richer pre-Preserve preview MUST render only a
receiver-sanitized allowlist inside a newly created iframe with:

```html
<iframe sandbox referrerpolicy="no-referrer"></iframe>
```

The `sandbox` attribute MUST be empty. In particular, it MUST NOT contain
`allow-scripts`, `allow-same-origin`, `allow-forms`, `allow-popups`,
`allow-top-navigation`, or `allow-downloads`. The generated `srcdoc` MUST begin
with this policy before any content:

```html
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; connect-src 'none'; img-src data: blob:; media-src 'none'; object-src 'none'; frame-src 'none'; font-src 'none'; style-src 'none'; script-src 'none'; form-action 'none'; base-uri 'none'; navigate-to 'none'">
<meta name="referrer" content="no-referrer">
```

Before serialization, the receiver MUST parse into an inert document and keep
only these HTML-namespace elements: `p`, `br`, `hr`, `strong`, `em`, `s`,
`code`, `pre`, `blockquote`, `ul`, `ol`, `li`, `h1`–`h6`, `table`, `thead`,
`tbody`, `tfoot`, `tr`, `th`, `td`, `caption`, `dl`, `dt`, `dd`, `sup`, and
`sub`. It MUST discard comments, processing instructions, custom elements,
templates, SVG, MathML, and every other namespace. It MUST remove all
attributes except integer `colspan` and `rowspan` values from 1 through 100 on
table cells. Links are rendered as text, not anchors. Images are represented
as inert filename/type/size metadata unless the receiver independently
re-encodes a supported raster format after Preserve.

The receiver MUST construct the iframe itself. Received text MUST never be
concatenated into the CSP, sandbox attribute, or surrounding application DOM.
The iframe MUST be removed and its `srcdoc` cleared on Discard, abort, timeout,
navigation, or component teardown.

## Files and active formats

Received HTML, SVG, PDF, office documents, media, archives, and any format that
can contain links or active behavior MUST remain opaque before Preserve. A
receiver MAY inspect or convert them only in an isolated, resource-bounded
decoder that has no network access and does not share the application's origin.
SVG MUST NOT be inserted with `innerHTML`, loaded into an application-origin
`img`, or exposed through an application-origin object URL during transient
preview.

After Preserve, opening a file is a separate receiver product action in a new
ordinary application Document. The restricted receive Document MUST first
erase transient state, attempt any best-effort terminal protocol result, and
either close or perform a full top-level navigation to a clean query-free and
fragment-free application URL. A SPA/history/widget state change is
insufficient. The new Document MUST still apply its normal hostile-document
controls; OAB provenance does not bless content.

The same Document boundary applies after every other terminal outcome. After
Discard, denial, expiry, cancellation, or error, the current Document MAY show
only a content-free terminal message while it remains restricted. It MUST close
or perform the same clean full navigation before starting the ordinary
application.

## Required attack corpus

Receiver conformance tests MUST cover at least the repository corpus in
`tests/fixtures/active-content-attacks.json`: scripts and event handlers,
`javascript:` and credential-bearing/signed URLs, CSS fetches, forms, iframes,
`srcdoc`, SVG/MathML, custom elements, meta refresh, base URL changes, and
hidden content. A passing test proves that no case executes, navigates, submits,
or initiates a network request in transient preview. Browser evidence MUST also
show zero forbidden services or third-party/content-derived requests during the
whole restricted lifetime and no preserved-content activation before the clean
full-document transition.
