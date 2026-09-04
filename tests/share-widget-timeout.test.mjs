import assert from "node:assert/strict";
import test from "node:test";

class AttributeOnlyElement {
  #attributes = new Map();

  getAttribute(name) {
    return this.#attributes.get(name) ?? null;
  }

  setAttribute(name, value) {
    this.#attributes.set(name, String(value));
  }

  removeAttribute(name) {
    this.#attributes.delete(name);
  }

  hasAttribute(name) {
    return this.#attributes.has(name);
  }

  toggleAttribute(name, force) {
    if (force) this.#attributes.set(name, "");
    else this.#attributes.delete(name);
  }
}

test("share widget exposes bounded network deadlines and no unbounded state", async () => {
  const priorHTMLElement = globalThis.HTMLElement;
  globalThis.HTMLElement = AttributeOnlyElement;
  try {
    const { OpenAppShareElement } = await import(
      `../src/share-widget.js?deadline-test=${Date.now()}`
    );
    const widget = new OpenAppShareElement();

    assert.equal(widget.discoveryTimeoutMs, 8000);
    assert.equal(widget.applicationManifestTimeoutMs, 4000);
    assert.equal(widget.applicationIconTimeoutMs, 4000);

    widget.discoveryTimeoutMs = 12000;
    widget.applicationManifestTimeoutMs = 5000;
    widget.applicationIconTimeoutMs = 6000;
    assert.equal(widget.getAttribute("discovery-timeout-ms"), "12000");
    assert.equal(widget.getAttribute("manifest-timeout-ms"), "5000");
    assert.equal(widget.getAttribute("icon-timeout-ms"), "6000");

    assert.throws(() => { widget.discoveryTimeoutMs = 30001; }, TypeError);
    assert.throws(() => { widget.applicationManifestTimeoutMs = 99; }, TypeError);
    assert.throws(() => { widget.applicationIconTimeoutMs = Infinity; }, TypeError);

    widget.setAttribute("discovery-timeout-ms", "08");
    assert.throws(() => widget.discoveryTimeoutMs, TypeError);
  } finally {
    if (priorHTMLElement === undefined) delete globalThis.HTMLElement;
    else globalThis.HTMLElement = priorHTMLElement;
  }
});
