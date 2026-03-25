// v3: permissions are embedded in JWT token, no API call needed
// This file is kept for backward compatibility but logic moved to useAuth

export { useAuth as usePermissions } from './useAuth';
