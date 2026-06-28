import { NotificationType, Prisma } from "../generated/prisma/client";

// Roles assignable when inviting a contributor to a repo.
export type InviteRole = "admin" | "member";

// A single invite recipient, already resolved to an existing account
// (invites require a real user_id — pre-signup email invites are out of scope).
export type RepoInvitee = {
    userId: string;
    role: InviteRole;
};

// Everything sendInviteNotification needs to build + persist repo_invite notifications.
// actorName / repoName are snapshotted into the title/body/data so the row still
// renders after the source (inviter / repo) changes or is deleted.
export type SendInviteParams = {
    actorId: string;
    actorName: string;
    repoId: string;
    repoName: string;
    recipients: RepoInvitee[];
};

// Per-recipient outcome of an invite batch (userIds bucketed by what happened).
export type SendInviteResult = {
    created: string[]; // fresh invite created
    updated: string[]; // existing invite refreshed (role changed or it had expired)
    skipped: string[]; // already invited with the same role — no-op
};

// One raw invite entry as received from the API.
export type InviteUserEntry = {
    email: string;
    role: InviteRole;
};

// Params for the email-based entry point shared by repo creation and the
// invite endpoint: same as SendInviteParams but with unresolved {email, role}.
export type InviteByEmailParams = {
    actorId: string;
    actorName: string;
    repoId: string;
    repoName: string;
    users: InviteUserEntry[];
};

export type InviteByEmailResult = SendInviteResult & {
    notFound: string[];      // emails with no account (invites require one)
    alreadyMember: string[]; // emails of active members (incl. the actor)
};

// Context interpolated into a notification's constant title/body template.
export type NotificationContentContext = {
    actorName: string;
    repoName: string;
    role?: string;
    oldRole?: string; // role_changed only
    newRole?: string; // role_changed only
    prTitle?: string; // pr events
};

export type NotificationContent = {
    title: string;
    body: string;
};

// Title/body templates per notification type. The wording for a given type is
// constant — only the interpolated context (actor, repo, role) changes. Add an
// entry here as each notification type is implemented.
export const NOTIFICATION_CONTENT: Partial<
    Record<NotificationType, (ctx: NotificationContentContext) => NotificationContent>
> = {
    repo_invite: (ctx) => ({
        title: `${ctx.actorName} invited you to ${ctx.repoName}`,
        body: `${ctx.actorName} invited you to join ${ctx.repoName} as ${ctx.role}.`,
    }),
    invite_accepted: (ctx) => ({
        title: `${ctx.actorName} accepted your invite to ${ctx.repoName}`,
        body: `${ctx.actorName} accepted your invitation to join ${ctx.repoName}.`,
    }),
    invite_declined: (ctx) => ({
        title: `${ctx.actorName} declined your invite to ${ctx.repoName}`,
        body: `${ctx.actorName} declined your invitation to join ${ctx.repoName}.`,
    }),
    member_removed: (ctx) => ({
        title: `You were removed from ${ctx.repoName}`,
        body: `${ctx.actorName} removed you from ${ctx.repoName}.`,
    }),
    role_changed: (ctx) => ({
        title: `Your role in ${ctx.repoName} changed from ${ctx.oldRole} to ${ctx.newRole}`,
        body: `${ctx.actorName} changed your role in ${ctx.repoName} from ${ctx.oldRole} to ${ctx.newRole}.`,
    }),
    pr_reviewed: (ctx) => ({
        title: `New comment on PR in ${ctx.repoName}`,
        body: `${ctx.actorName} commented on PR "${ctx.prTitle}".`,
    }),
    pr_created: (ctx) => ({
        title: `New Pull Request in ${ctx.repoName}`,
        body: `${ctx.actorName} opened PR "${ctx.prTitle}".`,
    }),
    pr_rejected: (ctx) => ({
        title: `Pull Request closed in ${ctx.repoName}`,
        body: `${ctx.actorName} closed PR "${ctx.prTitle}".`,
    }),
};

// Params for notificationService.notify — one recipient, one templated event.
export type NotifyParams = {
    userId: string;           // recipient (inbox owner)
    actorId?: string | null;  // who triggered it; null/omitted for system events
    type: NotificationType;
    context: NotificationContentContext;
    data?: Prisma.JsonObject; // structured snapshot payload (repoId, roles, ...)
};

// Shape stored in notification.data for a repo_invite (a snapshot — no FK).
export type RepoInviteData = Prisma.JsonObject & {
    repoId: string;
    repoName: string;
    role: InviteRole;
    actorName: string;
};
