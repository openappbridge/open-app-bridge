# Utility page lifecycle contract

This contract is normative for the detached receiver helper and sender
callback Documents. They continue an authorization already made in the
receiver; they are not authentication or consent pages.

## Automatic path and fallback

The helper automatically attempts a same-target navigation to the exact
validated callback URL. Because browsers, extensions, focus policy, and page
lifecycle may delay or prevent that navigation, the SDK starts a bounded local
fallback timer. The reference default is 1,500 ms and the permitted range is
250–5,000 ms.

The timer is a best-effort usability threshold, not a transport latency SLA,
delivery receipt, timeout for the peer channel, or evidence that navigation did
or did not commit. If the helper remains visible, it may show one branded native
same-target continuation link. That link performs no new authorization and
must preserve the profile-required origin referrer.

## Callback completion and closure

After successful one-use relay, the callback may request `window.close()`.
Script closure is best effort because the browser decides whether a Document
is script-closable. Inability to close is not a protocol failure and does not
alter delivery or disposition. A callback that remains visible shows a settled,
content-free page telling the user it is safe to return to the sender and close
the tab with browser controls.

## Restrictions

For their complete lifetimes, both utility Documents:

- remain branded, content-free, top-level, no-opener, and frame-denied;
- synchronously capture and scrub signaling before asynchronous work;
- never request authorization, login, account selection, or content review;
- contain no forms, text/password fields, payment controls, `contenteditable`
  regions, personal-detail or recovery prompts, or unrelated navigation;
- never imitate browser chrome, operating-system dialogs, authentication UI,
  malware/certificate warnings, or another product;
- load no analytics, telemetry, advertisements, third-party resources, remote
  fonts, ordinary application services, or content-derived URL;
- do not persist content or signaling; and
- treat reload, duplication, late messages, and reused capabilities as terminal
  failure or a content-free settled state.

Foregrounding, focus, automatic navigation, fallback timing, and callback
closure are not proof of delivery. Only the profile's authenticated channel and
defined result frames provide transport evidence.

These are conformance requirements for each origin's own utility Document, not
a claim that one origin can technically constrain UI served by another,
compromised origin. The receiver's one authorization screen carries the
corresponding temporary-page and no-credentials/no-payment disclosure.
