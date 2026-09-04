# Human interaction and consent contract

Open App Bridge separates permission to inspect an incoming handoff from
permission to keep it. A technically conforming transport must not turn that
separation into repeated, indistinguishable approval prompts.

This contract is normative for receiver user interaction. Product styling,
layout systems, animation, and exact localized wording remain application
choices.

## One preview authorization

A normal handoff has two user decisions with different effects:

1. **Review shared content** authorizes one attempt to verify the sender (when
   the selected profile supports verification), validate one compatible
   manifest, receive its bounded bytes, and present one inert preview.
2. **Save** (the protocol Preserve decision) authorizes receiver-controlled
   durable storage. **Discard** erases the transient handoff.

The first decision is one preview authorization, not a sequence of origin,
connection, manifest, and transfer prompts. A receiver may run any number of
internal validation or policy gates, but it MUST NOT represent those gates as
repeated user approval when the requested scope has not changed.

For `detached-datachannel/1`, the preview decision is recorded before helper
navigation and RTC work. The SDK-owned opaque grant is bound to the request ID,
claimed sender origin, receiver
origin, selected profile, `preview` intent, current receiver capability
ceilings, expiry, and session generation. It is single-use. The origin must
subsequently be verified by the profile, and the manifest must independently
pass integrity, capability, size, reservation, and receiver-policy checks
before Grant. These checks consume the existing authorization; cryptographic
success does not create or broaden it.
Application code receives only frozen descriptive evidence after the SDK has
consumed the grant; it does not create or manage the grant itself.

A receiver MAY require an additional decision only when a later verified fact
would materially expand what the first screen disclosed or what local policy
allowed. The standard detached flow describes the request generically as
content within the receiver's advertised capabilities, so a conforming
manifest does not normally create such an expansion. A receiver should fail a
manifest outside that scope instead of asking the user to approve a surprise
escalation.

A durable allow rule may satisfy preview authorization only when it was created
by an earlier explicit decision for the same verified canonical sender origin
and remains visible and revocable in receiver settings. `link-envelope/1`
provides no sender-origin evidence and always requires an allow-once decision,
normally labelled **Review once** in user-facing UI.

## Identity and page ownership

The restricted receiver Document MUST look and read as a page owned by the
receiver application. Before asking for preview authorization it prominently
identifies the receiver by its own local product name or mark and explains that
another app or website wants to share content. The page MUST NOT imitate a
browser, operating-system, authentication, malware, or certificate warning.

Before detached verification, the sender origin is conditional. Suitable copy
is: “`sender.example` would like to share content. This application will check
the sender before opening a preview.” After profile verification the receiver
may say “Shared from `sender.example`”. It MUST NOT call that origin verified
earlier.

The same single authorization surface MUST calmly explain that a temporary
page at the displayed canonical sender origin may briefly appear while the
preview is prepared, and that receiving shared content never requires a
password, payment, account selection, recovery code, or other personal detail.
For example: “A temporary page from `sender.example` may briefly appear while
this application prepares the preview. Receiving shared content never requires
a password or payment.” This disclosure is informational. It MUST NOT become a
separate confirmation and MUST NOT use browser-, operating-system-, malware-,
or certificate-warning presentation.

The canonical ASCII origin remains visible anywhere an origin affects consent,
policy, or provenance. Claimed application names, titles, source URLs, icons,
and Web App Manifest metadata are untrusted supplementary presentation. They
never replace the origin or provide consent. If a content class is not yet
known from verified metadata, the UI says “content” rather than inventing a
document, text, image, or attachment type.

Primary UI uses ordinary sharing language such as **Review shared content**,
**Getting your preview ready**, **Save**, **Discard**, and **Try again**.
Terms such as handshake, callback, peer, channel, SDP, ICE, AEAD, and protocol
error belong only in optional technical details.

## Helper and callback continuity

Restricted helper and callback Documents are utility pages, not consent
surfaces. They MUST NOT ask the receiver user to approve the same handoff.
Their normal path is automatic and contains no document content.

They also MUST NOT display credential, payment, account-selection, personal-
detail, or recovery controls; contain editable fields; imitate browser or
operating-system UI; or link to unrelated product flows. A visible callback is
limited to sender-owned branding and a content-free settlement/failure state.

If a browser foregrounds a utility page, it identifies the owning sender or
receiver application from local, origin-controlled presentation and explains
that the already-approved preview is being prepared or returned. If automatic
same-target navigation cannot complete, the helper MAY expose one native
same-target continuation link. That link continues the existing authorization;
it does not request a new one and must preserve the profile's required origin
referrer. If callback closure is unavailable, the callback shows a settled
state telling the user that it is safe to return to the original application
and close the utility tab with browser controls.

## Preview semantics

Alternative MIME representations in one handoff describe one logical content
item. They are not separate carousel pages or item-count entries. A receiver
chooses one safe primary representation for preview. Companion assets are
listed as attachments and are not counted as independent primary items unless
the application explicitly models them as such.

Once verified metadata is available, the preview SHOULD disclose the verified
origin, chosen content type, approximate byte size, and attachment count. Trust
state is expressed in text and not solely by color or iconography. All content
remains subject to the inert preview contract.

Expiry replaces the preview with an explicit erased/expired state. A receiver
must not leave stale content visible after the session terminates.

## Observable Preserve lifecycle

Save must acknowledge activation immediately. During a non-trivial Preserve
operation the receiver shows truthful indeterminate progress and prevents
duplicate Save, Discard, back, or close actions unless it can prove that the
transaction has settled or rolled back. It MUST NOT fabricate a percentage.

Useful local stages include:

- making a safe durable copy;
- adding the content to the application;
- finishing the sharing session; and
- saved.

The protocol Preserve boundary is reached when the exact validated delivery is
durably owned by the receiver under a receiver-generated identity. A receiver
may satisfy that boundary with a bounded durable staging record, report
`preserved`, and perform application import, indexing, or synchronization
afterward. If post-Preserve processing fails, the durable record remains
recoverable; the receiver MUST NOT report Discard or imply that the content was
lost. Finalization and retries are idempotent.

Before the restricted Document closes or performs its required clean
navigation, the receiver presents a perceptible success state. It must not
appear to freeze and then vanish. Active rendering or selection of preserved
content still occurs only after the clean full-document transition.

The receiver records the local outcome using this exact table:

| Event                                                                                        | Required local outcome                             |
| -------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| Atomic durable commit succeeds before its deadline                                           | `preserved`                                        |
| User chooses Discard before Preserve                                                         | `discarded`                                        |
| Preview expires before Preserve begins                                                       | `discarded`                                        |
| Commit fails or is cancelled and rollback proves the durable record is absent                | `discarded`                                        |
| Commit state is indeterminate, commit ignores cancellation, or rollback cannot prove absence | `failed` (never `discarded`)                       |
| Durable staging succeeds but later application import/indexing fails                         | `preserved`, with a recoverable local import state |

The UI may use friendlier labels, but it must not weaken these meanings or turn
an unknown persistence state into reassuring “discarded” copy.

## Failure, focus, and abuse resistance

Primary failure UI uses bounded receiver-controlled categories such as unable
to verify, expired, unsupported, interrupted, insufficient safe storage, or
saved but not yet fully imported. Raw exception messages, candidate data,
fragments, policy records, and untrusted sender strings are not reflected into
primary UI. Stable local OAB error codes may appear in optional technical
details.

A receiver presents at most one unresolved incoming-share authorization surface
across its origin at a time. Other sessions are bounded, queued, denied, or
expired without multiplying prompts. Admission and rate limits run before UI
where the profile permits it.

Receiver interaction supports keyboard operation, visible focus, focus
restoration, screen-reader status announcements, reduced motion, and labels
that do not depend on color or icons. Abort invalidates and dismisses callback-
owned UI. A late callback completion cannot reopen a prompt or change a
terminal result.

## Conformance evidence

Receiver evidence for this contract demonstrates:

- no more than one preview-authorization prompt for a normal handoff;
- the authorization screen includes the temporary-page/no-credentials warning,
  and helper/callback Documents contain no credential, payment, editable, or
  deceptive system/browser UI;
- origin and manifest policy gates cannot reuse authorization across requests,
  origins, profiles, expiries, or session generations;
- utility pages do not display consent UI;
- alternative representations appear as one logical preview;
- Save produces immediate observable progress and is one-shot;
- failed post-Preserve import retains a recoverable durable copy;
- terminal expiry or failure removes transient preview content; and
- success is perceptible before the clean transition.
