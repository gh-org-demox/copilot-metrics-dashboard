import { headers } from "next/headers";
import { ServerActionResponse } from "@/features/common/server-action-response";
import { unknownResponseError, formatResponseError } from "@/features/common/response-error";
import { ensureGitHubEnvConfig } from "./env-service";

export interface UserInfo {
  username: string;
  email?: string;
  nameId?: string;
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

export interface SamlIdentityMapping {
  user: {
    id: string;
    login: string;
    name: string;
    email: string;
  };
  samlIdentity: {
    nameId: string;
  };
}

/**
 * Gets SAML identity mappings from GitHub organization using GraphQL
 */
const getSamlIdentityMappings = async (organization: string): Promise<ServerActionResponse<SamlIdentityMapping[]>> => {
  const env = ensureGitHubEnvConfig();
  if (env.status !== "OK") {
    return env;
  }

  const { token, version } = env.response;

  const query = `
    query($org: String!, $continuationToken: String) {
      organization(login: $org) {
        samlIdentityProvider {
          id
          ssoUrl
          issuer
          externalIdentities(first: 100, after: $continuationToken) {
            totalCount
            pageInfo {
              hasNextPage
              endCursor
            }
            edges {
              node {
                user {
                  id
                  login
                  name
                  email
                }
                samlIdentity {
                  nameId
                }
              }
            }
          }
        }
      }
    }
  `;

  try {
    let allIdentities: SamlIdentityMapping[] = [];
    let continuationToken: string | null = null;
    let hasNextPage = true;

    while (hasNextPage) {
      const variables: { org: string; continuationToken: string | null } = {
        org: organization,
        continuationToken,
      };

      const response: Response = await fetch('https://api.github.com/graphql', {
        method: 'POST',
        cache: "no-store",
        headers: {
          'Accept': 'application/vnd.github+json',
          'Authorization': `Bearer ${token}`,
          'X-GitHub-Api-Version': version,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ query, variables }),
      });

      if (!response.ok) {
        return formatResponseError(organization, response);
      }

      const result: any = await response.json();
      
      if (result.errors) {
        console.warn('GraphQL errors:', result.errors);
        return {
          status: "ERROR",
          errors: [{ message: `GraphQL query failed: ${result.errors[0]?.message || 'Unknown error'}` }],
        };
      }

      const externalIdentities: any = result.data?.organization?.samlIdentityProvider?.externalIdentities;
      if (externalIdentities?.edges) {
        const identities = externalIdentities.edges.map((edge: any) => edge.node);
        allIdentities.push(...identities);
      }

      hasNextPage = externalIdentities?.pageInfo?.hasNextPage || false;
      continuationToken = externalIdentities?.pageInfo?.endCursor || null;
    }

    return {
      status: "OK",
      response: allIdentities,
    };
  } catch (e) {
    return unknownResponseError(e);
  }
};

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

        // Extract SAML nameId if available
        const nameId = userPrincipal.claims?.find((c: UserPrincipalClaim) => 
          c.typ === "nameidentifier" || c.typ === "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/nameidentifier"
        )?.val;

        return {
          status: "OK",
          response: {
            username: githubUsernameClaim || entraUsername,
            email: email,
            nameId: nameId,
            isAuthenticated: true,
          },
        };
      } catch (e) {
        // If we can't parse the principal, fall back to unauthenticated
        console.warn("Failed to parse X-MS-CLIENT-PRINCIPAL header:", e instanceof Error ? e.message : 'Unknown error');
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
 * 2. Look up GitHub user via SAML identity mapping (GraphQL)
 * 3. Look up GitHub user by email
 * 4. Fall back to EntraID username as-is
 */
export const resolveGitHubUsername = async (
  entraUsername: string,
  email?: string,
  nameId?: string
): Promise<ServerActionResponse<string>> => {
  // Strategy 1: Use custom GitHub username claim if available
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

  // Strategy 2: Use SAML identity mapping via GraphQL (primary method for SAML environments)
  if (nameId) {
    const env = ensureGitHubEnvConfig();
    if (env.status === "OK") {
      const { organization } = env.response;
      const samlMappingResult = await getSamlIdentityMappings(organization);
      
      if (samlMappingResult.status === "OK") {
        const mapping = samlMappingResult.response.find(
          identity => identity.samlIdentity.nameId === nameId
        );
        
        if (mapping) {
          return {
            status: "OK",
            response: mapping.user.login,
          };
        }
      }
    }
  }

  // Strategy 3: If we have an email, try to find the GitHub user by email
  if (email) {
    const userByEmailResult = await findGitHubUserByEmail(email);
    if (userByEmailResult.status === "OK" && userByEmailResult.response) {
      return {
        status: "OK",
        response: userByEmailResult.response.login,
      };
    }
  }

  // Strategy 4: Fall back to using the EntraID username as-is
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
  email?: string,
  nameId?: string
): Promise<ServerActionResponse<GitHubTeamMembership[]>> => {
  if (!username) {
    return {
      status: "OK",
      response: [],
    };
  }

  // Resolve the actual GitHub username
  const resolvedUsernameResult = await resolveGitHubUsername(username, email, nameId);
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
      if (Array.isArray(teams)) {
        allTeams.push(...teams);
      }

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
        console.warn(`Failed to check membership for team ${team.slug}: ${e instanceof Error ? e.message : 'Unknown error'}`);
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
  email?: string,
  nameId?: string
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
        const userTeamsResult = await getUserTeamMemberships(username, org.login, email, nameId);
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