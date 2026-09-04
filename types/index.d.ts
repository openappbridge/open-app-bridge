export const OAB_PROTOCOL: "org.openapp.bridge";
export const OAB_VERSION: "1.0";
export const OAB_WIRE_VERSIONS: readonly ["1.0"];
export const OAB_DISCOVERY_PATH: "/.well-known/open-app-bridge";
export const OAB_TRANSPORTS: Readonly<{
  linkEnvelope: "link-envelope/1";
  detachedDataChannel: "detached-datachannel/1";
}>;
export const LINK_ENVELOPE_REPRESENTATIONS: readonly [
  "text/markdown",
  "text/plain",
];
export const DETACHED_RESOURCE_LIMITS: Readonly<{
  maximumTransferBytes: number;
  maximumAggregateTransferBytes: number;
  maximumActiveSessions: number;
}>;
export const DEFAULT_LIMITS: Readonly<{
  maximumTextBytes: number;
  maximumTransferBytes: number;
  maximumAggregateTransferBytes: number;
  maximumAssets: number;
  maximumActiveSessions: number;
  maximumReplayClaims: number;
  pendingAuthorizationTtlMs: number;
  maximumDiscoveryBytes: number;
  maximumLinkEnvelopeUrlBytes: number;
  maximumLinkEnvelopeFragmentBytes: number;
  maximumLinkEnvelopeDecodedBytes: number;
  linkEnvelopeTtlMs: number;
  maximumLinkEnvelopeLifetimeMs: number;
}>;
export const DEFAULT_REPRESENTATIONS: readonly string[];
export const DEFAULT_ASSET_TYPES: readonly string[];
export const DEFAULT_EXTENSIONS_BY_MIME: Readonly<
  Record<string, readonly string[]>
>;
export const MAX_APPLICATION_MANIFEST_BYTES: number;
export const MAX_APPLICATION_ICONS: number;
export const MAX_APPLICATION_ICON_BYTES: number;
export const MAX_APPLICATION_ICON_DIMENSION: number;
export const MAX_APPLICATION_ICON_PIXELS: number;

export class OabError extends Error {
  readonly code: string;
  constructor(code: string, message: string, options?: ErrorOptions);
}
export function asOabError(error: unknown, fallbackCode?: string): OabError;
export const OAB_ERROR_CODES: readonly string[];
export function isOabErrorCode(value: unknown): boolean;
export const OAB_WIRE_ABORT_REASONS: readonly [
  "expired",
  "integrity_failure",
  "internal_error",
  "policy_denied",
  "protocol_error",
  "receiver_cancelled",
  "resource_limit",
  "sender_cancelled",
  "unavailable",
  "user_rejected",
];
export type OabWireAbortReason = (typeof OAB_WIRE_ABORT_REASONS)[number];
export function isOabWireAbortReason(value: unknown): boolean;

export interface BinaryAssetInput {
  name: string;
  mimeType?: string;
  data: Blob | ArrayBuffer | ArrayBufferView;
}

export interface ContentInput {
  title?: string;
  markdown?: string;
  html?: string;
  text?: string;
  representations?: Readonly<Record<string, string>>;
  assets?: Array<BinaryAssetInput | Blob | File>;
  sourceApplication?: string;
  sourceUrl?: string;
}

export interface PreparedAsset {
  readonly name: string;
  readonly mimeType: string;
  readonly size: number;
  readonly blob: Blob;
}

export class PreparedContent {
  private constructor();
  readonly title: string | null;
  readonly representations: Readonly<Record<string, string>>;
  readonly representationTypes: readonly string[];
  readonly textBytes: number;
  readonly assets: readonly PreparedAsset[];
  readonly assetManifest: readonly Readonly<{
    name: string;
    mimeType: string;
    size: number;
  }>[];
  readonly assetBytes: number;
  readonly totalBytes: number;
  readonly sourceApplication: string | null;
  readonly sourceUrl: string | null;
}

export interface PrepareContentOptions {
  representations?: readonly string[];
  assetTypes?: readonly string[];
  maximumTextBytes?: number;
  maximumTransferBytes?: number;
  maximumAssets?: number;
}

export function prepareContent(
  content: ContentInput,
  options?: PrepareContentOptions,
): PreparedContent;
export function safeAssetName(value: unknown): string;
export function assertContentMatchesReceiver(
  content: PreparedContent,
  receiver: ReceiverDeclaration,
): PreparedContent;

export interface ReceiverApplicationIcon {
  readonly src: string;
  readonly type: string;
  readonly sizes: string | null;
  readonly purpose: readonly ("any" | "maskable" | "monochrome")[];
}

export interface ReceiverApplicationMetadata {
  readonly manifestUrl: string;
  readonly name: string | null;
  readonly shortName: string | null;
  readonly description: string | null;
  readonly icons: readonly ReceiverApplicationIcon[];
  readonly themeColor: string | null;
}

export interface FetchedReceiverApplicationIcon {
  readonly icon: ReceiverApplicationIcon;
  readonly type: string;
  readonly width: number;
  readonly height: number;
  readonly bytes: Uint8Array;
  readonly blob: Blob;
}

export function normalizeApplicationManifest(
  value: unknown,
  options: { origin: string; manifestUrl?: string },
): ReceiverApplicationMetadata | null;
export function fetchReceiverApplicationManifest(
  origin: string,
  manifestValue: string,
  options?: {
    fetchImpl?: typeof fetch;
    signal?: AbortSignal;
    timeoutMs?: number;
  },
): Promise<ReceiverApplicationMetadata>;
export function fetchReceiverApplicationIcon(
  application: ReceiverApplicationMetadata,
  options?: {
    fetchImpl?: typeof fetch;
    signal?: AbortSignal;
    preferredSize?: number;
    icon?: ReceiverApplicationIcon;
    timeoutMs?: number;
  },
): Promise<FetchedReceiverApplicationIcon | null>;
export function selectApplicationIcon(
  application: ReceiverApplicationMetadata | null | undefined,
  preferredSize?: number,
): ReceiverApplicationIcon | null;

export interface LinkEnvelopeLimits {
  readonly maximumUrlBytes: number;
  readonly maximumFragmentBytes: number;
  readonly maximumDecodedBytes: number;
}

export interface LinkEnvelopeTransportDeclaration {
  readonly representations: readonly ("text/markdown" | "text/plain")[];
  readonly assetTypes: readonly [];
  readonly limits: Readonly<LinkEnvelopeLimits>;
  readonly extensions: Readonly<Record<string, unknown>>;
}

export interface DetachedDataChannelLimits {
  readonly maximumTransferBytes: number;
  readonly maximumAssets: number;
  readonly maximumSignalingBytes: number;
  readonly maximumFrameBytes: number;
}

export interface DetachedDataChannelTransportDeclaration {
  readonly representations: readonly string[];
  readonly assetTypes: readonly string[];
  readonly receiverHelper: string;
  readonly limits: Readonly<DetachedDataChannelLimits>;
  readonly extensions: Readonly<Record<string, unknown>>;
}

export interface ReceiverTransportDeclarations {
  readonly "link-envelope/1"?: LinkEnvelopeTransportDeclaration;
  readonly "detached-datachannel/1"?: DetachedDataChannelTransportDeclaration;
}

export class ReceiverDeclaration {
  private constructor();
  readonly origin: string;
  readonly discoveryUrl: string;
  readonly endpoint: string;
  readonly selectedVersion: "1.0";
  readonly wireVersions: readonly string[];
  readonly intents: readonly string[];
  readonly representations: readonly string[];
  readonly assetTypes: readonly string[];
  readonly transports: Readonly<ReceiverTransportDeclarations>;
  readonly transportIds: readonly (keyof ReceiverTransportDeclarations)[];
  readonly advertisedTransportIds: readonly string[];
  readonly linkEnvelope: LinkEnvelopeTransportDeclaration | null;
  readonly detachedDataChannel: DetachedDataChannelTransportDeclaration | null;
  readonly maximumTransferBytes: number;
  readonly maximumAssets: number;
  readonly senderPolicy: string;
  readonly declarationId: string | null;
  readonly extensions: Readonly<Record<string, unknown>>;
  readonly application: ReceiverApplicationMetadata | null;
  readonly checkedAt: number;
  readonly expiresAt: number;
  readonly isFresh: boolean;
  supportsTransport(value: string): boolean;
}

export interface DiscoverReceiverOptions {
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  timeoutMs?: number;
  applicationManifestTimeoutMs?: number;
  now?: () => number;
  fetchApplicationManifest?: boolean;
  maximumDiscoveryBytes?: number;
  supportedWireVersions?: readonly "1.0"[];
  requiredTransport?: string;
}

export function discoverReceiver(
  target: string,
  options?: DiscoverReceiverOptions,
): Promise<ReceiverDeclaration>;
export function assertFreshDeclaration(
  value: unknown,
  now?: number,
): ReceiverDeclaration;
export const NETWORK_REQUEST_LIMITS: Readonly<{
  minimumTimeoutMs: 100;
  discovery: Readonly<{
    defaultTimeoutMs: 8000;
    maximumTimeoutMs: 30000;
  }>;
  applicationManifest: Readonly<{
    defaultTimeoutMs: 4000;
    maximumTimeoutMs: 15000;
  }>;
  applicationIcon: Readonly<{
    defaultTimeoutMs: 4000;
    maximumTimeoutMs: 15000;
  }>;
}>;
export const DISCOVERY_HARD_LIMITS: Readonly<{
  maximumBytes: number;
  maximumTtlSeconds: number;
  maximumSignalingBytes: number;
  maximumFrameBytes: number;
  maximumLinkUrlBytes: number;
  maximumLinkFragmentBytes: number;
  maximumLinkDecodedBytes: number;
}>;

export type UnknownSenderPolicy = "ask" | "allow" | "deny";
export interface SenderPolicy {
  unknownSenders: UnknownSenderPolicy;
  allowedOrigins: readonly string[];
  blockedOrigins: readonly string[];
}
export const UNKNOWN_SENDER_POLICIES: readonly UnknownSenderPolicy[];
export function normalizeSenderPolicy(value?: Partial<SenderPolicy>): SenderPolicy;
export function evaluateSender(
  policy: Partial<SenderPolicy> | undefined,
  evidence:
    | { readonly originVerified: true; readonly origin: string }
    | { readonly originVerified?: false; readonly origin?: string | null }
    | null
    | undefined,
): "ask" | "allow" | "deny" | "block";
export function allowOrigin(
  policy: Partial<SenderPolicy> | undefined,
  origin: string,
): SenderPolicy;
export function blockOrigin(
  policy: Partial<SenderPolicy> | undefined,
  origin: string,
): SenderPolicy;
export function removeOriginRule(
  policy: Partial<SenderPolicy> | undefined,
  origin: string,
): SenderPolicy;

export type OabDisposition = "preserved" | "discarded";

export interface AuthorizationDecision {
  readonly allowed: boolean;
  readonly reason?: OabWireAbortReason;
}

export type SafeErrorCategory =
  | "expired"
  | "insufficient_safe_storage"
  | "interrupted"
  | "save_state_uncertain"
  | "unable_to_receive"
  | "unable_to_verify"
  | "unsupported";

export interface SafeErrorPresentation {
  readonly category: SafeErrorCategory;
  readonly message: string;
  readonly technicalCode: string | null;
}

export function toSafeErrorPresentation(error: unknown): SafeErrorPresentation;

export interface LinkEnvelopeSourceClaim {
  readonly origin: null;
  readonly application: string | null;
  readonly url: string | null;
}

export interface LinkEnvelopeEvidence {
  readonly transport: "link-envelope/1";
  readonly originVerified: false;
  readonly appAttested: false;
  readonly userActivationObserved: false;
  readonly declarationIdMatched: boolean;
}

export interface LinkEnvelopeOffer {
  readonly protocol: "org.openapp.bridge";
  readonly wireVersion: "1.0";
  readonly transport: "link-envelope/1";
  readonly requestId: string;
  readonly intent: "preview";
  readonly classification: "non-confidential";
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly title: string | null;
  readonly representations: Readonly<
    Partial<Record<"text/markdown" | "text/plain", string>>
  >;
  readonly assets: readonly [];
  readonly source: LinkEnvelopeSourceClaim;
  readonly evidence: LinkEnvelopeEvidence;
}

export interface LinkEnvelopeDelivery {
  readonly protocol: "org.openapp.bridge";
  readonly wireVersion: "1.0";
  readonly requestId: string;
  readonly batchId: string;
  readonly intent: "preview";
  readonly classification: "non-confidential";
  readonly title: string | null;
  readonly representations: LinkEnvelopeOffer["representations"];
  readonly assets: readonly [];
  readonly source: LinkEnvelopeSourceClaim;
  readonly evidence: Omit<LinkEnvelopeEvidence, "declarationIdMatched"> &
    Readonly<{
      declarationIdMatched: true;
      receiverAuthorized: true;
    }>;
}

export interface LinkEnvelopeHandoff {
  readonly transport: "link-envelope/1";
  readonly requestId: string;
  readonly href: string;
  readonly rel: "noopener noreferrer";
  readonly referrerPolicy: "no-referrer";
  readonly urlBytes: number;
  readonly fragmentBytes: number;
  readonly decodedBytes: number;
  readonly expiresAt: number;
  readonly classification: "non-confidential";
}

export interface LinkEnvelopeLimitOptions {
  maximumUrlBytes?: number;
  maximumFragmentBytes?: number;
  maximumDecodedBytes?: number;
  maximumTransferBytes?: number;
}

export interface LinkEnvelopeTimeOptions {
  lifetimeMs?: number;
  maximumLifetimeMs?: number;
  maximumClockSkewMs?: number;
  now?: () => number;
}

export interface CreateLinkEnvelopeOptions
  extends LinkEnvelopeLimitOptions,
    LinkEnvelopeTimeOptions {
  contentClassification: "non-confidential";
  representations?: readonly ("text/markdown" | "text/plain")[];
  randomToken?: () => string;
}

export interface DecodeLinkEnvelopeOptions
  extends LinkEnvelopeLimitOptions,
    LinkEnvelopeTimeOptions {
  launchUrl: string;
  acceptedWireVersions?: readonly "1.0"[];
  representations?: readonly ("text/markdown" | "text/plain")[];
  declarationId?: string | null;
}

export function createLinkEnvelopeHandoff(
  receiver: ReceiverDeclaration,
  content: PreparedContent | ContentInput,
  options: CreateLinkEnvelopeOptions,
): Promise<LinkEnvelopeHandoff>;

export function decodeLinkEnvelopeFragment(
  fragment: string,
  options: DecodeLinkEnvelopeOptions,
): Promise<LinkEnvelopeOffer>;

export interface ConsumeLinkEnvelopeOptions
  extends Omit<DecodeLinkEnvelopeOptions, "launchUrl"> {
  declarationId: string | null;
  signal?: AbortSignal;
  windowRef?: Window;
  expectedEndpoint: string;
  handoffAdmissionTimeoutMs?: number;
  sessionPromotionTimeoutMs?: number;
  maximumActiveSessions?: number;
  maximumReplayClaims?: number;
  batchRandomToken?: () => string;
  admitIncomingHandoff(request: IncomingHandoffAdmissionRequest):
    | IncomingHandoffAdmissionDecision
    | Promise<IncomingHandoffAdmissionDecision>;
  authorizeSender(request: {
    readonly requestId: string;
    readonly transport: "link-envelope/1";
    readonly classification: "non-confidential";
    readonly source: LinkEnvelopeSourceClaim;
    readonly evidence: LinkEnvelopeEvidence;
    readonly signal: AbortSignal;
  }): AuthorizationDecision | Promise<AuthorizationDecision>;
  deliver(
    delivery: LinkEnvelopeDelivery,
    context: Readonly<{ signal: AbortSignal; expiresAt: number }>,
  ): void | Promise<void>;
}

export function consumeLinkEnvelope(
  options: ConsumeLinkEnvelopeOptions,
): Promise<LinkEnvelopeDelivery | null>;

export const LINK_ENVELOPE_HARD_LIMITS: Readonly<{
  maximumLifetimeMs: number;
  maximumClockSkewMs: number;
  minimumRequestIdBits: 128;
}>;

export type CanonicalJsonValue =
  | null
  | boolean
  | string
  | number
  | readonly CanonicalJsonValue[]
  | Readonly<{ [key: string]: CanonicalJsonValue }>;

export interface DetachedP256PublicJwk {
  readonly kty: "EC";
  readonly crv: "P-256";
  readonly x: string;
  readonly y: string;
}

export interface DetachedKeyPair {
  readonly privateKey: CryptoKey;
  readonly publicKey: DetachedP256PublicJwk;
}

export interface DetachedSealedAnswer {
  readonly algorithm: "ECDH-P256+HKDF-SHA256+A256GCM";
  readonly receiverPublicKey: DetachedP256PublicJwk;
  readonly salt: string;
  readonly iv: string;
  readonly ciphertext: string;
}

export interface DetachedCryptoOptions {
  crypto?: Crypto;
}

export function canonicalJson(value: CanonicalJsonValue): string;
export function encodeBase64Url(
  value: Uint8Array | ArrayBuffer | ArrayBufferView,
): string;
export function decodeBase64Url(value: string, maximumBytes?: number): Uint8Array;
export function normalizeP256PublicJwk(value: unknown): DetachedP256PublicJwk;
export function sha256Base64Url(
  value: string | Uint8Array | ArrayBuffer | ArrayBufferView,
  options?: DetachedCryptoOptions,
): Promise<string>;
export function createDetachedKeyPair(
  options?: DetachedCryptoOptions,
): Promise<DetachedKeyPair>;
export function sealDetachedAnswer(
  answer: DetachedAnswer,
  options: DetachedCryptoOptions & {
    transcript: CanonicalJsonValue;
    senderPublicKey: DetachedP256PublicJwk;
  },
): Promise<DetachedSealedAnswer>;
export function openDetachedAnswer(
  envelope: DetachedSealedAnswer,
  options: DetachedCryptoOptions & {
    transcript: CanonicalJsonValue;
    senderPrivateKey: CryptoKey;
  },
): Promise<DetachedAnswer>;
export const DETACHED_ANSWER_ALGORITHM: "ECDH-P256+HKDF-SHA256+A256GCM";

export const DETACHED_TRANSPORT: "detached-datachannel/1";
export const DETACHED_TRANSPORT_VERSION: "1";
export const DETACHED_PROTOCOL: "org.openapp.bridge";
export const DETACHED_WIRE_VERSION: "1.0";
export const DETACHED_CHANNEL_LABEL: "oab-1";
export const DETACHED_CALLBACK_PATH: "/.well-known/open-app-bridge/callback";
export const DETACHED_SIGNAL_LIMITS: Readonly<{
  maximumSdpBytes: number;
  maximumSdpLines: number;
  maximumSdpLineBytes: number;
  maximumCandidateBytes: number;
  maximumCandidates: number;
  maximumFragmentBytes: number;
  maximumLifetimeMs: number;
  maximumClockSkewMs: number;
}>;

export interface DetachedIceCandidate {
  readonly candidate: string;
  readonly sdpMid: string;
  readonly sdpMLineIndex: 0;
  readonly usernameFragment: string | null;
}

export interface DetachedSessionDescription<T extends "offer" | "answer"> {
  readonly type: T;
  readonly sdp: string;
}

export interface DetachedOffer {
  readonly protocol: "org.openapp.bridge";
  readonly wireVersion: "1.0";
  readonly transport: "detached-datachannel/1";
  readonly transportVersion: "1";
  readonly requestId: string;
  readonly channelId: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly senderOrigin: string;
  readonly receiverOrigin: string;
  readonly receiverHelper: string;
  readonly declarationId: string | null;
  readonly senderPublicKey: DetachedP256PublicJwk;
  readonly description: DetachedSessionDescription<"offer">;
  readonly candidates: readonly DetachedIceCandidate[];
}

export interface DetachedAnswer {
  readonly description: DetachedSessionDescription<"answer">;
  readonly candidates: readonly DetachedIceCandidate[];
}

export interface DetachedSealedPlaintext {
  readonly answer: DetachedAnswer;
  readonly transcriptHash: string;
}

export interface DetachedTranscript {
  readonly protocol: "org.openapp.bridge";
  readonly wireVersion: "1.0";
  readonly transport: "detached-datachannel/1";
  readonly transportVersion: "1";
  readonly requestId: string;
  readonly channelId: string;
  readonly senderOrigin: string;
  readonly receiverOrigin: string;
  readonly receiverHelper: string;
  readonly senderPublicKey: DetachedP256PublicJwk;
  readonly callbackPath: "/.well-known/open-app-bridge/callback";
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly declarationId: string | null;
  readonly offerDigest: string;
}

export interface DetachedSignalOptions extends DetachedCryptoOptions {
  /** Optional lifecycle cancellation for in-progress signaling/setup work. */
  signal?: AbortSignal;
  now?: () => number;
  maximumSignalingBytes?: number;
  maximumFragmentBytes?: number;
  expectedReceiverOrigin?: string;
  structuralOnly?: boolean;
  candidateFactory?: (candidate: RTCIceCandidateInit) => RTCIceCandidate;
}

export function isPrivateHostCandidateAddress(value: unknown): boolean;
export function assertDataOnlySdp<T extends "offer" | "answer">(
  description: unknown,
  options: { type: T },
): DetachedSessionDescription<T>;
export function validateHostCandidate(
  value: unknown,
  options?: DetachedSignalOptions,
): DetachedIceCandidate;
export function validateCandidateList(
  values: unknown,
  options?: DetachedSignalOptions,
): readonly DetachedIceCandidate[];
export function validateDetachedOffer(
  value: unknown,
  options?: DetachedSignalOptions,
): DetachedOffer;
export function validateDetachedAnswer(
  value: unknown,
  options?: DetachedSignalOptions,
): DetachedAnswer;
export function createDetachedTranscript(
  offer: DetachedOffer,
  options?: DetachedSignalOptions,
): Promise<DetachedTranscript>;
export function createDetachedOfferLaunchUrl(
  endpoint: string,
  offer: DetachedOffer,
  options?: DetachedSignalOptions,
): Promise<string>;
export function parseDetachedOfferFragment(
  fragment: string,
  options?: DetachedSignalOptions,
): Promise<DetachedOffer>;
export function createDetachedAnswerFragment(
  value: DetachedAnswerCallback,
  options?: DetachedSignalOptions,
): Promise<string>;
export function parseDetachedAnswerFragment(
  fragment: string,
  options?: DetachedSignalOptions,
): Promise<unknown>;
export function detachedCallbackUrl(senderOrigin: string, fragment: string): string;
export function createHostOnlyPeerConnection(options?: {
  peerConnectionFactory?: (
    configuration: RTCConfiguration,
  ) => RTCPeerConnection;
}): RTCPeerConnection;
export function collectHostCandidates(
  connection: RTCPeerConnection,
  options?: DetachedSignalOptions & { timeoutMs?: number },
): Promise<readonly DetachedIceCandidate[]>;

export interface DetachedOfferCapture {
  readonly fragment: string;
  readonly receiverOrigin: string;
}

export interface DetachedScrubbedUtilityHandoff {
  readonly fragment: string;
  readonly href: string;
  readonly hadQuery: boolean;
  readonly referrer: string;
}

export interface DetachedHelperEnvelope {
  readonly protocol: "org.openapp.bridge";
  readonly transport: "detached-datachannel/1";
  readonly helperRequestId: string;
  readonly helperChannelId: string;
  readonly receiverOrigin: string;
  readonly receiverHelper: string;
}

export interface DetachedAnswerCallback {
  readonly protocol: "org.openapp.bridge";
  readonly transport: "detached-datachannel/1";
  readonly type: "sealed-answer";
  readonly requestId: string;
  readonly channelId: string;
  readonly receiverOrigin: string;
  readonly envelope: DetachedSealedAnswer;
}

export interface DetachedBroadcastOptions extends DetachedCryptoOptions {
  broadcastChannelFactory?: (name: string) => BroadcastChannel;
  maximumSignalingBytes?: number;
  randomToken?: (label: string) => string | undefined;
}

export interface DetachedReceiverHelperSession {
  readonly href: string | null;
  readonly target: "_blank";
  readonly rel: "noopener noreferrer";
  readonly referrerPolicy: "no-referrer";
  waitUntilReady(timeoutMs?: number): Promise<void>;
  navigateToCallback(href: string, senderOrigin: string): void;
  close(): void;
}

export function detachedBroadcastName(
  role: "sender" | "receiver",
  requestId: string,
  channelId: string,
): string;
export function captureDetachedOfferFromWindow(
  windowRef: Window,
  options?: { maximumSignalingBytes?: number },
): DetachedOfferCapture;
export function inspectCapturedDetachedOffer(
  capture: DetachedOfferCapture,
  options?: DetachedSignalOptions,
): Promise<DetachedOffer>;
export function createDetachedHelperUrl(
  receiverOrigin: string,
  value: Omit<DetachedHelperEnvelope, "receiverOrigin"> &
    Partial<Pick<DetachedHelperEnvelope, "receiverOrigin">>,
): string;
export function parseDetachedHelperFromWindow(
  windowRef: Window,
  options?: { scrubbedHandoff?: DetachedScrubbedUtilityHandoff },
): DetachedHelperEnvelope;
export function createDetachedReceiverHelperSession(
  value: Pick<DetachedHelperEnvelope, "receiverOrigin" | "receiverHelper"> &
    Partial<Omit<DetachedHelperEnvelope, "receiverOrigin" | "receiverHelper">>,
  options?: DetachedBroadcastOptions,
): DetachedReceiverHelperSession;
export function runDetachedReceiverHelper(
  windowRef: Window,
  options?: DetachedBroadcastOptions & {
    scrubbedHandoff?: DetachedScrubbedUtilityHandoff;
    timeoutMs?: number;
    readyIntervalMs?: number;
    navigationFallbackDelayMs?: number;
    onNavigationFallback?(navigation: Readonly<{
      href: string;
      senderOrigin: string;
    }>): boolean | void;
    onTimeout?(error: OabError): void;
  },
): Readonly<{ envelope: DetachedHelperEnvelope | null; close(): void }>;
export function createDetachedAnswerCallbackUrl(
  senderOrigin: string,
  value: Pick<
    DetachedAnswerCallback,
    "requestId" | "channelId" | "receiverOrigin" | "envelope"
  >,
  options?: DetachedSignalOptions,
): Promise<string>;
export function runDetachedSenderCallback(
  windowRef: Window,
  options?: DetachedBroadcastOptions & {
    scrubbedHandoff?: DetachedScrubbedUtilityHandoff;
    expectedReceiverOrigin?: string;
    closeWindow?: () => void;
  },
): Promise<void>;
export function waitForDetachedAnswer(
  value: {
    readonly requestId: string;
    readonly channelId: string;
    readonly receiverOrigin: string;
  },
  options?: DetachedBroadcastOptions & { timeoutMs?: number },
): Readonly<{ promise: Promise<DetachedSealedAnswer>; close(): void }>;

export const DETACHED_MAX_FRAME_BYTES: number;
export const DETACHED_FRAME_HEADER_BYTES: 16;
export const DETACHED_MAX_CHUNK_BYTES: number;
export const DETACHED_MAX_FRAMES: 65536;
export const DETACHED_FRAME_TYPES: Readonly<{
  capabilities: 1;
  manifest: 2;
  grant: 3;
  data: 4;
  complete: 5;
  previewing: 6;
  result: 7;
  abort: 8;
}>;

export interface DetachedCapabilities {
  readonly representations: readonly string[];
  readonly assetTypes: readonly string[];
  readonly maximumTransferBytes: number;
  readonly maximumAssets: number;
  readonly maximumFrameBytes: number;
}

/**
 * Frozen evidence that the SDK consumed its closure-private, one-use preview
 * authorization for this exact manifest gate. This object is descriptive and
 * is not itself a reusable bearer capability.
 */
export interface PreviewAuthorizationEvidence {
  readonly requestId: string;
  readonly senderOrigin: string;
  readonly receiverOrigin: string;
  readonly receiverId: string | null;
  readonly transport: "detached-datachannel/1";
  readonly intent: "preview";
  readonly capabilityCeilings: DetachedCapabilities;
  readonly expiresAt: number;
}

export interface DetachedManifestAuthorizationContext {
  readonly signal: AbortSignal;
  /** Present when invoked through the high-level receiver handoff facade. */
  readonly previewAuthorization?: PreviewAuthorizationEvidence;
}

export interface DetachedManifestItem {
  readonly index: number;
  readonly kind: "representation" | "asset";
  readonly mimeType: string;
  readonly name: string | null;
  readonly bytes: number;
  readonly sha256: string;
}

export interface DetachedManifest {
  readonly protocol: "org.openapp.bridge";
  readonly transport: "detached-datachannel/1";
  readonly frameVersion: 1;
  readonly transferId: string;
  readonly title: string | null;
  readonly source: Readonly<{
    application: string | null;
    url: string | null;
  }>;
  readonly items: readonly DetachedManifestItem[];
  readonly totalBytes: number;
}

export type DetachedFrameTypeName = keyof typeof DETACHED_FRAME_TYPES;
export type DetachedFrameType = (typeof DETACHED_FRAME_TYPES)[DetachedFrameTypeName];

export interface DecodedDetachedFrame {
  readonly type: DetachedFrameType;
  readonly typeName: DetachedFrameTypeName;
  readonly itemIndex: number;
  readonly sequence: number;
  readonly totalFrames: number;
  readonly payload: Uint8Array;
  readonly control: CanonicalJsonValue | null;
}

export interface PreparedDetachedTransfer {
  readonly manifest: DetachedManifest;
  readonly manifestDigest: string;
  readonly maximumFrameBytes: number;
  readonly totalFrames: number;
  readonly completionDigest: string;
  readonly manifestFrame: Uint8Array;
  dataFrames(): AsyncGenerator<Uint8Array, void, void>;
  readonly completionFrame: Uint8Array;
  readonly disposed: boolean;
  dispose(): void;
  forMaximumFrameBytes(maximumFrameBytes: number): Promise<PreparedDetachedTransfer>;
}

export function validateDetachedCapabilities(value: unknown): DetachedCapabilities;
export function assertManifestMatchesCapabilities(
  manifest: unknown,
  capabilities: unknown,
): DetachedManifest;
export function encodeDetachedFrame(value: {
  type: DetachedFrameType;
  itemIndex?: number;
  sequence?: number;
  totalFrames?: number;
  payload: Uint8Array | ArrayBuffer | ArrayBufferView;
}): Uint8Array;
export function encodeDetachedControl(
  type: Exclude<DetachedFrameTypeName, "data">,
  value: CanonicalJsonValue,
): Uint8Array;
export function decodeDetachedFrame(
  value: Uint8Array | ArrayBuffer | ArrayBufferView,
  options?: { maximumFrameBytes?: number },
): DecodedDetachedFrame;
export function validateDetachedManifest(
  value: unknown,
  options?: { maximumItems?: number; maximumTransferBytes?: number },
): DetachedManifest;
export function prepareDetachedTransfer(
  content: PreparedContent | {
    readonly title?: string | null;
    readonly representations: Readonly<Record<string, string>>;
    readonly assets?: readonly (
      | PreparedAsset
      | (BinaryAssetInput & { readonly blob?: Blob })
    )[];
    readonly sourceApplication?: string | null;
    readonly sourceUrl?: string | null;
  },
  options: DetachedCryptoOptions & {
    transferId: string;
    maximumItems?: number;
    maximumTransferBytes?: number;
    maximumFrameBytes?: number;
  },
): Promise<PreparedDetachedTransfer>;
export function assertReliableOrderedChannel(
  channel: RTCDataChannel,
): RTCDataChannel;
export function sendDetachedFrame(
  channel: RTCDataChannel,
  frame: Uint8Array | ArrayBuffer | ArrayBufferView,
  options?: {
    highWaterMark?: number;
    lowWaterMark?: number;
    timeoutMs?: number;
    maximumFrameBytes?: number;
  },
): Promise<void>;

export interface DetachedCompletedTransfer {
  readonly type: "complete";
  readonly transferId: string;
  readonly title: string | null;
  readonly source: Readonly<{
    application: string | null;
    url: string | null;
  }>;
  readonly representations: Readonly<Record<string, string>>;
  readonly assets: readonly Readonly<{
    name: string;
    mimeType: string;
    data: Uint8Array;
  }>[];
  readonly totalBytes: number;
}

export class DetachedFrameReceiver {
  constructor(options?: DetachedCryptoOptions & {
    expectedManifestDigest?: string;
    maximumItems?: number;
    maximumTransferBytes?: number;
    maximumFrameBytes?: number;
  });
  readonly state: string;
  readonly manifest: DetachedManifest | null;
  accept(
    frame: Uint8Array | ArrayBuffer | ArrayBufferView,
  ): Promise<
    | Readonly<{ type: "manifest"; manifest: DetachedManifest; manifestDigest: string }>
    | Readonly<{ type: "data"; receivedBytes: number; totalBytes: number }>
    | DetachedCompletedTransfer
    | Readonly<{ type: "abort"; reason: OabWireAbortReason }>
  >;
  grant(): Uint8Array;
  reject(reason?: OabWireAbortReason): Uint8Array;
  dispose(): void;
}

export interface DetachedSenderSessionOptions
  extends DetachedSignalOptions {
  senderOrigin: string;
  receiverOrigin: string;
  receiverEndpoint: string;
  receiverHelper: string;
  declarationId?: string | null;
  wireVersion?: "1.0";
  lifetimeMs?: number;
  channelTimeoutMs?: number;
  connectedToPreviewTimeoutMs?: number;
  expectedReceiverCapabilities: DetachedCapabilities;
  randomToken?: (label: "requestId" | "channelId") => string | undefined;
  peerConnectionFactory?: (
    configuration: RTCConfiguration,
  ) => RTCPeerConnection;
}

export interface DetachedTransferSendResult {
  readonly transferId: string;
  readonly status: "previewing";
  readonly capabilities: DetachedCapabilities;
  readonly completion: Promise<OabDisposition>;
}

export interface DetachedTransferProgress {
  readonly sentFrames: number;
  readonly totalFrames: number;
}

export interface DetachedTransferSendOptions {
  responseTimeoutMs?: number;
  dispositionTimeoutMs?: number;
  highWaterMark?: number;
  lowWaterMark?: number;
  timeoutMs?: number;
  maximumFrameBytes?: number;
  yieldEveryFrames?: number;
  yieldControl?(): void | Promise<void>;
  onProgress?(progress: DetachedTransferProgress): void;
}

export interface DetachedSenderSession {
  readonly requestId: string | null;
  readonly channelId: string | null;
  readonly offer: DetachedOffer | null;
  readonly transcript: DetachedTranscript | null;
  readonly launchHref: string | null;
  readonly target: "_blank";
  readonly rel: "noopener noreferrer";
  readonly referrerPolicy: "no-referrer";
  readonly connection: RTCPeerConnection | null;
  readonly channel: RTCDataChannel | null;
  readonly state: string;
  acceptSealedAnswer(envelope: DetachedSealedAnswer): Promise<RTCDataChannel>;
  sendTransfer(
    transfer: PreparedDetachedTransfer,
    options?: DetachedTransferSendOptions,
  ): Promise<DetachedTransferSendResult>;
  close(): void;
}

export function createDetachedSenderSession(
  options: DetachedSenderSessionOptions,
): Promise<DetachedSenderSession>;

export interface DetachedPreviewDelivery extends DetachedCompletedTransfer {
  readonly dispositionExpiresAt: number;
  readonly source: DetachedCompletedTransfer["source"] &
    Readonly<{ origin: string; originVerified: true }>;
  readonly evidence: Readonly<{
    transport: "detached-datachannel/1";
    originVerified: true;
    encryptedPeerChannel: true;
    receiverAuthorized: true;
    persisted: false;
  }>;
}

export interface DetachedPreserveContext {
  readonly transactionId: string;
  readonly delivery: DetachedPreviewDelivery;
  readonly dispositionExpiresAt: number;
  readonly signal: AbortSignal;
}

export interface DetachedPreserveRollbackContext
  extends DetachedPreserveContext {
  readonly reason: unknown;
  readonly commitSettlement:
    | "fulfilled"
    | "rejected"
    | "timeout"
    | "late-fulfilled"
    | "late-rejected";
}

export interface DetachedPreserveTransaction<T = unknown> {
  commit(context: DetachedPreserveContext): T | Promise<T>;
  rollback(context: DetachedPreserveRollbackContext): void | Promise<void>;
}

export interface DetachedReceiveHandle {
  readonly capabilities: DetachedCapabilities;
  readonly state: string;
  readonly dispositionExpiresAt: number | null;
  readonly preview: Promise<DetachedPreviewDelivery>;
  readonly completion: Promise<OabDisposition>;
  complete(disposition: "discarded"): Promise<"discarded">;
  preserve<T>(transaction: DetachedPreserveTransaction<T>): Promise<T>;
  abort(reason?: OabWireAbortReason): Promise<void>;
}

export interface DetachedAcceptedSession {
  readonly requestId: string | null;
  readonly channelId: string | null;
  readonly offer: DetachedOffer | null;
  readonly transcript: DetachedTranscript | null;
  readonly sealedAnswer: DetachedSealedAnswer | null;
  readonly connection: RTCPeerConnection | null;
  readonly channel: RTCDataChannel | null;
  readonly connected: Promise<RTCDataChannel> | null;
  readonly state: string;
  receiveTransfer(options: DetachedReceiveOptions): DetachedReceiveHandle;
  close(): void;
}

export interface IncomingByteReservationRequest {
  readonly requestId: string;
  readonly channelId: string;
  readonly transferId: string;
  readonly transport: "detached-datachannel/1";
  readonly totalBytes: number;
  readonly maximumAggregateTransferBytes: number;
  readonly expiresAt: number;
}

export type IncomingByteReservationDecision =
  | Readonly<{ reserved: false }>
  | Readonly<{
      reserved: true;
      release(): void | Promise<void>;
    }>;

export interface DetachedReceiveOptions extends DetachedCryptoOptions {
  sourceOrigin?: string;
  capabilities: DetachedCapabilities;
  transferTimeoutMs?: number;
  dispositionTimeoutMs?: number;
  preserveSettlementTimeoutMs?: number;
  maximumFramesPerSecond?: number;
  maximumBytesPerSecond?: number;
  maximumItems?: number;
  maximumTransferBytes?: number;
  maximumAggregateTransferBytes?: number;
  requestId?: string;
  channelId?: string;
  sessionExpiresAt?: number;
  byteReservationTimeoutMs?: number;
  reserveIncomingBytes(request: IncomingByteReservationRequest):
    | IncomingByteReservationDecision
    | Promise<IncomingByteReservationDecision>;
  onCleanupError?(failure: Readonly<{
    operation: string;
    error: unknown;
  }>): void;
  authorizeVerifiedSender(
    evidence: {
      readonly origin: string;
      readonly originVerified: true;
      readonly transport: "detached-datachannel/1";
    },
    context: Readonly<{ signal: AbortSignal }>,
  ): AuthorizationDecision | Promise<AuthorizationDecision>;
  authorizeManifest(
    manifest: DetachedManifest,
    manifestDigest: string,
    context: Readonly<DetachedManifestAuthorizationContext>,
  ): AuthorizationDecision | Promise<AuthorizationDecision>;
  onPreview(
    delivery: DetachedPreviewDelivery,
    context: Readonly<{ signal: AbortSignal }>,
  ): void | Promise<void>;
}

export function acceptDetachedOffer(
  offer: DetachedOffer,
  options: DetachedSignalOptions & {
    receiverOrigin: string;
    verificationAuthorized: true;
    channelTimeoutMs?: number;
    transferTimeoutMs?: number;
    peerConnectionFactory?: (
      configuration: RTCConfiguration,
    ) => RTCPeerConnection;
  },
): Promise<DetachedAcceptedSession>;
export function receiveDetachedTransfer(
  channel: RTCDataChannel,
  options: DetachedReceiveOptions & {
    sourceOrigin: string;
    requestId: string;
    channelId: string;
  },
): DetachedReceiveHandle;

export const DETACHED_LIFECYCLE_LIMITS: Readonly<{
  maximumRtcSetupMs: number;
  maximumConnectedToPreviewMs: number;
  maximumDispositionMs: number;
  maximumSessionLifetimeMs: number;
}>;

export const HANDOFF_PROFILES: Readonly<{
  linkEnvelope: "link-envelope/1";
  detachedDataChannel: "detached-datachannel/1";
}>;

export interface HandoffProfileAvailability {
  readonly advertised: boolean;
  readonly compatible: boolean;
  readonly reason: string | null;
}

export type HandoffAvailability = Readonly<{
  "link-envelope/1": HandoffProfileAvailability;
  "detached-datachannel/1": HandoffProfileAvailability;
}>;

export function inspectProfileAvailability(
  receiver: ReceiverDeclaration,
  content?: ContentInput | PreparedContent | null,
  options?: { now?: () => number },
): HandoffAvailability;

export function assertTrustedUserActivation(
  windowRef: Window,
  event: MouseEvent,
): void;

export interface LinkLaunchIndication {
  readonly requestId: string;
  readonly transport: "link-envelope/1";
  readonly status: "launched";
  readonly receiptAvailable: false;
}

export interface HandoffActivationFailure {
  readonly error: unknown;
  readonly eventType: string;
}

export interface LinkAnchorHandoff extends LinkEnvelopeHandoff {
  readonly target: "_blank";
  readonly state: "ready" | "launching" | "launched" | "expired" | "closed";
  bind(anchor: HTMLAnchorElement): HTMLAnchorElement;
  activate(event: MouseEvent): Promise<LinkLaunchIndication>;
  close(): void;
}

export interface LinkAnchorHandoffOptions extends CreateLinkEnvelopeOptions {
  windowRef?: Window;
  onActivationError?(failure: HandoffActivationFailure): void;
}

export function createLinkAnchorHandoff(
  receiver: ReceiverDeclaration,
  content: ContentInput | PreparedContent,
  options: LinkAnchorHandoffOptions,
): Promise<LinkAnchorHandoff>;

export interface DetachedAnchorHandoff {
  readonly transport: "detached-datachannel/1";
  readonly requestId: string;
  readonly expiresAt: number;
  readonly href: string;
  readonly target: "_blank";
  readonly rel: "noopener noreferrer";
  readonly referrerPolicy: "no-referrer";
  readonly result: Promise<DetachedTransferSendResult>;
  readonly state:
    | "ready"
    | "launching"
    | "launched"
    | "connecting"
    | "transferring"
    | "previewing"
    | "preserved"
    | "discarded"
    | "closed"
    | "expired"
    | "failed";
  bind(anchor: HTMLAnchorElement): HTMLAnchorElement;
  activate(event: MouseEvent): Promise<DetachedTransferSendResult>;
  close(): void;
}

export interface DetachedAnchorHandoffOptions
  extends DetachedSignalOptions,
    DetachedTransferSendOptions {
  windowRef?: Window;
  senderOrigin?: string;
  transferId?: string;
  answerTimeoutMs?: number;
  lifetimeMs?: number;
  channelTimeoutMs?: number;
  connectedToPreviewTimeoutMs?: number;
  randomToken?: (label?: string) => string | undefined;
  peerConnectionFactory?: (
    configuration: RTCConfiguration,
  ) => RTCPeerConnection;
  broadcastChannelFactory?: (name: string) => BroadcastChannel;
  onActivationError?(failure: HandoffActivationFailure): void;
}

export function createDetachedAnchorHandoff(
  receiver: ReceiverDeclaration,
  content: ContentInput | PreparedContent,
  options?: DetachedAnchorHandoffOptions,
): Promise<DetachedAnchorHandoff>;

export function createHandoff(
  receiver: ReceiverDeclaration,
  content: ContentInput | PreparedContent,
  options: LinkAnchorHandoffOptions & { transport: "link-envelope/1" },
): Promise<LinkAnchorHandoff>;
export function createHandoff(
  receiver: ReceiverDeclaration,
  content: ContentInput | PreparedContent,
  options: DetachedAnchorHandoffOptions & {
    transport: "detached-datachannel/1";
  },
): Promise<DetachedAnchorHandoff>;

export type IncomingHandoffProfile =
  | "link-envelope/1"
  | "detached-datachannel/1";

export const INCOMING_HANDOFF_CAPTURE_LIMITS: Readonly<{
  maximumFragmentBytes: 32768;
  maximumUrlBytes: 65536;
  maximumOriginBytes: 2048;
  maximumPathBytes: 8192;
  maximumQueryBytes: 16384;
}>;

/**
 * Exact bounded location evidence copied by a parser-blocking bootstrap before
 * it synchronously removes the query and fragment. Keep this value
 * closure-local, freeze it, and pass it exactly once to
 * consumeIncomingHandoff().
 */
export interface ScrubbedIncomingHandoff {
  readonly fragment: string;
  readonly href: string;
  readonly origin: string;
  readonly pathname: string;
  readonly search: string;
}

export function detectIncomingProfile(
  fragment: string | null | undefined,
): IncomingHandoffProfile | null;

export interface ConditionalOriginAuthorizationRequest {
  readonly origin: string;
  readonly originVerified: false;
  readonly conditional: true;
  readonly requestId: string;
  readonly transport: "detached-datachannel/1";
}

export interface PreparedDetachedReceiverHandoff {
  readonly transport: "detached-datachannel/1";
  /** Revoked to null after any terminal outcome. */
  readonly requestId: string | null;
  /** Revoked to null after any terminal outcome. */
  readonly expiresAt: number | null;
  /** Revoked to null after any terminal outcome. */
  readonly sender: Readonly<{
    origin: string;
    originVerified: false;
    status: "unverified-pending-connection";
  }> | null;
  readonly href: string;
  readonly target: "_blank";
  readonly rel: "noopener noreferrer";
  readonly referrerPolicy: "no-referrer";
  readonly state: string;
  bind(anchor: HTMLAnchorElement): HTMLAnchorElement;
  verify(event: MouseEvent): Promise<DetachedReceiveHandle>;
  close(): void;
}

export interface DetachedReceiverHandoffController {
  readonly transport: "detached-datachannel/1";
  /** Revoked to null on every terminal lifecycle path. */
  readonly capture: DetachedOfferCapture | null;
  readonly state: string;
  prepare(): Promise<PreparedDetachedReceiverHandoff>;
  close(): void;
}

export interface CaptureDetachedReceiverHandoffOptions
  extends DetachedBroadcastOptions,
    DetachedSignalOptions {
  windowRef?: Window;
  helperReadyTimeoutMs?: number;
  handoffAdmissionTimeoutMs?: number;
  sessionPromotionTimeoutMs?: number;
  channelTimeoutMs?: number;
  transferTimeoutMs?: number;
  dispositionTimeoutMs?: number;
  maximumFramesPerSecond?: number;
  maximumBytesPerSecond?: number;
  maximumActiveSessions?: number;
  maximumReplayClaims?: number;
  maximumAggregateTransferBytes?: number;
  byteReservationTimeoutMs?: number;
  preserveSettlementTimeoutMs?: number;
  admitIncomingHandoff(request: IncomingHandoffAdmissionRequest):
    | IncomingHandoffAdmissionDecision
    | Promise<IncomingHandoffAdmissionDecision>;
  reserveIncomingBytes(request: IncomingByteReservationRequest):
    | IncomingByteReservationDecision
    | Promise<IncomingByteReservationDecision>;
  onCleanupError?(failure: Readonly<{
    operation: string;
    error: unknown;
  }>): void;
  onActivationError?(failure: HandoffActivationFailure): void;
  authorizeOrigin(
    request: ConditionalOriginAuthorizationRequest,
    context: Readonly<{ signal: AbortSignal }>,
  ): AuthorizationDecision | Promise<AuthorizationDecision>;
  authorizeManifest(
    manifest: DetachedManifest,
    manifestDigest: string,
    context: Readonly<{
      signal: AbortSignal;
      previewAuthorization: PreviewAuthorizationEvidence;
    }>,
  ): AuthorizationDecision | Promise<AuthorizationDecision>;
  onPreview(
    delivery: DetachedPreviewDelivery,
    context: Readonly<{ signal: AbortSignal }>,
  ): void | Promise<void>;
  peerConnectionFactory?: (
    configuration: RTCConfiguration,
  ) => RTCPeerConnection;
}

export function captureDetachedReceiverHandoff(
  receiver: ReceiverDeclaration,
  options: CaptureDetachedReceiverHandoffOptions,
): DetachedReceiverHandoffController;

export interface IncomingHandoffAdmissionRequest {
  readonly requestId: string;
  readonly channelId: string | null;
  readonly transport: IncomingHandoffProfile;
  readonly replayExpiresAt: number;
  readonly pendingExpiresAt: number;
  readonly maximumActiveSessions: number;
  readonly maximumReplayClaims: number;
}

export type IncomingHandoffAdmissionDecision =
  | Readonly<{
      admitted: false;
      reason: "replay" | "session-capacity" | "replay-capacity";
    }>
  | Readonly<{
      admitted: true;
      promote(request: Readonly<{ expiresAt: number }>):
        | true
        | Promise<true>;
      release(): void | Promise<void>;
    }>;

export type ConsumeIncomingHandoffOptions =
  CaptureDetachedReceiverHandoffOptions &
  Omit<
    ConsumeLinkEnvelopeOptions,
    "launchUrl" | "expectedEndpoint" | "declarationId" | "windowRef"
  > &
  Readonly<{
    windowRef?: Window;
    now?: () => number;
    scrubbedHandoff?: ScrubbedIncomingHandoff;
  }>;

export function consumeIncomingHandoff(
  receiver: ReceiverDeclaration,
  options: ConsumeIncomingHandoffOptions,
):
  | DetachedReceiverHandoffController
  | Promise<LinkEnvelopeDelivery | null>
  | null;

export function canonicalOrigin(value: string): string;
export function isLoopbackHostname(value: unknown): boolean;
export function assertSecureContext(
  windowRef: Window,
  role?: string,
): void;
export function assertTopLevelContext(
  windowRef: Window,
  role?: string,
): void;
export function assertSafeDisplayText(
  value: unknown,
  maximumLength: number,
  label?: string,
): string | null;
export function safeSourceUrl(value: unknown): string | null;
export function receiverInputToOrigin(value: unknown): string;
export function receiverOriginToDomain(value: string): string;
