import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { clean } from "../src/titles.js";

describe("clean", () => {
  for (const [raw, want, why] of [
    ["Chrome extension bridge", "Chrome extension bridge", "already fine"],
    ['"Chrome extension bridge"', "Chrome extension bridge", "strips quotes"],
    ["Chrome extension bridge.", "Chrome extension bridge", "strips a trailing stop"],
    ["Title: Chrome extension bridge", "Chrome extension bridge", "strips a preamble"],
    ["**Chrome extension bridge**", "Chrome extension bridge", "strips markdown emphasis"],
    ["Chrome extension bridge\nsome rambling after", "Chrome extension bridge", "first line only"],
    ["  padded  ", "padded", "trims"],
  ] as const) {
    test(why, () => assert.equal(clean(raw), want));
  }

  test("rejects something too short to be a title", () => {
    assert.equal(clean("ok"), null);
    assert.equal(clean(""), null);
    assert.equal(clean("   "), null);
  });

  test("caps a rambling answer at eight words", () => {
    const got = clean("one two three four five six seven eight nine ten") as string;
    assert.equal(got.split(/\s+/).length, 8);
  });

  test("caps length so a list stays readable", () => {
    const got = clean("x".repeat(200)) as string;
    assert.ok(got.length <= 64, got.length.toString());
  });
});
