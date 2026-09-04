import {
  OAB_TRANSPORTS,
  createHandoff,
  discoverReceiver,
  inspectProfileAvailability,
  prepareContent,
  receiverInputToOrigin,
} from "../../src/index.js";

const byId = (id) => document.getElementById(id);
const originInput = byId("origin");
const titleInput = byId("title");
const markdownInput = byId("markdown");
const assetsInput = byId("assets");
const checkButton = byId("check");
const favoriteButton = byId("favorite");
const sendLink = byId("send");
const clearButton = byId("clear");
const declarationOutput = byId("declaration");
const profiles = byId("profiles");
const detachedRadio = byId("detached");
const linkRadio = byId("link");
const statusOutput = byId("status");

let receiver = null;
let prepared = null;
let handoff = null;
let generation = 0;

function setStatus(message, error = false) {
  statusOutput.textContent = message;
  statusOutput.classList.toggle("error", error);
}

function selectedTransport() {
  return document.querySelector('input[name="profile"]:checked')?.value ?? null;
}

function portableContent() {
  if (!prepared || prepared.assets.length > 0) return null;
  return prepareContent({
    title: prepared.title,
    markdown: prepared.representations["text/markdown"],
    text: prepared.representations["text/plain"],
    sourceApplication: prepared.sourceApplication,
    sourceUrl: prepared.sourceUrl,
  }, {
    representations: ["text/markdown", "text/plain"],
    assetTypes: [],
    maximumAssets: 0,
  });
}

function prepareCurrentContent() {
  prepared = prepareContent({
    title: titleInput.value,
    markdown: markdownInput.value,
    text: markdownInput.value,
    assets: Array.from(assetsInput.files || []),
    sourceApplication: "OAB sender example",
    sourceUrl: document.location.href,
  });
}

function disableSend(closeHandoff = true) {
  if (closeHandoff) handoff?.close?.();
  handoff = null;
  sendLink.removeAttribute("href");
  sendLink.removeAttribute("target");
  sendLink.removeAttribute("rel");
  sendLink.removeAttribute("referrerpolicy");
  sendLink.setAttribute("aria-disabled", "true");
}

async function configureHandoff() {
  const current = ++generation;
  disableSend();
  const transport = selectedTransport();
  if (!receiver || !prepared || !transport || !receiver.isFresh) return;
  const content = transport === OAB_TRANSPORTS.linkEnvelope
    ? portableContent()
    : prepared;
  if (!content) {
    setStatus("Portable links cannot include assets.", true);
    return;
  }
  try {
    const next = await createHandoff(receiver, content, {
      transport,
      contentClassification:
        transport === OAB_TRANSPORTS.linkEnvelope
          ? "non-confidential"
          : undefined,
      onActivationError({ error }) {
        disableSend(false);
        setStatus(`${error.code ?? "handoff_failed"}: ${error.message}`, true);
      },
    });
    if (current !== generation) {
      next.close?.();
      return;
    }
    handoff = next;
    handoff.bind(sendLink);
    sendLink.textContent = transport === OAB_TRANSPORTS.linkEnvelope
      ? "Send non-confidential text"
      : "Send privately";
    sendLink.setAttribute("aria-disabled", "false");
    setStatus("Ready. Send remains a separate user action.");
  } catch (error) {
    setStatus(`${error.code ?? "handoff_failed"}: ${error.message}`, true);
  }
}

function invalidateReceiver() {
  generation += 1;
  receiver = null;
  profiles.disabled = true;
  favoriteButton.disabled = true;
  declarationOutput.classList.add("hidden");
  disableSend();
}

originInput.addEventListener("input", invalidateReceiver);
for (const input of [titleInput, markdownInput, assetsInput]) {
  input.addEventListener("input", () => {
    try {
      prepareCurrentContent();
      void configureHandoff();
    } catch (error) {
      prepared = null;
      disableSend();
      setStatus(`${error.code ?? "content_failed"}: ${error.message}`, true);
    }
  });
}
for (const radio of [detachedRadio, linkRadio]) {
  radio.addEventListener("change", () => void configureHandoff());
}

checkButton.addEventListener("click", async () => {
  invalidateReceiver();
  const current = generation;
  setStatus("Checking the receiver's bounded JSON declaration…");
  try {
    prepareCurrentContent();
    const requestedOrigin = receiverInputToOrigin(originInput.value);
    const discovered = await discoverReceiver(requestedOrigin);
    if (current !== generation) return;
    receiver = discovered;
    const detached = inspectProfileAvailability(discovered, prepared)[
      OAB_TRANSPORTS.detachedDataChannel
    ];
    const portable = portableContent();
    const link = portable
      ? inspectProfileAvailability(discovered, portable)[OAB_TRANSPORTS.linkEnvelope]
      : { compatible: false };
    detachedRadio.disabled = !detached.compatible;
    linkRadio.disabled = !link.compatible;
    profiles.disabled = false;
    if (detached.compatible) detachedRadio.checked = true;
    else if (link.compatible) linkRadio.checked = true;
    else throw new Error("No advertised profile accepts this content.");
    favoriteButton.disabled = false;
    declarationOutput.textContent =
      `Verified receiver ${discovered.origin} · profiles: ${discovered.transportIds.join(", ")}`;
    declarationOutput.classList.remove("hidden");
    await configureHandoff();
  } catch (error) {
    if (current !== generation) return;
    invalidateReceiver();
    setStatus(`${error.code ?? "check_failed"}: ${error.message}`, true);
  }
});

sendLink.addEventListener("click", (event) => {
  if (!handoff) {
    event.preventDefault();
    return;
  }
  const active = handoff;
  const transport = selectedTransport();
  let result;
  try {
    result = active.activate(event);
  } catch (error) {
    event.preventDefault();
    disableSend(false);
    setStatus(`${error.code ?? "activation_failed"}: ${error.message}`, true);
    return;
  }
  // Let the trusted anchor activation commit its navigation before removing
  // the one-shot DOM capability.
  setTimeout(() => {
    disableSend(false);
    if (transport === OAB_TRANSPORTS.linkEnvelope) {
      void configureHandoff();
    }
  }, 0);
  if (transport === OAB_TRANSPORTS.linkEnvelope) {
    void Promise.resolve(result).then(() => {
      setStatus(
        "Launch initiated (unconfirmed). This profile provides no delivery or open receipt.",
      );
    }).catch((error) => {
      setStatus(`${error.code ?? "activation_failed"}: ${error.message}`, true);
    });
    return;
  }
  setStatus("Processing this Send action…");
  void Promise.resolve(result).then(async (preview) => {
    setStatus("Receiver is showing a transient preview.");
    const disposition = await preview.completion;
    setStatus(`Receiver ${disposition} the content.`);
  }).catch((error) => {
    setStatus(`${error.code ?? "transfer_failed"}: ${error.message}`, true);
  }).finally(() => {
    void configureHandoff();
  });
});

favoriteButton.addEventListener("click", () => {
  if (!receiver) return;
  const values = JSON.parse(localStorage.getItem("oab-example-favorites") || "[]");
  localStorage.setItem(
    "oab-example-favorites",
    JSON.stringify([...new Set([receiver.origin, ...values])].slice(0, 20)),
  );
  setStatus("Receiver saved locally in this browser.");
});

clearButton.addEventListener("click", () => {
  localStorage.removeItem("oab-example-favorites");
  setStatus("Local receiver history cleared.");
});

prepareCurrentContent();
setStatus("Check a receiver to begin.");
