/* Parser-blocking scrub-first loader for the detached helper and callback. */
(() => {
  "use strict";
  const maximumFragmentBytes = 32 * 1024;
  const maximumUrlBytes = 64 * 1024;
  const maximumReferrerBytes = 2 * 1024;
  const encoder = new TextEncoder();
  const helper = location.pathname === "/examples/receiver/helper.html";
  const callback =
    location.pathname === "/.well-known/open-app-bridge/callback";
  if (!helper && !callback) return;

  let fragment = typeof location.hash === "string" ? location.hash : "";
  let href = null;
  let referrer = typeof document.referrer === "string" ? document.referrer : "";
  let withinBounds =
    fragment.length <= maximumFragmentBytes &&
    encoder.encode(fragment).byteLength <= maximumFragmentBytes &&
    referrer.length <= maximumReferrerBytes &&
    encoder.encode(referrer).byteLength <= maximumReferrerBytes;
  if (withinBounds) {
    href = location.href;
    withinBounds =
      href.length <= maximumUrlBytes &&
      encoder.encode(href).byteLength <= maximumUrlBytes;
  }
  let scrubbedHandoff = withinBounds
    ? Object.freeze({
        fragment,
        href,
        hadQuery: Boolean(location.search),
        referrer,
      })
    : null;
  history.replaceState(history.state ?? null, "", location.pathname || "/");
  if (location.hash || location.search) {
    location.replace(location.pathname || "/");
    return;
  }
  fragment = null;
  href = null;
  referrer = null;

  if (scrubbedHandoff == null) {
    const reportOversizedHandoff = () => {
      const status = document.getElementById("status");
      if (status) {
        status.textContent = "The private handoff exceeded its security limit.";
        status.classList.add("error");
      }
    };
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", reportOversizedHandoff, {
        once: true,
      });
    } else {
      reportOversizedHandoff();
    }
    return;
  }

  window.__oabUtilityBootstrapActive = true;
  let active = true;
  const abandon = () => {
    active = false;
    scrubbedHandoff = null;
    delete window.__oabUtilityBootstrapActive;
  };
  window.addEventListener("pagehide", abandon, { once: true });
  const moduleUrl = helper
    ? "/examples/receiver/helper.js"
    : "/examples/sender/callback.js";
  import(moduleUrl).then((module) => {
    if (!active) return;
    const captured = scrubbedHandoff;
    // Transfer the one-time capture to the SDK and immediately release the
    // bootstrap closure's copy. Do not retain it until the asynchronous
    // helper/callback lifecycle settles.
    scrubbedHandoff = null;
    if (helper) return module.installReceiverHelper(captured);
    return module.installSenderCallback(captured);
  }).catch(() => {
    const status = document.getElementById("status");
    if (status) {
      status.textContent = "The private handoff could not be initialized.";
      status.classList.add("error");
    }
  }).finally(() => {
    // Also clear on import or synchronous installation failure.
    scrubbedHandoff = null;
    window.removeEventListener("pagehide", abandon);
    delete window.__oabUtilityBootstrapActive;
  });
})();
