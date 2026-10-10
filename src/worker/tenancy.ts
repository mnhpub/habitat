import type { Env } from './env';

export type OrgRole = 'owner' | 'admin' | 'member';
export const ORG_ROLES: OrgRole[] = ['owner', 'admin', 'member'];

/** A person's role in a workspace, or null if they are not a member. */
export async function orgRole(env: Env, email: string, orgId: string): Promise<OrgRole | null> {
  const row = await env.DB.prepare('SELECT role FROM org_members WHERE org_id = ? AND email = ?')
    .bind(orgId, email).first<{ role: OrgRole }>();
  return row?.role ?? null;
}

/** Owners and admins manage the workspace: members, sign-in-facing settings, campaigns and recordings. */
export const canManage = (role: OrgRole | null): boolean => role === 'owner' || role === 'admin';
