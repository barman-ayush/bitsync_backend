import { PrismaClient } from "../generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import logger from "./logger.service";

class DatabaseService {
    private static instance: DatabaseService;
    public prisma: PrismaClient;

    private constructor() {
        const connectionString = process.env.DATABASE_URL!;
        const isLocal = connectionString.includes("localhost") || connectionString.includes("127.0.0.1");

        const pool = new Pool({
            connectionString,
            ssl: isLocal ? false : { rejectUnauthorized: false },
        });

        const adapter = new PrismaPg(pool);
        this.prisma = new PrismaClient({ adapter });
    }

    public static getInstance(): DatabaseService {
        if (!this.instance) {
            this.instance = new DatabaseService();
        }
        return this.instance;
    }

    public async connect(): Promise<void> {
        try {
            await this.prisma.$connect();
            logger.success("DATABASE", "Connected to PostgreSQL");
        } catch (error) {
            logger.error("DATABASE", `Connection failed: ${error}`);
            process.exit(1);
        }
    }

    public async disconnect(): Promise<void> {
        await this.prisma.$disconnect();
        logger.info("DATABASE", "Disconnected from PostgreSQL");
    }
}

const db = DatabaseService.getInstance();

export default db;
