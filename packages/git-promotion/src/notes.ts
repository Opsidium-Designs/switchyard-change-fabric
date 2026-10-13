/**
 * The promotion receipt: a git note on the promoted commit, under its own
 * notes ref (`refs/notes/switchyard`), so anyone reading the history later can
 * see why that commit exists without the board.
 *
 * A note lives on its own ref: writing it never changes the promoted commit,
 * the delivery branch, HEAD, the index, or the working tree. Writing it is
 * best effort by design, but never silent: the outcome is returned as a
 * record (`written: false` with the reason) for the caller to report.
 *
 * Read it with `git log --notes=switchyard` or
 * `git notes --ref=switchyard show <commit>`.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_IDENTITY, git, type GitIdentity } from "./git.ts";

/** The dedicated notes ref promotion receipts are written under. */
export const RECEIPT_NOTES_REF = "refs/notes/switchyard";

/** What happened to a promotion receipt (reported, never swallowed). */
export interface PromotionReceiptRecord {
  /** The notes ref the receipt is (or would have been) written under. */
  readonly ref: string;
  /** The promoted commit the note is attached to. */
  readonly commit: string;
  /** True only when the note was written and read back verbatim. */
  readonly written: boolean;
  /** Why it was not written (absent when written). */
  readonly reason?: string;
}

/** Inputs for writing a promotion receipt note. */
export interface WritePromotionNoteInput {
  /** The local repository holding the promoted commit. */
  readonly repoDir: string;
  /** The promoted commit (a full or abbreviated hex id). */
  readonly commit: string;
  /** The note body (the receipt text). */
  readonly message: string;
  /** The identity the notes commit is made with. */
  readonly identity?: GitIdentity;
  /** The notes ref (defaults to RECEIPT_NOTES_REF). */
  readonly ref?: string;
  /** Scratch root for the message file. Defaults to OS temp. */
  readonly workRoot?: string;
}

/**
 * Attach `message` as a note to `commit` under the receipt notes ref, replacing
 * an earlier note on the same commit. Never throws: any failure comes back as
 * `written: false` with the reason, and the commit and branches are untouched
 * either way (a note is written to its own ref only).
 */
export async function writePromotionNote(input: WritePromotionNoteInput): Promise<PromotionReceiptRecord> {
  const ref = input.ref ?? RECEIPT_NOTES_REF;
  const base = { ref, commit: input.commit };
  if (!/^[0-9a-f]{7,64}$/.test(input.commit)) {
    return { ...base, written: false, reason: `not a commit id: ${JSON.stringify(input.commit.slice(0, 80))}` };
  }
  if (!/^refs\/notes\/[A-Za-z0-9._/-]+$/.test(ref) || ref.includes("..")) {
    return { ...base, written: false, reason: `not a notes ref: ${JSON.stringify(ref.slice(0, 80))}` };
  }
  const identity = input.identity ?? DEFAULT_IDENTITY;
  let scratch: string | undefined;
  try {
    // The body goes through a file (-F), so its size and content never ride
    // on git's argv.
    scratch = await mkdtemp(join(input.workRoot ?? tmpdir(), "scf-receipt-"));
    const file = join(scratch, "receipt.txt");
    await writeFile(file, input.message.endsWith("\n") ? input.message : `${input.message}\n`, "utf8");
    await git(input.repoDir, [
      "-c",
      `user.name=${identity.name}`,
      "-c",
      `user.email=${identity.email}`,
      "notes",
      `--ref=${ref}`,
      "add",
      "-f",
      "-F",
      file,
      `${input.commit}^{commit}`,
    ]);
    // Read it back: only a note that is there, on that commit, counts as written.
    const shown = await git(input.repoDir, ["notes", `--ref=${ref}`, "show", `${input.commit}^{commit}`]);
    if (shown.trimEnd() !== input.message.trimEnd()) {
      return { ...base, written: false, reason: "the note read back from the notes ref does not match the receipt written" };
    }
    return { ...base, written: true };
  } catch (error) {
    return { ...base, written: false, reason: noteFailure(error) };
  } finally {
    if (scratch !== undefined) {
      await rm(scratch, { recursive: true, force: true });
    }
  }
}

/** A short, single-line reason from a git failure (runGit already scrubs credentials). */
function noteFailure(error: unknown): string {
  const raw = error instanceof Error ? ((error as { stderr?: unknown }).stderr ?? error.message) : String(error);
  const text = String(raw).replace(/\s+/g, " ").trim();
  return `git notes failed: ${text.slice(0, 300) || "unknown error"}`;
}
