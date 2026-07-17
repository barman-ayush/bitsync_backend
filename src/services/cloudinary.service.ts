import { v2 as cloudinary } from "cloudinary";
import logger from "./logger.service";

// Cloudinary-backed object storage for blob content. Blobs are content-addressed,
// so the Cloudinary public_id IS the blobHash — uploads are idempotent (identical
// content -> identical id) and the delivery location is always derivable from the
// hash, so nothing about the location needs to be persisted in the DB.
//
// Resources are uploaded with delivery type "authenticated": they are NOT publicly
// reachable. The FE can only read content through a short-lived signed URL minted
// per request by getSignedUrl, AFTER our own RBAC (repo membership + view
// permission) has authorised the call.
class CloudinaryService {
    private static instance: CloudinaryService;

    // raw: blob content is arbitrary bytes (source files, binaries), not media —
    // Cloudinary must not try to transform or re-encode it.
    private static readonly RESOURCE_TYPE = "raw" as const;
    // authenticated: original is protected; delivery requires a signed URL.
    private static readonly DELIVERY_TYPE = "authenticated" as const;
    // Namespace all blobs under one folder/prefix in the account.
    private static readonly FOLDER = "bitsync/blobs";
    // Signed-URL lifetime: short enough to limit link sharing, long enough for the
    // FE to begin the fetch after receiving it.
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

    // The Cloudinary public_id for a blob: "<folder>/<blobHash>". Deterministic,
    // so it is never stored — always reconstructed from the hash.
    private publicId(blobHash: string): string {
        return `${CloudinaryService.FOLDER}/${blobHash}`;
    }

    // uploadRawBlob : push raw content to Cloudinary keyed by its hash. Idempotent
    // (overwrite:false — re-uploading identical content resolves to the existing
    // asset). The caller has already verified the hash matches the bytes.
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
            // upload_stream consumes a readable; feed it the in-memory buffer directly.
            stream.end(content);
        });
    }

    // getSignedUrl : a short-lived, signed download URL for an authenticated raw
    // blob. Signed with the account api_secret (server-only); the link expires, so
    // it is generated fresh per request and never persisted.
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

    // uploadAvatar : upload a public profile image for a user under bitsync/avatars/<userId>
    public async uploadAvatar(content: Buffer, userId: string): Promise<string> {
        return new Promise<string>((resolve, reject) => {
            const stream = cloudinary.uploader.upload_stream(
                {
                    resource_type: "image",
                    type: "upload", // public delivery
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
