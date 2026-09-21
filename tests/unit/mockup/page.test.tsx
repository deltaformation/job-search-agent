import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import MockupPage from "@/app/mockup/page";

describe("MockupPage Flow", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders Step 1 with persistent disclaimer and authentic job details", () => {
    render(<MockupPage />);

    // Persistent disclaimer
    expect(screen.getByText(/Prototype/i)).toBeInTheDocument();
    expect(screen.getByText(/Nothing is saved/i)).toBeInTheDocument();

    // Job header and target role
    const titles = screen.getAllByText("Lead Product Manager, Supply Chain Systems");
    expect(titles.length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("Lime").length).toBeGreaterThanOrEqual(1);

    // Step indicator
    expect(screen.getByText("Review data")).toBeInTheDocument();
    expect(screen.getAllByText("Tailor Resume")[0]).toBeInTheDocument();

    // Step 1 content: Full JD content
    expect(screen.getByText(/What You'll Do \(11 items\)/i)).toBeInTheDocument();
    expect(screen.getByText(/About You \(7 items\)/i)).toBeInTheDocument();
    expect(screen.getByText(/Compensation & Terms/i)).toBeInTheDocument();
  });

  it("transitions between steps and preserves focus input on Back navigation", () => {
    render(<MockupPage />);

    // Step 1 -> Step 2
    const continueBtn = screen.getByRole("button", {
      name: "Tailor Resume",
    });
    fireEvent.click(continueBtn);

    // Verify Step 2 is active with moved sections
    expect(
      screen.getByRole("button", { name: /Generate resume/i })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: /Keywords/i })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: /Priority phrases/i })
    ).toBeInTheDocument();
    expect(screen.getAllByText(/Strong Match/i).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/Transferable/i).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/Candidate Gap/i).length).toBeGreaterThanOrEqual(1);
    expect(
      screen.getByRole("heading", { name: /Positioning/i })
    ).toBeInTheDocument();
    expect(
      screen.getAllByText(/Lead with logistics product experience/i).length
    ).toBeGreaterThanOrEqual(1);

    // Type custom guidance
    const textarea = screen.getByPlaceholderText(/Focus on route optimization/i);
    fireEvent.change(textarea, {
      target: { value: "Custom guidance for logistics testing." },
    });
    expect(textarea).toHaveValue("Custom guidance for logistics testing.");

    // Navigate Back to Step 1
    const backBtn = screen.getByRole("button", { name: /Back/i });
    fireEvent.click(backBtn);

    // Verify on Step 1
    expect(
      screen.getByRole("button", { name: "Tailor Resume" })
    ).toBeInTheDocument();

    // Navigate Forward to Step 2 again
    fireEvent.click(
      screen.getByRole("button", { name: "Tailor Resume" })
    );

    // Verify custom guidance was preserved!
    const textareaAgain = screen.getByPlaceholderText(
      /Focus on route optimization/i
    );
    expect(textareaAgain).toHaveValue("Custom guidance for logistics testing.");
  });

  it("completes full workflow from Step 2 -> Step 3 -> Step 4 and executes approval", () => {
    render(<MockupPage />);

    // Step 1 -> Step 2
    fireEvent.click(
      screen.getByRole("button", { name: "Tailor Resume" })
    );

    // Step 2 -> Step 3
    fireEvent.click(
      screen.getByRole("button", { name: /Generate resume/i })
    );

    // On Step 3: Simulation view
    expect(screen.getByText(/Preparing your resume/i)).toBeInTheDocument();

    // Open prototype controls and fast-forward to completion
    const protoControlsBtn = screen.getByRole("button", {
      name: /Simulation/i,
    });
    fireEvent.click(protoControlsBtn);

    const fastForwardBtn = screen.getByRole("button", {
      name: /Complete now/i,
    });
    fireEvent.click(fastForwardBtn);

    // Verify on Step 4: Resume comparison & Diff Audit
    expect(screen.getByText("Resume comparison")).toBeInTheDocument();
    expect(screen.getByText("45%")).toBeInTheDocument();
    expect(screen.getByText("+37")).toBeInTheDocument();
    expect(screen.getByText("82%")).toBeInTheDocument();

    // Check What changed diff
    expect(screen.getByText("What changed")).toBeInTheDocument();
    expect(
      screen.getByText(/6 removed lines · 9 added lines · 3 of 6 sections changed/i)
    ).toBeInTheDocument();

    // Check Review decision section
    expect(screen.getByText("Review decision")).toBeInTheDocument();

    // Approve the sample version
    const approveBtn = screen.getByRole("button", {
      name: /Approve version/i,
    });
    fireEvent.click(approveBtn);

    // Verify Pipeline status updated to TAILORED and mock board card rendered
    expect(screen.getByText(/Primary resume selected/i)).toBeInTheDocument();
    expect(screen.getByText(/Download Resume \(PDF\)/i)).toBeInTheDocument();
  });

  it("opens Properties sheet and preserves step state when dismissed", () => {
    render(<MockupPage />);

    const propertiesBtn = screen.getByRole("button", {
      name: /Open job properties sheet/i,
    });
    fireEvent.click(propertiesBtn);

    // Verify sheet open with 5 streamlined properties
    expect(screen.getByRole("dialog", { name: /Properties/i })).toBeInTheDocument();
    expect(screen.getByText("Overview")).toBeInTheDocument();
    expect(screen.getByText("Intake")).toBeInTheDocument();
    expect(screen.getByText("Fetch")).toBeInTheDocument();
    expect(screen.getByText("Evidence Files")).toBeInTheDocument();
    expect(screen.getAllByText("Original posting").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("lime-jd-scraped.html")).toBeInTheDocument();

    // Close sheet
    const closeBtn = screen.getByRole("button", {
      name: /Close properties sheet/i,
    });
    fireEvent.click(closeBtn);

    // Verify still on Step 1
    expect(
      screen.getByRole("button", { name: "Tailor Resume" })
    ).toBeInTheDocument();
  });

  it("renders Step 2 keyword analytics, top 5 phrases match, and summary positioning themes", () => {
    render(<MockupPage />);

    // Step 1 -> Step 2
    fireEvent.click(
      screen.getByRole("button", { name: "Tailor Resume" })
    );

    // Check Candidate Profile section and actions
    expect(
      screen.getByRole("heading", { name: /Candidate profile/i })
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Edit candidate profile/i })).toHaveAttribute("href", "/master-resume");

    // Preview master resume
    const previewMasterBtn = screen.getByRole("button", { name: /Preview master resume/i });
    fireEvent.click(previewMasterBtn);
    expect(screen.getByRole("dialog", { name: /Master Resume/i })).toBeInTheDocument();
    // Close master preview dialog
    const closeDialogBtn = screen.getByRole("button", { name: /Close/i });
    fireEvent.click(closeDialogBtn);

    // Check heading and KPIs in Step 2
    expect(
      screen.getByRole("heading", { name: /Keywords/i })
    ).toBeInTheDocument();
    expect(screen.getByText("28 terms")).toBeInTheDocument();

    // Check default inspection card (Supply Chain Systems)
    expect(screen.getByText("Resume evidence")).toBeInTheDocument();
    expect(screen.getAllByText("Supply Chain Systems").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("12x mentions")).toBeInTheDocument();
    expect(screen.getByText(/Odotrack: last-mile tracking/i)).toBeInTheDocument();

    // Click on a gap keyword in word cloud (NetSuite ERP)
    const netsuiteBtn = screen.getByRole("button", {
      name: /NetSuite ERP, mentioned 8 times/i,
    });
    fireEvent.click(netsuiteBtn);

    // Inspector card should update to NetSuite ERP
    expect(screen.getByText(/NetSuite is not documented/i)).toBeInTheDocument();
    expect(screen.getAllByText(/Keep NetSuite as an evidence gap/i).length).toBeGreaterThanOrEqual(1);

    // Filter by Category: Supply Chain & Fleet
    const logisticsTab = screen.getByRole("button", {
      name: /Supply Chain & Fleet/i,
    });
    fireEvent.click(logisticsTab);

    // Search filter input
    const searchInput = screen.getByPlaceholderText(/Filter cloud terms/i);
    fireEvent.change(searchInput, { target: { value: "Fleet" } });
    expect(screen.getByRole("button", { name: /Fleet Operations/i })).toBeInTheDocument();

    // Check Top 5 Phrases Match section
    expect(
      screen.getByRole("heading", { name: /Priority phrases/i })
    ).toBeInTheDocument();
    expect(screen.getByText(/Lead the creation and execution of the supply chain product roadmap/i)).toBeInTheDocument();

    // Check Positioning Theme options for improving the summary
    expect(
      screen.getByRole("heading", { name: /Positioning/i })
    ).toBeInTheDocument();
    expect(screen.getByText(/Choose a theme/i)).toBeInTheDocument();

    // Click "Use theme" for Option 2 (ERP systems integration)
    const applyButtons = screen.getAllByRole("button", { name: /Use theme/i });
    expect(applyButtons.length).toBeGreaterThanOrEqual(1);
    fireEvent.click(applyButtons[0]);

    // Active summary should update with tailored draft
    expect(screen.getByText(/Senior Product Manager with 15\+ years leading enterprise systems/i)).toBeInTheDocument();
  });
});
