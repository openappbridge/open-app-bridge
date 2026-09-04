export const OAB_ERROR_CODES = Object.freeze([
  "aggregate_byte_capacity_exceeded",
  "ambiguous_handoff",
  "animated_application_icon_forbidden",
  "application_icon_dimensions_unsupported",
  "application_icon_redirected",
  "application_icon_timeout",
  "application_icon_too_large",
  "application_icon_unavailable",
  "application_manifest_redirected",
  "application_manifest_timeout",
  "application_manifest_too_large",
  "application_manifest_unavailable",
  "asset_type_mismatch",
  "authorize_manifest_required",
  "authorize_origin_required",
  "base64_unavailable",
  "bounded_response_required",
  "broadcast_channel_unavailable",
  "browser_required",
  "byte_reservation_required",
  "byte_reservation_timeout",
  "claim_detached_offer_required",
  "content_not_found",
  "content_not_prepared",
  "crypto_unavailable",
  "detached_answer_authentication_failed",
  "detached_answer_seal_failed",
  "detached_answer_wait_closed",
  "detached_backpressure_timeout",
  "detached_broadcast_too_large",
  "detached_callback_endpoint_mismatch",
  "detached_candidate_rejected",
  "detached_capability_broadened",
  "detached_capability_mismatch",
  "detached_channel_closed",
  "detached_channel_error",
  "detached_channel_not_open",
  "detached_completion_integrity_failed",
  "detached_completion_mismatch",
  "detached_control_frame_too_large",
  "detached_discovery_mismatch",
  "detached_disposition_timeout",
  "detached_fragment_integrity_failed",
  "detached_fragment_missing",
  "detached_fragment_not_scrubbed",
  "detached_fragment_too_large",
  "detached_frame_sequence_error",
  "detached_grant_mismatch",
  "detached_helper_closed",
  "detached_helper_endpoint_mismatch",
  "detached_helper_timeout",
  "detached_ice_cancelled",
  "detached_ice_failed",
  "detached_ice_no_eligible_candidate",
  "detached_ice_timeout",
  "detached_item_integrity_failed",
  "detached_key_agreement_failed",
  "detached_key_generation_failed",
  "detached_local_wait_cancelled",
  "detached_manifest_integrity_failed",
  "detached_memory_allocation_failed",
  "detached_offer_expired",
  "detached_offer_replayed",
  "detached_opener_forbidden",
  "detached_receive_queue_overflow",
  "detached_receive_rate_exceeded",
  "detached_receiver_aborted",
  "detached_receiver_endpoint_mismatch",
  "detached_receiver_origin_mismatch",
  "detached_receiver_origin_unverified",
  "detached_receiver_referrer_missing",
  "detached_result_mismatch",
  "detached_send_failed",
  "detached_sender_aborted",
  "detached_sender_not_authorized",
  "detached_sender_not_configured",
  "detached_session_terminal",
  "detached_signal_expired",
  "detached_signal_from_future",
  "detached_text_encoding_invalid",
  "detached_too_many_frames",
  "detached_too_many_items",
  "detached_top_level_required",
  "detached_transcript_mismatch",
  "detached_transfer_disposed",
  "detached_transfer_failed",
  "detached_transfer_overflow",
  "detached_transfer_rejected",
  "detached_transfer_timeout",
  "detached_transfer_too_large",
  "detached_verification_authorization_required",
  "discovery_expired",
  "discovery_failed",
  "discovery_redirected",
  "discovery_required",
  "discovery_timeout",
  "discovery_too_large",
  "discovery_url_mismatch",
  "empty_handoff",
  "fetch_unavailable",
  "framed_receiver_forbidden",
  "handoff_admission_required",
  "handoff_admission_timeout",
  "handoff_already_activated",
  "handoff_already_bound",
  "handoff_closed",
  "handoff_fragment_not_scrubbed",
  "handoff_fragment_too_large",
  "handoff_not_bindable",
  "handoff_url_too_large",
  "ice_candidate_parser_unavailable",
  "invalid_application_icon",
  "invalid_application_manifest",
  "invalid_asset",
  "invalid_base64url",
  "invalid_content_selector",
  "invalid_declaration",
  "invalid_detached_abort",
  "invalid_detached_answer",
  "invalid_detached_broadcast",
  "invalid_detached_callback",
  "invalid_detached_candidate",
  "invalid_detached_candidates",
  "invalid_detached_capabilities",
  "invalid_detached_capture",
  "invalid_detached_content",
  "invalid_detached_disposition",
  "invalid_detached_endpoint",
  "invalid_detached_fragment",
  "invalid_detached_frame",
  "invalid_detached_frame_limit",
  "invalid_detached_helper",
  "invalid_detached_helper_state",
  "invalid_detached_identifier",
  "invalid_detached_key",
  "invalid_detached_manifest",
  "invalid_detached_offer",
  "invalid_detached_sdp",
  "invalid_detached_signal",
  "invalid_detached_state",
  "invalid_detached_token",
  "invalid_detached_transfer",
  "invalid_detached_transfer_id",
  "invalid_discovery_media_type",
  "invalid_discovery_path",
  "invalid_display_text",
  "invalid_handoff_admission",
  "invalid_handoff_capture",
  "invalid_handoff_href",
  "invalid_link_envelope",
  "invalid_origin",
  "invalid_receiver_domain",
  "invalid_representation_types",
  "invalid_request_id",
  "invalid_resource_length",
  "invalid_signaling_limit",
  "invalid_text_representation",
  "invalid_transcript",
  "invalid_trigger",
  "invalid_widget_content",
  "link_envelope_assets_unsupported",
  "link_envelope_decoded_too_large",
  "link_envelope_endpoint_mismatch",
  "link_envelope_expired",
  "link_envelope_exposure_not_accepted",
  "link_envelope_fragment_too_large",
  "link_envelope_from_future",
  "link_envelope_html_unsupported",
  "link_envelope_integrity_failed",
  "link_envelope_replayed",
  "link_envelope_url_too_large",
  "link_receive_cancelled",
  "media_transport_forbidden",
  "native_anchor_required",
  "oab_error",
  "on_preview_required",
  "portable_text_unavailable",
  "preserve_aborted",
  "preserve_commit_unresponsive",
  "preserve_rollback_failed",
  "preserve_rollback_timeout",
  "preserve_transaction_required",
  "preview_authorization_consumed",
  "preview_authorization_expired",
  "preview_authorization_mismatch",
  "preview_authorization_revoked",
  "receiver_disabled",
  "receiver_required",
  "receiver_unavailable",
  "replay_claim_timeout",
  "replay_guard_required",
  "replay_store_capacity_exceeded",
  "reserve_incoming_bytes_required",
  "secure_context_required",
  "secure_random_unavailable",
  "sender_origin_denied",
  "sender_origin_mismatch",
  "sender_page_closed",
  "session_admission_required",
  "session_admission_timeout",
  "session_capacity_exceeded",
  "session_promotion_failed",
  "session_promotion_timeout",
  "share_failed",
  "text_too_large",
  "too_many_assets",
  "too_many_detached_candidates",
  "top_level_context_required",
  "transfer_too_large",
  "transport_selection_required",
  "trusted_activation_required",
  "unexpected_detached_channel",
  "unexpected_detached_frame",
  "unexpected_detached_manifest",
  "unsafe_detached_candidate",
  "unsafe_detached_channel",
  "unsafe_handoff_anchor",
  "unsafe_webrtc_configuration",
  "unsafe_window_relationship",
  "unsupported_asset",
  "unsupported_detached_version",
  "unsupported_intent",
  "unsupported_representation",
  "unsupported_transport",
  "unsupported_version",
  "unverified_sender_denied",
  "unverified_sender_not_authorized",
  "user_activation_required",
  "webrtc_unavailable",
  "widget_content_required",
  "widget_unavailable",
]);

const registeredErrorCodes = new Set(OAB_ERROR_CODES);

export function isOabErrorCode(value) {
  return typeof value === "string" && registeredErrorCodes.has(value);
}

const SAFE_ERROR_MESSAGES = Object.freeze({
  expired: "This share expired before it could be reviewed. Nothing was saved.",
  insufficient_safe_storage:
    "There is not enough safe capacity to review this content. Nothing was saved.",
  interrupted:
    "The share was interrupted before the preview was ready. Nothing was saved.",
  save_state_uncertain:
    "The save could not be confirmed. Check this app before trying again.",
  unable_to_receive:
    "We couldn’t prepare this shared content. Nothing was saved. You can return to the sending app and try again.",
  unable_to_verify:
    "We couldn’t verify where this share came from. Nothing was saved.",
  unsupported:
    "This kind of shared content is not supported here. Nothing was saved.",
});

function safeErrorCategory(code) {
  if (code == null) return "unable_to_receive";
  if (code.includes("expired")) return "expired";
  if (
    code.includes("unsupported") ||
    code.includes("unavailable") ||
    code === "portable_text_unavailable"
  ) return "unsupported";
  if (
    code.includes("referrer") ||
    code.includes("origin_mismatch") ||
    code.includes("origin_unverified") ||
    code.includes("authentication_failed") ||
    code === "sender_origin_denied" ||
    code === "unverified_sender_denied"
  ) return "unable_to_verify";
  if (
    code.includes("capacity") ||
    code.includes("too_large") ||
    code.includes("overflow") ||
    code.includes("allocation_failed") ||
    code === "too_many_assets"
  ) return "insufficient_safe_storage";
  if (
    code === "preserve_commit_unresponsive" ||
    code === "preserve_rollback_failed" ||
    code === "preserve_rollback_timeout"
  ) return "save_state_uncertain";
  if (
    code.includes("cancelled") ||
    code.includes("closed") ||
    code.includes("aborted") ||
    code.includes("timeout")
  ) return "interrupted";
  return "unable_to_receive";
}

/**
 * Converts any thrown value into a bounded, receiver-safe presentation. Raw
 * messages and untrusted protocol fields are intentionally never reflected.
 */
export function toSafeErrorPresentation(error) {
  const technicalCode = isOabErrorCode(error?.code) ? error.code : null;
  const category = safeErrorCategory(technicalCode);
  return Object.freeze({
    category,
    message: SAFE_ERROR_MESSAGES[category],
    technicalCode,
  });
}
