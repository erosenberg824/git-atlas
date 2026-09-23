import { describe, it, expect } from "vitest";
import {
  controlButtonClass,
  CONTROL_BUTTON_BASE,
  CONTROL_BUTTON_ACTIVE,
  CONTROL_BUTTON_INACTIVE,
} from "./controlStyles";

describe("controlButtonClass", () => {
  it("includes the shared base classes in both states", () => {
    expect(controlButtonClass(true)).toContain(CONTROL_BUTTON_BASE);
    expect(controlButtonClass(false)).toContain(CONTROL_BUTTON_BASE);
  });

  it("uses the active variant when active", () => {
    const cls = controlButtonClass(true);
    expect(cls).toContain(CONTROL_BUTTON_ACTIVE);
    expect(cls).not.toContain(CONTROL_BUTTON_INACTIVE);
    // Active look: solid accent fill + matching border (Primer primary button).
    expect(cls).toContain("bg-[#1f6feb]");
    expect(cls).toContain("border-[#1f6feb]");
    expect(cls).toContain("text-white");
  });

  it("uses the inactive variant with the shared hover border when inactive", () => {
    const cls = controlButtonClass(false);
    expect(cls).toContain(CONTROL_BUTTON_INACTIVE);
    expect(cls).not.toContain(CONTROL_BUTTON_ACTIVE);
    // Inactive look: neutral border, blue border on hover (shared convention).
    expect(cls).toContain("border-[#30363d]");
    expect(cls).toContain("hover:border-[#58a6ff]/50");
  });
});
