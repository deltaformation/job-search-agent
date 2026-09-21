import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import AppHeader from "../../../components/AppHeader";
vi.mock("next/navigation", () => ({ usePathname: () => "/board" }));
afterEach(() => vi.unstubAllGlobals());

it("keeps board/intake navigation and one Add Job entry point after alignment changes", () => {
  render(<AppHeader />);
  expect(screen.getByRole("link", { name: "Board" })).toHaveAttribute("href", "/board");
  expect(screen.getByRole("link", { name: "Intake" })).toHaveAttribute("href", "/intake");
  expect(screen.getByRole("link", { name: /ready/i })).toHaveAttribute("href", "/health");
  expect(screen.getByRole("link", { name: "Board" })).toHaveAttribute("aria-current", "page");
  expect(screen.getAllByRole("button", { name: "Add Job" })).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "Add Job" }));
  expect(screen.getByRole("dialog")).toHaveAccessibleName("Quick Add Job URL");
  expect(screen.getByRole("button", { name: "Queue Job" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(screen.queryByRole("dialog")).toBeNull();
});
