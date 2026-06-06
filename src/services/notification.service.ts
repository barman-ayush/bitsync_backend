import { Prisma } from "../generated/prisma/client";
import {
    InviteByEmailParams,
    InviteByEmailResult,
    InviteRole,
    NOTIFICATION_CONTENT,
    NotifyParams,
    RepoInvitee,
    RepoInviteData,
    SendInviteParams,
    SendInviteResult,
} from "../types/notification.types";
import db from "./database.service";
import logger from "./logger.service";

class NotificationService {
    private static instance: NotificationService;

    // repo_invite lifetime — invites expire 7 days after they are (re)sent.
    private static readonly INVITE_TTL_DAYS = 7;

    private constructor() {}

    public static getInstance(): NotificationService {
        if (!this.instance) {
            this.instance = new NotificationService();
        }
        return this.instance;
    }

    // notify : Generic single-recipient notification for a templated event
    // (invite_accepted, member_removed, role_changed, ...). Best-effort — a
    // notification is a side effect of the main action, so failures are logged
    // and swallowed, never thrown back into the calling endpoint.
    public async notify(params: NotifyParams): Promise<void> {
        try {
            const buildContent = NOTIFICATION_CONTENT[params.type];
            if (!buildContent) {
                logger.warn("notification.service", `No content template for type ${params.type}`);
                return;
            }
            const { title, body } = buildContent(params.context);
            await db.prisma.notification.create({
                data: {
                    userId: params.userId,
                    actorId: params.actorId ?? null,
                    type: params.type,
                    title,
                    body,
                    data: params.data,
                },
            });
        } catch (err) {
            logger.error("notification.service", `Failed to create ${params.type} notification: ${err}`);
        }
    }

    // inviteByEmail : Shared entry point for inviting contributors by email —
    // used by both repo creation and the invite endpoint. Resolves emails to
    // existing accounts, drops the actor and active members, then delegates the
    // create/update/skip decision to sendInviteNotification.
    public async inviteByEmail(params: InviteByEmailParams): Promise<InviteByEmailResult> {
        const { actorId, actorName, repoId, repoName, users } = params;

        // De-dupe by email (case-insensitively — signup does not normalize
        // email casing, so stored emails may differ in case), last role wins.
        const emailToRole = new Map<string, InviteRole>();
        for (const u of users) emailToRole.set(u.email.toLowerCase(), u.role);

        const emails = [...emailToRole.keys()];
        const [accounts, members] = await Promise.all([
            db.prisma.user.findMany({
                where: { email: { in: emails, mode: "insensitive" } },
                select: { id: true, email: true },
            }),
            db.prisma.repoMember.findMany({
                where: { repoId, deletedAt: null },
                select: { userId: true },
            }),
        ]);

        const foundEmails = new Set(accounts.map((a) => a.email.toLowerCase()));
        const memberIds = new Set(members.map((m) => m.userId));
        const notFound = emails.filter((e) => !foundEmails.has(e));

        const recipients: RepoInvitee[] = [];
        const alreadyMember: string[] = [];
        for (const account of accounts) {
            // Can't invite yourself or someone who is already in the repo.
            // Soft-deleted (removed) members CAN be re-invited — accepting
            // revives their membership row.
            if (account.id === actorId || memberIds.has(account.id)) {
                alreadyMember.push(account.email);
                continue;
            }
            recipients.push({ userId: account.id, role: emailToRole.get(account.email.toLowerCase())! });
        }

        const result = await this.sendInviteNotification({ actorId, actorName, repoId, repoName, recipients });
        return { ...result, notFound, alreadyMember };
    }

    // sendInviteNotification : Creates/refreshes repo_invite notifications for a
    // batch of recipients on a single repo. Per recipient, against any existing
    // repo_invite for the same repo:
    //   - none found            -> create a fresh invite
    //   - found, expired        -> refresh it (new expiry + role)
    //   - found, role changed   -> refresh it (new role + expiry)
    //   - found, same role      -> skip (already actively invited)
    // Recipients are bucketed into created / updated / skipped in the result.
    public async sendInviteNotification(params: SendInviteParams): Promise<SendInviteResult> {
        const { actorId, actorName, repoId, repoName, recipients } = params;
        const result: SendInviteResult = { created: [], updated: [], skipped: [] };

        if (recipients.length === 0) return result;

        const buildContent = NOTIFICATION_CONTENT.repo_invite!;
        const now = new Date();
        const expiresAt = new Date(now.getTime() + NotificationService.INVITE_TTL_DAYS * 24 * 60 * 60 * 1000);

        const recipientIds = recipients.map((r) => r.userId);

        // Existing repo_invite notifications for these recipients on this repo,
        // keyed by recipient so we can decide create vs update vs skip in memory.
        const existing = await db.prisma.notification.findMany({
            where: {
                type: "repo_invite",
                userId: { in: recipientIds },
                data: { path: ["repoId"], equals: repoId },
            },
            select: { id: true, userId: true, data: true, expiresAt: true },
        });
        const existingByUser = new Map(existing.map((n) => [n.userId, n]));

        await db.prisma.$transaction(async (tx) => {
            for (const recipient of recipients) {
                const { title, body } = buildContent({ actorName, repoName, role: recipient.role });
                const data: RepoInviteData = { repoId, repoName, role: recipient.role, actorName };
                const prev = existingByUser.get(recipient.userId);

                if (!prev) {
                    await tx.notification.create({
                        data: {
                            userId: recipient.userId,
                            actorId,
                            type: "repo_invite",
                            title,
                            body,
                            data,
                            expiresAt,
                        },
                    });
                    result.created.push(recipient.userId);
                    continue;
                }

                const prevRole = (prev.data as Prisma.JsonObject | null)?.role;
                const isExpired = prev.expiresAt != null && prev.expiresAt < now;

                // Active invite with the same role — nothing to do.
                if (!isExpired && prevRole === recipient.role) {
                    result.skipped.push(recipient.userId);
                    continue;
                }

                // Role changed or invite expired — refresh it in place (resets
                // read state and pushes the expiry out by the full TTL again).
                await tx.notification.update({
                    where: { id: prev.id },
                    data: {
                        actorId,
                        title,
                        body,
                        data,
                        isRead: false,
                        expiresAt,
                    },
                });
                result.updated.push(recipient.userId);
            }
        });

        return result;
    }
}

const notificationService = NotificationService.getInstance();

export default notificationService;
