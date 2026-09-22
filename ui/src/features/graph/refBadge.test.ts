import { describe, it, expect } from "vitest";
import { refBadgeColor, refBadgeClass, type RefBadgeLike } from "./refBadge";

// Pure styling logic — no DOM. We assert the color scheme rules documented in
// refBadge.ts and the size/variant composition, not exact Tailwind tokens
// beyond what the rules promise (so the tests stay meaningful but not brittle).

const branch: RefBadgeLike = { kind: "branch" };
const remote: RefBadgeLike = { kind: "remotebranch" };
const tag: RefBadgeLike = { kind: "tag" };
const headBranch: RefBadgeLike = { kind: "branch", is_head: true };

describe("refBadgeColor", () => {
  it("uses green for HEAD regardless of kind", () => {
    expect(refBadgeColor(headBranch)).toContain("green");
    // HEAD wins even if the kind would otherwise be a tag/remote.
    expect(refBadgeColor({ kind: "tag", is_head: true })).toContain("green");
    expect(refBadgeColor({ kind: "remotebranch", is_head: true })).toContain(
      "green",
    );
  });

  it("uses yellow for tags", () => {
    expect(refBadgeColor(tag)).toContain("yellow");
  });

  it("uses orange for remote branches", () => {
    expect(refBadgeColor(remote)).toContain("orange");
  });

  it("uses blue for local branches", () => {
    expect(refBadgeColor(branch)).toContain("blue");
  });

  it("treats the head kind (non-branch) as a non-HEAD blue by default", () => {
    // kind "head" without is_head falls through to the local-branch default.
    expect(refBadgeColor({ kind: "head" })).toContain("blue");
  });

  it("gives each distinct kind a distinct scheme", () => {
    const schemes = new Set([
      refBadgeColor(headBranch),
      refBadgeColor(tag),
      refBadgeColor(remote),
      refBadgeColor(branch),
    ]);
    expect(schemes.size).toBe(4);
  });
});

describe("refBadgeClass", () => {
  it("defaults to the compact node size", () => {
    const cls = refBadgeClass(branch);
    expect(cls).toContain("text-[10px]");
    expect(cls).not.toContain("text-[11px]");
  });

  it("uses the larger panel size when requested", () => {
    const cls = refBadgeClass(branch, { size: "panel" });
    expect(cls).toContain("text-[11px]");
    expect(cls).not.toContain("text-[10px]");
  });

  it("includes the shared base classes and the color scheme", () => {
    const cls = refBadgeClass(tag, { size: "panel" });
    // shared base
    expect(cls).toContain("rounded");
    expect(cls).toContain("font-mono");
    expect(cls).toContain("truncate");
    expect(cls).toContain("border");
    // color scheme for the ref
    expect(cls).toContain(refBadgeColor(tag));
  });

  it("is a single space-joined class string with no empty segments", () => {
    const cls = refBadgeClass(headBranch);
    expect(cls.split(" ").every((c) => c.length > 0)).toBe(true);
  });
});
