import { describe, expect, it } from "vitest";
import { redactSecrets } from "../launcher.ts";

const LEAK =
  "Error: Command failed: git clone https://token:art_v2_x_4ffa577eaa97aab3%3Fexpires%3D1791491633@acct.artifacts.cloudflare.net/git/ns/repo.git /tmp/x";

describe("redactSecrets", () => {
  for (const [name, redact] of [["launcher", redactSecrets]] as const) {
    it(`${name}: masks a token-bearing clone URL and keeps the rest readable`, () => {
      const out = redact(LEAK);
      expect(out).not.toContain("art_v2_");
      expect(out).not.toContain("4ffa577e");
      expect(out).toContain("https://***@acct.artifacts.cloudflare.net/git/ns/repo.git");
    });
    it(`${name}: masks a bare Artifact token and leaves clean text alone`, () => {
      expect(redact("token art_v2_abc123 issued")).toBe("token art_*** issued");
      expect(redact("remote: Invalid or expired token")).toBe("remote: Invalid or expired token");
    });
  }
});
