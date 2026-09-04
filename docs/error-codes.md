# Error-code registry

`OAB_ERROR_CODES` is the machine-readable registry for this draft. Codes are
stable, lower-case identifiers intended for local control flow and telemetry
classification. Human-readable `Error.message` text is local diagnostic text;
it is not a wire value and applications must not parse it.

The registry is append-only within a published minor SDK line. Removing or
changing the meaning of a code requires a documented breaking release. A new
wire-visible abort reason additionally requires a protocol revision. Unknown
codes are treated as generic failure and never authorize fallback.

Error families have these meanings:

| Family                                           | Meaning                                                                           |
| ------------------------------------------------ | --------------------------------------------------------------------------------- |
| `invalid_*`, `unexpected_*`, `unsafe_*`          | Malformed, state-inappropriate, or policy-forbidden input                         |
| `unsupported_*`                                  | Valid feature/version/profile not implemented or advertised                       |
| `*_timeout`, `*_expired`                         | A bounded operation or capability lifetime ended                                  |
| `*_replayed`, `*_mismatch`, `*_integrity_failed` | Replay, transcript, identity, or digest failure                                   |
| `*_required`, `*_unavailable`                    | A required host/browser capability is absent                                      |
| `preserve_*`                                     | Transactional persistence failed or became indeterminate                          |
| `preview_authorization_*`                        | The SDK-owned one-use preview grant was consumed, expired, mismatched, or revoked |
| `detached_*`, `link_envelope_*`                  | Profile-specific lifecycle failure                                                |

Remote `abort.reason` is one of the fixed values in
`OAB_WIRE_ABORT_REASONS`. It never contains
an origin, URL, title, asset name, SDP, candidate, exception message, user
identifier, or receiver-policy explanation. Hosts may keep richer diagnostics
locally through `onCleanupError`; they must not echo those details to the peer.

Important local diagnostic distinctions in this revision are:

| Code                                                        | Local meaning                                                                                 |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `detached_receiver_referrer_missing`                        | Callback referrer evidence was absent, stripped, or malformed                                 |
| `detached_receiver_origin_mismatch`                         | A valid callback referrer did not equal the transcript receiver origin                        |
| `detached_ice_no_eligible_candidate`                        | ICE gathering completed without a permitted `.local` or exact loopback host candidate         |
| `detached_signal_from_future` / `link_envelope_from_future` | The sender timestamp exceeds the fixed future-skew allowance                                  |
| `detached_signal_expired` / `link_envelope_expired`         | A validly formed handoff reached its expiry                                                   |
| `preview_authorization_consumed`                            | The exact preview grant was presented more than once                                          |
| `preview_authorization_expired`                             | The manifest gate reached an enforced authorization expiry                                    |
| `preview_authorization_mismatch`                            | Request/origin/receiver/profile/intent/capability/generation binding changed                  |
| `preview_authorization_revoked`                             | Terminal cleanup or an earlier failure invalidated the grant                                  |
| `handoff_admission_required`                                | The receiver omitted the required atomic replay-and-capacity admission hook                   |
| `handoff_admission_timeout`                                 | Atomic replay-and-capacity admission did not settle within its deadline                       |
| `replay_store_capacity_exceeded`                            | Live replay tombstones reached the receiver's bounded local capacity; none were evicted early |
| `session_capacity_exceeded`                                 | The receiver's origin-wide pending-plus-active session limit is full                          |
| `session_promotion_failed` / `session_promotion_timeout`    | A pending lease could not be promoted after user authorization, so the handoff terminated     |

These distinctions are for local debugging and safe UX categories. User-facing
copy must not reveal transcript, network, or private policy details.
`toSafeErrorPresentation(error)` returns a frozen bounded `{category, message,
technicalCode}` object. It never reflects `Error.message` or untrusted protocol
fields. Primary UI uses `category`/`message`; `technicalCode` belongs only in
optional local technical details.

See [`src/error-codes.js`](../src/error-codes.js) for the authoritative list.
