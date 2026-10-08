/**
 * Redact credentials from text that leaves the process (CLI errors, run logs).
 * A failed `git clone` reports its full command line, which embeds the Artifact
 * write token as `https://token:<secret>@host/...`; this masks the userinfo of
 * any URL and any bare Artifact token so a log never carries a usable secret.
 */
export function redactSecrets(text: string): string {
  return text
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, "$1***@")
    .replace(/\bart_v\d+_[A-Za-z0-9_%.=-]+/g, "art_***");
}
