import { describe, expect, it, vi } from "vitest";
import { createPinnedIPv4Lookup, parseVaultRequestCommand, requestWithVaultSecret } from "../src/vault-broker.js";

describe("vault broker DNS pinning", () => {
  it("refuses a destination outside the selected secret's grant before DNS or HTTPS", async () => {
    const request = parseVaultRequestCommand("agentguard-vault request --secret TEST_TOKEN --method GET --url https://other.example.test/v1")!;
    await expect(requestWithVaultSecret({ value: "synthetic-value", allowedHosts: ["api.example.test"], authHeader: "Authorization", authPrefix: "Bearer " }, request, new AbortController().signal))
      .rejects.toThrow("not approved for this API host");
  });
  it("returns a list when Node's HTTPS client requests all lookup results", () => {
    const callback = vi.fn();

    createPinnedIPv4Lookup("203.0.113.7")("api.example.test", { all: true }, callback);

    expect(callback).toHaveBeenCalledWith(null, [{ address: "203.0.113.7", family: 4 }]);
  });

  it("returns the address and family for a single-result lookup", () => {
    const callback = vi.fn();

    createPinnedIPv4Lookup("203.0.113.7")("api.example.test", { family: 4 }, callback);

    expect(callback).toHaveBeenCalledWith(null, "203.0.113.7", 4);
  });
});
