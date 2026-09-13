import { render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import PageTransition from "../../../components/PageTransition";

let viPathname = "/board";
vi.mock("next/navigation", () => ({ usePathname: () => viPathname }));

it("fades page content and remounts on route change", () => {
  viPathname = "/board";
  const rendered = render(
    <PageTransition>
      <p>board page</p>
    </PageTransition>,
  );
  const first = rendered.container.querySelector(".page-enter");
  expect(first).not.toBeNull();
  expect(screen.getByText("board page")).toBeInTheDocument();
  viPathname = "/intake";
  rendered.rerender(
    <PageTransition>
      <p>intake page</p>
    </PageTransition>,
  );
  // A new key replaces the wrapper node, replaying the enter animation.
  const second = rendered.container.querySelector(".page-enter");
  expect(second).not.toBeNull();
  expect(second).not.toBe(first);
  expect(screen.getByText("intake page")).toBeInTheDocument();
});
