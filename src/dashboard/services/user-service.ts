import { headers } from "next/headers";
import { ServerActionResponse } from "@/features/common/server-action-response";
import { unknownResponseError, formatResponseError } from "@/features/common/response-error";
import { ensureGitHubEnvConfig } from "./env-service";

export interface UserInfo {
  username: string;
  email?: string;
  isAuthenticated: boolean;
}

export interface UserPrincipalClaim {
  typ: string;
  val: string;
}

export interface GitHubUser {
  login: string;
  id: number;
  email?: string;
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
        
        // Look for GitHub username in custom claim first
        const githubUsernameClaim = userPrincipal.claims?.find((c: UserPrincipalClaim) => 
          c.typ === "github_username" || c.typ === "extension_github_username"
        )?.val;
        
        const entraUsername = userPrincipal.userDetails || 
          userPrincipal.claims?.find((c: UserPrincipalClaim) => c.typ === "preferred_username")?.val || 
          "unknown";
        
        const email = userPrincipal.claims?.find((c: UserPrincipalClaim) => c.typ === "email")?.val;

        return {
          status: "OK",
          response: {
            username: githubUsernameClaim || entraUsername,
            email: email,
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
 * Resolves the GitHub username from EntraID credentials using multiple strategies:
 * 1. Use GitHub username if provided in custom claims
 * 2. Look up GitHub user by email
 * 3. Fall back to EntraID username as-is
 */
export const resolveGitHubUsername = async (
  entraUsername: string,
  email?: string
): Promise<ServerActionResponse<string>> => {
  // If the username looks like a valid GitHub username (no @ or spaces), try it first
  if (entraUsername && !entraUsername.includes('@') && !entraUsername.includes(' ')) {
    // Test if this username exists on GitHub
    const testResult = await testGitHubUsername(entraUsername);
    if (testResult.status === "OK" && testResult.response) {
      return {
        status: "OK",
        response: entraUsername,
      };
    }
  }

  // If we have an email, try to find the GitHub user by email
  if (email) {
    const userByEmailResult = await findGitHubUserByEmail(email);
    if (userByEmailResult.status === "OK" && userByEmailResult.response) {
      return {
        status: "OK",
        response: userByEmailResult.response.login,
      };
    }
  }

  // Fall back to using the EntraID username as-is
  return {
    status: "OK",
    response: entraUsername,
  };
};

/**
 * Tests if a GitHub username exists
 */
const testGitHubUsername = async (username: string): Promise<ServerActionResponse<boolean>> => {
  const env = ensureGitHubEnvConfig();
  if (env.status !== "OK") {
    return { status: "OK", response: false };
  }

  const { token, version } = env.response;

  try {
    const response = await fetch(`https://api.github.com/users/${username}`, {
      cache: "no-store",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": version,
      },
    });

    return {
      status: "OK",
      response: response.ok,
    };
  } catch (e) {
    return {
      status: "OK",
      response: false,
    };
  }
};

/**
 * Finds a GitHub user by email address
 */
const findGitHubUserByEmail = async (email: string): Promise<ServerActionResponse<GitHubUser | null>> => {
  const env = ensureGitHubEnvConfig();
  if (env.status !== "OK") {
    return { status: "OK", response: null };
  }

  const { token, version } = env.response;

  try {
    // Search for users by email
    const response = await fetch(`https://api.github.com/search/users?q=${encodeURIComponent(email)}+in:email`, {
      cache: "no-store",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": version,
      },
    });

    if (!response.ok) {
      return { status: "OK", response: null };
    }

    const searchResult = await response.json();
    
    // Return the first user found, if any
    if (searchResult.items && searchResult.items.length > 0) {
      return {
        status: "OK",
        response: searchResult.items[0],
      };
    }

    return {
      status: "OK",
      response: null,
    };
  } catch (e) {
    return {
      status: "OK",
      response: null,
    };
  }
};

/**
 * Gets GitHub team memberships for a user
 */
export const getUserTeamMemberships = async (
  username: string,
  organization: string,
  email?: string
): Promise<ServerActionResponse<GitHubTeamMembership[]>> => {
  if (!username) {
    return {
      status: "OK",
      response: [],
    };
  }

  // Resolve the actual GitHub username
  const resolvedUsernameResult = await resolveGitHubUsername(username, email);
  if (resolvedUsernameResult.status !== "OK") {
    return resolvedUsernameResult;
  }
  
  const githubUsername = resolvedUsernameResult.response;

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
        const membershipUrl = `https://api.github.com/orgs/${organization}/teams/${team.slug}/memberships/${githubUsername}`;
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
  enterprise: string,
  email?: string
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
        const userTeamsResult = await getUserTeamMemberships(username, org.login, email);
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