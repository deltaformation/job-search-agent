import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import HealthPage from "../../../app/health/page";

function mockHealthResponse(data: unknown, ok = true, status = 200) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok,
      status,
      json: async () => data,
    }),
  );
}

const mockHealthyPayload = {
  status: "ok",
  dataRoot: {
    root: "/path/to/data",
    databaseExists: true,
    evidenceExists: true,
    artifactsExists: true,
  },
  migrations: {
    directory: "/path/to/drizzle",
    files: [
      "0000_cuddly_vance_astro.sql",
      "0001_tricky_starhawk.sql",
      "0002_quiet_leopardon.sql",
      "0003_salty_thunderbolt.sql",
    ],
  },
};

describe("HealthPage", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders healthy state with all diagnostic sections when API returns ok", async () => {
    mockHealthResponse(mockHealthyPayload);

    render(<HealthPage />);

    expect(screen.getByRole("heading", { level: 1, name: /api & system health/i })).toBeInTheDocument();
    expect(screen.getByText(/probing local api…/i)).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByText(/all core services operational & ready/i)).toBeInTheDocument();
    });

    expect(screen.getByText("200 OK")).toBeInTheDocument();
    expect(screen.getByText("SQLite Database & Schema")).toBeInTheDocument();
    expect(screen.getByText("Local Storage & Data Root")).toBeInTheDocument();
    expect(screen.getByText("Security & Network Boundary")).toBeInTheDocument();
    expect(screen.getByText("Platform Services & Engine")).toBeInTheDocument();
    expect(screen.getByText(/4 \/ 4 applied/i)).toBeInTheDocument();
    expect(screen.getByText("0000_cuddly_vance_astro.sql")).toBeInTheDocument();
  });

  it("renders degraded state when API reports degraded status", async () => {
    mockHealthResponse(
      {
        status: "degraded",
        dataRoot: {
          root: "/path/to/data",
          databaseExists: false,
          evidenceExists: false,
          artifactsExists: false,
        },
        migrations: { directory: "/drizzle", files: [] },
      },
      false,
      503,
    );

    render(<HealthPage />);

    await waitFor(() => {
      expect(screen.getByText(/system degraded or unavailable/i)).toBeInTheDocument();
    });
  });

  it("triggers a re-probe when the Probe API button is clicked", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => mockHealthyPayload,
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<HealthPage />);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    const probeBtn = screen.getByRole("button", { name: /re-probe local health endpoint/i });
    fireEvent.click(probeBtn);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });

  it("provides direct navigation links to Queue, Board, and Intake", async () => {
    mockHealthResponse(mockHealthyPayload);

    render(<HealthPage />);

    expect(screen.getByRole("link", { name: /^queue$/i })).toHaveAttribute("href", "/queue");
    expect(screen.getByRole("link", { name: /job board/i })).toHaveAttribute("href", "/board");
    expect(screen.getByRole("link", { name: /job intake/i })).toHaveAttribute("href", "/intake");
  });
});
