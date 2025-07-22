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
2. **Team Membership**: If user is authenticated, queries GitHub API for team memberships
3. **Team Filtering**: Passes user's teams to `getAllCopilotSeatsTeams()` for filtering
4. **Dropdown Display**: Team dropdown shows only teams the user belongs to

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