// Canonical discovery lives in discovery-document.js. This module remains a
// source-compatible import path for pre-release adopters; it implements no
// legacy header discovery behavior.
export {
  DISCOVERY_HARD_LIMITS,
  ReceiverDeclaration,
  assertFreshDeclaration,
  discoverReceiver,
} from "./discovery-document.js";
export { NETWORK_REQUEST_LIMITS } from "./network-deadline.js";
