import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import Dialog from "../../../../components/board/dialog";

it("Escape closes only the top dialog, restores focus, and keeps background scrolling locked", () => {
  function Harness() {
    const [workspace, setWorkspace] = useState(false);
    const [confirmation, setConfirmation] = useState(false);
    return <>
      <button onClick={() => setWorkspace(true)}>Open workspace</button>
      {workspace && <Dialog labelledBy="workspace-title" position="workspace" onClose={() => setWorkspace(false)}>
        <h2 id="workspace-title">Job workspace</h2>
        <button onClick={() => setConfirmation(true)}>Open confirmation</button>
      </Dialog>}
      {confirmation && <Dialog labelledBy="confirmation-title" position="center" onClose={() => setConfirmation(false)}>
        <h2 id="confirmation-title">Confirmation</h2>
        <button>Confirm</button>
      </Dialog>}
    </>;
  }
  render(<Harness />);
  const opener = screen.getByText("Open workspace");
  opener.focus();
  fireEvent.click(opener);
  const nestedOpener = screen.getByText("Open confirmation");
  expect(nestedOpener).toHaveFocus();
  fireEvent.click(nestedOpener);
  expect(screen.getByText("Confirm")).toHaveFocus();
  fireEvent.keyDown(document, { key: "Escape" });
  expect(screen.getAllByRole("dialog")).toHaveLength(1);
  expect(nestedOpener).toHaveFocus();
  expect(document.body.style.overflow).toBe("hidden");
  fireEvent.keyDown(document, { key: "Escape" });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(opener).toHaveFocus();
  expect(document.body.style.overflow).toBe("");
});
