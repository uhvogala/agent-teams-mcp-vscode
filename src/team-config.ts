import { readFile } from 'node:fs/promises';
import { z } from 'zod';

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

const roleDefinition = z.strictObject({
  id: roleId,
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().min(1),
  prompt: z.string().trim().optional(),
  launch: launchOptions.optional(),
  permissions: z.strictObject({
    read: z.boolean().optional(),
    edit: z.boolean().optional(),
    run: z.boolean().optional(),
    browser: z.boolean().optional(),
    sandbox: z.boolean().optional(),
    promptForApproval: z.boolean().optional(),
  }).optional(),
}).superRefine((role, ctx) => {
  if (role.launch && role.permissions?.promptForApproval !== undefined) {
    ctx.addIssue({ code: 'custom', path: ['permissions', 'promptForApproval'], message: 'Use launch.approvals instead of promptForApproval with the native Copilot launch profile.' });
  }
});
export type RoleDefinition = z.infer<typeof roleDefinition>;

const config = z.strictObject({
  roles: z.array(roleDefinition).min(1).max(10),
  defaultRecipientRoleId: roleId.optional(),
  browserPreviewPorts: z.array(z.number().int().min(1).max(65535)).max(10).optional(), // Accept older configs; VS Code controls browser access.
}).superRefine(({ roles, defaultRecipientRoleId }, ctx) => {
  const ids = new Set<string>();
  const names = new Set<string>(['you']);
  roles.forEach((role, index) => {
    const { id, name } = role;
    if (ids.has(id)) ctx.addIssue({ code: 'custom', path: ['roles', index, 'id'], message: 'Role IDs must be unique.' });
    const key = name.toLowerCase();
    if (names.has(key)) ctx.addIssue({ code: 'custom', path: ['roles', index, 'name'], message: 'Role names must be unique and cannot be "You".' });
    ids.add(id);
    names.add(key);
  });
  if (defaultRecipientRoleId && !ids.has(defaultRecipientRoleId)) {
    ctx.addIssue({ code: 'custom', path: ['defaultRecipientRoleId'], message: 'Choose a role ID from the configured roster.' });
  }
});

export const defaultRoles: readonly RoleDefinition[] = [
  {
    id: 'lead', name: 'Lead', description: 'Coordinate the team, clarify priorities, and track decisions.',
    prompt: 'Own the response to human requests. For implementation work, post a short plan and address Builder with a concrete next step and how to verify it. Ask Reviewer for a focused check when useful. If a decision is needed before work can proceed, ask the human a specific question. Report decisions, blockers, and results in the room; do not stop at an inbox acknowledgement.',
    permissions: { read: true, edit: false, run: false },
  },
  {
    id: 'builder', name: 'Builder', description: 'Implement and verify requested changes.',
    prompt: 'When the human requests implementation or Lead hands off work within the human request, make the changes and run focused checks. Report what changed, what passed, and what remains blocked in the room. If the request is for discussion or a proposal only, reply with a recommendation without editing. If blocked, explain what you need instead of silently waiting.',
    permissions: { read: true, edit: true, run: true },
  },
  {
    id: 'reviewer', name: 'Reviewer', description: 'Review proposals and changes for correctness and run relevant checks.',
    prompt: 'Review the requested proposal or change against the human goal. Run focused checks when available. Post concrete findings and their impact, or say what you verified if you found no issues. Address the worker who can fix an actionable issue; do not wake the whole room for a status update.',
    permissions: { read: true, edit: false, run: true },
  },
];

export const defaultTeamConfig = { defaultRecipientRoleId: 'lead', roles: defaultRoles };

export function rolePermissions(role?: RoleDefinition, defaultSandbox = true) {
  const defaults = defaultRoles.find(candidate => candidate.id === role?.id)?.permissions;
  return {
    read: role?.permissions?.read ?? defaults?.read ?? true,
    edit: role?.permissions?.edit ?? defaults?.edit ?? false,
    run: role?.permissions?.run ?? defaults?.run ?? false,
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
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return defaultTeamConfig;
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
  const { roles, defaultRecipientRoleId } = result.data;
  return { roles, defaultRecipientRoleId };
}
