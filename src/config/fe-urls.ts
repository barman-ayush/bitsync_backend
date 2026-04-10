const CLIENT_URL = process.env.CLIENT_URL || "";

const home = `${CLIENT_URL}`

const verifyEmail = `${CLIENT_URL}/api/auth/verify-email`;


export const feUrls = {
    home,
    verifyEmail,
};
