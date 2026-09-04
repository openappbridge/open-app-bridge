import { runDetachedReceiverHelper } from "../../src/index.js";

export function installReceiverHelper(scrubbedHandoff = null) {
  const status = document.getElementById("status");
  const heading = document.getElementById("heading");
  const actions = document.getElementById("fallback-actions");
  try {
    return runDetachedReceiverHelper(window, {
      ...(scrubbedHandoff == null ? {} : { scrubbedHandoff }),
      onNavigationFallback({ href, senderOrigin }) {
        heading.textContent = "Continue to finish preparing the preview";
        status.textContent =
          `Your approved preview is ready. Continue to return to ${senderOrigin}.`;
        const link = document.createElement("a");
        link.className = "action-button";
        link.href = href;
        link.target = "_self";
        link.rel = "noopener";
        link.referrerPolicy = "origin";
        link.textContent = "Continue";
        actions.replaceChildren(link);
        link.focus({ preventScroll: true });
        return true;
      },
    });
  } catch (error) {
    heading.textContent = "We couldn’t continue this share";
    status.textContent =
      "No content was opened or saved. Return to the receiver and try again.";
    status.classList.add("error");
    return null;
  }
}

if (!globalThis.window?.__oabUtilityBootstrapActive) {
  installReceiverHelper();
}
