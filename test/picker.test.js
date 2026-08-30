"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { HerdrRequestError } = require("../dist/herdr");
const { graphicsDisabledStatus, isGraphicsDisabled, keyToShortcut } = require("../dist/picker");

test("keyToShortcut handles select and cancel keys", () => {
  assert.equal(keyToShortcut("1"), "1");
  assert.equal(keyToShortcut("A"), "a");
  assert.equal(keyToShortcut("q"), null);
  assert.equal(keyToShortcut("\u001b"), null);
  assert.equal(keyToShortcut("\u0003"), null);
});

test("isGraphicsDisabled recognizes Herdr feature_disabled errors", () => {
  assert.equal(isGraphicsDisabled(new HerdrRequestError("feature_disabled", "disabled")), true);
  assert.equal(isGraphicsDisabled(new HerdrRequestError("invalid_params", "bad")), false);
  assert.equal(isGraphicsDisabled(new Error("feature_disabled")), false);
});

test("graphicsDisabledStatus explains the required config", () => {
  const status = graphicsDisabledStatus();

  assert.match(status.message, /disabled/);
  assert.match(status.detail, /kitty_graphics = true/);
});
