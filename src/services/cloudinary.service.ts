import { v2 as cloudinary } from "cloudinary";
import logger from "./logger.service";

class CloudinaryService {
    private static instance: CloudinaryService;

    private static readonly RESOURCE_TYPE = "raw" as const;
    private static readonly DELIVERY_TYPE = "authenticated" as const;
    private static readonly FOLDER = "bitsync/blobs";
    private static readonly DEFAULT_TTL_SECONDS = 300;

    private constructor() {
        cloudinary.config({
            cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
            api_key: process.env.CLOUDINARY_API_KEY,
            api_secret: process.env.CLOUDINARY_API_SECRET,
            secure: true,
        });
    }

    public static getInstance(): CloudinaryService {
        if (!this.instance) this.instance = new CloudinaryService();
        return this.instance;
    }

    private publicId(blobHash: string): string {
        return `${CloudinaryService.FOLDER}/${blobHash}`;
    }

    public async uploadRawBlob(content: Buffer, blobHash: string): Promise<void> {
        await new Promise<void>((resolve, reject) => {
            const stream = cloudinary.uploader.upload_stream(
                {
                    resource_type: CloudinaryService.RESOURCE_TYPE,
                    type: CloudinaryService.DELIVERY_TYPE,
                    public_id: this.publicId(blobHash),
                    overwrite: false,
                },
                (error) => {
                    if (error) {
                        logger.error("CLOUDINARY", `Upload failed for ${blobHash}: ${error.message}`);
                        return reject(error);
                    }
                    resolve();
                },
            );
            stream.end(content);
        });
    }

    public getSignedUrl(
        blobHash: string,
        ttlSeconds: number = CloudinaryService.DEFAULT_TTL_SECONDS,
    ): { url: string; expiresAt: number } {
        const expiresAt = Math.floor(Date.now() / 1000) + ttlSeconds;
        const url = cloudinary.utils.private_download_url(this.publicId(blobHash), "", {
            resource_type: CloudinaryService.RESOURCE_TYPE,
            type: CloudinaryService.DELIVERY_TYPE,
            expires_at: expiresAt,
        });
        return { url, expiresAt };
    }

    public async uploadAvatar(content: Buffer, userId: string): Promise<string> {
        return new Promise<string>((resolve, reject) => {
            const stream = cloudinary.uploader.upload_stream(
                {
                    resource_type: "image",
                    type: "upload",
                    folder: "bitsync/avatars",
                    public_id: userId,
                    overwrite: true,
                    invalidate: true
                },
                (error, result) => {
                    if (error) {
                        logger.error("CLOUDINARY", `Avatar upload failed for user ${userId}: ${error.message}`);
                        return reject(error);
                    }
                    if (!result) {
                        return reject(new Error("Cloudinary upload returned empty result"));
                    }
                    resolve(result.secure_url);
                }
            );
            stream.end(content);
        });
    }
}

const cloudinaryService = CloudinaryService.getInstance();

export default cloudinaryService;
