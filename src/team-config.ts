import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import defaultTeamConfig from './default-team.json';

export { defaultTeamConfig };

export const teamConfigPath = '.vscode/agent-teams.json';

const roleId = z.string().max(64).regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/, 'Use a lowercase role ID such as release-lead.');
const agentMode = z.enum(['interactive', 'plan', 'autopilot']);
const agentApprovals = z.enum(['manual', 'assisted', 'allowAll']);
const launchOptions = z.strictObject({
  mode: agentMode.optional(),
  approvals: agentApprovals.optional(),
});
const chatDefaults = z.object({
  mode: agentMode.optional().catch(undefined),
  approvals: agentApprovals.optional().catch(undefined),
});
type LaunchOptions = z.infer<typeof launchOptions>;

export function resolveRoleLaunch(launch: LaunchOptions, editorDefaults?: unknown): Required<LaunchOptions> {
  const { data } = chatDefaults.safeParse(editorDefaults);
  return {
    mode: launch.mode ?? data?.mode ?? 'interactive',
    approvals: launch.approvals ?? data?.approvals ?? 'manual',
  };
}

const permissions = z.strictObject({
  read: z.boolean().optional(),
  edit: z.boolean().optional(),
  run: z.boolean().optional(),
  browser: z.boolean().optional(),
  sandbox: z.boolean().optional(),
  promptForApproval: z.boolean().optional(),
});
const roleDefinition = z.strictObject({
  id: roleId,
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().min(1),
  prompt: z.string().trim().optional(),
  launch: launchOptions.optional(),
  permissions: permissions.optional(),
});
export type RoleDefinition = z.infer<typeof roleDefinition>;

const config = z.strictObject({
  roles: z.array(roleDefinition).min(1).max(10),
  defaults: z.strictObject({ permissions: permissions.optional(), launch: launchOptions.optional() }).optional(),
  defaultRecipientRoleId: roleId.optional(),
  browserPreviewPorts: z.array(z.number().int().min(1).max(65535)).max(10).optional(), // Accept older configs; VS Code controls browser access.
}).superRefine(({ roles, defaults, defaultRecipientRoleId }, ctx) => {
  const ids = new Set<string>();
  const names = new Set<string>(['you']);
  const approvalMessage = 'Use launch.approvals instead of promptForApproval with the native Copilot launch profile.';
  if (defaults?.permissions?.promptForApproval !== undefined && roles.some(role => role.launch)) {
    ctx.addIssue({ code: 'custom', path: ['defaults', 'permissions', 'promptForApproval'], message: approvalMessage });
  }
  roles.forEach((role, index) => {
    const { id, name } = role;
    if (ids.has(id)) ctx.addIssue({ code: 'custom', path: ['roles', index, 'id'], message: 'Role IDs must be unique.' });
    const key = name.toLowerCase();
    if (names.has(key)) ctx.addIssue({ code: 'custom', path: ['roles', index, 'name'], message: 'Role names must be unique and cannot be "You".' });
    ids.add(id);
    names.add(key);
    if (role.launch && role.permissions?.promptForApproval !== undefined) {
      ctx.addIssue({ code: 'custom', path: ['roles', index, 'permissions', 'promptForApproval'], message: approvalMessage });
    }
  });
  if (defaultRecipientRoleId && !ids.has(defaultRecipientRoleId)) {
    ctx.addIssue({ code: 'custom', path: ['defaultRecipientRoleId'], message: 'Choose a role ID from the configured roster.' });
  }
}).transform(({ roles, defaults, defaultRecipientRoleId }) => ({
  defaultRecipientRoleId,
  roles: roles.map((role): RoleDefinition => ({
    ...role,
    ...(defaults?.permissions ? { permissions: { ...defaults.permissions, ...role.permissions } } : {}),
    ...(role.launch ? { launch: { ...defaults?.launch, ...role.launch } } : {}),
  })),
}));

const resolvedDefaultTeam = config.parse(defaultTeamConfig);
export const defaultRoles: readonly RoleDefinition[] = resolvedDefaultTeam.roles;

export function rolePermissions(role?: RoleDefinition, defaultSandbox = true) {
  return {
    read: role?.permissions?.read ?? true,
    edit: role?.permissions?.edit ?? false,
    run: role?.permissions?.run ?? false,
    browser: role?.permissions?.browser ?? (role?.launch !== undefined),
    sandbox: role?.permissions?.sandbox ?? defaultSandbox,
    promptForApproval: role?.permissions?.promptForApproval ?? true,
  };
}

export async function loadTeamConfig(path: string): Promise<{ roles: readonly RoleDefinition[]; defaultRecipientRoleId?: string }> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return resolvedDefaultTeam;
    throw error;
  }
  let input: unknown;
  try {
    input = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new Error(`${teamConfigPath}: ${error.message}`);
  }
  const result = config.safeParse(input);
  if (!result.success) {
    throw new Error(`${teamConfigPath}: ${result.error.issues.map(issue => `${issue.path.join('.') || 'root'}: ${issue.message}`).join('; ')}`);
  }
  return result.data;
}
