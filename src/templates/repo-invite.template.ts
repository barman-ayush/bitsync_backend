export function repoInviteTemplate(
    inviterName: string,
    repoName: string,
    role: string,
    inviteLink: string,
): string {
    return `
    <!DOCTYPE html>
    <html>
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
    </head>
    <body style="margin: 0; padding: 0; background-color: #f4f4f5; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;">
        <table width="100%" cellpadding="0" cellspacing="0" style="padding: 40px 0;">
            <tr>
                <td align="center">
                    <table width="600" cellpadding="0" cellspacing="0" style="background-color: #ffffff; border-radius: 8px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,0.08);">
                        <tr>
                            <td style="background-color: #18181b; padding: 30px; text-align: center;">
                                <h1 style="color: #ffffff; margin: 0; font-size: 24px;">BitSync</h1>
                            </td>
                        </tr>
                        <tr>
                            <td style="padding: 40px 30px;">
                                <p style="color: #27272a; font-size: 16px; margin: 0 0 16px;">You're invited!</p>
                                <p style="color: #3f3f46; font-size: 15px; line-height: 1.6; margin: 0 0 24px;">
                                    <strong>${inviterName}</strong> has invited you to join the repository
                                    <strong>${repoName}</strong> as a <strong>${role}</strong>.
                                </p>
                                <table cellpadding="0" cellspacing="0" style="margin: 0 auto;">
                                    <tr>
                                        <td align="center" style="background-color: #18181b; border-radius: 6px;">
                                            <a href="${inviteLink}" style="display: inline-block; padding: 14px 32px; color: #ffffff; text-decoration: none; font-size: 15px; font-weight: 600;">
                                                View Invitation
                                            </a>
                                        </td>
                                    </tr>
                                </table>
                                <p style="color: #71717a; font-size: 13px; line-height: 1.6; margin: 24px 0 0;">
                                    If the button doesn't work, copy and paste this link into your browser:<br>
                                    <a href="${inviteLink}" style="color: #3b82f6; word-break: break-all;">${inviteLink}</a>
                                </p>
                                <p style="color: #71717a; font-size: 13px; margin: 24px 0 0;">
                                    This invitation expires in 7 days. If you weren't expecting this, you can safely ignore the email.
                                </p>
                            </td>
                        </tr>
                        <tr>
                            <td style="background-color: #f4f4f5; padding: 20px 30px; text-align: center;">
                                <p style="color: #a1a1aa; font-size: 12px; margin: 0;">&copy; ${new Date().getFullYear()} BitSync. All rights reserved.</p>
                            </td>
                        </tr>
                    </table>
                </td>
            </tr>
        </table>
    </body>
    </html>
    `;
}
