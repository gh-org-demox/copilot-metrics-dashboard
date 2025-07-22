import { describe, expect, it, vi } from "vitest";
import { getCurrentUser, getUserTeamMemberships, resolveGitHubUsername } from "./user-service";

// Mock the headers function from Next.js
vi.mock("next/headers", () => ({
  headers: vi.fn(),
}));

// Mock the env service
vi.mock("./env-service", () => ({
  ensureGitHubEnvConfig: vi.fn(() => ({
    status: "OK",
    response: {
      token: "test-token",
      version: "2022-11-28",
      enterprise: "test-enterprise",
      organization: "test-org",
    },
  })),
}));

// Mock fetch globally
global.fetch = vi.fn();

describe("getCurrentUser", () => {
  it("returns unauthenticated user when no auth header is present", async () => {
    const { headers } = await import("next/headers");
    const mockHeaders = {
      get: vi.fn().mockReturnValue(null),
    };
    (headers as any).mockReturnValue(mockHeaders);

    const result = await getCurrentUser();

    expect(result.status).toBe("OK");
    if (result.status === "OK") {
      expect(result.response.isAuthenticated).toBe(false);
      expect(result.response.username).toBe("");
    }
  });

  it("returns authenticated user when X-MS-CLIENT-PRINCIPAL header is present", async () => {
    const { headers } = await import("next/headers");
    const userPrincipal = {
      userDetails: "testuser",
      claims: [
        { typ: "email", val: "test@example.com" },
        { typ: "preferred_username", val: "testuser" },
      ],
    };

    const base64Principal = Buffer.from(JSON.stringify(userPrincipal)).toString("base64");
    const mockHeaders = {
      get: vi.fn().mockReturnValue(base64Principal),
    };
    (headers as any).mockReturnValue(mockHeaders);

    const result = await getCurrentUser();

    expect(result.status).toBe("OK");
    if (result.status === "OK") {
      expect(result.response.isAuthenticated).toBe(true);
      expect(result.response.username).toBe("testuser");
      expect(result.response.email).toBe("test@example.com");
    }
  });

  it("uses GitHub username from custom claim when available", async () => {
    const { headers } = await import("next/headers");
    const userPrincipal = {
      userDetails: "john.smith@company.com",
      claims: [
        { typ: "email", val: "john.smith@company.com" },
        { typ: "preferred_username", val: "john.smith@company.com" },
        { typ: "github_username", val: "johnsmith123" },
      ],
    };
    const encodedPrincipal = Buffer.from(JSON.stringify(userPrincipal)).toString("base64");
    
    const mockHeaders = {
      get: vi.fn().mockReturnValue(encodedPrincipal),
    };
    (headers as any).mockReturnValue(mockHeaders);

    const result = await getCurrentUser();

    expect(result.status).toBe("OK");
    if (result.status === "OK") {
      expect(result.response.isAuthenticated).toBe(true);
      expect(result.response.username).toBe("testuser");
      expect(result.response.email).toBe("test@example.com");
    }
  });
});

describe("getUserTeamMemberships", () => {
  it("returns empty array when username is empty", async () => {
    const result = await getUserTeamMemberships("", "test-org");

    expect(result.status).toBe("OK");
    if (result.status === "OK") {
      expect(result.response).toEqual([]);
    }
  });

  it("returns user teams when username is provided", async () => {
    const mockTeams = [
      { id: 1, name: "team1", slug: "team1", organization: { login: "test-org" } },
      { id: 2, name: "team2", slug: "team2", organization: { login: "test-org" } },
    ];

    const mockMembership = { state: "active" };

    (global.fetch as any)
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockTeams),
        headers: { get: () => null },
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockMembership),
      })
      .mockResolvedValueOnce({
        ok: false, // Not a member of team2
      });

    const result = await getUserTeamMemberships("testuser", "test-org");

    expect(result.status).toBe("OK");
    if (result.status === "OK") {
      expect(result.response).toHaveLength(1);
      expect(result.response[0].name).toBe("team1");
    }
  });
});

describe("resolveGitHubUsername", () => {
  it("returns username as-is when it looks like a valid GitHub username", async () => {
    // Mock GitHub user check to return true
    (global.fetch as any).mockResolvedValueOnce({
      ok: true,
    });

    const result = await resolveGitHubUsername("johnsmith123", "john@example.com");

    expect(result.status).toBe("OK");
    if (result.status === "OK") {
      expect(result.response).toBe("johnsmith123");
    }
  });

  it("looks up user by email when username contains @ symbol", async () => {
    // Mock GitHub user search to return a user
    (global.fetch as any).mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        items: [{ login: "johnsmith123", id: 12345 }]
      }),
    });

    const result = await resolveGitHubUsername("john.smith@company.com", "john.smith@company.com");

    expect(result.status).toBe("OK");
    if (result.status === "OK") {
      expect(result.response).toBe("johnsmith123");
    }
  });

  it("falls back to original username when email lookup fails", async () => {
    // Mock GitHub user search to return no results
    (global.fetch as any).mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        items: []
      }),
    });

    const result = await resolveGitHubUsername("john.smith@company.com", "john.smith@company.com");

    expect(result.status).toBe("OK");
    if (result.status === "OK") {
      expect(result.response).toBe("john.smith@company.com");
    }
  });
});