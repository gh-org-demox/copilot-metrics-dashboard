# Team Filtering Implementation

## Overview

This implementation adds user-based team filtering to the GitHub Copilot Metrics Dashboard. When users are authenticated via Azure App Service EntraID, they will only see teams they belong to in the team filter dropdown. For unauthenticated users, all teams are shown to maintain backward compatibility.

## Features

- **Azure App Service Authentication Support**: Detects authenticated users via X-MS-CLIENT-PRINCIPAL header
- **GitHub Team Membership Integration**: Queries GitHub API to determine user's team memberships
- **Graceful Fallback**: Shows all teams when authentication is not available
- **Enterprise & Organization Support**: Works with both GitHub API scopes
- **Backward Compatibility**: No disruption to existing functionality

## Implementation Details

### New Files
- `services/user-service.ts` - Handles user authentication and GitHub team membership queries
- `services/user-service.test.ts` - Unit tests for user service functionality

### Modified Files
- `services/copilot-seat-service.ts` - Added optional user team filtering parameter
- `features/dashboard/dashboard-page.tsx` - Integrated user context and team filtering
- `vitest.config.ts` - Fixed path aliases for testing

## How It Works

1. **User Detection**: Dashboard page calls `getCurrentUser()` to check for authentication
2. **GitHub Username Resolution**: If user is authenticated, resolves the actual GitHub username using multiple strategies:
   - First checks for custom GitHub username claims (`github_username` or `extension_github_username`)
   - If EntraID username looks like a GitHub username (no @ symbol), validates it exists on GitHub
   - If an email is available, searches GitHub for users with that email
   - Falls back to using the EntraID username as-is
3. **Team Membership**: Queries GitHub API for team memberships using the resolved GitHub username
4. **Team Filtering**: Passes user's teams to `getAllCopilotSeatsTeams()` for filtering
5. **Dropdown Display**: Team dropdown shows only teams the user belongs to

## Username Resolution

The system handles scenarios where EntraID and GitHub usernames differ:

### Strategy 1: Custom Claims
If your EntraID configuration includes a custom claim for GitHub username:
```json
{
  "claims": [
    { "typ": "github_username", "val": "johnsmith123" },
    { "typ": "preferred_username", "val": "john.smith@company.com" }
  ]
}
```

### Strategy 2: Email Lookup
For users with public email addresses, the system searches GitHub:
- EntraID email: `john.smith@company.com`
- GitHub API search finds user with matching email
- Returns GitHub username: `johnsmith123`

### Strategy 3: Direct Validation
If the EntraID username looks like a GitHub username (no @ symbol), it's validated on GitHub:
- EntraID username: `johnsmith`
- Validates user exists on GitHub
- Uses username if valid

### Strategy 4: Fallback
As a last resort, uses the EntraID username directly:
- Useful when usernames match or for debugging

## Scenarios

### Authenticated User
- EntraID authentication detected via X-MS-CLIENT-PRINCIPAL header
- User's GitHub team memberships are queried
- Team dropdown shows only user's teams

### Unauthenticated User
- No authentication header detected
- All teams are shown in dropdown
- No disruption to existing functionality

## Security Considerations

- Uses Azure App Service built-in authentication
- Leverages existing GitHub API permissions
- No sensitive data is stored or logged
- Fails safely by showing all teams if authentication detection fails

## Testing

Unit tests cover:
- User authentication detection
- GitHub team membership querying
- Error handling and edge cases
- TypeScript type safety

Run tests with: `npm test user-service.test.ts`