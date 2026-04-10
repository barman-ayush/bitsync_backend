import nodemailer, { Transporter } from "nodemailer";
import logger from "./logger.service";

class MailService {
    private static instance: MailService;
    private transporter: Transporter;

    private constructor() {
        this.transporter = nodemailer.createTransport({
            host: process.env.SMTP_HOST,
            port: Number(process.env.SMTP_PORT),
            secure: process.env.SMTP_SECURE === "true",
            auth: {
                user: process.env.SMTP_USER,
                pass: process.env.SMTP_PASS,
            },
        });
    }

    public static getInstance(): MailService {
        if (!this.instance) {
            this.instance = new MailService();
        }
        return this.instance;
    }

    public async sendMail(to: string, subject: string, html: string): Promise<void> {
        try {
            await this.transporter.sendMail({
                from: process.env.SMTP_FROM,
                to,
                subject,
                html,
            });
            logger.success("MAIL", `Email sent to ${to}`);
        } catch (error) {
            logger.error("MAIL", `Failed to send email to ${to}: ${error}`);
            throw error;
        }
    }
}

const mailService = MailService.getInstance();

export default mailService;
