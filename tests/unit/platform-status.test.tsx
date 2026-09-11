import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import PlatformStatus from "../../components/PlatformStatus";

describe("PlatformStatus", () => {
  it("announces the scaffold state with a top-level heading", () => {
    render(<PlatformStatus />);

    expect(
      screen.getByRole("heading", { level: 1, name: /local job tracker/i }),
    ).toBeInTheDocument();
    expect(screen.getByText(/platform scaffold/i)).toBeInTheDocument();
    expect(
      screen.getByText(/nothing here reads or writes product data yet/i),
    ).toBeInTheDocument();
  });
});
