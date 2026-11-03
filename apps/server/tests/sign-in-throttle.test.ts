import { describe, expect, it } from "vitest";
import { SignInThrottle } from "../src/sign-in-throttle.js";

describe("SignInThrottle", () => {
  it("blocks an account after five failures and expires the block after fifteen minutes", () => {
    let now = 10_000;
    const throttle = new SignInThrottle(() => now);
    for (let i = 0; i < 5; i += 1) throttle.failed("Person@example.test", "192.0.2.1");
    expect(throttle.retryAfterSeconds("person@example.test", "192.0.2.1")).toBe(900);
    now += 15 * 60_000;
    expect(throttle.retryAfterSeconds("person@example.test", "192.0.2.1")).toBe(0);
  });

  it("tracks accounts separately and also limits repeated attempts from one client", () => {
    const throttle = new SignInThrottle(() => 10_000);
    for (let i = 0; i < 5; i += 1) throttle.failed("a@example.test", "192.0.2.2");
    expect(throttle.retryAfterSeconds("b@example.test", "192.0.2.2")).toBe(0);
    for (let i = 0; i < 25; i += 1) throttle.failed(`user${i}@example.test`, "192.0.2.2");
    expect(throttle.retryAfterSeconds("other@example.test", "192.0.2.2")).toBe(900);
  });
});
