import { runDetachedSenderCallback } from "../../src/index.js";

export async function installSenderCallback(scrubbedHandoff = null) {
  const status = document.getElementById("status");
  const heading = document.getElementById("heading");
  try {
    return await runDetachedSenderCallback(window, {
      ...(scrubbedHandoff == null ? {} : { scrubbedHandoff }),
      closeWindow() {
        heading.textContent = "You can return to the sharing app";
        status.textContent =
          "The private preview is being prepared. If this tab stays open, return to the original app and close it with your browser controls.";
        setTimeout(() => window.close(), 50);
      },
    });
  } catch (error) {
    heading.textContent = "We couldn’t finish this share";
    status.textContent =
      "No shared content was returned. Go back to the original app and try again.";
    status.classList.add("error");
    return null;
  }
}

if (!globalThis.window?.__oabUtilityBootstrapActive) {
  await installSenderCallback();
}
