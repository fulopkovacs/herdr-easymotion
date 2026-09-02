"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { PassThrough } = require("node:stream");
const { HerdrRequestError } = require("../dist/herdr");
const {
  graphicsDisabledStatus,
  isGraphicsDisabled,
  keyToShortcut,
  readKey,
} = require("../dist/picker");

test("readKey buffers input that arrives before rendering finishes", async () => {
  const input = new PassThrough();
  const firstKey = readKey(input);
  input.resume();
  input.write("1");

  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(await firstKey, "1");
});

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
