import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";

const senderUrl = "http://localhost:18080/examples/sender/";
const widgetUrl = "http://localhost:18080/examples/widget/";
const receiverDomain = "127.0.0.1:18081";
const receiverOrigin = `http://${receiverDomain}`;
const hostileText = JSON.parse(
  readFileSync("tests/fixtures/active-content-attacks.json", "utf8"),
).map((entry) => entry.html).join("\n");

test("production widget bundle registers and integrity-pins its stylesheet", async ({ page }) => {
  await page.goto(senderUrl);
  const result = await page.evaluate(async () => {
    await import("/dist/oab-widget.min.js");
    await customElements.whenDefined("oab-share");
    const widget = document.createElement("oab-share");
    document.body.append(widget);
    const stylesheet = widget.shadowRoot.querySelector('link[rel="stylesheet"]');
    return {
      registered: customElements.get("oab-share") === widget.constructor,
      href: stylesheet?.href,
      integrity: stylesheet?.integrity,
      crossOrigin: stylesheet?.crossOrigin,
    };
  });
  expect(result.registered).toBe(true);
  expect(result.href).toBe("http://localhost:18080/dist/oab-widget.css");
  expect(result.integrity).toMatch(/^sha384-[A-Za-z0-9+/]+=*$/u);
  expect(result.crossOrigin).toBe("anonymous");
});

async function configurePortableSender(page, markdown = "Portable text") {
  await page.goto(senderUrl);
  await page.getByRole("textbox", { name: "Receiver domain" })
    .fill(receiverDomain);
  await page.getByRole("textbox", { name: "Markdown" }).fill(markdown);
  await page.getByRole("button", { name: "Check receiver" }).click();
  await expect(page.getByText(/Verified receiver/)).toContainText(receiverOrigin);
  await page.getByRole("radio", { name: /Portable text link/ }).check();
  const send = page.getByRole("link", {
    name: "Send non-confidential text",
  });
  await expect(send).toBeVisible();
  return send;
}

async function configurePrivateSender(page, markdown = "Private text") {
  await page.goto(senderUrl);
  await page.getByRole("textbox", { name: "Receiver domain" })
    .fill(receiverDomain);
  await page.getByRole("textbox", { name: "Markdown" }).fill(markdown);
  await page.getByRole("button", { name: "Check receiver" }).click();
  await expect(page.getByText(/Verified receiver/)).toContainText(receiverOrigin);
  await page.getByRole("radio", { name: /Private peer channel/ }).check();
  const send = page.getByRole("link", { name: "Send privately" });
  await expect(send).toBeVisible();
  return send;
}

test("widget verifies a distinct receiver origin and restores accessible focus", async ({ page }) => {
  await page.goto(widgetUrl);
  const trigger = page.getByRole("button", { name: "Share with another app" });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "Share to an app" });
  await expect(dialog).toBeVisible();
  await expect(trigger).toHaveAttribute("aria-expanded", "true");

  await dialog.getByRole("textbox", { name: "Receiver domain (no https://)" })
    .fill(receiverDomain);
  await dialog.getByRole("button", { name: "Check" }).click();
  await expect(dialog.getByRole("heading", { name: "OAB Receiver" }))
    .toBeVisible();
  await dialog.getByRole("radio", { name: /Portable text link/ }).check();
  const send = dialog.getByRole("link", {
    name: "Send non-confidential text",
  });
  await expect(send).toHaveAttribute("target", "_blank");
  await expect(send).toHaveAttribute("rel", "noopener noreferrer");
  await expect(send).toHaveAttribute("referrerpolicy", "no-referrer");
  const launchUrl = new URL(await send.getAttribute("href"));
  expect(launchUrl.origin).toBe(receiverOrigin);
  expect(decodeURIComponent(launchUrl.hash)).toMatch(/oab-link=1/);
  await page.waitForTimeout(750);
  await expect(dialog.getByRole("radio", { name: /Portable text link/ }))
    .toBeChecked();
  await expect(send).toHaveAttribute("href", /#oab-link=1&/u);

  await dialog.getByRole("button", { name: "Close sharing" }).click();
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
});

test("widget portable launch is task-delayed and creates one real receiver request", async ({ context, page }) => {
  await page.goto(widgetUrl);
  await page.getByRole("button", { name: "Share with another app" }).click();
  const dialog = page.getByRole("dialog", { name: "Share to an app" });
  await dialog.getByRole("textbox", { name: "Receiver domain (no https://)" })
    .fill(receiverDomain);
  await dialog.getByRole("button", { name: "Check" }).click();
  await expect(dialog.getByRole("heading", { name: "OAB Receiver" }))
    .toBeVisible();
  await dialog.getByRole("radio", { name: /Portable text link/ }).check();
  const send = dialog.getByRole("link", {
    name: "Send non-confidential text",
  });
  const preparedWidgetHref = await send.getAttribute("href");

  await page.evaluate(() => {
    const widget = document.querySelector("oab-share");
    window.__oabLaunchAudit = {
      phase: "armed",
      clickTrusted: null,
      preparedHref: null,
      launchEvents: [],
      forbiddenEvents: [],
    };
    document.addEventListener("click", (event) => {
      const anchor = event.composedPath().find(
        (node) => node?.textContent === "Send non-confidential text",
      );
      if (anchor) {
        window.__oabLaunchAudit.clickTrusted = event.isTrusted;
        window.__oabLaunchAudit.preparedHref = anchor.href;
        window.__oabLaunchAudit.phase = "click";
        queueMicrotask(() => {
          window.__oabLaunchAudit.phase = "microtask";
        });
        setTimeout(() => {
          window.__oabLaunchAudit.phase = "later-task";
        }, 0);
      }
    }, { capture: true, once: true });
    widget.addEventListener("oab-launched", (event) => {
      window.__oabLaunchAudit.launchEvents.push({
        phase: window.__oabLaunchAudit.phase,
        detail: { ...event.detail },
      });
      // A host is permitted to tear down its share surface as soon as this
      // indication arrives. Navigation must already be safe from that action.
      widget.remove();
    }, { once: true });
    for (const type of ["oab-previewing", "oab-result"]) {
      widget.addEventListener(type, () => {
        window.__oabLaunchAudit.forbiddenEvents.push(type);
      });
    }
  });

  const endpointResponses = [];
  const launchedPages = [];
  const observePage = (openedPage) => launchedPages.push(openedPage);
  context.on("page", observePage);
  context.on("response", (response) => {
    const request = response.request();
    let requestUrl;
    try {
      requestUrl = new URL(request.url());
    } catch (_) {
      return;
    }
    if (
      request.isNavigationRequest() &&
      request.resourceType() === "document" &&
      response.status() === 200 &&
      requestUrl.origin === receiverOrigin
    ) {
      endpointResponses.push(response);
    }
  });
  const pageCountBeforeLaunch = context.pages().length;
  const receiverPagePromise = context.waitForEvent("page");
  const endpointResponsePromise = context.waitForEvent("response", (response) =>
    response.status() === 200 &&
    response.request().isNavigationRequest() &&
    response.request().resourceType() === "document" &&
    response.url() === `${receiverOrigin}/examples/receiver/index.html`
  );
  await send.click();
  const [receiverPage, endpointResponse] = await Promise.all([
    receiverPagePromise,
    endpointResponsePromise,
  ]);
  const endpointRequest = endpointResponse.request();
  expect(endpointRequest.url()).toBe(
    `${receiverOrigin}/examples/receiver/index.html`,
  );
  await receiverPage.waitForLoadState("domcontentloaded");
  await expect(
    receiverPage.getByRole("dialog", { name: "Review shared text?" }),
  ).toBeVisible();
  await expect.poll(() => context.pages().length).toBe(pageCountBeforeLaunch + 1);
  await page.waitForTimeout(100);
  // WebKit can emit an aborted COOP provisional request before the one
  // committed navigation. Count successful document responses, together with
  // the exact target and trusted-click evidence, rather than raw request events.
  expect(endpointResponses).toHaveLength(1);
  for (const response of endpointResponses) {
    const request = response.request();
    const requestUrl = new URL(request.url());
    expect(requestUrl.pathname).toBe("/examples/receiver/index.html");
    expect(requestUrl.search).toBe("");
    expect(request.frame().page()).toBe(receiverPage);
  }
  expect(await receiverPage.evaluate(() => ({
    opener: window.opener,
    referrer: document.referrer,
    hash: location.hash,
  }))).toEqual({ opener: null, referrer: "", hash: "" });
  await expect.poll(() => page.evaluate(() =>
    window.__oabLaunchAudit?.launchEvents.length ?? 0
  )).toBe(1);
  const launchAudit = await page.evaluate(() => window.__oabLaunchAudit);
  expect(launchAudit).toEqual({
    phase: "later-task",
    clickTrusted: true,
    preparedHref: preparedWidgetHref,
    launchEvents: [{
      phase: "later-task",
      detail: {
        origin: receiverOrigin,
        requestId: expect.any(String),
        transport: "link-envelope/1",
        receiptAvailable: false,
      },
    }],
    forbiddenEvents: [],
  });
  await page.waitForTimeout(50);
  expect(launchedPages).toEqual([receiverPage]);
  context.off("page", observePage);
  expect(launchAudit.launchEvents[0].detail.requestId).toMatch(
    /^[A-Za-z0-9_-]{22,128}$/u,
  );
});

test("native portable launch is opener-free, referrer-free, and reusable", async ({ context, page }) => {
  const send = await configurePortableSender(page);
  await expect(send).toHaveAttribute("rel", "noopener noreferrer");
  const receiverPagePromise = context.waitForEvent("page");
  await send.click();
  const receiverPage = await receiverPagePromise;
  await receiverPage.waitForLoadState("domcontentloaded");
  await expect(
    receiverPage.getByRole("dialog", { name: "Review shared text?" }),
  ).toBeVisible();
  expect(await receiverPage.evaluate(() => ({
    opener: window.opener,
    referrer: document.referrer,
    hash: location.hash,
  }))).toEqual({ opener: null, referrer: "", hash: "" });
  await expect(page.getByRole("link", {
    name: "Send non-confidential text",
  })).toBeVisible();
});

test("armed anchors reject middle-click, context-menu, and drag bypasses", async ({ context, page }) => {
  const unexpectedTargets = [];
  const observeTarget = (openedPage) => unexpectedTargets.push(openedPage);
  context.on("page", observeTarget);

  let send = await configurePortableSender(page, "Guarded middle click");
  await send.click({ button: "middle", noWaitAfter: true });
  await page.waitForTimeout(100);
  expect(unexpectedTargets).toEqual([]);
  await expect(page.locator("#send")).not.toHaveAttribute("href");

  send = await configurePortableSender(page, "Guarded context menu");
  await send.click({ button: "right", noWaitAfter: true });
  await page.waitForTimeout(100);
  expect(unexpectedTargets).toEqual([]);
  await expect(page.locator("#send")).not.toHaveAttribute("href");

  send = await configurePortableSender(page, "Guarded drag");
  expect(await send.evaluate((anchor) => {
    const event = new Event("dragstart", { bubbles: true, cancelable: true });
    anchor.dispatchEvent(event);
    return event.defaultPrevented;
  })).toBe(true);
  await expect(page.locator("#send")).not.toHaveAttribute("href");

  send = await configurePortableSender(page, "Valid primary click");
  const receiverPagePromise = context.waitForEvent("page");
  await send.click();
  const receiverPage = await receiverPagePromise;
  await receiverPage.waitForLoadState("domcontentloaded");
  await expect(
    receiverPage.getByRole("dialog", { name: "Review shared text?" }),
  ).toBeVisible();
  expect(unexpectedTargets).toEqual([receiverPage]);
  context.off("page", observeTarget);
});

test("detached launches reach the endpoint, helper, and callback in one target each", async ({ context, page, browserName }) => {
  const send = await configurePrivateSender(page, "# Private browser evidence");
  const sendElement = page.locator("#send");
  const preparedSenderHref = await send.getAttribute("href");
  expect(new URL(preparedSenderHref).origin).toBe(receiverOrigin);
  expect(decodeURIComponent(new URL(preparedSenderHref).hash)).toMatch(
    /oab-detached=1/,
  );

  await page.evaluate(() => {
    window.__detachedSenderLaunchAudit = {
      phase: "armed",
      clickTrusted: null,
      preparedHref: null,
      microtaskHref: null,
      laterTaskHref: null,
      hostTeardownPhase: null,
    };
    document.addEventListener("click", (event) => {
      const anchor = event.composedPath().find(
        (node) => node?.textContent === "Send privately",
      );
      if (!anchor) return;
      window.__detachedSenderLaunchAudit.clickTrusted = event.isTrusted;
      window.__detachedSenderLaunchAudit.preparedHref = anchor.href;
      window.__detachedSenderLaunchAudit.phase = "click";
      queueMicrotask(() => {
        window.__detachedSenderLaunchAudit.phase = "microtask";
        window.__detachedSenderLaunchAudit.microtaskHref =
          anchor.hasAttribute("href");
      });
      setTimeout(() => {
        window.__detachedSenderLaunchAudit.phase = "later-task";
        window.__detachedSenderLaunchAudit.laterTaskHref =
          anchor.hasAttribute("href");
        window.__detachedSenderLaunchAudit.hostTeardownPhase =
          window.__detachedSenderLaunchAudit.phase;
        anchor.closest("section")?.remove();
      }, 0);
    }, { capture: true, once: true });
  });

  const pageCountBeforeSenderLaunch = context.pages().length;
  const detachedTargets = [];
  const endpointResponses = [];
  const helperResponses = [];
  const callbackResponses = [];
  const observeDetachedTarget = (openedPage) => detachedTargets.push(openedPage);
  const observeDetachedResponse = (response) => {
    const request = response.request();
    if (!request.isNavigationRequest() || request.resourceType() !== "document") {
      return;
    }
    if (response.status() !== 200) return;
    if (request.url() === `${receiverOrigin}/examples/receiver/index.html`) {
      endpointResponses.push(response);
    } else if (
      request.url() === `${receiverOrigin}/examples/receiver/helper.html`
    ) {
      helperResponses.push(response);
    } else if (
      request.url() ===
      "http://localhost:18080/.well-known/open-app-bridge/callback"
    ) {
      callbackResponses.push(response);
    }
  };
  context.on("page", observeDetachedTarget);
  context.on("response", observeDetachedResponse);
  const receiverPagePromise = context.waitForEvent("page");
  const endpointResponsePromise = context.waitForEvent("response", (response) =>
    response.status() === 200 &&
    response.request().isNavigationRequest() &&
    response.request().resourceType() === "document" &&
    response.url() === `${receiverOrigin}/examples/receiver/index.html`
  );
  await send.click();
  const [receiverPage, endpointResponse] = await Promise.all([
    receiverPagePromise,
    endpointResponsePromise,
  ]);
  const endpointRequest = endpointResponse.request();
  expect(endpointRequest.frame().page()).toBe(receiverPage);
  await receiverPage.waitForLoadState("domcontentloaded");
  await expect.poll(() => context.pages().length).toBe(
    pageCountBeforeSenderLaunch + 1,
  );
  await page.waitForTimeout(100);
  expect(endpointResponses).toHaveLength(1);
  expect(await page.evaluate(() => window.__detachedSenderLaunchAudit)).toEqual({
    phase: "later-task",
    clickTrusted: true,
    preparedHref: preparedSenderHref,
    microtaskHref: true,
    laterTaskHref: true,
    hostTeardownPhase: "later-task",
  });
  expect(new URL(preparedSenderHref).origin + new URL(preparedSenderHref).pathname)
    .toBe(endpointRequest.url());
  await expect(sendElement).toHaveCount(0);
  expect(await receiverPage.evaluate(() => ({
    opener: window.opener,
    referrer: document.referrer,
    hash: location.hash,
    search: location.search,
  }))).toEqual({ opener: null, referrer: "", hash: "", search: "" });

  const verify = receiverPage.getByRole("link", {
    name: "Review shared content",
  });
  const verifyElement = receiverPage.locator("#verify");
  await expect(verify).toBeVisible();
  const preparedVerifyHref = await verify.getAttribute("href");
  expect(new URL(preparedVerifyHref).href).toMatch(
    new RegExp(
      `^${receiverOrigin.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}` +
      "/examples/receiver/helper\\.html#oab-detached-helper=1&",
      "u",
    ),
  );
  await receiverPage.evaluate(() => {
    window.__detachedVerifyLaunchAudit = {
      phase: "armed",
      clickTrusted: null,
      preparedHref: null,
      microtaskHref: null,
      laterTaskHref: null,
      hostTeardownPhase: null,
    };
    document.addEventListener("click", (event) => {
      const anchor = event.composedPath().find(
        (node) => node?.textContent === "Review shared content",
      );
      if (!anchor) return;
      window.__detachedVerifyLaunchAudit.clickTrusted = event.isTrusted;
      window.__detachedVerifyLaunchAudit.preparedHref = anchor.href;
      window.__detachedVerifyLaunchAudit.phase = "click";
      queueMicrotask(() => {
        window.__detachedVerifyLaunchAudit.phase = "microtask";
        window.__detachedVerifyLaunchAudit.microtaskHref =
          anchor.hasAttribute("href");
      });
      setTimeout(() => {
        window.__detachedVerifyLaunchAudit.phase = "later-task";
        window.__detachedVerifyLaunchAudit.laterTaskHref =
          anchor.hasAttribute("href");
        window.__detachedVerifyLaunchAudit.hostTeardownPhase =
          window.__detachedVerifyLaunchAudit.phase;
        anchor.closest("section")?.remove();
      }, 0);
    }, { capture: true, once: true });
  });

  const pageCountBeforeVerify = context.pages().length;
  const helperPagePromise = context.waitForEvent("page");
  const helperResponsePromise = context.waitForEvent("response", (response) =>
    response.status() === 200 &&
    response.request().isNavigationRequest() &&
    response.request().resourceType() === "document" &&
    response.url() === `${receiverOrigin}/examples/receiver/helper.html`
  );
  const callbackResponsePromise = context.waitForEvent("response", (response) =>
    response.status() === 200 &&
    response.request().isNavigationRequest() &&
    response.request().resourceType() === "document" &&
    response.url() ===
      "http://localhost:18080/.well-known/open-app-bridge/callback"
  );
  await verify.click();
  const [helperPage, helperResponse] = await Promise.all([
    helperPagePromise,
    helperResponsePromise,
  ]);
  const helperRequest = helperResponse.request();
  expect(helperRequest.frame().page()).toBe(helperPage);
  await expect.poll(() => receiverPage.evaluate(() =>
    window.__detachedVerifyLaunchAudit.microtaskHref
  )).toBe(true);
  expect(await receiverPage.evaluate(() =>
    window.__detachedVerifyLaunchAudit
  )).toEqual({
    phase: "later-task",
    clickTrusted: true,
    preparedHref: preparedVerifyHref,
    microtaskHref: true,
    laterTaskHref: true,
    hostTeardownPhase: "later-task",
  });
  expect(new URL(preparedVerifyHref).origin + new URL(preparedVerifyHref).pathname)
    .toBe(helperRequest.url());
  await expect(verifyElement).toHaveCount(0);
  const callbackResponse = await callbackResponsePromise;
  const callbackRequest = callbackResponse.request();
  expect(callbackRequest.frame().page()).toBe(helperPage);
  expect(callbackRequest.headers().referer).toBe(`${receiverOrigin}/`);
  await page.waitForTimeout(100);
  expect(endpointResponses).toHaveLength(1);
  expect(helperResponses).toHaveLength(1);
  expect(callbackResponses).toHaveLength(1);
  expect(context.pages().length).toBeLessThanOrEqual(pageCountBeforeVerify + 1);
  expect(detachedTargets).toEqual([receiverPage, helperPage]);
  context.off("page", observeDetachedTarget);
  context.off("response", observeDetachedResponse);

  // Playwright's headless WebKit build on Linux (WebKitGTK) lacks loopback
  // WebRTC host DataChannel connectivity in container CI environments.
  // The launch topology (endpoint, helper, callback in one target each) has
  // been verified above.
  if (browserName === "webkit" && process.platform === "linux") {
    return;
  }

  await expect(receiverPage.getByRole("heading", { name: "Preview shared content" }))
    .toBeVisible();
  await receiverPage.getByRole("button", { name: "Discard" }).click();
  await expect(receiverPage).toHaveURL(
    `${receiverOrigin}/examples/receiver/app/index.html`,
  );
});

test("detached sender and receiver Verify consume alternate activations", async ({ context, page }) => {
  const openedPages = [];
  const protocolDocuments = [];
  const observePage = (openedPage) => openedPages.push(openedPage);
  const observeResponse = (response) => {
    const request = response.request();
    if (!request.isNavigationRequest() || request.resourceType() !== "document") {
      return;
    }
    if (response.status() !== 200) return;
    const url = new URL(request.url());
    if (
      url.pathname === "/examples/receiver/index.html" ||
      url.pathname === "/examples/receiver/helper.html" ||
      url.pathname === "/.well-known/open-app-bridge/callback"
    ) {
      protocolDocuments.push(request.url());
    }
  };
  context.on("page", observePage);
  context.on("response", observeResponse);

  let send = await configurePrivateSender(page, "Guarded private transfer");
  await send.click({ button: "middle", noWaitAfter: true });
  await page.waitForTimeout(100);
  expect(openedPages).toEqual([]);
  expect(protocolDocuments).toEqual([]);
  await expect(page.locator("#send")).not.toHaveAttribute("href");

  send = await configurePrivateSender(page, "Guarded receiver Verify");
  const receiverPagePromise = context.waitForEvent("page");
  await send.click();
  const receiverPage = await receiverPagePromise;
  await receiverPage.waitForLoadState("domcontentloaded");
  const verify = receiverPage.getByRole("link", {
    name: "Review shared content",
  });
  await expect(verify).toBeVisible();
  expect(openedPages).toEqual([receiverPage]);
  expect(protocolDocuments).toEqual([
    `${receiverOrigin}/examples/receiver/index.html`,
  ]);

  await verify.click({ button: "middle", noWaitAfter: true });
  await receiverPage.waitForTimeout(100);
  expect(openedPages).toEqual([receiverPage]);
  expect(protocolDocuments).toEqual([
    `${receiverOrigin}/examples/receiver/index.html`,
  ]);
  await expect(receiverPage.locator("#verify")).not.toHaveAttribute("href");
  await expect(receiverPage.locator("#waiting")).toContainText(
    "Nothing was saved",
  );
  await expect(receiverPage.locator("#waiting")).toHaveAttribute(
    "data-technical-code",
    "unsafe_handoff_anchor",
  );
  await expect(receiverPage.getByText(/unsafe_handoff_anchor/u)).toHaveCount(0);

  context.off("page", observePage);
  context.off("response", observeResponse);
});

test("receiver scrubs its launch before a held stylesheet can load", async ({ context, page }) => {
  const send = await configurePortableSender(page);
  const launch = new URL(await send.getAttribute("href"));
  launch.search = "?must-be-scrubbed=1";

  let releaseCss;
  const cssRelease = new Promise((resolve) => {
    releaseCss = resolve;
  });
  let observeCss;
  const cssObserved = new Promise((resolve) => {
    observeCss = resolve;
  });
  await context.route(
    `${receiverOrigin}/examples/shared.css`,
    async (route) => {
      observeCss();
      await cssRelease;
      await route.continue();
    },
  );

  const receiverPage = await context.newPage();
  const navigation = receiverPage.goto(launch.href).catch(() => null);
  await cssObserved;
  expect(await receiverPage.evaluate(() => ({
    hash: location.hash,
    search: location.search,
  }))).toEqual({ hash: "", search: "" });
  await expect.poll(() => receiverPage.url()).toBe(
    `${receiverOrigin}/examples/receiver/index.html`,
  );
  releaseCss();
  await navigation;
  await context.unroute(`${receiverOrigin}/examples/shared.css`);
});

test("Preserve leaves the restricted document through a clean full navigation", async ({ context, page }) => {
  const markdown = "# Durable receiver-owned example";
  const send = await configurePortableSender(page, markdown);
  const receiverRequests = [];
  const receiverPage = await context.newPage();
  receiverPage.on("request", (request) => {
    receiverRequests.push(new URL(request.url()));
  });
  await receiverPage.goto(await send.getAttribute("href"));
  await receiverPage.getByRole("button", { name: "Review once" }).click();
  await expect(receiverPage.getByRole("heading", {
    name: "Preview shared content",
  })).toBeVisible();
  await receiverPage.evaluate(() => {
    window.__restrictedDocumentSentinel = true;
  });
  expect(await receiverPage.evaluate(async () => ({
    controlled: navigator.serviceWorker?.controller != null,
    registrations: navigator.serviceWorker
      ? (await navigator.serviceWorker.getRegistrations()).length
      : 0,
  }))).toEqual({ controlled: false, registrations: 0 });

  await receiverPage.getByRole("button", { name: "Save" }).click();
  await expect(receiverPage).toHaveURL(new RegExp(
    `^${receiverOrigin.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}` +
    "/examples/receiver/app/document/[A-Za-z0-9_-]{16,128}$",
    "u",
  ));
  expect(await receiverPage.evaluate(() => ({
    hash: location.hash,
    search: location.search,
    retainedRestrictedDocument:
      Object.prototype.hasOwnProperty.call(window, "__restrictedDocumentSentinel"),
  }))).toEqual({
    hash: "",
    search: "",
    retainedRestrictedDocument: false,
  });
  await expect(receiverPage.getByRole("heading", {
    name: "Portable research note",
  })).toBeVisible();
  await expect(receiverPage.locator("#document-text")).toHaveText(markdown);
  expect(await receiverPage.evaluate(async () => ({
    controlled: navigator.serviceWorker?.controller != null,
    registrations: navigator.serviceWorker
      ? (await navigator.serviceWorker.getRegistrations()).length
      : 0,
  }))).toEqual({ controlled: false, registrations: 0 });
  for (const requestUrl of receiverRequests) {
    expect(requestUrl.origin).toBe(receiverOrigin);
    expect(requestUrl.search).toBe("");
    expect(requestUrl.pathname).toMatch(
      /^(?:\/\.well-known\/open-app-bridge|\/src\/[A-Za-z0-9._/-]+\.js|\/examples\/shared\.css|\/examples\/receiver\/[A-Za-z0-9._/-]+)$/u,
    );
  }
});

test("the active-content corpus remains transient inert text", async ({ context, page }) => {
  const outboundRequests = [];
  context.on("request", (request) => {
    if (request.url().includes("track.invalid")) outboundRequests.push(request.url());
  });
  const send = await configurePortableSender(page, hostileText);
  const href = await send.getAttribute("href");
  const receiverPage = await context.newPage();
  await receiverPage.goto(href);
  await expect(
    receiverPage.getByRole("button", { name: "Review once" }),
  ).toBeVisible();
  expect(receiverPage.url()).toBe(
    `${receiverOrigin}/examples/receiver/index.html`,
  );
  await receiverPage.getByRole("button", { name: "Review once" }).click();
  await expect(receiverPage.getByRole("heading", {
    name: "Preview shared content",
  })).toBeVisible();

  const previewState = await receiverPage.locator("#preview").evaluate((preview) => ({
    injectedElements: preview.querySelectorAll(
      "script,img,a,style,form,input,iframe,svg,math,meta,base,evil-widget",
    ).length,
    pwned: Object.prototype.hasOwnProperty.call(window, "pwned"),
    text: preview.querySelector("#preview-text")?.textContent,
  }));
  expect(previewState).toEqual({
    injectedElements: 0,
    pwned: false,
    text: hostileText,
  });
  expect(outboundRequests).toEqual([]);

  const durableCount = await receiverPage.evaluate(() => new Promise((resolve, reject) => {
    const request = indexedDB.open("oab-receiver-bridge-example", 2);
    request.addEventListener("error", () => reject(request.error));
    request.addEventListener("upgradeneeded", () => {
      if (!request.result.objectStoreNames.contains("documents")) {
        request.result.createObjectStore("documents", { keyPath: "batchId" });
      }
    });
    request.addEventListener("success", () => {
      const database = request.result;
      const count = database.transaction("documents", "readonly")
        .objectStore("documents").count();
      count.addEventListener("success", () => {
        resolve(count.result);
        database.close();
      });
      count.addEventListener("error", () => reject(count.error));
    });
  }));
  expect(durableCount).toBe(0);
  await receiverPage.getByRole("button", { name: "Discard" }).click();
  await expect(receiverPage).toHaveURL(
    `${receiverOrigin}/examples/receiver/app/index.html`,
  );
  await expect(receiverPage.getByText(/No preserved document was selected/i))
    .toBeVisible();
});

test("a historical service worker migrates while OAB is disabled before later enablement", async ({ context, page }) => {
  test.setTimeout(120_000);
  const setPhase = (value) => context.addCookies([{
    name: "oab-test-sw-phase",
    value,
    url: `${receiverOrigin}/`,
    sameSite: "Lax",
  }]);
  const waitForController = () => page.evaluate(async () => {
    if (navigator.serviceWorker.controller) return;
    await new Promise((resolve) => {
      navigator.serviceWorker.addEventListener("controllerchange", resolve, {
        once: true,
      });
    });
  });

  await setPhase("legacy");
  await page.goto(`${receiverOrigin}/examples/receiver/app/index.html`, {
    waitUntil: "domcontentloaded",
  });
  await page.evaluate(async () => {
    await navigator.serviceWorker.register(
      "/_oab-test/historical-worker.js",
      { scope: "/", updateViaCache: "none" },
    );
    await navigator.serviceWorker.ready;
  });
  await waitForController();
  const legacyEvidence = await page.evaluate(async () => {
    const response = await fetch("/examples/receiver/index.html", {
      cache: "no-store",
    });
    const discovery = await fetch("/.well-known/open-app-bridge", {
      cache: "no-store",
    });
    return {
      controlled: navigator.serviceWorker.controller != null,
      intercepted: response.headers.get("x-oab-legacy-intercepted"),
      discoveryStatus: (await discovery.json()).status,
    };
  });
  expect(legacyEvidence).toEqual({
    controlled: true,
    intercepted: "legacy",
    discoveryStatus: "disabled",
  });

  await setPhase("migration");
  await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration("/");
    const previous = navigator.serviceWorker.controller;
    const changed = new Promise((resolve) => {
      navigator.serviceWorker.addEventListener("controllerchange", resolve, {
        once: true,
      });
    });
    await registration.update();
    if (navigator.serviceWorker.controller === previous) await changed;
  });
  const migrationEvidence = await page.evaluate(async () => {
    const workerResponse = await fetch("/_oab-test/historical-worker.js", {
      cache: "no-store",
    });
    const discovery = await fetch("/.well-known/open-app-bridge", {
      cache: "no-store",
    });
    return {
      controlled: navigator.serviceWorker.controller != null,
      workerSource: await workerResponse.text(),
      discoveryStatus: (await discovery.json()).status,
      discoveryIntercepted:
        discovery.headers.get("x-oab-legacy-intercepted"),
    };
  });
  expect(migrationEvidence.controlled).toBe(true);
  expect(migrationEvidence.discoveryStatus).toBe("disabled");
  expect(migrationEvidence.discoveryIntercepted).toBeNull();
  expect(migrationEvidence.workerSource).not.toMatch(
    /addEventListener\(['"](?:fetch|message|sync|push)['"]/u,
  );

  await setPhase("enabled");
  const authorityResponses = [];
  const receiverGraphRequests = [];
  let receiverHelperPage;
  const observeReceiverGraphRequest = (request) => {
    let ownerPage;
    try {
      ownerPage = request.frame().page();
    } catch (_) {
      return;
    }
    if (ownerPage === page || ownerPage === receiverHelperPage) {
      receiverGraphRequests.push(request.url());
    }
  };
  const observeAuthorityResponse = (response) => {
    const responseUrl = new URL(response.url());
    if (responseUrl.origin === receiverOrigin) {
      authorityResponses.push(response.allHeaders().then((headers) => ({
        headers,
        pathname: responseUrl.pathname,
      })));
    }
  };
  context.on("request", observeReceiverGraphRequest);
  context.on("response", observeAuthorityResponse);
  await page.goto(`${receiverOrigin}/examples/receiver/index.html`, {
    waitUntil: "domcontentloaded",
  });
  await expect(page.getByText("No OAB handoff was found in this URL."))
    .toBeVisible();
  expect(await page.evaluate(() =>
    navigator.serviceWorker.controller != null
  )).toBe(true);
  receiverHelperPage = await context.newPage();
  await receiverHelperPage.goto(
    `${receiverOrigin}/examples/receiver/helper.html`,
    { waitUntil: "domcontentloaded" },
  );
  await expect(receiverHelperPage.locator("#status")).toHaveText(
    "No content was opened or saved. Return to the receiver and try again.",
  );
  await page.waitForTimeout(100);
  const responseEvidence = await Promise.all(authorityResponses);
  expect(responseEvidence.length).toBeGreaterThan(3);
  const observedPaths = new Set(responseEvidence.map((entry) => entry.pathname));
  for (const requiredPath of [
    "/examples/receiver/index.html",
    "/examples/receiver/receiver.js",
    "/examples/receiver/helper.html",
    "/examples/receiver/helper.js",
    "/examples/utility-bootstrap.js",
    "/examples/shared.css",
  ]) {
    expect(observedPaths.has(requiredPath)).toBe(true);
  }
  expect(
    observedPaths.has("/.well-known/open-app-bridge"),
  ).toBe(true);
  for (const evidence of responseEvidence) {
    expect(evidence.headers["x-oab-test-network-phase"]).toBe("enabled");
    expect(evidence.headers["x-oab-legacy-intercepted"]).toBeUndefined();
  }
  expect(receiverGraphRequests.length).toBeGreaterThan(3);
  for (const requestUrl of receiverGraphRequests) {
    expect(new URL(requestUrl).origin).toBe(receiverOrigin);
    // Match forbidden application-service path components, not security SDK
    // vocabulary such as preview-authorization.js.
    expect(new URL(requestUrl).pathname).not.toMatch(
      /\/(?:analytics|telemetry|tracking|sync|auth|account|advertising|services?)(?:[./_-]|$)/iu,
    );
  }
  context.off("request", observeReceiverGraphRequest);
  context.off("response", observeAuthorityResponse);

  const senderOrigin = "http://localhost:18080";
  const senderMigrationPage = await context.newPage();
  const setSenderPhase = (value) => context.addCookies([{
    name: "oab-test-sw-phase",
    value,
    url: `${senderOrigin}/`,
    sameSite: "Lax",
  }]);
  await setSenderPhase("legacy");
  await senderMigrationPage.goto(`${senderOrigin}/examples/sender/index.html`, {
    waitUntil: "domcontentloaded",
  });
  await senderMigrationPage.evaluate(async () => {
    await navigator.serviceWorker.register(
      "/_oab-test/historical-worker.js",
      { scope: "/", updateViaCache: "none" },
    );
    await navigator.serviceWorker.ready;
    if (navigator.serviceWorker.controller) return;
    await new Promise((resolve) => {
      navigator.serviceWorker.addEventListener("controllerchange", resolve, {
        once: true,
      });
    });
  });
  const senderLegacy = await senderMigrationPage.evaluate(async () => {
    const callback = await fetch(
      "/.well-known/open-app-bridge/callback",
      { cache: "no-store" },
    );
    const discovery = await fetch("/.well-known/open-app-bridge", {
      cache: "no-store",
    });
    return {
      callbackIntercepted:
        callback.headers.get("x-oab-legacy-intercepted"),
      callbackStatus: callback.status,
      discoveryStatus: (await discovery.json()).status,
    };
  });
  expect(senderLegacy).toEqual({
    callbackIntercepted: "legacy",
    callbackStatus: 404,
    discoveryStatus: "disabled",
  });

  await setSenderPhase("migration");
  const senderMigration = await senderMigrationPage.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration("/");
    const previous = navigator.serviceWorker.controller;
    const changed = new Promise((resolve) => {
      navigator.serviceWorker.addEventListener("controllerchange", resolve, {
        once: true,
      });
    });
    await registration.update();
    if (navigator.serviceWorker.controller === previous) await changed;
    const worker = await fetch("/_oab-test/historical-worker.js", {
      cache: "no-store",
    });
    const discovery = await fetch("/.well-known/open-app-bridge", {
      cache: "no-store",
    });
    return {
      workerSource: await worker.text(),
      discoveryStatus: (await discovery.json()).status,
      discoveryIntercepted:
        discovery.headers.get("x-oab-legacy-intercepted"),
    };
  });
  expect(senderMigration.discoveryStatus).toBe("disabled");
  expect(senderMigration.discoveryIntercepted).toBeNull();
  expect(senderMigration.workerSource).not.toMatch(
    /addEventListener\(['"](?:fetch|message|sync|push)['"]/u,
  );

  await setSenderPhase("enabled");
  const callbackResponses = [];
  const callbackGraphRequests = [];
  const observeCallbackRequest = (request) => {
    let ownerPage;
    try {
      ownerPage = request.frame().page();
    } catch (_) {
      return;
    }
    if (ownerPage === senderMigrationPage) {
      callbackGraphRequests.push(request.url());
    }
  };
  const observeCallbackResponse = (response) => {
    const responseUrl = new URL(response.url());
    if (responseUrl.origin !== senderOrigin) return;
    callbackResponses.push(response.allHeaders().then((headers) => ({
      headers,
      pathname: responseUrl.pathname,
    })));
  };
  context.on("request", observeCallbackRequest);
  context.on("response", observeCallbackResponse);
  await senderMigrationPage.goto(
    `${senderOrigin}/.well-known/open-app-bridge/callback`,
    { waitUntil: "domcontentloaded" },
  );
  await expect(senderMigrationPage.locator("#status")).toHaveText(
    "No shared content was returned. Go back to the original app and try again.",
  );
  await senderMigrationPage.waitForTimeout(100);
  const callbackEvidence = await Promise.all(callbackResponses);
  const callbackPaths = new Set(
    callbackEvidence.map((entry) => entry.pathname),
  );
  for (const requiredPath of [
    "/.well-known/open-app-bridge/callback",
    "/examples/utility-bootstrap.js",
    "/examples/sender/callback.js",
    "/examples/shared.css",
  ]) {
    expect(callbackPaths.has(requiredPath)).toBe(true);
  }
  for (const evidence of callbackEvidence) {
    expect(evidence.headers["x-oab-test-network-phase"]).toBe("enabled");
    expect(evidence.headers["x-oab-legacy-intercepted"]).toBeUndefined();
  }
  expect(callbackGraphRequests.length).toBeGreaterThan(2);
  for (const requestUrl of callbackGraphRequests) {
    expect(new URL(requestUrl).origin).toBe(senderOrigin);
    expect(new URL(requestUrl).pathname).not.toMatch(
      /\/(?:analytics|telemetry|tracking|sync|auth|account|advertising|services?)(?:[./_-]|$)/iu,
    );
  }
  context.off("request", observeCallbackRequest);
  context.off("response", observeCallbackResponse);
  await page.evaluate(async () => {
    const registrations = await navigator.serviceWorker.getRegistrations();
    await Promise.all(registrations.map((registration) => registration.unregister()));
  });
  await senderMigrationPage.evaluate(async () => {
    const registrations = await navigator.serviceWorker.getRegistrations();
    await Promise.all(registrations.map((registration) => registration.unregister()));
  });
});

test("reference routes deliver the exact security policy", async ({ request }) => {
  for (const discoveryPath of [
    "/.well-known/open-app-bridge",
  ]) {
    const discovery = await request.get(`${receiverOrigin}${discoveryPath}`);
    expect(discovery.status()).toBe(200);
    expect(discovery.headers()["access-control-allow-origin"]).toBe("*");
    expect(discovery.headers()["content-type"]).toContain("application/json");
    expect(discovery.headers()["x-content-type-options"]).toBe("nosniff");
  }

  const helper = await request.get(
    `${receiverOrigin}/examples/receiver/helper.html`,
  );
  expect(helper.headers()["cross-origin-opener-policy"]).toBe("same-origin");
  expect(helper.headers()["referrer-policy"]).toBe("origin");
  expect(helper.headers()["content-security-policy"]).toContain(
    "frame-ancestors 'none'",
  );

  for (const callbackPath of [
    "/.well-known/open-app-bridge/callback",
  ]) {
    const callback = await request.get(`http://localhost:18080${callbackPath}`);
    expect(callback.headers()["cross-origin-opener-policy"]).toBe("same-origin");
    expect(callback.headers()["referrer-policy"]).toBe("no-referrer");
  }
});
