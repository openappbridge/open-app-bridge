import { discoverReceiver } from "../src/discovery-document.js";

function discoveryDocument(options = {}) {
  const transports = {};
  if (options.link !== false) {
    transports["link-envelope/1"] = {
      representations: ["text/markdown", "text/plain"],
      assetTypes: [],
      limits: {
        maximumUrlBytes: 16384,
        maximumFragmentBytes: 12288,
        maximumDecodedBytes: 8192,
      },
    };
  }
  if (options.detached !== false) {
    transports["detached-datachannel/1"] = {
      receiverHelper: "/_oab/detached-helper",
      representations: ["text/markdown", "text/html", "text/plain"],
      assetTypes: ["image/png", "image/svg+xml"],
      limits: {
        maximumSignalingBytes: 32768,
        maximumFrameBytes: 16384,
        maximumTransferBytes: 16 * 1024 * 1024,
        maximumAssets: 32,
      },
    };
  }
  return {
    protocol: "org.openapp.bridge",
    wireVersions: ["1.0"],
    status: "enabled",
    endpoint: "/_oab/receive",
    intents: ["preview"],
    transports,
    senderPolicy: "user-controlled",
    declarationId: options.declarationId ?? "declaration-test-0001",
    discoveryTtl: 3600,
    extensions: {},
  };
}

async function verifiedReceiver(options = {}) {
  const origin = options.origin ?? "https://receiver.example";
  const expiresAt = options.expiresAt;
  const discoveryTtl = expiresAt == null ? 3600 : 1;
  const checkedAt = expiresAt == null
    ? Date.now()
    : Math.max(0, expiresAt - 1000);
  const value = {
    ...discoveryDocument(options),
    discoveryTtl,
  };
  return discoverReceiver(origin, {
    now: () => checkedAt,
    fetchApplicationManifest: false,
    fetchImpl: async (url) => {
      const response = new Response(JSON.stringify(value), {
        headers: { "content-type": "application/json" },
      });
      Object.defineProperty(response, "url", { value: String(url) });
      return response;
    },
  });
}

const receiverFixtures = new Map();
for (const options of [
  {},
  { detached: false },
  { link: false },
  { detached: false, declarationId: "replacement-declaration" },
  { detached: false, declarationId: "declaration-link-0001" },
  { detached: false, expiresAt: 999 },
]) {
  const key = JSON.stringify(options);
  receiverFixtures.set(key, await verifiedReceiver(options));
}

export function makeReceiver(options = {}) {
  const receiver = receiverFixtures.get(JSON.stringify(options));
  if (!receiver) throw new Error("Unsupported receiver test fixture options.");
  return receiver;
}

export function makeWindow(options = {}) {
  const listeners = new Map();
  const location = {
    origin: options.origin ?? "https://sender.example",
    href: options.href ?? `${options.origin ?? "https://sender.example"}/send`,
    hash: options.hash ?? "",
    pathname: options.pathname ?? "/send",
    search: "",
    replace(value) {
      this.href = new URL(value, this.href).href;
      const parsed = new URL(this.href);
      this.hash = parsed.hash;
      this.pathname = parsed.pathname;
      this.search = parsed.search;
    },
  };
  const history = {
    state: null,
    replaceState(_state, _title, value) {
      location.replace(value);
    },
  };
  const windowRef = {
    location,
    history,
    isSecureContext: options.isSecureContext ?? true,
    navigator: { userActivation: { isActive: true } },
    opener: options.opener ?? null,
    addEventListener(type, listener) {
      const entries = listeners.get(type) ?? [];
      entries.push(listener);
      listeners.set(type, entries);
    },
    removeEventListener(type, listener) {
      const entries = listeners.get(type) ?? [];
      listeners.set(type, entries.filter((entry) => entry !== listener));
    },
    dispatch(type, event = {}) {
      for (const listener of listeners.get(type) ?? []) listener(event);
    },
  };
  windowRef.top = options.framed ? {} : windowRef;
  windowRef.self = windowRef;
  return windowRef;
}

export function trustedClick(overrides = {}) {
  return {
    type: "click",
    defaultPrevented: false,
    isTrusted: true,
    button: 0,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    preventDefault() {
      this.defaultPrevented = true;
    },
    ...overrides,
  };
}

export function bindHandoff(handoff, overrides = {}) {
  const attributes = new Set();
  const anchor = Object.assign(new EventTarget(), {
    tagName: "A",
    href: "",
    target: "",
    rel: "",
    referrerPolicy: "",
    removeAttribute(name) {
      attributes.delete(String(name).toLowerCase());
      if (String(name).toLowerCase() === "href") this.href = "";
    },
    hasAttribute(name) {
      return attributes.has(String(name).toLowerCase());
    },
    setAttribute(name, value) {
      const normalized = String(name).toLowerCase();
      attributes.add(normalized);
      if (normalized === "href") this.href = String(value);
    },
  });
  handoff.bind(anchor);
  Object.assign(anchor, overrides);
  return anchor;
}

export function trustedHandoffClick(handoff, eventOverrides = {}, anchorOverrides = {}) {
  const currentTarget = bindHandoff(handoff, anchorOverrides);
  return trustedClick({ currentTarget, ...eventOverrides });
}

export function memoryReplayGuard() {
  const values = new Set();
  return {
    claim(value) {
      if (values.has(value)) return false;
      values.add(value);
      return true;
    },
  };
}

export function admitSession() {
  return Object.freeze({
    admitted: true,
    promote() { return true; },
    release() {},
  });
}

export const DETACHED_RECEIVE_SECURITY_OPTIONS = Object.freeze({
  requestId: "r".repeat(32),
  channelId: "c".repeat(43),
  reserveIncomingBytes() {
    return Object.freeze({
      reserved: true,
      release() {},
    });
  },
});
