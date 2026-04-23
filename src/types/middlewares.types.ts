export type RepoContextRepo = {
    id: string;
    name: string;
    description: string | null;
    ownerId: string;
    headCommit: string | null;
    isDeleted: boolean;
    createdAt: Date;
    updatedAt: Date;
};
