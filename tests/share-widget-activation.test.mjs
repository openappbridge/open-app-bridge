import assert from "node:assert/strict";
import test from "node:test";

import { OpenAppShareElement } from "../src/share-widget.js";

test("share widget latches a one-shot handoff before activation can re-enter", () => {
  const widget = Object.create(OpenAppShareElement.prototype);
  const transport = "detached-datachannel/1";
  const receiver = {
    origin: "https://receiver.example",
    application: { name: "Receiver" },
  };
  const prepared = Object.freeze({ representations: Object.freeze({}) });
  let activations = 0;
  let prevented = 0;
  const errors = [];
  const event = {
    preventDefault() {
      prevented += 1;
    },
  };
  const handoff = {
    requestId: "r".repeat(32),
    activate() {
      activations += 1;
      widget._activateSend(event);
      return new Promise(() => {});
    },
  };

  Object.assign(widget, {
    _anchorHandoff: handoff,
    _activeHandoff: false,
    _activeHandoffController: null,
    _armedTransport: transport,
    _selectedTransport: transport,
    _armedOrigin: receiver.origin,
    _armedReceiver: receiver,
    _receiver: receiver,
    _armedPrepared: prepared,
    _prepared: prepared,
    _contentPromise: null,
    _pendingPreparedContent: null,
    _remember: { checked: false },
    _setBusy() {},
    _setStatus() {},
    _disableSend() {},
    _showError(error) {
      errors.push(error);
    },
  });

  widget._activateSend(event);

  assert.equal(activations, 1);
  assert.equal(prevented, 1);
  assert.deepEqual(errors, []);
  assert.equal(widget._activeHandoff, true);
  assert.equal(widget._activeHandoffController, handoff);
});

test("openFor opens, canonicalizes, and verifies a known receiver domain", async () => {
  const widget = Object.create(OpenAppShareElement.prototype);
  const calls = [];
  const content = { title: "Example", text: "Example" };
  Object.assign(widget, {
    _activeHandoff: false,
    _dialog: { open: false },
    _input: { value: "" },
    _pendingPreparedContent: null,
    async open(value) {
      calls.push(["open", value]);
      this._dialog.open = true;
      this._pendingPreparedContent = {};
    },
    _renderDestinations(value) {
      calls.push(["render", value]);
    },
    async _verifyDestination(value) {
      calls.push(["verify", value]);
    },
  });

  await widget.openFor("markerpad.app", content);

  assert.equal(widget._input.value, "markerpad.app");
  assert.deepEqual(calls, [
    ["open", content],
    ["render", "markerpad.app"],
    ["verify", "markerpad.app"],
  ]);
});

test("openFor rejects an invalid receiver before opening the widget", async () => {
  const widget = Object.create(OpenAppShareElement.prototype);
  let opened = false;
  widget.open = async () => {
    opened = true;
  };

  await assert.rejects(
    widget.openFor("https://markerpad.app"),
    /without https:\/\//u,
  );
  assert.equal(opened, false);
});
