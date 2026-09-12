import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import PlatformStatus from "../../components/PlatformStatus";

describe("PlatformStatus", () => {
  it("announces the workspace state with a top-level heading", () => {
    render(<PlatformStatus />);

    expect(
      screen.getByRole("heading", { level: 1, name: /local job tracker/i }),
    ).toBeInTheDocument();
    expect(screen.getByText(/workspace ready/i)).toBeInTheDocument();
    expect(
      screen.getByText(/deterministic local application pipeline/i),
    ).toBeInTheDocument();
  });
});
