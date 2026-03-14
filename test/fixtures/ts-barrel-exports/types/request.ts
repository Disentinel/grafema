/**
 * Source definitions - interfaces and types
 */

export interface AuthenticatedRequest {
  userId: string;
  apiKey: string;
}

export type CrontabConfig = {
  intervalMs: number;
  tasks: string[];
};

export enum UserRole {
  Admin = "admin",
  User = "user",
  Guest = "guest"
}
