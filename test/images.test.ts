import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { parseAgentMessage, MAX_IMAGES } from "../src/protocol.js";
import { Session, type ClientEvent, type SessionDeps } from "../src/session.js";
import { fakeSdk, settle } from "./fakes/sdk.js";

const png = "iVBORw0KGgo=";   // any base64 will do for the wire; the model side is not exercised here

describe("prompt images on the wire", () => {
  test("valid images pass; an image-only prompt is allowed", () => {
    const m = parseAgentMessage({ type: "prompt", text: "", images: [{ media_type: "image/png", data: png, thumb: png }] });
    assert.ok(m && m.type === "prompt"); assert.equal(m.images!.length, 1); assert.equal(m.text, "");
    assert.equal(parseAgentMessage({ type: "prompt", text: "", images: [] }), null, "nothing at all is still nothing");
  });
  test("malformed images refuse the whole prompt rather than being stripped", () => {
    const bad = (images: unknown) => parseAgentMessage({ type: "prompt", text: "hi", images });
    assert.equal(bad("nope"), null);
    assert.equal(bad([{ media_type: "image/svg+xml", data: png, thumb: "" }]), null, "svg is not accepted");
    assert.equal(bad([{ media_type: "image/png", data: "not base64!!", thumb: "" }]), null);
    assert.equal(bad([{ media_type: "image/png", data: "", thumb: "" }]), null);
    assert.equal(bad([{ media_type: "image/png", data: png, thumb: "x".repeat(70_000) }]), null, "thumb cap");
    assert.equal(bad(Array.from({ length: MAX_IMAGES + 1 }, () => ({ media_type: "image/png", data: png, thumb: "" }))), null, "too many");
    assert.equal(bad([{ media_type: "image/png", data: "A".repeat(6 * 1024 * 1024), thumb: "" }]), null, "too big");
    assert.ok(bad([{ media_type: "image/jpeg", data: png, thumb: "" }]), "a valid one still passes");
  });
});

describe("Session.send with images", () => {
  test("the SDK gets image blocks first, then the composed text; no images keeps the string form", async () => {
    const sdk = fakeSdk(); const events: ClientEvent[] = [];
    const deps: SessionDeps = { chatId: "c", bridge: null, getShell: () => null, watches: null, prompts: null, prefer: () => undefined, spawnQuery: sdk.spawnQuery };
    const s = new Session("/w", (e) => events.push(e), deps);
    const done = s.start();
    s.send("what is this?", "active tab: T — https://t", [{ media_type: "image/png", data: png }]);
    s.send("plain");
    s.send("", undefined, [{ media_type: "image/jpeg", data: png }]);
    await settle();
    const [a, b, c] = sdk.last.received.map((m) => m.message.content);
    assert.ok(Array.isArray(a)); assert.equal((a as { type: string }[])[0].type, "image"); assert.equal((a as { type: string }[])[1].type, "text");
    assert.deepEqual((a as { source: unknown }[])[0].source, { type: "base64", media_type: "image/png", data: png });
    assert.match((a as { text: string }[])[1].text, /what is this\?/); assert.match((a as { text: string }[])[1].text, /untrusted-page-data/);
    assert.equal(typeof b, "string");
    assert.match((c as { text: string }[])[1].text, /see the attached image/, "an image with no words gets a stand-in prompt");
    s.close(); await done;
  });
});
