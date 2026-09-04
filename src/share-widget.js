import { OAB_TRANSPORTS } from "./constants.js";
import { prepareContent } from "./content.js";
import { discoverReceiver } from "./discovery-document.js";
import { OabError } from "./errors.js";
import { fetchReceiverApplicationIcon } from "./application-manifest.js";
import {
  NETWORK_REQUEST_LIMITS,
  resolveNetworkTimeout,
} from "./network-deadline.js";
import {
  createDetachedAnchorHandoff,
  createLinkAnchorHandoff,
  inspectProfileAvailability,
} from "./sender.js";
import {
  DEFAULT_SHARE_HISTORY_KEY,
  ShareDestinationHistory,
  filterShareDestinations,
  receiverInputToOrigin,
  receiverOriginToDomain,
} from "./share-widget-history.js";

const ELEMENT_NAME = "oab-share";
const ACTIVE_CAPTURE_ELEMENTS =
  "script, style, template, noscript, iframe, object, embed, base, link, " +
  "meta, form, button, input, select, textarea, canvas, audio, video, source, track";
const HIDDEN_CAPTURE_ELEMENTS =
  "[hidden], [inert], [aria-hidden='true'], [style*='display:none' i], " +
  "[style*='display: none' i], [style*='visibility:hidden' i], " +
  "[style*='visibility: hidden' i]";
const URL_CAPTURE_ATTRIBUTES = new Set([
  "action",
  "cite",
  "data",
  "formaction",
  "href",
  "ping",
  "poster",
  "src",
  "srcset",
  "xlink:href",
]);

function timeoutAttribute(element, name, limits, label) {
  const value = element.getAttribute(name);
  if (value == null) return limits.defaultTimeoutMs;
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) {
    throw new TypeError(`${name} must be a canonical base-10 integer.`);
  }
  return resolveNetworkTimeout(Number(value), limits, label);
}

function setTimeoutAttribute(element, name, value, limits, label) {
  if (value == null) {
    element.removeAttribute(name);
    return;
  }
  element.setAttribute(
    name,
    String(resolveNetworkTimeout(value, limits, label)),
  );
}

function createElement(documentRef, tagName, options = {}) {
  const node = documentRef.createElement(tagName);
  if (options.id) node.id = options.id;
  if (options.className) node.className = options.className;
  if (options.text != null) node.textContent = options.text;
  if (options.part) node.setAttribute("part", options.part);
  for (const [name, value] of Object.entries(options.attributes ?? {})) {
    node.setAttribute(name, value);
  }
  return node;
}

function removeActiveCaptureContent(root) {
  root.querySelectorAll?.(ACTIVE_CAPTURE_ELEMENTS).forEach((node) => node.remove());
  root.querySelectorAll?.(HIDDEN_CAPTURE_ELEMENTS).forEach((node) => node.remove());
  const elements = [root, ...(root.querySelectorAll?.("*") ?? [])];
  for (const element of elements) {
    for (const attribute of [...(element.attributes ?? [])]) {
      if (
        attribute.name.toLowerCase().startsWith("on") ||
        ["nonce", "srcdoc", "style"].includes(attribute.name.toLowerCase()) ||
        URL_CAPTURE_ATTRIBUTES.has(attribute.name.toLowerCase())
      ) {
        element.removeAttribute(attribute.name);
      }
    }
  }
}

function storageFor(element) {
  try {
    return element.ownerDocument?.defaultView?.localStorage;
  } catch (_) {
    return null;
  }
}

function displayDate(timestamp) {
  if (!timestamp) return "Previously used";
  try {
    return `Last used ${new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
    }).format(new Date(timestamp))}`;
  } catch (_) {
    return "Previously used";
  }
}

function applicationName(application, domain) {
  return application?.shortName || application?.name || domain;
}

function portableTextProjection(content) {
  const representations = {};
  for (const type of ["text/markdown", "text/plain"]) {
    if (typeof content.representations[type] === "string") {
      representations[type] = content.representations[type];
    }
  }
  if (Object.keys(representations).length === 0) return null;
  return prepareContent(
    {
      title: content.title,
      representations,
      sourceApplication: content.sourceApplication,
      sourceUrl: content.sourceUrl,
    },
    {
      representations: Object.keys(representations),
      assetTypes: [],
      maximumAssets: 0,
      maximumTextBytes: content.textBytes,
      maximumTransferBytes: content.textBytes,
    },
  );
}

function createApplicationIcon(
  documentRef,
  application,
  domain,
  className,
  iconSrc = null,
) {
  const frame = createElement(documentRef, "span", {
    className: `application-icon ${className}`,
    part: "application-icon",
  });
  const fallback = createElement(documentRef, "span", {
    className: "application-icon-fallback",
    text: applicationName(application, domain).slice(0, 1).toUpperCase() || "↗",
    attributes: { "aria-hidden": "true" },
  });
  frame.append(fallback);
  if (!iconSrc) return frame;
  const image = createElement(documentRef, "img", {
    className: "application-icon-image",
    attributes: {
      src: iconSrc,
      alt: "",
      loading: "lazy",
      decoding: "async",
      crossorigin: "anonymous",
      referrerpolicy: "no-referrer",
    },
  });
  image.addEventListener("load", () => fallback.classList.add("hidden"));
  image.addEventListener("error", () => image.remove());
  frame.append(image);
  return frame;
}

function createApplicationIdentity(
  documentRef,
  application,
  domain,
  options = {},
) {
  const identity = createElement(documentRef, "span", {
    className: `application-identity ${options.className || ""}`.trim(),
    part: options.part || "application-identity",
  });
  identity.append(
    createApplicationIcon(
      documentRef,
      application,
      domain,
      options.iconClassName || "",
      options.iconSrc || null,
    ),
  );
  const copy = createElement(documentRef, "span", {
    className: "application-copy",
  });
  copy.append(
    createElement(documentRef, options.headingTag || "span", {
      className: "application-name",
      text: applicationName(application, domain),
      part: "application-name",
    }),
    createElement(documentRef, "span", {
      className: "application-origin",
      text: domain,
      part: "application-origin",
    }),
  );
  if (application?.description) {
    copy.append(
      createElement(documentRef, "span", {
        className: "application-description",
        text: application.description,
        part: "application-description",
      }),
    );
  }
  identity.append(copy);
  return identity;
}

const HTMLElementBase = globalThis.HTMLElement ?? class {};
const WIDGET_STYLESHEET_URL = new URL(
  "./share-widget.css",
  import.meta.url,
).href;
const WIDGET_STYLESHEET_INTEGRITY = "";

/**
 * Framework-neutral OAB sender UI. Importing this module registers <oab-share>
 * when Custom Elements are available.
 */
export class OpenAppShareElement extends HTMLElementBase {
  static get observedAttributes() {
    return ["detached", "share-label", "storage-key", "trigger"];
  }

  constructor() {
    super();
    if (!this.attachShadow || !this.ownerDocument) return;
    this._content = null;
    this._contentProvider = null;
    this._contentPromise = null;
    this._pendingPreparedContent = null;
    this._receiver = null;
    this._prepared = null;
    this._portablePrepared = null;
    this._availability = null;
    this._selectedTransport = null;
    this._anchorHandoff = null;
    this._activeHandoffController = null;
    this._armedTransport = null;
    this._armedOrigin = null;
    this._armedReceiver = null;
    this._armedPrepared = null;
    this._selectedOrigin = null;
    this._verifyGeneration = 0;
    this._armGeneration = 0;
    this._openGeneration = 0;
    this._discoveryAbort = null;
    this._verifiedIconUrl = null;
    this._externalTrigger = null;
    this._externalTriggerAccessibility = null;
    this._triggerObserver = null;
    this._activeHandoff = false;
    this._busy = false;
    this._returnFocus = null;
    this._invocationTarget = null;
    this._boundExternalTrigger = (event) => {
      event.preventDefault();
      this._invocationTarget = event.currentTarget;
      void this.open();
    };

    const documentRef = this.ownerDocument;
    const shadow = this.attachShadow({ mode: "open" });
    const stylesheet = createElement(documentRef, "link", {
      attributes: {
        rel: "stylesheet",
        href: WIDGET_STYLESHEET_URL,
        ...(WIDGET_STYLESHEET_INTEGRITY
          ? {
              integrity: WIDGET_STYLESHEET_INTEGRITY,
              crossorigin: "anonymous",
            }
          : {}),
      },
    });
    this._defaultTrigger = createElement(documentRef, "button", {
      className: "trigger",
      text: "Share",
      part: "trigger",
      attributes: {
        type: "button",
        "aria-haspopup": "dialog",
        "aria-expanded": "false",
      },
    });

    this._dialog = createElement(documentRef, "dialog", {
      part: "dialog",
      attributes: {
        "aria-labelledby": "oab-share-title",
        "aria-describedby": "oab-share-introduction",
      },
    });
    const surface = createElement(documentRef, "div", {
      className: "surface",
      part: "surface",
    });
    const header = createElement(documentRef, "header", {
      className: "header",
      part: "header",
    });
    const headerText = createElement(documentRef, "div");
    headerText.append(
      createElement(documentRef, "div", {
        className: "eyebrow",
        text: "Open App Bridge",
        part: "eyebrow",
      }),
    );
    this._title = createElement(documentRef, "h2", {
      id: "oab-share-title",
      text: "Share to an app",
      part: "title",
    });
    headerText.append(this._title);
    this._closeButton = createElement(documentRef, "button", {
      className: "icon-button",
      text: "×",
      part: "close-button",
      attributes: { type: "button", "aria-label": "Close sharing" },
    });
    header.append(headerText, this._closeButton);

    const introduction = createElement(documentRef, "p", {
      id: "oab-share-introduction",
      className: "introduction",
      text:
        "Choose a recent app or enter any domain that supports Open App Bridge.",
      part: "introduction",
    });

    this._historySection = createElement(documentRef, "section", {
      className: "history",
      part: "history",
      attributes: { "aria-labelledby": "oab-history-title" },
    });
    this._historyHeading = createElement(documentRef, "h3", {
      id: "oab-history-title",
      text: "Recent apps",
      part: "history-title",
    });
    this._destinationList = createElement(documentRef, "ul", {
      id: "oab-destination-list",
      className: "destination-list",
      part: "destination-list",
      attributes: { "aria-label": "Recent apps" },
    });
    this._historySection.append(this._historyHeading, this._destinationList);

    const searchSection = createElement(documentRef, "section", {
      className: "search-section",
      part: "search-section",
    });
    this._searchLabel = createElement(documentRef, "label", {
      text: "Search previous destinations or enter a domain",
      part: "search-label",
      attributes: { for: "oab-destination-input" },
    });
    const searchRow = createElement(documentRef, "div", {
      className: "search-row",
      part: "search-row",
    });
    this._input = createElement(documentRef, "input", {
      id: "oab-destination-input",
      part: "destination-input",
      attributes: {
        type: "text",
        inputmode: "url",
        autocomplete: "off",
        autocapitalize: "none",
        spellcheck: "false",
        placeholder: "markerpad.app",
        "aria-describedby": "oab-share-introduction",
      },
    });
    this._checkButton = createElement(documentRef, "button", {
      text: "Check",
      part: "check-button",
      attributes: { type: "button" },
    });
    searchRow.append(this._input, this._checkButton);
    searchSection.append(this._searchLabel, searchRow);

    this._status = createElement(documentRef, "div", {
      className: "status",
      part: "status",
      attributes: { role: "status", "aria-live": "polite" },
    });

    this._verified = createElement(documentRef, "section", {
      className: "verified hidden",
      part: "verified",
      attributes: { "aria-label": "Verified receiver" },
    });
    this._verifiedIdentity = createElement(documentRef, "div", {
      className: "verified-identity",
      part: "verified-identity",
    });
    this._capabilities = createElement(documentRef, "p", {
      className: "capabilities",
      part: "capabilities",
    });
    this._profileChoices = createElement(documentRef, "fieldset", {
      className: "profile-choices",
      part: "profile-choices",
    });
    this._profileChoices.append(
      createElement(documentRef, "legend", {
        text: "Transfer method",
        part: "profile-title",
      }),
    );
    const detachedChoice = createElement(documentRef, "label", {
      className: "profile-choice",
      part: "profile-choice",
    });
    this._detachedRadio = createElement(documentRef, "input", {
      attributes: {
        type: "radio",
        name: "oab-transfer-profile",
        value: OAB_TRANSPORTS.detachedDataChannel,
      },
    });
    const detachedCopy = createElement(documentRef, "span", {
      className: "profile-copy",
    });
    detachedCopy.append(
      createElement(documentRef, "strong", {
        text: "Private transfer",
      }),
      createElement(documentRef, "small", {
        text: "Encrypted peer channel, verified sender origin, assets, and a final result.",
      }),
    );
    detachedChoice.append(this._detachedRadio, detachedCopy);
    const linkChoice = createElement(documentRef, "label", {
      className: "profile-choice",
      part: "profile-choice",
    });
    this._linkRadio = createElement(documentRef, "input", {
      attributes: {
        type: "radio",
        name: "oab-transfer-profile",
        value: OAB_TRANSPORTS.linkEnvelope,
      },
    });
    const linkCopy = createElement(documentRef, "span", {
      className: "profile-copy",
    });
    linkCopy.append(
      createElement(documentRef, "strong", {
        text: "Portable text link",
      }),
      createElement(documentRef, "small", {
        text: "For non-confidential Markdown or plain text. Sender identity and delivery are not verified.",
      }),
    );
    linkChoice.append(this._linkRadio, linkCopy);
    this._profileNote = createElement(documentRef, "p", {
      className: "profile-note",
      part: "profile-note",
    });
    this._profileChoices.append(detachedChoice, linkChoice, this._profileNote);
    const rememberLabel = createElement(documentRef, "label", {
      className: "remember",
      part: "remember-label",
    });
    this._remember = createElement(documentRef, "input", {
      part: "remember-input",
      attributes: { type: "checkbox" },
    });
    rememberLabel.append(
      this._remember,
      documentRef.createTextNode("Remember this destination in this browser"),
    );
    const verifiedActions = createElement(documentRef, "div", {
      className: "actions",
      part: "actions",
    });
    this._sendLink = createElement(documentRef, "a", {
      className: "primary-action",
      text: "Send",
      part: "send-link",
      attributes: { "aria-disabled": "true", tabindex: "-1" },
    });
    this._changeButton = createElement(documentRef, "button", {
      className: "secondary-action",
      text: "Choose another",
      part: "change-button",
      attributes: { type: "button" },
    });
    verifiedActions.append(this._sendLink, this._changeButton);
    this._verified.append(
      this._verifiedIdentity,
      this._capabilities,
      this._profileChoices,
      rememberLabel,
      verifiedActions,
    );

    const privacy = createElement(documentRef, "p", {
      className: "privacy",
      text:
        "Recent app details stay in this browser. Content is transferred " +
        "only after receiver verification and your separate Send action.",
      part: "privacy-note",
    });

    surface.append(
      header,
      introduction,
      this._historySection,
      searchSection,
      this._status,
      this._verified,
      privacy,
    );
    this._dialog.append(surface);
    shadow.append(stylesheet, this._defaultTrigger, this._dialog);

    this._defaultTrigger.addEventListener("click", (event) => {
      this._invocationTarget = event.currentTarget;
      void this.open();
    });
    this._closeButton.addEventListener("click", () => this.close());
    this._checkButton.addEventListener("click", () => {
      void this._checkInput();
    });
    this._input.addEventListener("input", () => {
      this._verifyGeneration += 1;
      this._discoveryAbort?.abort();
      this._setBusy(false);
      this._clearVerified();
      this._setStatus("Choose a destination, then check its OAB support.");
      this._renderDestinations(this._input.value);
    });
    this._input.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      void this._checkInput();
    });
    this._changeButton.addEventListener("click", () => {
      this._clearVerified();
      this._input.focus();
    });
    this._sendLink.addEventListener("click", (event) => {
      this._activateSend(event);
    });
    this._detachedRadio.addEventListener("change", () => {
      if (this._detachedRadio.checked) {
        void this._selectTransport(OAB_TRANSPORTS.detachedDataChannel);
      }
    });
    this._linkRadio.addEventListener("change", () => {
      if (this._linkRadio.checked) {
        void this._selectTransport(OAB_TRANSPORTS.linkEnvelope);
      }
    });
    this._dialog.addEventListener("close", () => {
      if (!this._activeHandoff) {
        this._clearPendingContent();
        this._verifyGeneration += 1;
        this._discoveryAbort?.abort();
        this._clearVerified();
        this._setBusy(false);
      }
      this._restoreFocus();
      this._externalTrigger?.setAttribute?.("aria-expanded", "false");
      this._defaultTrigger?.setAttribute?.("aria-expanded", "false");
      this._dispatch("oab-close", {});
    });
  }

  connectedCallback() {
    if (!this.shadowRoot) return;
    this._initializeHistory();
    this._updateTriggerBinding();
    this._updateLabels();
    this._renderDestinations();
  }

  disconnectedCallback() {
    const activeController = this._activeHandoffController;
    this._activeHandoffController = null;
    if (activeController) {
      // A host can unmount synchronously from the click stack. Preserve the
      // native navigation boundary and close the volatile session no earlier
      // than the following task.
      setTimeout(() => activeController.close?.(), 0);
    }
    this._unbindExternalTrigger();
    this._discoveryAbort?.abort();
    this._verifyGeneration += 1;
    this._clearPendingContent();
    this._clearVerified();
  }

  attributeChangedCallback(name, oldValue, newValue) {
    if (oldValue === newValue || !this.shadowRoot) return;
    if (name === "trigger") this._updateTriggerBinding();
    if (name === "share-label") this._updateLabels();
    if (name === "detached" && this._receiver) void this._configureProfiles();
    if (name === "storage-key" && this.isConnected) {
      this._initializeHistory();
      this._renderDestinations();
    }
  }

  get content() {
    return this._content;
  }

  set content(value) {
    this._content = value;
  }

  get contentProvider() {
    return this._contentProvider;
  }

  set contentProvider(value) {
    if (value != null && typeof value !== "function") {
      throw new TypeError("contentProvider must be a function or null.");
    }
    this._contentProvider = value;
  }

  get detachedEnabled() {
    return this.hasAttribute("detached");
  }

  set detachedEnabled(value) {
    this.toggleAttribute("detached", Boolean(value));
  }

  get discoveryTimeoutMs() {
    return timeoutAttribute(
      this,
      "discovery-timeout-ms",
      NETWORK_REQUEST_LIMITS.discovery,
      "discoveryTimeoutMs",
    );
  }

  set discoveryTimeoutMs(value) {
    setTimeoutAttribute(
      this,
      "discovery-timeout-ms",
      value,
      NETWORK_REQUEST_LIMITS.discovery,
      "discoveryTimeoutMs",
    );
  }

  get applicationManifestTimeoutMs() {
    return timeoutAttribute(
      this,
      "manifest-timeout-ms",
      NETWORK_REQUEST_LIMITS.applicationManifest,
      "applicationManifestTimeoutMs",
    );
  }

  set applicationManifestTimeoutMs(value) {
    setTimeoutAttribute(
      this,
      "manifest-timeout-ms",
      value,
      NETWORK_REQUEST_LIMITS.applicationManifest,
      "applicationManifestTimeoutMs",
    );
  }

  get applicationIconTimeoutMs() {
    return timeoutAttribute(
      this,
      "icon-timeout-ms",
      NETWORK_REQUEST_LIMITS.applicationIcon,
      "applicationIconTimeoutMs",
    );
  }

  set applicationIconTimeoutMs(value) {
    setTimeoutAttribute(
      this,
      "icon-timeout-ms",
      value,
      NETWORK_REQUEST_LIMITS.applicationIcon,
      "applicationIconTimeoutMs",
    );
  }

  async open(contentOverride) {
    const invocationTarget = this._invocationTarget;
    this._invocationTarget = null;
    if (!this._dialog) {
      throw new OabError("widget_unavailable", "The share widget needs a browser DOM.");
    }
    if (this._activeHandoff) {
      if (!this._dialog.open) {
        if (typeof this._dialog.showModal === "function") this._dialog.showModal();
        else this._dialog.setAttribute("open", "");
      }
      this._setStatus("A share is already in progress.");
      return;
    }
    const generation = ++this._openGeneration;
    this._returnFocus = invocationTarget ?? this.ownerDocument.activeElement;
    this._verifyGeneration += 1;
    this._discoveryAbort?.abort();
    this._input.value = "";
    this._clearPendingContent(false);
    this._clearVerified();
    this._renderDestinations();
    this._setStatus("Preparing the content to share…");
    const contentPromise = this._resolveContent(contentOverride).then(
      (content) => prepareContent(content),
    );
    this._contentPromise = contentPromise;
    if (!this._dialog.open) {
      if (typeof this._dialog.showModal === "function") this._dialog.showModal();
      else this._dialog.setAttribute("open", "");
    }
    this._externalTrigger?.setAttribute?.("aria-expanded", "true");
    this._defaultTrigger?.setAttribute?.("aria-expanded", "true");
    this._dispatch("oab-open", {});
    queueMicrotask(() => this._focusInitialChoice());
    try {
      const preparedContent = await contentPromise;
      if (generation !== this._openGeneration) return;
      this._pendingPreparedContent = preparedContent;
      this._setStatus("Choose a destination, then check its OAB support.");
    } catch (error) {
      if (generation !== this._openGeneration) return;
      this._showError(error);
    } finally {
      // A settled Promise retains its fulfillment value. Keep only the
      // normalized, explicitly active content snapshot and release the Promise
      // (and its provider/override closure) generation-safely.
      if (this._contentPromise === contentPromise) this._contentPromise = null;
    }
  }

  /**
   * Opens the share UI for a known receiver domain and immediately performs
   * normal OAB discovery. This is intended for app-directory buttons and
   * other user gestures that already identify the destination.
   */
  async openFor(destination, contentOverride) {
    const displayDomain = receiverOriginToDomain(
      receiverInputToOrigin(destination),
    );
    await this.open(contentOverride);
    if (
      !this._dialog?.open ||
      this._activeHandoff ||
      !this._pendingPreparedContent
    ) {
      return;
    }
    this._input.value = displayDomain;
    this._renderDestinations(displayDomain);
    await this._verifyDestination(displayDomain);
  }

  close() {
    if (!this._dialog?.open) return;
    if (typeof this._dialog.close === "function") this._dialog.close();
    else {
      this._dialog.removeAttribute("open");
      if (!this._activeHandoff) {
        this._clearPendingContent();
        this._clearVerified();
      }
      this._restoreFocus();
      this._externalTrigger?.setAttribute?.("aria-expanded", "false");
      this._defaultTrigger?.setAttribute?.("aria-expanded", "false");
      this._dispatch("oab-close", {});
    }
  }

  clearDestinations() {
    this._history?.clear();
    this._renderDestinations(this._input?.value);
  }

  _restoreFocus() {
    const target = this._returnFocus;
    this._returnFocus = null;
    if (!target?.focus) return;
    const restore = () => {
      if (target.isConnected !== false) target.focus({ preventScroll: true });
    };
    const requestFrame = this.ownerDocument?.defaultView?.requestAnimationFrame;
    if (typeof requestFrame === "function") requestFrame(restore);
    else queueMicrotask(restore);
  }

  _initializeHistory() {
    const key = this.getAttribute("storage-key") || DEFAULT_SHARE_HISTORY_KEY;
    this._history = new ShareDestinationHistory(storageFor(this), key);
    this._history.load();
  }

  _updateLabels() {
    const label = this.getAttribute("share-label")?.trim() || "Share";
    this._defaultTrigger.textContent = label;
  }

  _unbindExternalTrigger() {
    this._externalTrigger?.removeEventListener(
      "click",
      this._boundExternalTrigger,
    );
    if (this._externalTrigger) {
      for (const [name, value] of Object.entries(
        this._externalTriggerAccessibility ?? {},
      )) {
        if (value == null) this._externalTrigger.removeAttribute?.(name);
        else this._externalTrigger.setAttribute?.(name, value);
      }
    }
    this._externalTrigger = null;
    this._externalTriggerAccessibility = null;
    this._triggerObserver?.disconnect();
    this._triggerObserver = null;
  }

  _updateTriggerBinding() {
    if (!this._defaultTrigger) return;
    this._unbindExternalTrigger();
    const selector = this.getAttribute("trigger")?.trim();
    this._defaultTrigger.hidden = false;
    if (!selector || !this.isConnected) return;
    const bind = () => {
      this._externalTrigger = this.ownerDocument.querySelector(selector);
      if (!this._externalTrigger) return false;
      this._defaultTrigger.hidden = true;
      this._externalTriggerAccessibility = {
        "aria-haspopup": this._externalTrigger.getAttribute?.("aria-haspopup"),
        "aria-expanded": this._externalTrigger.getAttribute?.("aria-expanded"),
      };
      this._externalTrigger.setAttribute?.("aria-haspopup", "dialog");
      this._externalTrigger.setAttribute?.("aria-expanded", "false");
      this._externalTrigger.addEventListener(
        "click",
        this._boundExternalTrigger,
      );
      this._triggerObserver?.disconnect();
      this._triggerObserver = null;
      return true;
    };
    try {
      if (bind()) return;
    } catch (error) {
      this._showError(
        new OabError("invalid_trigger", "The widget trigger selector is invalid.", {
          cause: error,
        }),
      );
      return;
    }
    const MutationObserverCtor =
      this.ownerDocument.defaultView?.MutationObserver;
    if (MutationObserverCtor && this.ownerDocument.documentElement) {
      this._triggerObserver = new MutationObserverCtor(() => {
        try {
          bind();
        } catch (_) {
          this._triggerObserver?.disconnect();
          this._triggerObserver = null;
        }
      });
      this._triggerObserver.observe(this.ownerDocument.documentElement, {
        childList: true,
        subtree: true,
      });
    }
  }

  _focusInitialChoice() {
    const firstSaved = this._destinationList.querySelector(
      "button[data-destination]",
    );
    (firstSaved ?? this._input).focus();
  }

  async _resolveContent(contentOverride) {
    let value;
    if (contentOverride !== undefined) {
      value =
        typeof contentOverride === "function"
          ? contentOverride()
          : contentOverride;
    } else if (this._contentProvider) {
      value = this._contentProvider();
    } else if (this._content != null) {
      value = this._content;
    } else {
      value = this._captureDocumentContent();
    }
    const resolved = await value;
    if (!resolved || typeof resolved !== "object") {
      throw new OabError(
        "invalid_widget_content",
        "The share widget content provider must return a content object.",
      );
    }
    const result = { ...resolved };
    result.title ??=
      this.getAttribute("content-title")?.trim() ||
      this.ownerDocument.title ||
      null;
    result.sourceApplication ??=
      this.getAttribute("source-application")?.trim() ||
      this.ownerDocument.location?.hostname ||
      null;
    if (result.sourceUrl == null && this.hasAttribute("include-source-url")) {
      result.sourceUrl = this.ownerDocument.location?.href ?? null;
    }
    return result;
  }

  _captureDocumentContent() {
    const documentRef = this.ownerDocument;
    const selection = documentRef.defaultView?.getSelection?.();
    if (selection && !selection.isCollapsed && selection.rangeCount > 0) {
      const range = selection.getRangeAt(0);
      if (range.commonAncestorContainer.getRootNode() === this.shadowRoot) {
        return this._captureSelectedElement();
      }
      const container = documentRef.createElement("div");
      container.append(range.cloneContents());
      removeActiveCaptureContent(container);
      return {
        html: container.innerHTML,
        text: container.textContent || "",
      };
    }

    return this._captureSelectedElement();
  }

  _captureSelectedElement() {
    const documentRef = this.ownerDocument;
    let target;
    const selector = this.getAttribute("content-selector")?.trim();
    if (!selector) {
      throw new OabError(
        "widget_content_required",
        "Provide content, a contentProvider, a user selection, or an explicit content-selector. Whole-page capture is not implicit.",
      );
    }
    try {
      target = documentRef.querySelector(selector);
    } catch (error) {
      throw new OabError(
        "invalid_content_selector",
        "The widget content selector is invalid.",
        { cause: error },
      );
    }
    if (!target) {
      throw new OabError(
        "content_not_found",
        "The widget could not find page content to share.",
      );
    }
    const clone = target.cloneNode(true);
    clone
      .querySelectorAll?.(`${ELEMENT_NAME}, [data-oab-share-exclude]`)
      .forEach((node) => node.remove());
    removeActiveCaptureContent(clone);
    return {
      html: clone.innerHTML,
      text: clone.textContent || "",
    };
  }

  _renderDestinations(query = "") {
    if (!this._history || !this._destinationList) return;
    const all = this._history.load();
    const destinations = filterShareDestinations(all, query);
    this._destinationList.replaceChildren();
    this._historySection.hidden = all.length === 0;
    this._searchLabel.textContent = all.length
      ? "Search previous destinations or enter a domain (no https://)"
      : "Receiver domain (no https://)";
    for (const destination of destinations) {
      const displayDomain = receiverOriginToDomain(destination.origin);
      const displayName = applicationName(
        destination.application,
        displayDomain,
      );
      const item = createElement(this.ownerDocument, "li", {
        className: "destination-item",
        part: "destination-item",
      });
      const select = createElement(this.ownerDocument, "button", {
        className: "destination-choice",
        part: "destination-choice",
        attributes: {
          type: "button",
          "data-destination": destination.origin,
          "aria-label": `Use ${displayName} at ${displayDomain}`,
        },
      });
      select.append(
        createApplicationIdentity(
          this.ownerDocument,
          destination.application,
          displayDomain,
          { className: "destination-identity" },
        ),
        createElement(this.ownerDocument, "span", {
          className: "destination-date",
          text: displayDate(destination.lastUsedAt),
        }),
      );
      select.addEventListener("click", () => {
        this._input.value = displayDomain;
        void this._verifyDestination(displayDomain);
      });
      const remove = createElement(this.ownerDocument, "button", {
        className: "remove-destination",
        text: "Remove",
        part: "remove-destination",
        attributes: {
          type: "button",
          "aria-label": `Remove ${displayDomain} from previous destinations`,
        },
      });
      remove.addEventListener("click", () => {
        this._history.remove(destination.origin);
        if (this._selectedOrigin === destination.origin) {
          this._remember.checked = false;
        }
        this._renderDestinations(this._input.value);
        this._dispatch("oab-destination-removed", {
          origin: destination.origin,
        });
      });
      item.append(select, remove);
      select.disabled = this._busy;
      remove.disabled = this._busy;
      this._destinationList.append(item);
    }
    if (all.length > 0 && destinations.length === 0) {
      this._destinationList.append(
        createElement(this.ownerDocument, "li", {
          className: "empty-destinations",
          text: "No previous destination matches this search.",
          part: "empty-destinations",
        }),
      );
    }
    this._destinationList.setAttribute(
      "aria-label",
      destinations.length
        ? "Recent apps"
        : "No matching recent apps",
    );
  }

  async _checkInput() {
    const value = this._input.value.trim();
    if (!value) {
      this._showError(
        new OabError(
          "receiver_required",
          "Enter a receiver domain or choose a recent app.",
        ),
      );
      this._input.focus();
      return;
    }
    await this._verifyDestination(value);
  }

  async _verifyDestination(value) {
    const generation = ++this._verifyGeneration;
    this._discoveryAbort?.abort();
    this._discoveryAbort = new AbortController();
    this._clearVerified();
    this._setBusy(true);
    this._setStatus("Checking the receiver declaration…");
    const contentPromise = this._contentPromise ?? (
      this._pendingPreparedContent
        ? Promise.resolve(this._pendingPreparedContent)
        : this._resolveContent().then((content) => prepareContent(content))
    );
    try {
      const targetOrigin = receiverInputToOrigin(value);
      const [receiver, prepared] = await Promise.all([
        discoverReceiver(targetOrigin, {
          signal: this._discoveryAbort.signal,
          timeoutMs: this.discoveryTimeoutMs,
          applicationManifestTimeoutMs: this.applicationManifestTimeoutMs,
        }),
        contentPromise,
      ]);
      if (generation !== this._verifyGeneration) return;
      this._pendingPreparedContent = null;
      this._receiver = receiver;
      this._prepared = prepared;
      this._portablePrepared = portableTextProjection(prepared);
      this._availability = inspectProfileAvailability(receiver, prepared);
      this._selectedOrigin = receiver.origin;
      this._input.value = receiverOriginToDomain(receiver.origin);
      const alreadyRemembered = this._history
        .load()
        .some((item) => item.origin === receiver.origin);
      this._remember.checked =
        alreadyRemembered || this.getAttribute("remember-destinations") !== "false";
      this._renderVerifiedIdentity(receiver);
      void this._loadVerifiedIcon(
        receiver,
        generation,
        this._discoveryAbort.signal,
      );
      this._capabilities.textContent =
        `Receiver verified · Content: ${prepared.representationTypes.join(", ") || "assets only"}` +
        `${prepared.assets.length ? ` · ${prepared.assets.length} asset${prepared.assets.length === 1 ? "" : "s"}` : ""}`;
      this._verified.classList.remove("hidden");
      const armed = await this._configureProfiles();
      if (generation !== this._verifyGeneration || this._receiver !== receiver) {
        return;
      }
      if (!armed) return;
      this._setStatus(
        "Receiver verified. Select a method, then use Send as a separate action.",
      );
      this._dispatch("oab-receiver-verified", {
        origin: receiver.origin,
        declaration: receiver,
      });
      this._sendLink.focus();
    } catch (error) {
      if (generation !== this._verifyGeneration) return;
      if (error?.name === "AbortError" || error?.cause?.name === "AbortError") {
        return;
      }
      this._showError(error);
    } finally {
      if (generation === this._verifyGeneration) this._setBusy(false);
    }
  }

  _setBusy(busy) {
    this._busy = busy;
    this._dialog?.setAttribute("aria-busy", String(busy));
    this._checkButton.disabled = busy;
    this._input.disabled = busy;
    this._remember.disabled = busy;
    this._changeButton.disabled = busy;
    if (busy) {
      this._detachedRadio.disabled = true;
      this._linkRadio.disabled = true;
    }
    for (const button of this._destinationList.querySelectorAll("button")) {
      button.disabled = busy;
    }
  }

  _renderVerifiedIdentity(receiver) {
    const domain = receiverOriginToDomain(receiver.origin);
    this._verifiedIdentity.replaceChildren(
      createApplicationIdentity(
        this.ownerDocument,
        receiver.application,
        domain,
        {
          className: "verified-application",
          iconClassName: "verified-application-icon",
          iconSrc: this._verifiedIconUrl,
          headingTag: "h3",
        },
      ),
    );
  }

  _clearVerified() {
    this._releaseVerifiedIcon();
    this._receiver = null;
    this._prepared = null;
    this._portablePrepared = null;
    this._availability = null;
    this._selectedTransport = null;
    this._selectedOrigin = null;
    this._verified?.classList.add("hidden");
    this._disableSend();
  }

  _clearPendingContent(invalidateOpen = true) {
    if (invalidateOpen) this._openGeneration += 1;
    this._contentPromise = null;
    this._pendingPreparedContent = null;
  }

  _releaseVerifiedIcon() {
    if (!this._verifiedIconUrl) return;
    const Url = this.ownerDocument?.defaultView?.URL ?? globalThis.URL;
    try { Url?.revokeObjectURL?.(this._verifiedIconUrl); } catch (_) {}
    this._verifiedIconUrl = null;
  }

  async _loadVerifiedIcon(receiver, generation, signal) {
    if (!receiver.application) return;
    let resource;
    try {
      resource = await fetchReceiverApplicationIcon(receiver.application, {
        signal,
        preferredSize: 96,
        timeoutMs: this.applicationIconTimeoutMs,
      });
    } catch (error) {
      if (error?.name === "AbortError" || error?.cause?.name === "AbortError") {
        return;
      }
      // Display metadata is optional. A failed or unsafe icon never weakens an
      // otherwise valid receiver declaration and falls back to a local glyph.
      return;
    }
    if (!resource || generation !== this._verifyGeneration || this._receiver !== receiver) {
      return;
    }
    const Url = this.ownerDocument?.defaultView?.URL ?? globalThis.URL;
    if (typeof Url?.createObjectURL !== "function") return;
    const objectUrl = Url.createObjectURL(resource.blob);
    if (generation !== this._verifyGeneration || this._receiver !== receiver) {
      Url.revokeObjectURL?.(objectUrl);
      return;
    }
    this._releaseVerifiedIcon();
    this._verifiedIconUrl = objectUrl;
    this._renderVerifiedIdentity(receiver);
  }

  async _configureProfiles() {
    if (!this._receiver || !this._prepared || !this._availability) return;
    const detachedAvailable =
      this.detachedEnabled &&
      this._availability[OAB_TRANSPORTS.detachedDataChannel]?.compatible === true;
    let linkAvailable = false;
    if (this._portablePrepared) {
      try {
        linkAvailable =
          inspectProfileAvailability(this._receiver, this._portablePrepared)[
            OAB_TRANSPORTS.linkEnvelope
          ]?.compatible === true;
      } catch (_) {
        linkAvailable = false;
      }
    }
    this._detachedRadio.disabled = !detachedAvailable;
    this._linkRadio.disabled = !linkAvailable;
    const selected = detachedAvailable
      ? OAB_TRANSPORTS.detachedDataChannel
      : linkAvailable
        ? OAB_TRANSPORTS.linkEnvelope
        : null;
    this._detachedRadio.checked = selected === OAB_TRANSPORTS.detachedDataChannel;
    this._linkRadio.checked = selected === OAB_TRANSPORTS.linkEnvelope;
    if (!this.detachedEnabled && this._receiver.detachedDataChannel) {
      this._profileNote.textContent =
        "Private transfer is available after this sender hosts the fixed OAB callback resource and enables detached mode.";
    } else if (!detachedAvailable && !linkAvailable) {
      this._profileNote.textContent =
        "This receiver has no profile compatible with the current content.";
    } else {
      this._profileNote.textContent =
        "Profiles are independent. A failure never switches to another method automatically.";
    }
    if (selected) return this._selectTransport(selected);
    this._disableSend();
    this._setStatus(
      "Receiver verified, but no advertised profile accepts this content.",
      true,
    );
    return false;
  }

  async _selectTransport(transport) {
    const generation = ++this._armGeneration;
    this._selectedTransport = transport;
    this._disableSend(true, false);
    const armed = await this._armSend(generation, {
      transport,
      receiver: this._receiver,
      prepared: this._prepared,
      portablePrepared: this._portablePrepared,
    });
    if (
      armed &&
      generation === this._armGeneration &&
      this._selectedTransport === transport
    ) {
      this._setStatus("Selected transfer method is ready.");
    }
    return armed;
  }

  async _armSend(generation, selection) {
    if (
      !selection.receiver ||
      !selection.prepared ||
      !selection.transport ||
      this._activeHandoff
    ) {
      if (generation === this._armGeneration) this._disableSend();
      return false;
    }
    let handoff = null;
    try {
      const { transport, receiver, prepared, portablePrepared } = selection;
      if (transport === OAB_TRANSPORTS.detachedDataChannel) {
        if (!this.detachedEnabled) {
          throw new OabError(
            "detached_sender_not_configured",
            "Host the fixed callback resource before enabling private transfer.",
          );
        }
        handoff = await createDetachedAnchorHandoff(
          receiver,
          prepared,
          {
            onActivationError: ({ error }) => {
              if (generation !== this._armGeneration) return;
              this._disableSend(false);
              this._showError(error);
            },
          },
        );
      } else if (transport === OAB_TRANSPORTS.linkEnvelope) {
        if (!portablePrepared) {
          throw new OabError(
            "portable_text_unavailable",
            "The current content has no Markdown or plain-text representation.",
          );
        }
        handoff = await createLinkAnchorHandoff(
          receiver,
          portablePrepared,
          {
            contentClassification: "non-confidential",
            onActivationError: ({ error }) => {
              if (generation !== this._armGeneration) return;
              this._disableSend(false);
              this._showError(error);
            },
          },
        );
      } else {
        throw new OabError(
          "transport_selection_required",
          "Select an advertised OAB transfer method.",
        );
      }
      if (
        generation !== this._armGeneration ||
        this._selectedTransport !== transport ||
        this._receiver !== receiver ||
        this._prepared !== prepared ||
        this._activeHandoff
      ) {
        handoff.close?.();
        return;
      }
      handoff.bind(this._sendLink);
      this._anchorHandoff = handoff;
      this._armedTransport = transport;
      this._armedOrigin = receiver.origin;
      this._armedReceiver = receiver;
      this._armedPrepared = prepared;
      this._sendLink.textContent = transport === OAB_TRANSPORTS.linkEnvelope
        ? "Send non-confidential text"
        : "Send privately";
      this._sendLink.setAttribute("aria-disabled", "false");
      this._sendLink.setAttribute("tabindex", "0");
      return true;
    } catch (error) {
      handoff?.close?.();
      if (generation === this._armGeneration) this._showError(error);
      return false;
    }
  }

  _disableSend(closeHandoff = true, invalidate = true) {
    if (!this._sendLink) return;
    if (invalidate) this._armGeneration += 1;
    if (closeHandoff) this._anchorHandoff?.close?.();
    this._anchorHandoff = null;
    this._armedTransport = null;
    this._armedOrigin = null;
    this._armedReceiver = null;
    this._armedPrepared = null;
    this._sendLink.removeAttribute("href");
    this._sendLink.removeAttribute("target");
    this._sendLink.removeAttribute("rel");
    this._sendLink.removeAttribute("referrerpolicy");
    this._sendLink.setAttribute("aria-disabled", "true");
    this._sendLink.setAttribute("tabindex", "-1");
    this._sendLink.textContent = "Send";
  }

  _activateSend(event) {
    if (
      !this._anchorHandoff ||
      this._activeHandoff ||
      this._armedTransport !== this._selectedTransport ||
      this._armedReceiver !== this._receiver ||
      this._armedPrepared !== this._prepared
    ) {
      event.preventDefault();
      return;
    }
    const active = this._anchorHandoff;
    const transport = this._armedTransport;
    const origin = this._armedOrigin;
    const application = this._armedReceiver?.application;
    let outcome;
    // Latch synchronously before entering the one-shot SDK capability. A host
    // event hook can re-enter this method during activation; without this
    // boundary the same trusted action can reach activate() twice.
    this._activeHandoff = true;
    this._activeHandoffController = active;
    try {
      outcome = active.activate(event);
    } catch (error) {
      this._activeHandoff = false;
      this._activeHandoffController = null;
      event.preventDefault();
      this._disableSend(false);
      this._showError(error);
      return;
    }
    this._contentPromise = null;
    this._pendingPreparedContent = null;
    this._setBusy(true);
    this._setStatus("Processing this Send action…");
    // Navigation has consumed the launch URL. Remove the UI handle without
    // closing a detached session that is waiting for its independent callback.
    setTimeout(() => this._disableSend(false), 0);
    void (async () => {
      try {
        const handoff = await outcome;
        if (this._remember.checked) {
          this._history.remember(
            origin,
            Date.now(),
            application,
          );
        } else {
          this._history.remove(origin);
        }
        this._renderDestinations();
        if (transport === OAB_TRANSPORTS.linkEnvelope) {
          this._setStatus(
            "Launch initiated (unconfirmed). Portable text links provide no delivery or open receipt.",
          );
          this._dispatch("oab-launched", {
            origin,
            requestId: active.requestId,
            transport,
            receiptAvailable: false,
          });
          return;
        }
        this._setStatus("The receiver is showing a transient preview.");
        this._dispatch("oab-previewing", {
          origin,
          requestId: active.requestId,
          transferId: handoff.transferId,
          transport,
        });
        const disposition = await handoff.completion;
        this._setStatus(
          disposition === "preserved"
            ? "The receiver preserved the shared content."
            : "The receiver discarded the shared content.",
        );
        this._dispatch("oab-result", {
          origin,
          requestId: active.requestId,
          transferId: handoff.transferId,
          transport,
          disposition,
        });
      } catch (error) {
        this._showError(error);
      } finally {
        if (this._activeHandoffController === active) {
          this._activeHandoffController = null;
        }
        active.close?.();
        this._activeHandoff = false;
        this._setBusy(false);
        if (this._dialog?.open && this._receiver?.isFresh && this._prepared) {
          void this._configureProfiles();
        }
        else this._clearVerified();
      }
    })();
  }

  _setStatus(message, error = false) {
    if (!this._status) return;
    this._status.textContent = message;
    this._status.setAttribute("role", error ? "alert" : "status");
    this._status.classList.toggle("error", error);
  }

  _showError(error) {
    const failure =
      error instanceof OabError
        ? error
        : new OabError(
            "share_failed",
            "The content could not be shared.",
            { cause: error },
          );
    this._setStatus(`${failure.code}: ${failure.message}`, true);
    this._dispatch("oab-error", {
      code: failure.code,
      message: failure.message,
      error: failure,
    });
  }

  _dispatch(type, detail) {
    const CustomEventCtor = this.ownerDocument?.defaultView?.CustomEvent;
    if (!CustomEventCtor) return;
    this.dispatchEvent(
      new CustomEventCtor(type, {
        bubbles: true,
        composed: true,
        detail: Object.freeze({ ...detail }),
      }),
    );
  }
}

export function defineOpenAppShareElement(
  registry = globalThis.customElements,
) {
  if (!registry?.define) return null;
  if (!registry.get(ELEMENT_NAME)) {
    registry.define(ELEMENT_NAME, OpenAppShareElement);
  }
  return registry.get(ELEMENT_NAME);
}

defineOpenAppShareElement();
