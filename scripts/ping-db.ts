import dotenv from "dotenv";
import { Pool } from "pg";

dotenv.config();

async function pingDatabase() {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] Starting database keep-alive ping...`);

    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
        console.error(`[${timestamp}] ERROR: DATABASE_URL environment variable is not defined.`);
        process.exit(1);
    }

    const isLocal = connectionString.includes("localhost") || connectionString.includes("127.0.0.1");

    const pool = new Pool({
        connectionString,
        ssl: isLocal ? false : { rejectUnauthorized: false },
        connectionTimeoutMillis: 10000,
    });

    try {
        const client = await pool.connect();
        const res = await client.query("SELECT 1 as keep_alive, NOW() as current_time;");
        console.log(`[${timestamp}] Database ping successful:`, res.rows[0]);
        client.release();
    } catch (error) {
        console.error(`[${timestamp}] Database ping failed:`, error);
        process.exit(1);
    } finally {
        await pool.end();
        console.log(`[${timestamp}] Database pool closed cleanly.`);
    }
}

pingDatabase();
