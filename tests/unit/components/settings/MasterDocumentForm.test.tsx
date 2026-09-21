import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import MasterDocumentForm, {
  assembleMasterDocument,
  emptyMasterDraft,
} from "../../../../components/settings/MasterDocumentForm";

/**
 * WO-1.2-C: the structured editor covers the §2 payload inventory,
 * mints ids (never hand-authored), assembles a valid import-v2
 * document, and highlights server issues on exact controls.
 */

describe("assembleMasterDocument", () => {
  it("builds an import-v2 document with minted ids and pending verification", () => {
    const draft = emptyMasterDraft();
    draft.identity.fullName = "Casey Doe";
    draft.identity.email = "casey@example.com";
    draft.identity.linkedin = "https://linkedin.example/casey";
    draft.employment.push({
      key: "row-1",
      id: "emp-1",
      company: "Acme",
      role: "PM",
      location: "",
      startDate: "2021-01-01",
      endDate: "",
      isCurrent: true,
      description: "",
    });
    draft.achievements.push({
      key: "row-2",
      factId: "fact-2",
      employmentKey: "row-1",
      category: "launch",
      text: "Shipped the thing.",
      technologies: "TypeScript, SQL",
      metrics: "10 users\n20% faster",
      source: "",
    });
    draft.skills.push({
      key: "row-3",
      name: "SQL",
      category: "technical",
      proficiency: "expert",
      yearsExperience: "5",
      verified: true,
    });
    draft.languages.push({ key: "row-4", name: "French", proficiency: "", verified: false });
    const document = assembleMasterDocument(draft);
    expect(document["schemaVersion"]).toBe("candidate-import/v2");
    expect(document["identity"]).toMatchObject({
      fullName: "Casey Doe",
      email: "casey@example.com",
      links: { linkedin: "https://linkedin.example/casey" },
    });
    expect(document["identity"]).not.toHaveProperty("phone");
    const employment = document["employment"] as Array<Record<string, unknown>>;
    expect(employment).toHaveLength(1);
    expect(employment[0]).not.toHaveProperty("endDate");
    const achievements = document["achievements"] as Array<Record<string, unknown>>;
    expect(achievements[0]).toMatchObject({
      factId: "fact-2",
      employmentId: "emp-1",
      technologies: ["TypeScript", "SQL"],
      metrics: ["10 users", "20% faster"],
      verification: "PENDING",
    });
    const skills = document["skills"] as Array<Record<string, unknown>>;
    expect(skills[0]).toMatchObject({ name: "SQL", proficiency: "expert", yearsExperience: 5 });
    const languages = document["languages"] as Array<Record<string, unknown>>;
    expect(languages[0]).toEqual({ name: "French", verified: false });
  });
});

describe("MasterDocumentForm controls", () => {
  it("adds employment and achievement rows with minted read-only ids", () => {
    const onSubmitDocument = vi.fn();
    render(
      <MasterDocumentForm
        idPrefix="test"
        disabled={false}
        issues={[]}
        submitLabel="Validate & preview"
        onSubmitDocument={onSubmitDocument}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Add employment" }));
    expect(screen.getByText(/emp-\d+/)).toBeVisible();
    fireEvent.change(screen.getByLabelText("Company"), { target: { value: "Acme" } });
    fireEvent.change(screen.getByLabelText("Role"), { target: { value: "PM" } });
    fireEvent.change(screen.getByLabelText("Start date (YYYY-MM-DD)"), {
      target: { value: "2021-01-01" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add achievement" }));
    expect(screen.getByText(/fact-\d+ · pending review/)).toBeVisible();
    // No hand-authored id field exists anywhere in the form.
    expect(screen.queryByLabelText(/fact id/i)).toBeNull();
    expect(screen.queryByLabelText(/employment id/i)).toBeNull();
    fireEvent.change(screen.getByLabelText("Full name"), { target: { value: "Casey Doe" } });
    fireEvent.change(screen.getByLabelText("Category"), { target: { value: "launch" } });
    fireEvent.change(screen.getByLabelText("Achievement text"), {
      target: { value: "Shipped the thing." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Validate & preview" }));
    expect(onSubmitDocument).toHaveBeenCalledTimes(1);
    const document = onSubmitDocument.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(document["schemaVersion"]).toBe("candidate-import/v2");
    expect((document["identity"] as Record<string, unknown>)["fullName"]).toBe("Casey Doe");
  });

  it("highlights the exact control for each server issue", () => {
    render(
      <MasterDocumentForm
        idPrefix="test"
        disabled={false}
        issues={[
          { path: ["identity", "email"], message: "Invalid email address." },
          { path: ["employment", 0, "endDate"], message: "past employment requires endDate" },
        ]}
        submitLabel="Validate & preview"
        onSubmitDocument={() => {}}
      />,
    );
    const email = screen.getByLabelText("Email");
    expect(email).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByText("Invalid email address.")).toBeVisible();
  });

  it("reports dirty state as the draft changes", () => {
    const onDirtyChange = vi.fn();
    render(
      <MasterDocumentForm
        idPrefix="test"
        disabled={false}
        issues={[]}
        submitLabel="Validate & preview"
        onSubmitDocument={() => {}}
        onDirtyChange={onDirtyChange}
      />,
    );
    fireEvent.change(screen.getByLabelText("Full name"), { target: { value: "Casey" } });
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);
  });
});
