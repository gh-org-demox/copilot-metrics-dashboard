import { headers } from "next/headers";
import { ServerActionResponse } from "@/features/common/server-action-response";
import { unknownResponseError, formatResponseError } from "@/features/common/response-error";
import { ensureGitHubEnvConfig } from "./env-service";

export interface UserInfo {
  username: string;
  email?: string;
  isAuthenticated: boolean;
}

export interface GitHubTeamMembership {
  id: number;
  name: string;
  slug: string;
  organization: {
    login: string;
  };
}

/**
 * Gets current user information from Azure App Service authentication headers
 * or returns unauthenticated user info if not available
 */
export const getCurrentUser = async (): Promise<ServerActionResponse<UserInfo>> => {
  try {
    const headersList = headers();
    
    // Check for Azure App Service authentication header
    const clientPrincipal = headersList.get("X-MS-CLIENT-PRINCIPAL");
    
    if (clientPrincipal) {
      try {
        // Decode the base64 encoded user principal
        const decodedPrincipal = Buffer.from(clientPrincipal, "base64").toString("utf8");
        const userPrincipal: { userDetails?: string; claims?: UserPrincipalClaim[] } = JSON.parse(decodedPrincipal);
        
        return {
          status: "OK",
          response: {
            username: userPrincipal.userDetails || userPrincipal.claims?.find((c: UserPrincipalClaim) => c.typ === "preferred_username")?.val || "unknown",
            email: userPrincipal.claims?.find((c: UserPrincipalClaim) => c.typ === "email")?.val,
            isAuthenticated: true,
          },
        };
      } catch (e) {
        // If we can't parse the principal, fall back to unauthenticated
        console.warn("Failed to parse X-MS-CLIENT-PRINCIPAL header:", formatResponseError(e));
      }
    }
    
    // Return unauthenticated user info
    return {
      status: "OK",
      response: {
        username: "",
        isAuthenticated: false,
      },
    };
  } catch (e) {
    return unknownResponseError(e);
  }
};

/**
 * Gets GitHub team memberships for a user
 */
export const getUserTeamMemberships = async (
  username: string,
  organization: string
): Promise<ServerActionResponse<GitHubTeamMembership[]>> => {
  if (!username) {
    return {
      status: "OK",
      response: [],
    };
  }

  const env = ensureGitHubEnvConfig();
  if (env.status !== "OK") {
    return env;
  }

  const { token, version } = env.response;

  try {
    const url = `https://api.github.com/orgs/${organization}/teams`;
    let allTeams: GitHubTeamMembership[] = [];
    let nextUrl: string | null = url;

    // First, get all teams in the organization
    do {
      const response = await fetch(nextUrl, {
        cache: "no-store",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "X-GitHub-Api-Version": version,
        },
      });

      if (!response.ok) {
        return formatResponseError(organization, response);
      }

      const teams = await response.json();
      allTeams.push(...teams);

      // Check for pagination
      const linkHeader = response.headers.get("Link");
      nextUrl = getNextUrlFromLinkHeader(linkHeader);
    } while (nextUrl);

    // Now check membership for each team
    const userTeams: GitHubTeamMembership[] = [];
    
    for (const team of allTeams) {
      try {
        const membershipUrl = `https://api.github.com/orgs/${organization}/teams/${team.slug}/memberships/${username}`;
        const membershipResponse = await fetch(membershipUrl, {
          cache: "no-store",
          headers: {
            Accept: "application/vnd.github+json",
            Authorization: `Bearer ${token}`,
            "X-GitHub-Api-Version": version,
          },
        });

        // If membership exists (200) or pending (200 with state: pending), include the team
        if (membershipResponse.ok) {
          const membership = await membershipResponse.json();
          if (membership.state === "active" || membership.state === "pending") {
            userTeams.push(team);
          }
        }
        // 404 means no membership, which is expected for teams the user isn't in
      } catch (e) {
        // Continue checking other teams if one fails
        console.warn(`Failed to check membership for team ${team.slug}: ${e.message}`);
      }
    }

    return {
      status: "OK",
      response: userTeams,
    };
  } catch (e) {
    return unknownResponseError(e);
  }
};

/**
 * Gets GitHub team memberships for enterprise scope
 */
export const getUserTeamMembershipsEnterprise = async (
  username: string,
  enterprise: string
): Promise<ServerActionResponse<GitHubTeamMembership[]>> => {
  if (!username) {
    return {
      status: "OK",
      response: [],
    };
  }

  const env = ensureGitHubEnvConfig();
  if (env.status !== "OK") {
    return env;
  }

  const { token, version } = env.response;

  try {
    // For enterprise scope, we need to get organizations first, then teams
    const orgsUrl = `https://api.github.com/enterprises/${enterprise}/organizations`;
    let allUserTeams: GitHubTeamMembership[] = [];
    let nextOrgUrl: string | null = orgsUrl;

    do {
      const orgResponse = await fetch(nextOrgUrl, {
        cache: "no-store",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "X-GitHub-Api-Version": version,
        },
      });

      if (!orgResponse.ok) {
        return formatResponseError(enterprise, orgResponse);
      }

      const organizations = await orgResponse.json();

      // For each organization, get user's team memberships
      for (const org of organizations) {
        const userTeamsResult = await getUserTeamMemberships(username, org.login);
        if (userTeamsResult.status === "OK") {
          allUserTeams.push(...userTeamsResult.response);
        }
      }

      // Check for pagination
      const linkHeader = orgResponse.headers.get("Link");
      nextOrgUrl = getNextUrlFromLinkHeader(linkHeader);
    } while (nextOrgUrl);

    return {
      status: "OK",
      response: allUserTeams,
    };
  } catch (e) {
    return unknownResponseError(e);
  }
};

const getNextUrlFromLinkHeader = (linkHeader: string | null): string | null => {
  if (!linkHeader) return null;

  const links = linkHeader.split(",");
  for (const link of links) {
    const match = link.match(/<([^>]+)>;\s*rel="([^"]+)"/);
    if (match && match[2] === "next") {
      return match[1];
    }
  }
  return null;
};